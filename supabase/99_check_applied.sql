-- ============================================================================
-- 99_check_applied.sql — GB マイグレーション適用状況チェッカー (読み取り専用)
-- ----------------------------------------------------------------------------
-- SQL Editor でこのファイル全体を実行すると 01〜05 の適用状況を一覧で返す
-- (applied=false の行が未適用 → そのファイルを番号順に適用する)。
-- カタログ (pg_catalog / information_schema) のみ参照するため、
-- どのテーブルが欠けていても全体がエラーにならず、常に全行の判定が返る。
--
-- 使いどころ: 新しい Supabase プロジェクト / 別PC・新環境のセットアップ時 (必須)。
-- 新しいマイグレーションを足したら、このファイルにも判定行を1行追加すること。
--
-- 注意: seed (slv_ratio / fururi_bases のデータ) はカタログから判定できない。
--   確認は  select count(*) from public.slv_ratio;
--           select * from public.fururi_bases order by season, attribute;
--   が空なら node scripts/gen-seed.mjs → seed.local.sql を実行する。
-- ============================================================================

SELECT * FROM (
    SELECT '01_schema' AS migration,
           (to_regclass('public.measurements') IS NOT NULL) AS applied,
           'measurements テーブル' AS what

    UNION ALL SELECT '02_stats',
        (to_regclass('public.slv_ratio') IS NOT NULL
         AND to_regclass('public.fururi_bases') IS NOT NULL
         AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'measurements_compute')),
        '参照テーブル (slv_ratio/fururi_bases) + スコア再計算トリガ'

    UNION ALL SELECT '04_hardening',
        (EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'submit_measurements')
         AND EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = to_regclass('public.measurements')
                       AND conname = 'characters_format')
         AND NOT EXISTS (SELECT 1 FROM pg_policies
                         WHERE schemaname = 'public' AND tablename = 'measurements'
                           AND policyname IN ('anon_select', 'anon_insert'))),
        'submit RPC 一本化 + characters CHECK + 匿名直読み書き撤去'

    UNION ALL SELECT '06_input_bounds',
        EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = to_regclass('public.measurements')
                  AND conname = 'damage_bounds'),
        'damage のサニティ上限 (0 < damage < 1000B)'

    UNION ALL SELECT '05_seasons',
        (to_regclass('public.site_state') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'measurements'
                       AND column_name = 'season')
         AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'get_distribution'
                       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_season%')
         AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'get_comp_insights'
                       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_season%')),
        'シーズン制 (season列/site_state/p_season版RPC)'
) t
ORDER BY migration;
