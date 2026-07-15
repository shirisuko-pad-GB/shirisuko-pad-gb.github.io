-- しりすこPAD GB: シーズン制への移行 (01〜04 適用済みのDBに1回実行)。冪等・シードなし (committable)。
--
-- 【この移行で入るもの】
--   1) base_version → season にリネーム、raid_key 撤去、season-first index
--   2) fururi_bases も season キーに
--   3) site_state テーブル = 運用状態 (open/between/maintenance) の唯一の真実
--   4) submit_measurements に active-season ガード (閉じた/準備中/別シーズンへの送信を拒否)
--   5) get_distribution / get_comp_insights を p_season 版に (シーズン絞り・120日窓撤去・
--      閾値 50/15/10・編成開示下限 5・gated に need)
--   ※ 関数はこのファイルが最終定義。月次の baseline 投入 (seed) は関数を再定義しない
--     (gen-seed.mjs が生成する data-only seed を使う) → 04強化の上書きバグを回避
--
-- ⚠ 実行前に既存データを掃除: delete from public.measurements;
-- ⚠ 実行後、site_state は maintenance (送信停止) が既定。シーズンを開くのは運用手順 (README) で。

-- ============================================================
-- 1) measurements: season 統合
-- ============================================================
do $$ begin
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='measurements' and column_name='base_version') then
        alter table public.measurements rename column base_version to season;
    end if;
end $$;

drop index if exists public.measurements_raid_idx;
alter table public.measurements drop constraint if exists raid_key_format;
alter table public.measurements drop column if exists raid_key;

alter table public.measurements drop constraint if exists season_format;
alter table public.measurements add constraint season_format check (season ~ '^\d{4}-\d{2}$');

drop index if exists public.measurements_dist_idx;   -- 旧 (base_version, attribute)
drop index if exists public.measurements_norm_idx;   -- 旧 (attribute, created_at) — 時間窓廃止で不要
create index if not exists measurements_season_idx on public.measurements (season, attribute);

-- ============================================================
-- 2) fururi_bases: base_version → season
-- ============================================================
do $$ begin
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='fururi_bases' and column_name='base_version') then
        alter table public.fururi_bases rename column base_version to season;
    end if;
end $$;

-- ============================================================
-- 3) site_state: 運用状態の唯一の真実 (1行のみ)
-- ============================================================
create table if not exists public.site_state (
    id             boolean primary key default true check (id),
    status         text not null default 'maintenance' check (status in ('open','between','maintenance')),
    active_season  text,          -- open時に書き込みを許すシーズン (それ以外は null)
    display_season text,          -- between/maintenance時に read-only 表示するシーズン
    message        text,
    updated_at     timestamptz not null default now()
);
insert into public.site_state (id, status) values (true, 'maintenance') on conflict (id) do nothing;

alter table public.site_state enable row level security;
drop policy if exists "anon_select" on public.site_state;
create policy "anon_select" on public.site_state for select to anon using (true);
-- UPDATE は SQL Editor からのみ (運営)。anon には insert/update/delete ポリシーなし。

-- ============================================================
-- 4) トリガ関数: season 参照に更新 (トリガ自体は04で作成済み)
-- ============================================================
create or replace function public.measurements_compute()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ratio numeric; v_base_d numeric; v_base_r numeric;
begin
    select ratio into v_ratio from public.slv_ratio where slv = new.slv;
    if not found then raise exception 'unknown slv: %', new.slv; end if;
    select b.base_damage, r.ratio into v_base_d, v_base_r
    from public.fururi_bases b join public.slv_ratio r on r.slv = b.base_slv
    where b.season = new.season and b.attribute = new.attribute;
    if not found then raise exception 'unknown season/attribute: % / %', new.season, new.attribute; end if;
    new.norm_damage := new.damage / v_ratio;
    new.score       := new.damage / (v_base_d * v_ratio / v_base_r);
    return new;
end; $$;

