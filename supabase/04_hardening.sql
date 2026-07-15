-- しりすこPAD GB: セキュリティ堅牢化 (Phase 1 + 2)。01〜03 適用後に実行。冪等。
-- シードを含まないためコミット・GitHubからのコピーOK。
--
-- 【このSQLで塞ぐもの】(2レビュー突き合わせの根: characters無検証 と anon全公開)
--   1-1 characters にフォーマットCHECK      … ストアドXSS・不正JSONによる集計DoS・汚染を入口で拒否
--   1-4 生データSELECT/rawINSERT を遮断      … measurements の匿名read/writeを撤去し RPC 一本化
--   2-1 分布ゲートをサーバー側で強制          … n<閾値なら分布本体を返さない (表示制御から実効制御へ)
--   2-2 client_id を NOT NULL 化・server由来  … 「client_id省略で毎行別票」を封じる
--   2-3 RPC引数のクランプ + raid_key 形式CHECK … DoSの種とゴミraid_keyを排除
--
-- ⚠ 実行前に既存のテストデータを掃除しておくこと (CHECK追加が既存不正行で失敗しないため):
--     delete from public.measurements;

-- ============================================================
-- 1-1 / 2-3) 入口のフォーマット制約 (全INSERT経路に効く)
--   characters: null か「32桁hex.webp が ちょうど5要素」の配列のみ
--   raid_key  : null か 'YYYY-MM' 形式のみ
--   ※ CHECK 制約内でサブクエリは使えない (0A000) ため、配列検証は
--     IMMUTABLE 関数に切り出して CHECK から呼ぶ
-- ============================================================
create or replace function public.is_valid_characters(p jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
    select p is null or (
        jsonb_typeof(p) = 'array'
        and jsonb_array_length(p) = 5
        and not exists (
            select 1 from jsonb_array_elements(p) e
            where jsonb_typeof(e) <> 'string'
               or (e #>> '{}') !~ '^[0-9a-f]{32}\.webp$'
        )
    );
$$;

alter table public.measurements drop constraint if exists characters_format;
alter table public.measurements add constraint characters_format
    check (public.is_valid_characters(characters));

alter table public.measurements drop constraint if exists raid_key_format;
alter table public.measurements add constraint raid_key_format check (
    raid_key is null or raid_key ~ '^[0-9]{4}-[0-9]{2}$'
);

-- ============================================================
-- 2-2) client_id を NOT NULL 化 (既存 null は採番してから)
-- ============================================================
update public.measurements set client_id = gen_random_uuid() where client_id is null;
alter table public.measurements alter column client_id set not null;

-- ============================================================
-- 1-4) 匿名の read/write ポリシーを撤去 → 書き込みは submit_measurements RPC 一本化
--   ・生行 (client_id/damage/slv/編成/時刻) は匿名から取得不可
--   ・rawINSERT 不可 (フォーマット偽装・大量投入の直接経路を塞ぐ)
--   ・RPC は SECURITY DEFINER なので RLS を貫通して動く
-- ============================================================
drop policy if exists "anon_select" on public.measurements;
drop policy if exists "anon_insert" on public.measurements;

-- ============================================================
-- 送信 RPC: 1〜3凸を一括登録し、サーバー計算の score と server由来 comp_key を返す。
--   ・score/norm_damage は BEFORE INSERT トリガが計算 (クライアント申告は無視)
--   ・comp_key は characters から再計算 (クライアント申告を信用しない・照合順の齟齬も回避)
--   ・characters/raid_key/attribute/slv/damage は上の CHECK が検証 (不正は例外→全体ロールバック)
--   ・client_id 必須 (省略で毎行別票にする Sybil を封じる)
-- ============================================================
create or replace function public.submit_measurements(p_rows jsonb)
returns jsonb                       -- [{score, comp_key}] を挿入順で返す
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_len      int;
    v_row      jsonb;
    v_char     jsonb;
    v_comp_key text;
    v_score    numeric;
    v_out      jsonb := '[]'::jsonb;
begin
    v_len := jsonb_array_length(p_rows);
    if v_len is null or v_len < 1 or v_len > 3 then
        raise exception 'invalid batch size';
    end if;

    for v_row in select value from jsonb_array_elements(p_rows) loop
        if (v_row ->> 'client_id') is null then
            raise exception 'client_id required';
        end if;

        -- characters は配列のときだけ採用 (それ以外は null 扱い → CHECK も通る)
        v_char := case when jsonb_typeof(v_row -> 'characters') = 'array'
                       then v_row -> 'characters' else null end;
        v_comp_key := case when v_char is null then null
                           else (select string_agg(e, '|' order by e)
                                 from jsonb_array_elements_text(v_char) as t(e)) end;

        insert into public.measurements
            (attribute, slv, damage, base_version, raid_key, characters, comp_key, client_id, set_id, set_slot)
        values (
            v_row ->> 'attribute',
            (v_row ->> 'slv')::int,
            (v_row ->> 'damage')::numeric,
            v_row ->> 'base_version',
            v_row ->> 'raid_key',
            v_char,
            v_comp_key,
            (v_row ->> 'client_id')::uuid,
            nullif(v_row ->> 'set_id', '')::uuid,
            (v_row ->> 'set_slot')::smallint
        )
        returning score into v_score;

        v_out := v_out || jsonb_build_object('score', v_score, 'comp_key', v_comp_key);
    end loop;

    return v_out;
end;
$$;

grant execute on function public.submit_measurements(jsonb) to anon;

