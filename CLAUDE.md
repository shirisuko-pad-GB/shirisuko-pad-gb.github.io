# しりすこPAD GB プロジェクトガイド

NIKKE ユニオンレイドの実力指標「ふるり値」を測定する**公開サイト**。
[shirisu-pad](https://github.com/Furu1018/shirisu-pad) (内輪運用の本家PAD) の姉妹プロジェクトで、
**本家のリポジトリ・DBには一切書き込まない** (ビルド時に読むだけ)。
詳細仕様・運用ランブックは **README.md が正** — このファイルは作業ルールの要点だけ。

- 公開URL: https://shirisuko-pad-gb.github.io/ (GitHub Pages, main へ push で反映)
- 専用 Supabase (本家とは別プロジェクト)。接続情報は `js/backend.js`
- SNS で拡散する前提のサイト。**本家と違い、外部入力・悪意ある閲覧者を常に想定すること**

## 絶対ルール

1. **SLv補正テーブル (slv-ratio) は公開厳禁**。リポジトリ・サイト・Supabase の公開範囲に置かない。
   計算はサーバー側トリガのみ。seed は `scripts/gen-seed.mjs` が生成する gitignore 済みの
   `supabase/seed.local.sql` だけ (データのみ・関数は含めない)。詳細: README「SLv補正テーブルの秘匿」
2. **キャラ画像は掲載停止中** (2026-08-10 — README「権利方針」が正)。
   二次創作ガイドライン第1条4項 (複製・トレースは二次創作と認められない) に照らし
   `js/tiles.js` の `USE_CHAR_IMAGES = false` に切替済み。権利元 (business@shiftup.co.kr) へ
   **許諾を申請中で、許諾が出るまで独断で true に戻さないこと** (CIのテストが false 固定を担保)。
   画像ファイル自体と build の仕組みは再開に備えて残してある —
   手で character-images/ に画像を足さない。属性アイコン等のUI用ゲームアセットは引き続き自作のみ
3. **書き込みRPCは「新規提出 = `submit_measurements`」+「自分の行の後編集 =
   `mark_own_finish` / `correct_own_measurement` (10)」のみ**。後編集は必ず
   client_id + season + attribute の3条件スコープ (他人の行に触れない)。
   テーブルへの匿名直接 INSERT/SELECT を許すポリシーを追加しない。
   最終定義: submit/集計RPC = `09_finish_flag.sql`、後編集 = `10_own_edits.sql`
   (05/07/08 は歴史。関数を seed で上書きしない)。
   **エラーで行内容を返さない**: INSERT は例外ハンドラで包む (DETAIL に norm_damage が入り slv_ratio が漏れる)
4. **DB由来・ユーザー入力由来の文字列は必ず `escapeHtml` を通して DOM へ**。キャラ名も本家DB由来
   なので信頼しない (tiles.js は textContent/escape 済みの経路のみ使う)
5. **運用設定の書き換えは Git 経由のみ** (管理画面を作らない)。認証がないサイトなので、
   サイト内に書き込みUIを作ると誰でも触れてしまう。`tools/ops.html` は
   「フォーム→JSON生成→GitHubで commit」の閲覧専用ワークベンチ方式を守ること

## 構成の要点 (詳細は README の表)

- `js/app.js` (測定UI) / `js/stats.js` (みんなのデータ) / `js/backend.js` (RPC) /
  `js/calc.js` (純関数) / `js/sharecard.js` (Canvas) / `js/shared.js` (共通・XSS対策) /
  `js/tiles.js` (キャラタイル描画 — DOM/Canvas 両対応)
- `data/characters.json` — 生成物。キー = キャラID (`32桁hex.webp` 形式。画像があった時代の
  md5 を継承 or `md5(名前)` の合成ID)。値 = {name, burst, burstAlt, element, aliases}
- `data/element-map.json` — キャラ名→属性 (手動メンテ)。未登録はグレー「属性?」表示に劣化
- `data/site.json` — 運用設定 (ユニオン募集・Xアカウント)。`tools/ops.html` で編集支援
- `data/raid.json` + `data/base.json` — シーズンごとの基準。`scripts/new-season.mjs` が自動生成

## シーズン切替 (毎レイド・PC必須)

```sh
node scripts/new-season.mjs        # 本家からボス5体+ふるり基準(実凸/模擬)を取得して
                                   # raid.json / base.json / roster を更新し seed を生成
# → 表示された残り手順: SQL Editor で seed 実行 → commit&push → site_state を open
```
順序厳守 (基準投入前に open しない)。詳細ランブック: README「シーズン切替の運用ランブック」

## テスト・検証

```sh
node tests/run-tests.mjs   # 純関数・XSS・しきい値・データ整合の単体テスト
node tests/e2e.mjs         # headless Chrome で実 Supabase まで通す常設E2E
```

push (main) で GitHub Actions が run-tests → Pages デプロイ。UI を触ったら e2e を回すこと。
Supabase の適用状況チェック: `supabase/99_check_applied.sql` を SQL Editor で実行 (新環境で必須)。

## Codex 併用レビュー

本家と同じ運用: 実装 → commit → **同一ターン内で codex:codex-rescue に明示レビュー** →
指摘対応 → **同一ターンで push まで完了**。監査を通さない push は禁止。
(Stop フックは本家リポジトリ側の設定で動く保険。フラグは本家 `.claude/hooks/.codex-on`)

## デザイン: Finance系スキン (2026-07〜 / 本家のClaudeDesignとは別物)

Figma の Finance ダッシュボードテンプレを基調にした GB 独自スキン。
**モノクロ + クリーム/イエロー1アクセント / 角丸22px / 影なし極薄ボーダー / ピルはフルラウンド /
数字主役 (Poppins + Noto Sans JP, tabular-nums) / ダークモードは端末設定追従**。

- トークンは index.html / stats.html の `:root` に定義 (ライト) + `@media (prefers-color-scheme: dark)`。
  **新しい色は必ずトークン経由・両テーマ分を定義**すること (直書きhexはダークで破綻する)
- 主要トークン: bg `#F4F4F1/#0C0C0A`・card `#fff/#171715`・ink `#141412/#F2F2EE`・
  cream `#F6F1CD` (選択状態)・accent `#EFDD3C` (CTA)。ink塗りの上の文字は `--onink`
- 選択状態=クリーム面 / 主ボタン=黒(ink)ピル / CTA=黄ピル / チャート=モノクロシルエット+
  自分だけ ink + 黒吹き出しツールチップ
- 属性カラーは `js/shared.js` の ATTR_INFO が唯一の定義 (パステル円・タイル背景に18%混色で使う)。
  バースト色 (ゲーム準拠): B1=緑 `#1FA95C` / B2=黄 `#F2B705` / B3=赤 `#E5484D` / BΛ=紫 `#8B5CF6`
