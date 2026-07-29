# 運用TODO (完了したら該当行を消す / 全部済んだらこのファイルごと削除)

## 📍 引き継ぎメモ (2026-07-29 作業終了時点 — 自宅PC向け)

- **現在地**: 全ニケ対応・自作タイル化・権利表記・募集カード・new-season 自動化まで**本番反映済み**
  (main = 915f281)。テスト: unit 39 + E2E 11 全パス。現行シーズン 2026-07 は open のまま無停止で移行完了。
- **別PCでの最初の一歩**: 両リポジトリ (shirisu-pad / shirisu-pad-global を同じ親フォルダに) を pull →
  GB の CLAUDE.md を読む → `node tests/run-tests.mjs` で環境確認。
  Codex 併用フラグは PC ごと: 本家側で `touch .claude/hooks/.codex-on` (本家 CLAUDE.md 参照)。
- **未決の判断事項** (ユーザー判断待ち):
  1. REVIEW-aggregation.md 提案A (中央値比の副表示) / 提案B (3凸総合指標) の採否
  2. Figma で検討中のサイト全体デザインの適用 (現状は既存 ClaudeDesign のまま)
  3. IDEAS-pad-integration.md (本家活用6案) の着手順 — 本家 ROADMAP への転記もまだ
- **実機確認もまだ**: タイルUIの見やすさ・シェアカードの見た目 (スマホで https://shirisuko-pad-gb.github.io/ )

## ⏳ 未適用: supabase/06_input_bounds.sql (2026-07-29 作成)

damage のサーバー側上限CHECK (0 < damage < 1000B)。**適用するまで動作は今まで通り** (急ぎではないが公開拡散前に推奨)。

手順 (どのPCでもOK — SQL Editor はブラウザ作業):
1. https://supabase.com/dashboard → **GB のプロジェクト** (uwrtsrkeiitboksyzmtq) → SQL Editor
2. リポジトリの `supabase/06_input_bounds.sql` の中身を貼り付けて **Run**
3. 確認: 同じく SQL Editor で `supabase/99_check_applied.sql` を実行 → `06_input_bounds` の行が ✅ になればOK

⚠ 本家PADのプロジェクトと間違えないこと (GB は別プロジェクト)。
