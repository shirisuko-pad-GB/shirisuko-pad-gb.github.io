# 運用TODO (完了したら該当行を消す / 全部済んだらこのファイルごと削除)

## 🧪 投入中: 見え方確認用の仮データ (2026-07-30)

`scripts/seed-demo.mjs` で仮ユーザー350人分 (各属性 n≈190〜250) を本番に投入済み。
公開拡散の前に必ず削除する:
```sql
delete from public.measurements where client_id::text like 'dddddddd-dddd-4ddd-8ddd-%';
```
(実機確認用の固定端末票 …-ffffffffffff も同じSQLで消える)。追加投入は
`node scripts/seed-demo.mjs --from 350 --to 400` のように範囲を伸ばす (同範囲の再実行は同じデータ)。

## ⏳ 実行待ち: score_bounds の運用値 (2026-07-30 決定)

08 は適用済み・シャドウ除外の実弾テストOK (範囲外票が n に乗らないことを確認済み)。
運用値 [0.1, 2.5] (実測: 最強クラスでも1.5、下は0.3もいる) への更新だけ残っている:
```sql
update public.score_bounds set min_score = 0.1, max_score = 2.5 where season = '2026-07';
```
※ 仮データは最大2.6まで振ってあるので、適用後に n が数票減るのは正常 (除外の動作確認になる)。
シーズン切替時の新シーズン行は new-season.mjs の残り手順に表示される (0.1〜2.5 で挿入)。
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
