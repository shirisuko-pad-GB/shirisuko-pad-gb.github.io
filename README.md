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
| `js/app.js` | UIロジック (3凸入力・分布ゲート・バースト枠ピッカー)・シェアカード生成 (Canvas) |
| `js/backend.js` | 専用 Supabase への REST 送信 (返事で score 受領) / RPC分布取得 |
| `data/base.json` | 基準値 (基準者ふるり の属性別ダメージ @ 基準SLv) — 手動メンテ |
| `data/presets.json` | 属性別キャラ使用率 + 使用率TOP編成 (生成物) |
| `data/burst-map.json` | キャラ名 → バースト区分 (B1/B2/B3/BΛ) — 手動メンテ |
| `data/characters.json` | キャラ画像 → {名前, バースト} (生成物) |
| `scripts/build-data.mjs` | presets.json 再生成 + キャラ画像コピー |
| `scripts/build-characters.mjs` | characters.json 再生成 (PADの nikke_characters × burst-map.json) |
| `scripts/gen-02-sql.mjs` | 実行用 02_stats.local.sql をローカル生成 (シードは非コミット) |

### 編成ピッカーのバースト枠

編成入力はバースト構成テンプレート (`B1・B2・B3×3` / `B1・B2×2・B3×2` / 自由) の
枠タップ式。枠を選ぶと、その枠に入るバーストのキャラだけが候補に出る。
**BΛ (レッドフードのみ) はどの枠にも入れる特殊仕様**。バースト未分類のキャラも
弾かず全枠の候補に出す (「？」表示)。同一キャラのアイコン違いは名前で1つにまとめ、
二重編成も名前単位で防ぐ。バースト区分は `data/burst-map.json` が唯一のソース
(出典: game8 のバースト別キャラ一覧 + 個別評価ページ)。
| `supabase/01_schema.sql` | measurements テーブル + RLS (anon は INSERT/SELECT のみ) |
| `supabase/02_stats.sql` | 統計基盤テンプレート: 参照テーブル(非公開)・スコア再計算トリガ・分布RPC |

## テスト

```sh
node tests/run-tests.mjs
```

push (main) で GitHub Actions がテスト → Pages デプロイ。

## 月次メンテ (レイド終了ごと)

新しい基準値でスコアの版を更新する。**旧版の提出と分布が混ざらないよう `version` の更新を忘れない**こと
(分布集計は norm_damage ベースなので月をまたいで継続する。version はふるり値表示の基準切替)。

1. shirisu-pad 側で月次JSON配置が終わったら:
   `node scripts/build-data.mjs ../shirisu-pad` (presets.json とキャラ画像を更新)
   続けて `node scripts/build-characters.mjs ../shirisu-pad` (characters.json を更新)。
   「⚠ バースト未分類」の警告が出た新キャラは、攻略サイトでバーストを調べて
   `data/burst-map.json` に追記 → 再実行
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
4. Project Settings → API の URL と publishable key を `js/backend.js` の定数に設定
