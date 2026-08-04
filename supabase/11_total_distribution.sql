-- ============================================================================
-- 11_total_distribution.sql — 総合 (各凸の中央値比の平均) の全体分布 + 利用者数
-- ----------------------------------------------------------------------------
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜10。
-- **既存データ・既存関数は一切変更しない** (読み取り専用の新規RPC 1本のみ)。
--
-- 背景 (運営判断 2026-08-04):
--  - 「総合◯%」が比較しているのは属性ごとのマッチド集団で、「利用者全体の中の
--    自分の位置」は分からなかった → 全利用者それぞれの総合を計算した分布を返す。
--  - 母集団は **有効な凸 (シャドウ・締め凸除外後) が3属性以上ある人** のみ
--    (= 3凸完走勢。1〜2凸の人は分布に数えず、本人画面では「参考位置」表示)。
--  - あわせてシェアカードの「のべ人数」を正す: 属性別 n の合計は同一人物を
--    重複して数えるため、ユニーク利用者数 (users) を返す。
--
-- 一貫性: 属性ごとの中央値は get_distribution と同じ定義
-- (シーズン絞り → 締め凸除外 → シャドウ範囲内 → per-client ベスト → 中央値)。
-- ============================================================================

create or replace function public.get_total_distribution(
    p_season text, p_total numeric default null, p_bins int default 20
) returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    v_totals numeric[]; v_users int; v_n int; v_median numeric;
    v_lo numeric; v_hi numeric; v_bins int[]; v_my_bin int;
    v_thresh int := 50;   -- 分布の解禁しきい値 (属性分布と同じ感覚)
begin
    p_bins := least(greatest(p_bins, 5), 50);

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
           (select array_agg(total) from totals where atk >= 3)             -- 3凸完走勢の総合
      into v_users, v_totals;

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
        v_my_bin := case when p_total is null then null else 1 end;
    else
        select array_agg(coalesce(c, 0) order by gs.b) into v_bins
        from generate_series(1, p_bins) as gs(b)
        left join (select least(width_bucket(least(greatest(x, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) as b,
                          count(*)::int as c from unnest(v_totals) as x group by 1) h on h.b = gs.b;
        -- p_total (閲覧者の総合・1〜2凸の参考位置も含む) は範囲外でも端のビンに寄せる
        v_my_bin := case when p_total is null then null
                         else least(width_bucket(least(greatest(p_total, v_lo), v_hi), v_lo, v_hi, p_bins), p_bins) end;
    end if;

    return json_build_object('users', v_users, 'n', v_n, 'median', v_median,
                             'lo', v_lo, 'hi', v_hi, 'bins', to_json(v_bins), 'my_bin', v_my_bin);
end; $$;
revoke all on function public.get_total_distribution(text, numeric, int) from public;
grant execute on function public.get_total_distribution(text, numeric, int) to anon;

notify pgrst, 'reload schema';
