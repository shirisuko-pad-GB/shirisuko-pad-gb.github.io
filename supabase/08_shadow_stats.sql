-- ============================================================================
-- 08_shadow_stats.sql — シャドウ集計 + 編成集計の刷新
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜07。
-- このファイルが get_distribution / get_comp_insights の最終定義になる
-- (submit_measurements の最終は 07 のまま — 送信側は一切変えない)。
--
-- 方針 (REVIEW-aggregation.md 提案D・運営判断 2026-07-30):
--  1) 荒らしの極端値は「拒否しない」。送信は普通に受理してスコアも普通に返す
--     (突っぱねると意地になってエスカレートするため)。そのかわり、
--     シーズン別の妥当スコア範囲 (score_bounds) の外にある票は
--     **公開集計から黙って除外**する (n・上位%・中央値・ヒスト・編成集計すべて)。
--     本人の画面には自分のスコアが出続けるので、除外されたことは分からない。
--  2) 編成の「最高」(生 max) は廃止 — 境界内の1票で乗っ取れるため。
--     かわりに「中央値が高い編成 TOP」(採用5人以上) を返す。
--  3) 編成の横展開: 順不同5人 (comp_key) ごとに「並び順 (配置) の内訳」を返す。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) シーズン別の妥当スコア範囲。行が無いシーズンは既定 [0.01, 5.0]。
--    シーズン切替時に見直す (基準者の強さはシーズンで変わる — Codex指摘)。
--    anon には一切公開しない (境界値を知られると際どい値で回避されるため)。
-- ---------------------------------------------------------------------------
create table if not exists public.score_bounds (
    season    text primary key,
    min_score numeric not null default 0.01,
    max_score numeric not null default 5.0,
    constraint score_bounds_sane check (min_score > 0 and max_score > min_score)
);
alter table public.score_bounds enable row level security;
revoke all on public.score_bounds from anon, authenticated;

insert into public.score_bounds (season, min_score, max_score)
values ('2026-07', 0.01, 5.0)
on conflict (season) do nothing;

