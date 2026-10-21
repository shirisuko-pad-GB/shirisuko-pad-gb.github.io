-- しりすこPAD GB: 募集基準グラフ用の帯別集計 (読み取りのみ・テーブルもポリシーも変えない)
-- 画面の結果グリッドは先頭 100 行しか出ないので、SLv 50 刻みの帯ごとに集計して ~70 行に収めた版
-- 出力列: attribute, lo (帯の下端 SLv), n (人数), dmin, q (5%刻みの分位点 19 個を | で連結), dmax
-- 集計条件は get_distribution と同じ: シーズン絞り → 締め凸除外 → シャドウ範囲内 → 1端末1票 (シーズンベスト)
with k as (
    select b.attribute, r.ratio / b.base_damage as v_k
      from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv
     where b.season = '2026-10'
), bounds as (
    select coalesce(sb.min_score, 0.01) as lo, coalesce(sb.max_score, 5.0) as hi
      from (select 1) one
      left join public.score_bounds sb on sb.season = '2026-10'
), best as (
    select distinct on (m.attribute, m.client_id) m.attribute, m.slv, m.damage
      from public.measurements m
      join k on k.attribute = m.attribute
      cross join bounds
     where m.season = '2026-10'
       and not m.is_finish
       and m.norm_damage is not null
       and (m.norm_damage * k.v_k) between bounds.lo and bounds.hi
     order by m.attribute, m.client_id, m.norm_damage desc
), agg as (
    select attribute, (slv / 50) * 50 as lo, count(*)::int as n,
           min(damage) as dmin, max(damage) as dmax,
           percentile_cont(array[0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70,0.75,0.80,0.85,0.90,0.95])
               within group (order by damage) as qs
      from best
     group by attribute, (slv / 50) * 50
)
select attribute, lo, n, round(dmin)::bigint as dmin,
       (select string_agg(round(v)::bigint::text, '|' order by ord) from unnest(qs) with ordinality as t(v, ord)) as q,
       round(dmax)::bigint as dmax
  from agg
 order by attribute, lo;
