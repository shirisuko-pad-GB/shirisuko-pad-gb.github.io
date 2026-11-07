-- ============================================================================
-- 15_comp_insights_cap.sql — get_comp_insights の返す編成数の上限を 20 → 50 に (第46回 2026-11)
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜14。
-- **テーブル・データは一切変更しない** (集計RPC 1本の再定義のみ)。
--
-- 背景 (2026-11-08・第46回の締め):
--  - 凍結エクスポート (scripts/export-season.mjs) は「採用 5 人以上の編成を全部」出す約束で、
--    get_comp_insights を p_top_comps=20 で呼んでいた (実測で 20 位以内に収まっていた)。
--  - 第46回の水冷 (有効 776 人・編成つき 502 人) で n>=5 の編成が 20 件を超え、
--    スクリプトの安全弁 (末尾がまだ n>=5) で止まった。上限を 50 に広げる。
--  - 解禁しきい値 (編成データ全体 10・個別編成の中央値 5 人) は変えない。n<5 の編成は
--    これまでどおり median を伏せたまま返るだけで、公開される情報の種類は増えない。
--    返す行が増えるだけなので応答サイズも小さいまま (1 行 ≈ 数百バイト)。
--  - 画面 (stats.html) は既定の 10 件のまま。広げた上限を使うのは凍結エクスポートだけ。
--
-- 中身は 09 の get_comp_insights と **上限の 1 行以外は同一**
-- (ここから先はこのファイルが最終定義。tests/run-tests.mjs が 09 との同一性を突き合わせる)。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) get_comp_insights — 09 と同一 + p_top_comps の上限 50
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
    p_top_comps := least(greatest(p_top_comps, 1), 50);   -- 15 で 20→50 (凍結エクスポートが n>=5 の編成を全部取れるように)
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
          and not is_finish                                      -- 締め凸除外
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
          -- 中央値が高い編成TOP10 (採用5人以上のみ — 少数票の分位点は不安定なので出さない)
          (select json_agg(json_build_object('chars', chars, 'n', n_votes,
                    'median', round((med * v_k)::numeric, 4)) order by med desc)
           from (select chars, n_votes, med from comps_base where n_votes >= v_floor
                 order by med desc limit 10) m) end
      into v_n, v_chars, v_comps, v_median_top;

    if v_n = 0 then return json_build_object('n', 0); end if;
    if v_n < v_thresh then return json_build_object('n', v_n, 'gated', true, 'need', v_thresh); end if;
    return json_build_object('n', v_n, 'chars', v_chars, 'comps', v_comps,
                             'medianTop', coalesce(v_median_top, '[]'::json));
end; $$;
grant execute on function public.get_comp_insights(text, text, int, int) to anon;

notify pgrst, 'reload schema';
