-- ============================================================================
-- 14_lower_thresholds.sql — 分布の解禁しきい値を引き下げる (第46回 2026-11〜)
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜13。
-- **テーブル・データは一切変更しない** (集計RPC 2本の再定義のみ)。
--
-- 背景 (運営判断 2026-11-01):
--  - 毎シーズン提出してくれる常連が増え、分布が早く埋まるようになった。
--    → 導入期の「まき餌」だった基準者ふるりの値 (ふるり値) をやめ、そのぶん
--      「中央値比 %」を早く出す。
--  - しきい値: 属性分布 50→20 / 同一編成 15→10 / 3凸総合 50→20。
--    get_comp_insights (編成データ全体 10・個別編成の中央値 5人) は変えない。
--
-- 中身は 09 の get_distribution / 11 の get_total_distribution と **しきい値以外は同一**
-- (ここから先はこのファイルが最終定義)。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) get_distribution — 09 と同一 + しきい値 20/10
-- ---------------------------------------------------------------------------
create or replace function public.get_distribution(
    p_attribute text, p_season text, p_score numeric,
    p_comp_key text default null, p_bins int default 20
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_k numeric; v_scores numeric[]; v_n int; v_above int; v_median numeric;
    v_lo numeric; v_hi numeric; v_bins int[]; v_my_bin int;
    v_min numeric; v_max numeric;
    v_thresh int := case when p_comp_key is null then 20 else 10 end;   -- 分布20 / 同一編成10 (14 で引き下げ)
begin
    p_bins := least(greatest(p_bins, 5), 50);
    select r.ratio / b.base_damage into v_k from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv where b.season = p_season and b.attribute = p_attribute;
    if not found then raise exception 'unknown season/attribute: % / %', p_season, p_attribute; end if;

    select coalesce(b.min_score, 0.01), coalesce(b.max_score, 5.0) into v_min, v_max
      from (select 1) one left join public.score_bounds b on b.season = p_season;

    -- シャドウ除外 + 締め凸除外: per-client ベスト選抜の前に落とす
    select array_agg(best * v_k) into v_scores from (
        select max(norm_damage) as best from public.measurements
        where season = p_season and attribute = p_attribute and norm_damage is not null
          and not is_finish
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
-- 2) get_total_distribution — 11 と同一 + しきい値 20
-- ---------------------------------------------------------------------------
create or replace function public.get_total_distribution(
    p_season text, p_client_id uuid default null, p_bins int default 20
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_totals numeric[]; v_users int; v_n int; v_median numeric;
    v_lo numeric; v_hi numeric; v_bins int[]; v_my_bin int;
    v_my_total numeric; v_my_atk int;
    v_thresh int := 20;   -- 分布の解禁しきい値 (属性分布と同じ・14 で 50→20)
begin
    p_bins := least(greatest(p_bins, 5), 50);

    -- 基準 (fururi_bases) が無い属性に提出がある = seed 不完全。黙って部分集計せず
    -- 落とす (get_distribution と同じフェイルクローズ — Codex指摘)
    if exists (
        select 1 from public.measurements m
        where m.season = p_season
          and not exists (select 1 from public.fururi_bases b
                          where b.season = p_season and b.attribute = m.attribute)
    ) then
        raise exception 'incomplete bases for season %', p_season;
    end if;

    with k as (
        -- 属性ごとのスコア係数 (シャドウ範囲の判定に使う — 09 と同じ定義)
        select b.attribute, r.ratio / b.base_damage as k
        from public.fururi_bases b
        join public.slv_ratio r on r.slv = b.base_slv
        where b.season = p_season
    ), bounds as (
        select coalesce(b.min_score, 0.01) as mn, coalesce(b.max_score, 5.0) as mx
        from (select 1) one left join public.score_bounds b on b.season = p_season
    ), valid as (
        -- 有効な凸 = 締め凸除外 + シャドウ範囲内、を per-client ベスト選抜の前に適用
        select m.client_id, m.attribute, max(m.norm_damage) as best
        from public.measurements m
        join k on k.attribute = m.attribute
        cross join bounds
        where m.season = p_season and m.norm_damage is not null
          and not m.is_finish
          and (m.norm_damage * k.k) between bounds.mn and bounds.mx
        group by m.client_id, m.attribute
    ), med as (
        select attribute, percentile_cont(0.5) within group (order by best) as med
        from valid group by attribute
    ), ratios as (
        select v.client_id, v.best / med.med as ratio
        from valid v join med on med.attribute = v.attribute
        where med.med > 0
    ), totals as (
        select client_id, avg(ratio) as total, count(*) as atk
        from ratios group by client_id
    )
    select (select count(*) from totals),                                   -- 利用者 (有効1凸以上)
           (select array_agg(total) from totals where atk >= 3),            -- 3凸完走勢の総合
           -- 閲覧者本人の総合はサーバーの正 (属性ごとシーズンベスト) から計算する。
           -- クライアントの表示セット由来の値だと再提出・同属性重複でズレる (Codex指摘)
           (select total from totals where p_client_id is not null and client_id = p_client_id),
           (select atk from totals where p_client_id is not null and client_id = p_client_id)
      into v_users, v_totals, v_my_total, v_my_atk;

    v_n := coalesce(array_length(v_totals, 1), 0);
    if v_n = 0 then return json_build_object('users', coalesce(v_users, 0), 'n', 0); end if;
    if v_n < v_thresh then
        return json_build_object('users', v_users, 'n', v_n, 'gated', true, 'need', v_thresh);
    end if;

    select percentile_cont(0.5) within group (order by x),
           percentile_cont(0.01) within group (order by x),
           percentile_cont(0.99) within group (order by x)
      into v_median, v_lo, v_hi from unnest(v_totals) as x;

    if v_hi <= v_lo then
        v_bins := array_fill(0, array[p_bins]); v_bins[1] := v_n;
        v_my_bin := case when v_my_total is null then null else 1 end;
    else
        select array_agg(coalesce(c, 0) order by gs.b) into v_bins
        from generate_series(1, p_bins) as gs(b)
        left join (select least(width_bucket(least(greatest(x, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) as b,
                          count(*)::int as c from unnest(v_totals) as x group by 1) h on h.b = gs.b;
        -- 本人の総合 (1〜2凸の参考位置も含む) は範囲外でも端のビンに寄せる
        v_my_bin := case when v_my_total is null then null
                         else least(width_bucket(least(greatest(v_my_total, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) end;
    end if;

    return json_build_object('users', v_users, 'n', v_n, 'median', v_median,
                             'lo', v_lo, 'hi', v_hi, 'bins', to_json(v_bins), 'my_bin', v_my_bin,
                             'my_total', v_my_total, 'my_atk', v_my_atk);
end; $$;
revoke all on function public.get_total_distribution(text, uuid, int) from public;
grant execute on function public.get_total_distribution(text, uuid, int) to anon;

notify pgrst, 'reload schema';
