-- しりすこPAD GB: 統計基盤 v2 (Stage 0 + SLv補正テーブルの秘匿)
-- 01_schema.sql 適用済みのプロジェクトの SQL Editor で実行すること。
-- 冪等 (再実行しても壊れない)。v1 を実行済みの環境にもそのまま流せる。
--
-- 【秘匿方針】 slv_ratio は未公開の検証データのため:
--   - このファイルはシードなしのテンプレート。実行用は scripts/gen-02-sql.mjs が
--     ローカル生成する supabase/02_stats.local.sql (gitignore 済み・コミット禁止)
--   - slv_ratio / fururi_bases は外部から SELECT 不可 (RLS 有効・ポリシーなし + REVOKE)
--   - 参照するのは SECURITY DEFINER の関数 (トリガ・RPC) だけ
--   - クライアントには計算結果 (ふるり値) しか渡らない
--
-- 入れるもの:
--   1) slv_ratio / fururi_bases — サーバー側でスコアを計算するための参照テーブル (非公開)
--   2) measurements 拡張 — norm_damage (SLv正規化ダメージ・月をまたいで比較可能) と 3凸セット列
--   3) BEFORE INSERT トリガ — score / norm_damage をサーバー側で計算 (クライアント申告値は無視)
--   4) get_distribution RPC — 1端末1票(ベスト)・直近N日・外れ値トリム済みの分布をふるり値単位で返す

-- ============================================================
-- 1) SLv補正テーブル (非公開)
-- ============================================================
create table if not exists public.slv_ratio (
    slv   int     primary key check (slv between 1 and 1000),
    ratio numeric not null check (ratio > 0)
);

insert into public.slv_ratio (slv, ratio) values
--SLV_RATIO_SEED--
on conflict (slv) do update set ratio = excluded.ratio;

-- 基準値 (月次更新はこのテーブルに新versionをINSERT)
create table if not exists public.fururi_bases (
    base_version text    not null,
    attribute    text    not null check (attribute in ('FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND')),
    base_slv     int     not null references public.slv_ratio (slv),
    base_damage  numeric not null check (base_damage > 0),
    primary key (base_version, attribute)
);

insert into public.fururi_bases (base_version, attribute, base_slv, base_damage) values
--FURURI_BASES_SEED--
on conflict (base_version, attribute) do update
    set base_slv = excluded.base_slv, base_damage = excluded.base_damage;

-- 外部からは読めない: RLS有効 + ポリシーなし + 明示REVOKE (v1のanon_selectポリシーは撤去)
alter table public.slv_ratio    enable row level security;
alter table public.fururi_bases enable row level security;
drop policy if exists "anon_select" on public.slv_ratio;
drop policy if exists "anon_select" on public.fururi_bases;
revoke all on table public.slv_ratio    from anon, authenticated;
revoke all on table public.fururi_bases from anon, authenticated;

-- ============================================================
-- 2) measurements 拡張
-- ============================================================
alter table public.measurements
    add column if not exists norm_damage numeric,                                    -- damage ÷ ratio[slv]
    add column if not exists set_id      uuid,                                       -- 3凸まとめ送信の束ね
    add column if not exists set_slot    smallint check (set_slot between 1 and 3);  -- セット内の何凸目か

create index if not exists measurements_norm_idx on public.measurements (attribute, created_at);

-- ============================================================
-- 3) score / norm_damage のサーバー側計算 (改ざん対策)
--    SECURITY DEFINER: 非公開の参照テーブルを関数内でだけ読む
-- ============================================================
create or replace function public.measurements_compute()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_ratio  numeric;
    v_base_d numeric;
    v_base_r numeric;
