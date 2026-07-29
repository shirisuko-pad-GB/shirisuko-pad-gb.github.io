-- 06_input_bounds.sql — 入力値のサーバー側サニティ上限 (REVIEW-aggregation.md 対処2)
-- 適用: Supabase Dashboard → SQL Editor で実行。冪等 (再実行可)。前提: 01〜05 適用済み。
--
-- ダメージの桁ミス (B単位欄に生値を貼る等) や荒らしの極端値を入口で拒否する。
-- 上限 1000B (1e12) は現実の凸ダメージ (十数B〜数十B) の余裕を大きく取った値。
-- p1-p99 トリム + 中央値で集計自体は頑健だが、異常票が「その端末のベスト」として
-- 分布の n に残り続けるのを防ぐ。

alter table public.measurements drop constraint if exists damage_bounds;
alter table public.measurements add constraint damage_bounds
    check (damage > 0 and damage < 1e12);

notify pgrst, 'reload schema';