-- ---------------------------------------------------------------------------
-- 2) get_distribution — 05 と同じ形だが、集計対象を妥当範囲内の票に限定する。
--    しきい値 (分布50 / 同一編成15) は「除外後の票数」で判定する。
-- ---------------------------------------------------------------------------
create or replace function public.get_distribution(
    p_attribute text, p_season text, p_score numeric,
    p_comp_key text default null, p_bins int default 20
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_k numeric; v_scores numeric[]; v_n int; v_above int; v_median numeric;
    v_lo numeric; v_hi numeric; v_bins int[]; v_my_bin int;
    v_min numeric; v_max numeric;
    v_thresh int := case when p_comp_key is null then 50 else 15 end;   -- 分布50 / 同一編成15
begin
    p_bins := least(greatest(p_bins, 5), 50);
    select r.ratio / b.base_damage into v_k from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv where b.season = p_season and b.attribute = p_attribute;
    if not found then raise exception 'unknown season/attribute: % / %', p_season, p_attribute; end if;

    select coalesce(b.min_score, 0.01), coalesce(b.max_score, 5.0) into v_min, v_max
      from (select 1) one left join public.score_bounds b on b.season = p_season;

    -- シャドウ除外: 妥当範囲外の票は per-client ベスト選抜の前に落とす
    -- (荒らしの巨大票が本人の正当票を上書きしないように、先にフィルタする)
    select array_agg(best * v_k) into v_scores from (
        select max(norm_damage) as best from public.measurements
        where season = p_season and attribute = p_attribute and norm_damage is not null
          and (norm_damage * v_k) between v_min and v_max
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
        -- 範囲外の閲覧者も端のビンとして表示する (除外されたことは知らせない)
        v_my_bin := least(width_bucket(least(greatest(p_score, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins);
    end if;

    return json_build_object('n', v_n, 'above', v_above, 'median', v_median,
                             'lo', v_lo, 'hi', v_hi, 'bins', to_json(v_bins), 'my_bin', v_my_bin);
end; $$;
grant execute on function public.get_distribution(text, text, numeric, text, int) to anon;

-- ---------------------------------------------------------------------------
-- 3) get_comp_insights — シャドウ除外 + 「最高」廃止 + 中央値TOP + 並び順内訳
--    返り値 (解禁時):
--      n:         編成つき提出の票数 (除外後)
--      chars:     [{img, count}]                       — キャラ採用率 (従来通り)
--      comps:     [{chars, n, median, arr}]            — 使用率順TOP。median は採用5人未満で null。
--                 arr = [{chars(並び順そのまま), n}]    — その編成の配置内訳 上位3
--      medianTop: [{chars, n, median}]                 — 中央値が高い編成TOP3 (採用5人以上のみ)
-- ---------------------------------------------------------------------------
create or replace function public.get_comp_insights(
    p_attribute text, p_season text, p_top_chars int default 30, p_top_comps int default 10
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_k numeric; v_chars json; v_comps json; v_median_top json; v_n int;
    v_min numeric; v_max numeric;
    v_thresh int := 10;   -- 編成データ全体の解禁しきい値
    v_floor  int := 5;    -- 個別編成の median を出す下限 (プライバシー: n<5 は数値を伏せる)
begin
    p_top_chars := least(greatest(p_top_chars, 1), 60);
    p_top_comps := least(greatest(p_top_comps, 1), 20);
    select r.ratio / b.base_damage into v_k from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv where b.season = p_season and b.attribute = p_attribute;
    if not found then raise exception 'unknown season/attribute: % / %', p_season, p_attribute; end if;

    select coalesce(b.min_score, 0.01), coalesce(b.max_score, 5.0) into v_min, v_max
      from (select 1) one left join public.score_bounds b on b.season = p_season;

    with rows as (
        select distinct on (client_id) characters, comp_key, norm_damage
        from public.measurements
        where season = p_season and attribute = p_attribute and characters is not null
          and jsonb_typeof(characters) = 'array' and norm_damage is not null
          and (norm_damage * v_k) between v_min and v_max        -- シャドウ除外
        order by client_id, norm_damage desc
    ), counted as (
        select count(*)::int as n from rows
    ), comps_base as (
        select comp_key, (array_agg(characters))[1] as chars, count(*)::int as n_votes,
               percentile_cont(0.5) within group (order by norm_damage) as med
        from rows group by comp_key
    ), top_comps as (
        select * from comps_base order by n_votes desc, med desc limit p_top_comps
    ), arr_ranked as (
        -- 各編成の「並び順 (配置)」内訳: characters 配列の完全一致でグループ化し上位3配置
        select comp_key, characters, count(*)::int as c,
               row_number() over (partition by comp_key order by count(*) desc) as rn
        from rows group by comp_key, characters
    ), arrs as (
        select comp_key, json_agg(json_build_object('chars', characters, 'n', c) order by c desc) as arr
        from arr_ranked where rn <= 3 group by comp_key
    )
    select (select n from counted),
        case when (select n from counted) < v_thresh then null else
          (select json_agg(json_build_object('img', img, 'count', cnt) order by cnt desc, img)
           from (select img, count(*)::int as cnt from rows, lateral jsonb_array_elements_text(characters) as t(img)
                 group by img order by cnt desc limit p_top_chars) c) end,
        case when (select n from counted) < v_thresh then null else
          (select json_agg(json_build_object(
                    'chars', g.chars, 'n', g.n_votes,
                    'median', case when g.n_votes >= v_floor then round((g.med * v_k)::numeric, 4) else null end,
                    'arr', coalesce(a.arr, '[]'::json))
                  order by g.n_votes desc, g.med desc)
           from top_comps g left join arrs a on a.comp_key = g.comp_key) end,
        case when (select n from counted) < v_thresh then null else
          -- 中央値が高い編成TOP3 (採用5人以上のみ — 少数票の分位点は不安定なので出さない)
          (select json_agg(json_build_object('chars', chars, 'n', n_votes,
                    'median', round((med * v_k)::numeric, 4)) order by med desc)
           from (select chars, n_votes, med from comps_base where n_votes >= v_floor
                 order by med desc limit 3) m) end
      into v_n, v_chars, v_comps, v_median_top;

    if v_n = 0 then return json_build_object('n', 0); end if;
    if v_n < v_thresh then return json_build_object('n', v_n, 'gated', true, 'need', v_thresh); end if;
    return json_build_object('n', v_n, 'chars', v_chars, 'comps', v_comps,
                             'medianTop', coalesce(v_median_top, '[]'::json));
end; $$;
grant execute on function public.get_comp_insights(text, text, int, int) to anon;

notify pgrst, 'reload schema';
