# 運用TODO (完了したら該当行を消す / 全部済んだらこのファイルごと削除)

## ⏳ 未適用: supabase/08_shadow_stats.sql (2026-07-30 作成)

シャドウ集計 (荒らしの極端値は受理したまま公開集計から黙って除外) + 編成集計の刷新
(「最高」廃止 → 中央値TOP / 並び順内訳)。**適用するまでは従来の集計のまま動く**
(クライアントは新旧両対応済み。medianTop・並び順内訳は適用後に自然に出現する)。

手順: **push 後のデプロイが済んでから** (Pages 反映 + JSキャッシュ約10分。旧クライアントは
best 前提のため、08 を先に適用すると一時的に編成の中央値が「5人以上で表示」と出る) →
SQL Editor で `supabase/08_shadow_stats.sql` を実行 → `99_check_applied.sql` で 08 が ✅ になればOK。
シーズン切替時は `score_bounds` に新シーズン行を足す (無ければ既定 [0.01, 5.0] で動く。
new-season.mjs の残り手順にも表示される)。

## 📍 引き継ぎメモ (2026-07-29 作業終了時点 — 自宅PC向け)

- **現在地**: 全ニケ対応・自作タイル化・権利表記・募集カード・new-season 自動化まで**本番反映済み**。
  Supabase は 01〜07 全適用済み (06/07 は 2026-07-29 に適用し、外部プローブで動作確認済み —
  07 = エラーDETAILからの slv_ratio 漏洩対策)。テスト: unit 40 + E2E 12 全パス。
  現行シーズン 2026-07 は open のまま無停止で移行完了。
- **別PCでの最初の一歩**: 両リポジトリ (shirisu-pad / shirisu-pad-global を同じ親フォルダに) を pull →
  GB の CLAUDE.md を読む → `node tests/run-tests.mjs` で環境確認。
  Codex 併用フラグは PC ごと: 本家側で `touch .claude/hooks/.codex-on` (本家 CLAUDE.md 参照)。
- **未決の判断事項** (ユーザー判断待ち):
  1. REVIEW-aggregation.md 提案A (中央値比の副表示) / 提案B (3凸総合指標) の採否
  2. Figma で検討中のサイト全体デザインの適用 (現状は既存 ClaudeDesign のまま)
  3. IDEAS-pad-integration.md (本家活用6案) の着手順 — 本家 ROADMAP への転記もまだ
- **実機確認もまだ**: タイルUIの見やすさ・シェアカードの見た目 (スマホで https://shirisuko-pad-gb.github.io/ )