begin
    select ratio into v_ratio from public.slv_ratio where slv = new.slv;
    if not found then
        raise exception 'unknown slv: %', new.slv;
    end if;

    select b.base_damage, r.ratio into v_base_d, v_base_r
    from public.fururi_bases b
    join public.slv_ratio r on r.slv = b.base_slv
    where b.base_version = new.base_version and b.attribute = new.attribute;
    if not found then
        raise exception 'unknown base_version/attribute: % / %', new.base_version, new.attribute;
    end if;

    -- クライアントが何を申告してきても上書きする
    new.norm_damage := new.damage / v_ratio;
    new.score       := new.damage / (v_base_d * v_ratio / v_base_r);
    return new;
end;
$$;

drop trigger if exists measurements_compute_trg on public.measurements;
create trigger measurements_compute_trg
    before insert on public.measurements
    for each row execute function public.measurements_compute();

-- ============================================================
-- 4) 分布集計 RPC
--    ルール: 1端末(client_id)につき属性ごとベスト1件 / 直近 p_days 日 /
--            ヒストグラムは p1〜p99 でトリム (外れ値は端のbinに合算)
--    返り値はすべて「ふるり値」単位: {n, above, median, lo, hi, bins[], my_bin}
--    (内部の比較軸は norm_damage。p_base_version の基準でふるり値に換算して返す)
-- ============================================================
drop function if exists public.get_distribution(text, numeric, text, int, int);  -- v1 (norm渡し) を撤去
create or replace function public.get_distribution(
    p_attribute    text,
    p_score        numeric,              -- 自分のふるり値 (送信の返事で得た値)
    p_base_version text,
    p_comp_key     text    default null, -- 指定すると同一編成のみで集計
    p_days         int     default 120,
    p_bins         int     default 20
)
returns json
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_k      numeric;   -- ふるり値換算係数: score = norm × K
    v_scores numeric[];
    v_n      int;
    v_above  int;
    v_median numeric;
    v_lo     numeric;
    v_hi     numeric;
    v_bins   int[];
    v_my_bin int;
begin
    select r.ratio / b.base_damage into v_k
    from public.fururi_bases b
    join public.slv_ratio r on r.slv = b.base_slv
    where b.base_version = p_base_version and b.attribute = p_attribute;
    if not found then
        raise exception 'unknown base_version/attribute: % / %', p_base_version, p_attribute;
    end if;

    -- 1端末1票 (ベスト)。client_id が無い行は1行=1票として扱う
    select array_agg(best * v_k) into v_scores
    from (
        select max(norm_damage) as best
        from public.measurements
        where attribute = p_attribute
          and norm_damage is not null
          and created_at > now() - make_interval(days => p_days)
          and (p_comp_key is null or comp_key = p_comp_key)
        group by coalesce(client_id::text, id::text)
    ) d;

    v_n := coalesce(array_length(v_scores, 1), 0);
    if v_n = 0 then
        return json_build_object('n', 0);
    end if;

    select count(*) filter (where x > p_score),
           percentile_cont(0.5)  within group (order by x),
           percentile_cont(0.01) within group (order by x),
           percentile_cont(0.99) within group (order by x)
    into v_above, v_median, v_lo, v_hi
    from unnest(v_scores) as x;

    if v_hi <= v_lo then
        -- 全員ほぼ同値: 1本のバーにまとめる
        v_bins   := array_fill(0, array[p_bins]);
        v_bins[1] := v_n;
        v_my_bin := 1;
    else
        select array_agg(coalesce(c, 0) order by gs.b) into v_bins
        from generate_series(1, p_bins) as gs(b)
        left join (
            select least(width_bucket(least(greatest(x, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) as b,
                   count(*)::int as c
            from unnest(v_scores) as x
            group by 1
        ) h on h.b = gs.b;
        v_my_bin := least(width_bucket(least(greatest(p_score, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins);
    end if;

    return json_build_object(
        'n', v_n,
        'above', v_above,
        'median', v_median,
        'lo', v_lo,
        'hi', v_hi,
        'bins', to_json(v_bins),
        'my_bin', v_my_bin
    );
end;
$$;

grant execute on function public.get_distribution(text, numeric, text, text, int, int) to anon;
