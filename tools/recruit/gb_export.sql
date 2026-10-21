-- しりすこPAD GB: 募集基準グラフ用の匿名エクスポート (読み取りのみ・テーブルもポリシーも変えない)
-- 出力は attribute / slv / damage の 3 列だけ (秘匿テーブルの値・client_id・編成は出さない)
-- 集計条件は get_distribution と同じ: シーズン絞り → 締め凸除外 → シャドウ範囲内 → 1端末1票 (シーズンベスト)
-- 実行後: 結果の「Export → Download CSV」で保存 (約 1,800 行)
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
)
select attribute, slv, round(damage)::bigint as damage
  from best
 order by attribute, slv, damage;
