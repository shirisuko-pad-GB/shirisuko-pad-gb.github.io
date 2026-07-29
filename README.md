# しりすこPAD GB — ふるり値チェッカー

NIKKE ユニオンレイドのダメージを SLv 補正し、実力指標「ふるり値」を測定する公開サイト。
[shirisu-pad](https://github.com/Furu1018/shirisu-pad) 内のシミュレータの独立サイト版
(ROADMAP 機能候補2)。PAD の Supabase には依存しない。

- 公開URL: https://shirisuko-pad-gb.github.io/
- 計算式: `ふるり値 = ダメージ ÷ (基準ダメージ × slvRatio[自分のSLv] ÷ slvRatio[基準SLv])`
- 1〜3凸をまとめて「送信して測定」→ 専用 Supabase に匿名蓄積し、しきい値を超えた属性から
  「みんなの分布 (上位◯%・ヒストグラム)」が解禁される
- **シーズン制**: レイド毎に分布をリセット (新キャラ・ボスの regime が変わるため)。
  シーズン切替 = 全データ削除 + 新基準投入 (下記ランブック)

## プロダクトの狙いと段階計画

「自分の基準を知りたい」動機で スコア+編成 を集め、ビッグデータ化して
**編成まで考慮した比較** を提供する (類似サイトは編成を collect していない)。

| 段階 | 解禁条件 (シーズン内) | 内容 | 状態 |
|---|---|---|---|
| 0. 土台 | — | 1端末1票(ベスト)・サーバー側スコア再計算(改ざん対策)・外れ値トリム | ✅ |
| 1. 属性別分布 | 属性ごと n≥50 | 上位◯%・ヒストグラム・中央値 (平均でなく中央値=外れ値に頑健) | ✅ |
| 2. 同一編成分布 | 編成ごと n≥15 | 同じ5体編成の中での位置 | ✅ |
| 3. 編成補正 | 属性ごと データ増加後 | キャラ寄与の回帰モデルで「編成の期待値との差=腕前」 | 未着手 |
| 4. 3凸総合指標 | Stage1が5属性で成立 | 各凸を集団中央値で割って平均 → ボスの通りやすさを自動補正 | 入力体験のみ |

### 統計設計の要点 (シーズン制)

- **シーズン = 1つの regime (同じボス集合・キャラ顔ぶれ)**。regime が変わると母集団が変わるため、
  分布・採用率・編成ランキングは **season で区切る** (RPC が `season = p_season` で絞る)。
- **順位づけは norm_damage (= damage ÷ slvRatio[slv])**。ふるり値は表示用の換算値。
- 集計はサーバー側 RPC (`get_distribution` / `get_comp_insights`、supabase/05_seasons.sql):
  シーズン絞り・1端末(client_id)につき属性ごとベスト1件・ヒストグラムは p1〜p99 トリム。
  返り値はふるり値単位。**時間窓は撤去** (シーズンで区切るため)。
- score / norm_damage は BEFORE INSERT トリガがサーバー側で再計算 (クライアント申告値は無視)。
- **しきい値はサーバーが強制** (n<閾値なら分布本体を返さず `{n,gated,need}`)。
  クライアントの `js/shared.js` `THRESHOLDS` (dist=50 / comp=15 / insights=10) は表示用で、
  ゲート表示はサーバーの `need` を優先。個別編成の best/median は **採用5人未満だと伏せる** (プライバシー)。

### 🛡️ 脅威モデルと対策 (04_hardening.sql / 公開サイトの前提)

匿名の不特定多数が書き込む公開サイトとして、外部入力を信頼しない設計にしてある。

- **書き込みは RPC `submit_measurements` 一本 (SECURITY DEFINER)**。measurements テーブルへの
  匿名の直接 SELECT / INSERT は撤去済み (`anon_select`/`anon_insert` を drop)。
  → 生行 (client_id/damage/slv/編成/時刻) は匿名から取得不可・rawINSERT不可
- **`characters` にフォーマットCHECK** (null か「32桁hex.webp が ちょうど5要素」の配列のみ)。
  → ストアドXSS・不正JSONによる集計RPCのDoS・データ汚染を入口で拒否。
  `score`/`norm_damage`/`comp_key` はサーバーが計算・付与 (クライアント申告は不採用)
- **描画は全てエスケープ** (`js/shared.js` の `escapeHtml`)。DB由来の画像名は `CHAR_IMG_RE` で
  再検証してから src に入れる (CHECK との二重防御)。テストに XSS ペイロードの回帰あり
- **分布ゲートはサーバー側で強制**。しきい値 (分布=50 / 同一編成=15 / 編成データ=10) は
  RPC 内定数で、未満なら `{n, gated, need}` だけ返し分布本体を出さない。
- **閉じた/準備中シーズンへの送信をサーバーが拒否** (`submit_measurements` が `site_state` を見て
  `status='open' かつ season=active_season` 以外を弾く)。運用モードは UI だけでなく DB が強制。
- **個別編成のスコア開示は採用5人以上** (`get_comp_insights` が best/median を n<5 で null に)。
- **Sybil を弱める**: `client_id` は NOT NULL 必須。完全な1端末1票保証・レート制限は将来課題。
- RPC の可変引数 (`p_bins`/`p_top_*`) は関数内でクランプ、`season` は `YYYY-MM` 形式CHECK。
- **エラー応答から行内容を漏らさない** (07_sanitize_errors.sql): CHECK違反の Postgres エラー DETAIL
  ("Failing row contains ...") にはトリガ計算済みの norm_damage が入り、拒否される送信を繰り返すだけで
  slv_ratio を1行も挿入せず逆算できてしまうため、submit の INSERT を例外ハンドラで包み
  メッセージ+SQLSTATE だけ返す (DETAIL/HINT は落とす)
- **限界**: SLvを1ずつ変えて送信しスコアを記録する逆算は原理的に防げない (受容済み)

### 🔒 SLv補正テーブルの秘匿 (最重要の運用ルール)

slv-ratio (SLv別攻撃力補正) は **めいでる+ふるりの未公開検証データ**。公開厳禁。

- **リポジトリにも サイトにも Supabaseの公開範囲にも 置かない**。存在してよいのは
  Supabase の `slv_ratio` テーブル (RLSで外部SELECT不可) と、手元のローカルファイルだけ
- ふるり値の計算はサーバー側のみ: 送信 (INSERT) のトリガが計算し、返事で score を返す。
  クライアントは計算式のテーブル部分を一切持たない
- 秘匿データの投入は **`node scripts/gen-seed.mjs`** (shirisu-pad の slv-ratio.json を読む) が生成する
  `supabase/seed.local.sql` — **gitignore 済み。コミット禁止**。
  ※ seed は **データのみ (slv_ratio + fururi_bases)**。関数定義は含めない
  (含めると月次再実行で 04/05/07 のRPC強化を上書きしてしまうため。集計RPCの正は 05_seasons.sql、
  submit_measurements の正は 07_sanitize_errors.sql)。
- tests/run-tests.mjs に混入ガードあり (slv-ratio がリポジトリに現れたら CI が落ちる)
- 限界の認識: 「SLvを1ずつ変えて送信し返ってくるスコアを記録する」方式での逆算は
  原理的に防げない (許容済み)。守っているのは「ファイルとして持ち出される」ことまで

## 構成

| パス | 役割 |
|---|---|
| `index.html` | UI (ClaudeDesign・スマホファースト) |
| `js/calc.js` | クライアント側ユーティリティ (計算式本体はサーバー側のみ)・バースト枠ロジック |
| `js/shared.js` | 全モジュール共通: escapeHtml・sanitizeCharacters・ATTR_INFO・THRESHOLDS・SITE_URL |
| `js/tiles.js` | **自作キャラタイル描画** (DOM/Canvas 両対応)。ゲーム画像は使わない (下記「権利方針」) |
| `css/tiles.css` | タイルの共通スタイル (index/stats 両方から読む) |
| `js/app.js` | UIロジック (3凸入力・分布ゲート・バースト枠ピッカー・前回結果の再確認・募集カード) |
| `js/sharecard.js` | シェアカードの Canvas 描画 (自己完結・状態を持たない純処理・権利表記を焼き込み) |
| `js/backend.js` | 専用 Supabase への RPC 送信 (submit で score 受領) / 分布・集計取得 |
| `data/base.json` | 基準値 (基準者ふるり の属性別ダメージ @ 基準SLv) — new-season.mjs が生成 |
| `data/raid.json` | シーズンのボス名・属性パネルの表示順 (order) — new-season.mjs が生成 |
| `data/boss-catalog.json` | 本家の全実シーズンのボス名履歴 (生成物・raid.json の typo 検証用) |
| `data/presets.json` | 属性別キャラ使用率 + 使用率TOP編成 (生成物) |
| `data/characters.json` | **v2 (生成物)**: 代表ID → {name, burst, burstAlt, element} + 旧アイコンIDの aliases |
| `data/element-map.json` | キャラ名 → 属性 (手動メンテ。出典: game8 属性別キャラ一覧) — タイル背景色用 |
| `data/burst-map.json` | 非常用フォールバック (バーストの正は本家DB。DBが null のときだけ参照) |
| `data/name-overrides.json` | 本家DBに紐付かない旧アイコンID → キャラ名 (過去データ互換レイヤー) |
| `data/site.json` | 運用設定: 連絡先X・ユニオン募集カード (tools/ops.html で編集支援) |
| `stats.html` + `js/stats.js` | みんなのデータページ (分布・キャラ採用率・編成ランキング) |
| `tools/ops.html` | 運営用サイト設定パネル (閲覧専用ワークベンチ — site.json を生成して GitHub で commit) |
| `scripts/new-season.mjs` | **シーズン切替の1コマンド** (本家からボス+ふるり基準を取得 → raid/base/seed 生成) |
| `scripts/update-roster.mjs` | 新キャラ取り込みの1コマンド (build-characters → build-data) |
| `scripts/build-characters.mjs` | characters.json 再生成 (本家 nikke_characters の名前・バースト × element-map) |
| `scripts/build-data.mjs` | presets.json 再生成 (旧アイコンIDは aliases で代表IDに正規化して集計) |
| `scripts/gen-seed.mjs` | 実行用 seed.local.sql をローカル生成 (**データのみ**・シードは非コミット) |
| `supabase/01_schema.sql` | measurements テーブルの初期形 (05で season 化・匿名read/write撤去) |
| `supabase/02_stats.sql` | 参照テーブル(非公開)・スコア再計算トリガ・分布RPC の初期形 (05が最終定義) |
| `supabase/03_analytics.sql` | 集計RPC の初期形 (05が最終定義) |
| `supabase/04_hardening.sql` | セキュリティ堅牢化: characters CHECK・submit RPC一本化・サーバー側ゲート |
| `supabase/05_seasons.sql` | **シーズン制への移行 (集計RPCの最終定義)**: season統合・site_state・p_season RPC (submit の最終は 07) |
| `supabase/06_input_bounds.sql` | damage のサニティ上限CHECK (REVIEW-aggregation.md 対処2) |
| `supabase/07_sanitize_errors.sql` | **submit_measurements の最終定義**: エラーDETAILの行内容漏洩 (norm_damage→slv_ratio逆算) を遮断 |
| `supabase/99_check_applied.sql` | マイグレーション適用状況チェッカー (新環境で必須・読み取り専用) |

### 🎨 権利方針: ゲームアセットを使わない (2026-07 全面移行)

NIKKE 公式の二次創作ガイドラインは「ゲーム画像・動画の複製・転載」を禁止しているため、
**キャラアイコン画像・属性アイコン等のゲームアセットはサイトから全廃した** (自作は許容されている)。

- キャラ表示は `js/tiles.js` の**自作タイル** (バースト帯 = ゲーム準拠色 B1緑/B2黄/B3赤/Λ紫 +
  キャラ名 + 属性の背景色)。属性アイコンは絵文字 (🔥💧⚡🛡️🍃)
- キャラIDは画像があった時代の「32桁hex.webp」形式を維持 (過去データ・DB CHECK と互換)。
  画像が無かったキャラは `md5(名前).webp` の合成ID
- シェアカード (SNS拡散面) にも「非公式ファンコンテンツ / © SHIFT UP CORP.」を焼き込む
- **ゲーム画像を復活させないこと** (tests/run-tests.mjs に回帰ガードあり)。
  キャラ名等の名称・属性・バースト区分は事実データとして扱う

### 編成ピッカーのバースト枠

編成入力はバースト構成テンプレート (`B1・B2・B3×3` / `B1・B2×2・B3×2` / 自由) の
枠タップ式。枠を選ぶと、その枠に入るバーストのキャラだけが候補に出る (全キャラ対象・
ユニオン使用実績が多い順)。**BΛ (レッドフードのみ) はどの枠にも入れる特殊仕様**。
サブバースト (`burstAlt` — 例: ラピ:レッドフード は B3 表示だが B1 枠にも入る) にも対応。
バースト未分類のキャラも弾かず全枠の候補に出す。
**バースト区分の正は本家DB (nikke_characters.burst / burst_alt)** — 修正は本家PADの
設定タブ → キャラ管理から。data/burst-map.json は DB が null のときだけの非常用。

### 設定の書き換えは Git 経由のみ (管理画面を作らない)

raid.json・site.json などの運用設定は**リポジトリのファイル**。書けるのは
組織メンバーだけで、スマホでも GitHub のWeb/アプリから編集→コミットで反映できる。
サイト内に管理UIは置かない (認証がないので誰でも触れてしまうため)。
`tools/ops.html` は「フォーム→JSON生成→コピー→GitHubで commit」の閲覧専用ワークベンチ
(どこにも書き込まない) — この方式なら安全にパネル化できる。

## テスト

```sh
node tests/run-tests.mjs   # 純関数・XSS/入力検証・しきい値の単体テスト
node tests/e2e.mjs         # 常設E2E: headless Chrome で index.html を 375px iframe で駆動
                           #   (実 Supabase に接続して 送信→スコア→分布ゲート→前回結果の再確認 を通す。
                           #    Chrome の場所は自動探索、CHROME_PATH で上書き可)
```

push (main) で GitHub Actions が run-tests → Pages デプロイ。
UI を変えたら手元で `node tests/e2e.mjs` を回して回帰を確認する
(Windows headless は viewport 最小 500px のため、狭幅検証は iframe 375px で行う)。

## 3凸総合指標の補正設計 (Stage 4 の方針メモ)

ボスには属性ごとに「ダメージの通りやすさ/通りにくさ」の差があるため、3凸の生合計では公平に比べられない。

- **現在の「平均ふるり値」は既に補正済み**: 各凸を基準者ふるりの**同じボスへの**ダメージで
  割っているので、通りやすいボスは分母も大きくなり相殺される。
  弱点は「基準者自身のボスごとの得意不得意」が混入すること
- **データが貯まったら (シーズン内・属性ごと)**: 各凸のスコアを
  「そのボスへの**みんなの中央値** (同じ season 内)」で割って平均する。
  集団の中央値が通りやすさをそのまま吸収するので、補正係数を人手で決める必要がない。
  例: 総合 1.05 = 「平均的なプレイヤーの1.05倍のダメージを3凸で出した」
- 前提工事は済んでいる: 送信には season が刻印され、シーズンで区切られている。

## シーズン切替の運用ランブック (レイド毎)

**新シーズンは「ふるり基準が揃って初めて開く」。基準が未投入の隙間は between で蓋をする。**

```
[前シーズンN 開催中]  site_state: status=open, active_season=N
      ↓ レイド終了
[シーズン間 between]  SQL Editor で:
    update public.site_state set status='between', active_season=null, display_season='N',
        message='次シーズン準備中です', updated_at=now();
    → 送信停止・stats は N を read-only 表示 (最終結果)
      ↓ 本家PADでふるり基準が確定 (模擬タブ登録 or 実凸の月次JSON)
[新シーズンN+1 開始]  ★切替オペレーション (VSCode・PC必須)★
  (a) 旧データ削除:   delete from public.measurements;
  (b) node scripts/new-season.mjs        ← ボス5体・ふるり基準 (模擬優先)・roster を全自動生成
        (月次JSONがまだ無ければ --slv <ふるりの現在SLv> を付ける。
         基準が揃っていなければエラーで止まる = そのまま open しないこと)
  (c) SQL Editor で supabase/seed.local.sql を実行 (fururi_bases に N+1 を投入)
  (d) node tests/run-tests.mjs → commit & push
  (e) 開く:  update public.site_state set status='open', active_season='N+1',
                 display_season=null, updated_at=now();
    → N+1 が 0 から開始。
```
- **順序厳守**: 基準 (seed) を入れてから open。逆だとトリガが `unknown season/attribute` で送信を弾く
  (between が蓋なので実害はないが、open は基準投入後に)。
- `base.json` の `version` / `raid.json` の `season` / site_state の `active_season` が
  揃って初めて送信が通る (テストが version 一致とボス名 typo を検証する)。
- 現行シーズンの再生成・検証は `node scripts/new-season.mjs --season-id <本家ID>`。

## 工事中モード (随時)

サイトを止めたいとき (実際の改修中など) は SQL Editor で:
```sql
update public.site_state set status='maintenance', message='メンテナンス中です', updated_at=now();
```
戻すときは `status='open'` (と `active_season` を戻す)。**site_state が唯一の真実**で、
UI もサーバーの書き込み可否もこれで決まる。

## 新キャラの取り込み (実装されたら / 月次)

```sh
node scripts/update-roster.mjs        # ../shirisu-pad を読む (パス指定も可)
```

- 「⚠ バースト未分類」 → 本家PADの設定タブ → キャラ管理で登録 (本家DBが唯一の正) → 再実行
- 「⚠ 属性未分類」 → game8 の属性別キャラ一覧で調べて `data/element-map.json` に追記 → 再実行
  (未分類のままでも動く — タイルがグレーの「属性？」表示になるだけ)
- 警告が消えたら commit → push

base.json の基準ダメージの出所 (new-season.mjs が自動で解決する):
- 基準者ふるりの `syncLevel` と各属性の実凸ダメージ → 最新月JSON (`../shirisu-pad/data/YYYY-MM.json`)
- 模擬スコア (実凸が無い/締め凸だった属性の差し替え) → PAD の Supabase
  `fururi_simulation_scores` (該当 season_id)。**模擬登録がある属性は模擬値を優先**

## Supabase セットアップ (初回のみ)

1. https://supabase.com/dashboard で新規プロジェクト作成 (PAD とは別プロジェクト)
2. SQL Editor で `supabase/01_schema.sql` を実行
3. `node scripts/gen-seed.mjs` (shirisu-pad が隣にある環境で) → 生成された
   `supabase/seed.local.sql` を SQL Editor で実行 (slv_ratio + fururi_bases のデータ)
4. SQL Editor で `04_hardening.sql` → `05_seasons.sql` → `06_input_bounds.sql` →
   `07_sanitize_errors.sql` の**番号順に全部**実行 (04で characters CHECK・submit RPC一本化、
   05で season化・site_state、06で damage上限、07でエラーDETAIL漏洩対策 — 07を飛ばすと
   slv_ratio が逆算可能なままになる)。
   **04 の実行前に `delete from public.measurements;` でテストデータを掃除**しておくこと。
   最後に `99_check_applied.sql` を実行して**全行 applied=true** を確認。
5. Project Settings → API の URL と publishable key を `js/backend.js` の定数に設定
6. シーズンを開く: 上の「シーズン切替ランブック」の (c) で `site_state` を open に。

### 既に 01〜04 適用済みの環境をシーズン制へ移行する場合
`delete from public.measurements;` → `supabase/05_seasons.sql` → `06_input_bounds.sql` →
`07_sanitize_errors.sql` を番号順に実行 (`99_check_applied.sql` で全行 true を確認)。
05 は冪等 (base_version→season のリネーム等をガード付きで実施)。実行後は maintenance が既定なので、
ランブック (c) でシーズンを開く。
