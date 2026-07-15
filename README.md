# しりすこPAD GB — ふるり値チェッカー

NIKKE ユニオンレイドのダメージを SLv 補正し、実力指標「ふるり値」を測定する公開サイト。
[shirisu-pad](https://github.com/Furu1018/shirisu-pad) 内のシミュレータの独立サイト版
(ROADMAP 機能候補2)。PAD の Supabase には依存しない。

- 公開URL: https://shirisuko-pad-gb.github.io/
- 計算式: `ふるり値 = ダメージ ÷ (基準ダメージ × slvRatio[自分のSLv] ÷ slvRatio[基準SLv])`
- 1〜3凸をまとめて「送信して測定」→ 専用 Supabase に匿名蓄積し、しきい値を超えた属性から
  「みんなの分布 (上位◯%・ヒストグラム)」が解禁される

## プロダクトの狙いと段階計画

「自分の基準を知りたい」動機で スコア+編成 を集め、ビッグデータ化して
**編成まで考慮した比較** を提供する (類似サイトは編成を collect していない)。

| 段階 | 解禁条件 | 内容 | 状態 |
|---|---|---|---|
| 0. 土台 | — | 1端末1票(ベスト)・サーバー側スコア再計算(改ざん対策)・件数無制限の集計・外れ値トリム | ✅ 実装済み |
| 1. 属性別分布 | 属性ごと n≥100 | 上位◯%・ヒストグラム・中央値 (平均でなく中央値=外れ値に頑健) | ✅ 実装済み (ゲート待ち) |
| 2. 同一編成分布 | 編成ごと n≥30 | 同じ5体編成の中での位置 | ✅ 実装済み (ゲート待ち) |
| 3. 編成補正 | 属性ごと n≥500目安 | キャラ寄与の回帰モデルで「編成の期待値との差=腕前」 | 未着手 (データ待ち) |
| 4. 3凸総合指標 | Stage1が5属性で成立 | 各凸を集団中央値で割って平均 → ボスの通りやすさを自動補正 | 入力体験のみ実装済み (3凸まとめ入力・平均表示) |

### 統計設計の要点

- **順位づけは norm_damage (= damage ÷ slvRatio[slv]) で行う**。基準者に依存しないため
  月をまたいでデータを合算できる (ふるり値は表示用。同一基準版内では順位が完全一致)
- 集計はサーバー側 RPC `get_distribution` (supabase/02_stats.sql):
  1端末(client_id)につき属性ごとベスト1件 / 直近120日 / ヒストグラムは p1〜p99 トリム。
  返り値はふるり値単位に換算済み
- score / norm_damage は BEFORE INSERT トリガがサーバー側で再計算 (クライアント申告値は無視)
- しきい値は `js/app.js` の `MIN_N_ALL` (=100) / `MIN_N_COMP` (=30) で一元管理。
  解禁前は「あと◯人で解禁」の進捗を出して送信を促す

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
- **分布ゲートはサーバー側で強制**。しきい値 (全体=100 / 同一編成=30 / 編成データ=10) は
  RPC 内定数で、未満なら `{n, gated:true}` だけ返し分布本体を出さない。
  クライアントの `MIN_N_*` は進捗表示用 (判定はサーバーの `gated` が正)
- **Sybil を弱める**: `client_id` は NOT NULL 必須 (省略で毎行別票にする経路を封じた)。
  完全な1端末1票保証・レート制限は将来課題 (Edge Function/IP が要る領域)
- RPC の可変引数 (`p_bins`/`p_days`/`p_top_*`) は関数内でクランプ、`raid_key` は形式CHECK
- **限界**: SLvを1ずつ変えて送信しスコアを記録する逆算は原理的に防げない (受容済み)

### 🔒 SLv補正テーブルの秘匿 (最重要の運用ルール)

slv-ratio (SLv別攻撃力補正) は **めいでる+ふるりの未公開検証データ**。公開厳禁。

- **リポジトリにも サイトにも Supabaseの公開範囲にも 置かない**。存在してよいのは
  Supabase の `slv_ratio` テーブル (RLSで外部SELECT不可) と、手元のローカルファイルだけ
- ふるり値の計算はサーバー側のみ: 送信 (INSERT) のトリガが計算し、返事で score を返す。
  クライアントは計算式のテーブル部分を一切持たない
- `supabase/02_stats.sql` はシード抜きのテンプレート。実行用は
  `node scripts/gen-02-sql.mjs` (shirisu-pad の slv-ratio.json を読む) が生成する
  `supabase/02_stats.local.sql` — **gitignore 済み。コミット禁止**
- tests/run-tests.mjs に混入ガードあり (slv-ratio がリポジトリに現れたら CI が落ちる)
- 限界の認識: 「SLvを1ずつ変えて送信し返ってくるスコアを記録する」方式での逆算は
  原理的に防げない (許容済み)。守っているのは「ファイルとして持ち出される」ことまで

## 構成

| パス | 役割 |
|---|---|
| `index.html` | UI (ClaudeDesign・スマホファースト) |
| `js/calc.js` | クライアント側ユーティリティ (計算式本体はサーバー側のみ)・バースト枠ロジック |
| `js/shared.js` | 全モジュール共通: escapeHtml・sanitizeCharacters・ATTR_INFO・THRESHOLDS・SITE_URL |
| `js/app.js` | UIロジック (3凸入力・分布ゲート・バースト枠ピッカー・前回結果の再確認) |
| `js/sharecard.js` | シェアカードの Canvas 描画 (自己完結・状態を持たない純処理) |
| `js/backend.js` | 専用 Supabase への RPC 送信 (submit で score 受領) / 分布・集計取得 |
| `data/base.json` | 基準値 (基準者ふるり の属性別ダメージ @ 基準SLv) — 手動メンテ |
| `data/presets.json` | 属性別キャラ使用率 + 使用率TOP編成 (生成物) |
| `data/burst-map.json` | キャラ名 → バースト区分 (B1/B2/B3/BΛ) — 手動メンテ |
| `data/characters.json` | キャラ画像 → {名前, バースト} (生成物) |
| `data/name-overrides.json` | PADに名前がない画像 → キャラ名 (手動メンテ・注釈ツールで生成) |
| `data/raid.json` | **レイド毎に更新**: raidKey とボス名 (送信に刻印・画面に表示) |
| `data/annotate-queue.json` | 注釈ツール用の作業キュー (生成物) |
| `stats.html` + `js/stats.js` | みんなのデータページ (分布・キャラ採用率・編成ランキング) |
| `tools/annotate.html` | 運営用の注釈ツール (名前なし画像に名前+バーストを付ける。閲覧専用) |
| `scripts/update-roster.mjs` | **新キャラ取り込みの1コマンド** (build-data → build-characters) |
| `scripts/build-data.mjs` | presets.json 再生成 + キャラ画像コピー |
| `scripts/build-characters.mjs` | characters.json 再生成 (PADの nikke_characters + name-overrides × burst-map) |
| `scripts/gen-02-sql.mjs` | 実行用 02_stats.local.sql をローカル生成 (シードは非コミット) |
| `js/shared.js` | 共通ユーティリティ (escapeHtml・編成の入口検証 sanitizeCharacters) |
| `supabase/01_schema.sql` | measurements テーブル + RLS の初期形 (04で匿名read/writeは撤去) |
| `supabase/02_stats.sql` | 統計基盤テンプレート: 参照テーブル(非公開)・スコア再計算トリガ・分布RPC |
| `supabase/03_analytics.sql` | raid_key 列 + みんなのデータ集計RPC (シードなし・コミット可) |
| `supabase/04_hardening.sql` | セキュリティ堅牢化: characters CHECK・submit RPC一本化・サーバー側ゲート |

### 編成ピッカーのバースト枠

編成入力はバースト構成テンプレート (`B1・B2・B3×3` / `B1・B2×2・B3×2` / 自由) の
枠タップ式。枠を選ぶと、その枠に入るバーストのキャラだけが候補に出る。
**BΛ (レッドフードのみ) はどの枠にも入れる特殊仕様**。バースト未分類のキャラも
弾かず全枠の候補に出す (「？」表示)。同一キャラのアイコン違いは名前で1つにまとめ、
二重編成も名前単位で防ぐ。バースト区分は `data/burst-map.json` が唯一のソース
(出典: game8 のバースト別キャラ一覧 + 個別評価ページ)。
`_unverified` に載っている名前は Claude の推定 — game8 で確認したら消すこと。

### 設定の書き換えは Git 経由のみ (管理画面を作らない)

raid.json・burst-map.json などの運用設定は**リポジトリのファイル**。書けるのは
組織メンバーだけで、スマホでも GitHub のWeb/アプリから編集→コミットで反映できる。
サイト内に管理UIは置かない (誰でも触れてしまうため)。

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
- **データが貯まったら (レイド内・属性ごと n≥100 目安)**: 各凸のスコアを
  「そのボスへの**みんなの中央値** (同じ raid_key 内)」で割って平均する。
  集団の中央値が通りやすさをそのまま吸収するので、補正係数を人手で決める必要がない。
  例: 総合 1.05 = 「平均的なプレイヤーの1.05倍のダメージを3凸で出した」
- 前提工事は済んでいる: 送信には raid_key が刻印され (data/raid.json)、
  norm_damage は基準者に依存しないため月をまたいでも比較可能

## レイド毎の更新 (レイド開始時)

`data/raid.json` の `raidKey` (YYYY-MM) と `bosses` (属性→ボス名) を編集して push するだけ。
GitHub のWeb/アプリからでも編集できる。ボス名は属性選択の下に表示され、送信に刻印される。

## 新キャラの取り込み (実装されたら / 月次)

```sh
node scripts/update-roster.mjs        # ../shirisu-pad を読む (パス指定も可)
```

- 「⚠ バースト未分類」 → game8 でバーストを調べて `data/burst-map.json` に追記 → 再実行
- 「⚠ 名前なし画像」 → `python -m http.server` でリポジトリを配信し
  `/tools/annotate.html` を開く → 画像を見ながら名前+バーストを入力 →
  出力を `data/name-overrides.json` と `data/burst-map.json` に貼る → 再実行
- 警告が消えたら commit → push

## 月次メンテ (レイド終了ごと)

新しい基準値でスコアの版を更新する。**旧版の提出と分布が混ざらないよう `version` の更新を忘れない**こと
(分布集計は norm_damage ベースなので月をまたいで継続する。version はふるり値表示の基準切替)。

1. shirisu-pad 側で月次JSON配置が終わったら: `node scripts/update-roster.mjs`
   (presets・キャラ画像・characters.json をまとめて更新。警告が出たら上記「新キャラの取り込み」)
2. `data/base.json` を手動更新:
   - 基準者ふるりの `syncLevel` と各属性の実凸ダメージ → 最新月JSON (`../shirisu-pad/data/YYYY-MM.json`)
   - 模擬スコア (実凸が無い/締め凸だった属性の差し替え) → PAD の Supabase
     `fururi_simulation_scores` (該当 season_id)。**模擬登録がある属性は模擬値を優先**
   - `version` を "YYYY-MM" に更新
3. `node scripts/gen-02-sql.mjs` で 02_stats.local.sql を再生成し、SQL Editor で実行
   (冪等: fururi_bases に新 version が追加され、slv_ratio は上書き更新される)
4. commit → push (自動デプロイ)

## Supabase セットアップ (初回のみ)

1. https://supabase.com/dashboard で新規プロジェクト作成 (PAD とは別プロジェクト)
2. SQL Editor で `supabase/01_schema.sql` を実行
3. `node scripts/gen-02-sql.mjs` (shirisu-pad が隣にある環境で) → 生成された
   `supabase/02_stats.local.sql` を SQL Editor で実行
4. SQL Editor で `supabase/03_analytics.sql` を実行 (raid_key 列 + 集計RPC)
5. SQL Editor で `supabase/04_hardening.sql` を実行 (堅牢化。**実行前に
   `delete from public.measurements;` でテストデータを掃除しておくこと** —
   characters CHECK 追加が既存不正行で失敗しないため)
6. Project Settings → API の URL と publishable key を `js/backend.js` の定数に設定
