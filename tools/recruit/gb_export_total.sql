-- しりすこPAD GB: 3凸合計 (同じ日にまとめて送った 3 凸の合計) の匿名エクスポート (読み取りのみ)
-- 出力は attribute ('TOTAL' 固定) / slv / damage (= 3 凸の合計) の 3 列。個人を特定する列は出さない
-- 条件: シーズン 2026-10 → 締め凸・シャドウ範囲外の凸を落とす → 3 凸とも残ったセットだけ → 1 人 1 票 (合計が最大のセット)
-- 実行後: 「Export → Download CSV」で保存 (数百行。画面は先頭 100 行しか出ない)
with k as (
    select b.attribute, r.ratio / b.base_damage as v_k
      from public.fururi_bases b
      join public.slv_ratio r on r.slv = b.base_slv
     where b.season = '2026-10'
), bounds as (
    select coalesce(sb.min_score, 0.01) as lo, coalesce(sb.max_score, 5.0) as hi
      from (select 1) one
      left join public.score_bounds sb on sb.season = '2026-10'
), ok as (
    select m.client_id, m.set_id, m.slv, m.damage
      from public.measurements m
      join k on k.attribute = m.attribute
      cross join bounds
     where m.season = '2026-10'
       and m.set_id is not null
       and not m.is_finish
       and m.norm_damage is not null
       and (m.norm_damage * k.v_k) between bounds.lo and bounds.hi
), sets as (
    select client_id, set_id, max(slv) as slv, sum(damage) as total
      from ok
     group by client_id, set_id
    having count(*) = 3
), best as (
    select distinct on (client_id) slv, total
      from sets
     order by client_id, total desc
)
select 'TOTAL' as attribute, slv, round(total)::bigint as damage
  from best
 order by slv, damage;
