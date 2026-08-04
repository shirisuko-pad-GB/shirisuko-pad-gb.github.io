-- ============================================================================
-- 09_finish_flag.sql — 締め凸フラグ + ランキングTOP10
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜08。
-- **既存データは一切変更しない** (カラム追加 default false + 関数差し替えのみ。
--  旧クライアントの送信も is_finish 省略 = false で従来どおり通る → 無停止で適用できる)。
--
-- 背景 (運営判断 2026-08-04): 「締め凸」= ボスを撃破して戦闘が3分未満で終わる凸。
-- ダメージが途中で打ち切られるためスコアが構造的に低く出る。本人の測定は普通に
-- 受け付けて返すが、**みんなの分布・編成集計には入れない** (n にも数えない)。
-- あわせて 編成ランキング (中央値TOP) をTOP3→TOP10へ拡張 (使用率TOPは既定10のまま)。
--
-- このファイルが submit_measurements / get_distribution / get_comp_insights の
-- 最終定義になる (07 / 08 は歴史)。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 締め凸フラグ (追加のみ・既存行は false のまま)
-- ---------------------------------------------------------------------------
alter table public.measurements
    add column if not exists is_finish boolean not null default false;

-- ---------------------------------------------------------------------------
-- 2) submit_measurements — is_finish を受け取る (省略時 false = 旧クライアント互換)。
--    本文は 07 と同一 (エラーDETAIL落とし等はそのまま)。
-- ---------------------------------------------------------------------------
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

        begin
            insert into public.measurements
                (attribute, slv, damage, season, characters, comp_key, client_id, set_id, set_slot, is_finish)
            values (
                v_row ->> 'attribute', (v_row ->> 'slv')::int, (v_row ->> 'damage')::numeric, v_row ->> 'season',
                v_char, v_comp_key, (v_row ->> 'client_id')::uuid,
                nullif(v_row ->> 'set_id', '')::uuid, (v_row ->> 'set_slot')::smallint,
                coalesce((v_row ->> 'is_finish')::boolean, false)
            )
            returning score into v_score;
        exception when others then
            -- DETAIL ("Failing row contains ...") を落とす。メッセージと SQLSTATE は保持
            raise exception '%', sqlerrm using errcode = sqlstate;
        end;
        v_out := v_out || jsonb_build_object('score', v_score, 'comp_key', v_comp_key);
    end loop;
    return v_out;
end; $$;
grant execute on function public.submit_measurements(jsonb) to anon;

-- ---------------------------------------------------------------------------
-- 3) get_distribution — 08 と同一 + 締め凸を集計対象から除外 (not is_finish)。
--    しきい値は「除外後の票数」で判定 (従来どおり)。
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
-- 4) get_comp_insights — 08 と同一 + 締め凸除外 + 中央値TOPを3→10へ拡張
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