-- ============================================================
-- 2-1 / 2-3) get_distribution を再定義: サーバー側ゲート + 引数クランプ
--   閾値 (関数内定数・改ざん不可): 全体=100 / 同一編成=30
--   n<閾値: {n, gated:true} だけ返す (bins/percentile を出さない)
-- ============================================================
create or replace function public.get_distribution(
    p_attribute    text,
    p_score        numeric,
    p_base_version text,
    p_comp_key     text    default null,
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
    v_k      numeric;
    v_scores numeric[];
    v_n      int;
    v_above  int;
    v_median numeric;
    v_lo     numeric;
    v_hi     numeric;
    v_bins   int[];
    v_my_bin int;
    v_thresh int := case when p_comp_key is null then 100 else 30 end;
begin
    p_days := least(greatest(p_days, 1), 400);
    p_bins := least(greatest(p_bins, 5), 50);

    select r.ratio / b.base_damage into v_k
    from public.fururi_bases b
    join public.slv_ratio r on r.slv = b.base_slv
    where b.base_version = p_base_version and b.attribute = p_attribute;
    if not found then
        raise exception 'unknown base_version/attribute: % / %', p_base_version, p_attribute;
    end if;

    -- 1端末1票 (ベスト)。client_id は NOT NULL なので単純に client_id で集約
    select array_agg(best * v_k) into v_scores
    from (
        select max(norm_damage) as best
        from public.measurements
        where attribute = p_attribute
          and norm_damage is not null
          and created_at > now() - make_interval(days => p_days)
          and (p_comp_key is null or comp_key = p_comp_key)
        group by client_id
    ) d;

    v_n := coalesce(array_length(v_scores, 1), 0);
    if v_n = 0 then
        return json_build_object('n', 0);
    end if;
    if v_n < v_thresh then
        return json_build_object('n', v_n, 'gated', true, 'need', v_thresh);   -- 分布本体は出さない
    end if;

    select count(*) filter (where x > p_score),
           percentile_cont(0.5)  within group (order by x),
           percentile_cont(0.01) within group (order by x),
           percentile_cont(0.99) within group (order by x)
    into v_above, v_median, v_lo, v_hi
    from unnest(v_scores) as x;

    if v_hi <= v_lo then
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
        'n', v_n, 'above', v_above, 'median', v_median,
        'lo', v_lo, 'hi', v_hi, 'bins', to_json(v_bins), 'my_bin', v_my_bin
    );
end;
$$;

grant execute on function public.get_distribution(text, numeric, text, text, int, int) to anon;

-- ============================================================
-- 2-1 / 2-3) get_comp_insights を再定義: ゲート (編成データ=10) + 引数クランプ
-- ============================================================
create or replace function public.get_comp_insights(
    p_attribute    text,
    p_base_version text,
    p_days         int  default 120,
    p_raid_key     text default null,
    p_top_chars    int  default 30,
    p_top_comps    int  default 10
)
returns json
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_k      numeric;
    v_chars  json;
    v_comps  json;
    v_n      int;
    v_thresh int := 10;   -- 編成データの解禁しきい値
begin
    p_days       := least(greatest(p_days, 1), 400);
    p_top_chars  := least(greatest(p_top_chars, 1), 60);
    p_top_comps  := least(greatest(p_top_comps, 1), 20);

    select r.ratio / b.base_damage into v_k
    from public.fururi_bases b
    join public.slv_ratio r on r.slv = b.base_slv
    where b.base_version = p_base_version and b.attribute = p_attribute;
    if not found then
        raise exception 'unknown base_version/attribute: % / %', p_base_version, p_attribute;
    end if;

    -- 編成つき提出のみ・1端末1票 (ベスト)。characters は CHECK 済みだが念のため配列限定
    with rows as (
        select distinct on (client_id)
               characters, comp_key, norm_damage
        from public.measurements
        where attribute = p_attribute
          and characters is not null
          and jsonb_typeof(characters) = 'array'
          and norm_damage is not null
          and created_at > now() - make_interval(days => p_days)
          and (p_raid_key is null or raid_key = p_raid_key)
        order by client_id, norm_damage desc
    ),
    counted as (select count(*)::int as n from rows)
    select
        (select n from counted),
        case when (select n from counted) < v_thresh then null else
            (select json_agg(json_build_object('img', img, 'count', cnt) order by cnt desc, img)
             from (
                 select img, count(*)::int as cnt
                 from rows, lateral jsonb_array_elements_text(characters) as t(img)
                 group by img
                 order by cnt desc
                 limit p_top_chars
             ) c) end,
        case when (select n from counted) < v_thresh then null else
            (select json_agg(json_build_object(
                        'chars', chars, 'n', n_votes,
                        'best', round((best * v_k)::numeric, 4),
                        'median', round((med * v_k)::numeric, 4))
                    order by n_votes desc, med desc)
             from (
                 select comp_key,
                        (array_agg(characters))[1] as chars,
                        count(*)::int as n_votes,
                        max(norm_damage) as best,
                        percentile_cont(0.5) within group (order by norm_damage) as med
                 from rows
                 group by comp_key
                 order by n_votes desc, med desc
                 limit p_top_comps
             ) g) end
    into v_n, v_chars, v_comps;

    if v_n = 0 then
        return json_build_object('n', 0);
    end if;
    if v_n < v_thresh then
        return json_build_object('n', v_n, 'gated', true, 'need', v_thresh);   -- 採用率・編成は出さない
    end if;
    return json_build_object('n', v_n, 'chars', v_chars, 'comps', v_comps);
end;
$$;

grant execute on function public.get_comp_insights(text, text, int, text, int, int) to anon;