-- ============================================================
-- 5) submit_measurements: season + active-season ガード
-- ============================================================
create or replace function public.submit_measurements(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    v_len int; v_row jsonb; v_char jsonb; v_comp_key text; v_score numeric;
    v_out jsonb := '[]'::jsonb; v_status text; v_active text;
begin
    select status, active_season into v_status, v_active from public.site_state where id;
    if v_status is distinct from 'open' or v_active is null then
        raise exception 'submissions are closed';                 -- between/maintenance は送信不可
    end if;

    v_len := jsonb_array_length(p_rows);
    if v_len is null or v_len < 1 or v_len > 3 then raise exception 'invalid batch size'; end if;

    for v_row in select value from jsonb_array_elements(p_rows) loop
        if (v_row ->> 'client_id') is null then raise exception 'client_id required'; end if;
        if (v_row ->> 'season') is distinct from v_active then raise exception 'season not open'; end if;

        v_char := case when jsonb_typeof(v_row -> 'characters') = 'array' then v_row -> 'characters' else null end;
        v_comp_key := case when v_char is null then null
                           else (select string_agg(e, '|' order by e) from jsonb_array_elements_text(v_char) as t(e)) end;

        insert into public.measurements
            (attribute, slv, damage, season, characters, comp_key, client_id, set_id, set_slot)
        values (
            v_row ->> 'attribute', (v_row ->> 'slv')::int, (v_row ->> 'damage')::numeric, v_row ->> 'season',
            v_char, v_comp_key, (v_row ->> 'client_id')::uuid,
            nullif(v_row ->> 'set_id', '')::uuid, (v_row ->> 'set_slot')::smallint
        )
        returning score into v_score;
        v_out := v_out || jsonb_build_object('score', v_score, 'comp_key', v_comp_key);
    end loop;
    return v_out;
end; $$;
grant execute on function public.submit_measurements(jsonb) to anon;

-- ============================================================
-- 6) get_distribution: p_season + シーズン絞り + 閾値50/15 + need
--    旧シグネチャ (…, p_base_version, p_comp_key, p_days, p_bins) を明示DROP (Codex指摘: 上書きでなく置換)
-- ============================================================
drop function if exists public.get_distribution(text, numeric, text, text, int, int);
create or replace function public.get_distribution(
    p_attribute text, p_season text, p_score numeric,
    p_comp_key text default null, p_bins int default 20
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_k numeric; v_scores numeric[]; v_n int; v_above int; v_median numeric;
    v_lo numeric; v_hi numeric; v_bins int[]; v_my_bin int;
    v_thresh int := case when p_comp_key is null then 50 else 15 end;   -- 分布50 / 同一編成15
begin
    p_bins := least(greatest(p_bins, 5), 50);
    select r.ratio / b.base_damage into v_k from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv where b.season = p_season and b.attribute = p_attribute;
    if not found then raise exception 'unknown season/attribute: % / %', p_season, p_attribute; end if;

    select array_agg(best * v_k) into v_scores from (
        select max(norm_damage) as best from public.measurements
        where season = p_season and attribute = p_attribute and norm_damage is not null
          and (p_comp_key is null or comp_key = p_comp_key)
        group by client_id
    ) d;

    v_n := coalesce(array_length(v_scores, 1), 0);
    if v_n = 0 then return json_build_object('n', 0); end if;
    if v_n < v_thresh then return json_build_object('n', v_n, 'gated', true, 'need', v_thresh); end if;

    select count(*) filter (where x > p_score), percentile_cont(0.5) within group (order by x),
           percentile_cont(0.01) within group (order by x), percentile_cont(0.99) within group (order by x)
      into v_above, v_median, v_lo, v_hi from unnest(v_scores) as x;

    if v_hi <= v_lo then
        v_bins := array_fill(0, array[p_bins]); v_bins[1] := v_n; v_my_bin := 1;
    else
        select array_agg(coalesce(c, 0) order by gs.b) into v_bins
        from generate_series(1, p_bins) as gs(b)
        left join (select least(width_bucket(least(greatest(x, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) as b,
                          count(*)::int as c from unnest(v_scores) as x group by 1) h on h.b = gs.b;
        v_my_bin := least(width_bucket(least(greatest(p_score, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins);
    end if;

    return json_build_object('n', v_n, 'above', v_above, 'median', v_median,
                             'lo', v_lo, 'hi', v_hi, 'bins', to_json(v_bins), 'my_bin', v_my_bin);
end; $$;
grant execute on function public.get_distribution(text, text, numeric, text, int) to anon;

-- ============================================================
-- 7) get_comp_insights: p_season + シーズン絞り + 編成開示下限5
--    旧シグネチャ (…, p_base_version, p_days, p_raid_key, …) を明示DROP
-- ============================================================
drop function if exists public.get_comp_insights(text, text, int, text, int, int);
create or replace function public.get_comp_insights(
    p_attribute text, p_season text, p_top_chars int default 30, p_top_comps int default 10
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_k numeric; v_chars json; v_comps json; v_n int;
    v_thresh int := 10;   -- 編成データ全体の解禁しきい値
    v_floor  int := 5;    -- 個別編成の best/median を出す下限 (プライバシー: n<5 は数値を伏せる)
begin
    p_top_chars := least(greatest(p_top_chars, 1), 60);
    p_top_comps := least(greatest(p_top_comps, 1), 20);
    select r.ratio / b.base_damage into v_k from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv where b.season = p_season and b.attribute = p_attribute;
    if not found then raise exception 'unknown season/attribute: % / %', p_season, p_attribute; end if;

    with rows as (
        select distinct on (client_id) characters, comp_key, norm_damage
        from public.measurements
        where season = p_season and attribute = p_attribute and characters is not null
          and jsonb_typeof(characters) = 'array' and norm_damage is not null
        order by client_id, norm_damage desc
    ), counted as (select count(*)::int as n from rows)
    select (select n from counted),
        case when (select n from counted) < v_thresh then null else
          (select json_agg(json_build_object('img', img, 'count', cnt) order by cnt desc, img)
           from (select img, count(*)::int as cnt from rows, lateral jsonb_array_elements_text(characters) as t(img)
                 group by img order by cnt desc limit p_top_chars) c) end,
        case when (select n from counted) < v_thresh then null else
          (select json_agg(json_build_object('chars', chars, 'n', n_votes,
                   'best',   case when n_votes >= v_floor then round((best * v_k)::numeric, 4) else null end,
                   'median', case when n_votes >= v_floor then round((med  * v_k)::numeric, 4) else null end)
                 order by n_votes desc, med desc)
           from (select comp_key, (array_agg(characters))[1] as chars, count(*)::int as n_votes,
                        max(norm_damage) as best, percentile_cont(0.5) within group (order by norm_damage) as med
                 from rows group by comp_key order by n_votes desc, med desc limit p_top_comps) g) end
      into v_n, v_chars, v_comps;

    if v_n = 0 then return json_build_object('n', 0); end if;
    if v_n < v_thresh then return json_build_object('n', v_n, 'gated', true, 'need', v_thresh); end if;
    return json_build_object('n', v_n, 'chars', v_chars, 'comps', v_comps);
end; $$;
grant execute on function public.get_comp_insights(text, text, int, int) to anon;
