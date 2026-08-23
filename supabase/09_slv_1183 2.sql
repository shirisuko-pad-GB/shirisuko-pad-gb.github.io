-- ============================================================
-- 09: SLv 対応上限を 1000 → 1183 に拡張 (2026-08-23)
-- ============================================================
-- SLv補正テーブル (めいでん実測) が SLv1183 まで拡張されたため、
-- 入口の CHECK を追随させる。既存1〜1000との一致は取り込み時に全件検証済み。
--
-- 適用: Supabase (GB プロジェクト) の SQL Editor で実行 → 続けて
--       `node scripts/gen-seed.mjs` で再生成した seed.local.sql を実行
--       (順序が逆だと 1001 以上の INSERT が CHECK 違反で失敗する)
--
-- ⚠ 上限は「補正データの実測範囲」と常に一致させること。CHECK だけ緩めて
--   テーブルに無い SLv を受け付けると、集計 join で行が静かに消える。

-- measurements.slv (01_schema の inline check — 既定名 measurements_slv_check)
alter table public.measurements drop constraint if exists measurements_slv_check;
alter table public.measurements add constraint measurements_slv_check
    check (slv between 1 and 1183);

-- slv_ratio.slv (02_stats の inline check — 既定名 slv_ratio_slv_check)
alter table public.slv_ratio drop constraint if exists slv_ratio_slv_check;
alter table public.slv_ratio add constraint slv_ratio_slv_check
    check (slv between 1 and 1183);
