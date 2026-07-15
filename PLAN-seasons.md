# シーズン制・運用モードの設計方針 (v2 / Codex検証反映済み → Opus実装)

作成: Fable 5 / 検証: Codex gpt-5.6-sol / 実装: Opus / 最終更新: 2026-07-15

## この版の位置づけ

v1 を Codex が独立検証 → 事実誤認の訂正・見落としの反映・ユーザー判断 (過去シーズン削除 /
しきい値50) を織り込んだ確定版。**Opus はこの v2 を実装する。**

## 背景と目的

公開サイトをシーズン制にする。理由 (Codex により精緻化):
- **シーズン = 1つの競技 regime (同じボス集合・キャラ顔ぶれ・スコア条件)**。regime が変わると
  データの母集団が変わるため、跨いだ分布の混在は無意味。
- スコア計算 (`measurements_compute`) は **SLv しか正規化していない**。ボス機構・ロスター・
  戦闘時間などは未正規化 → シーズンで区切って初めて公平な比較になる。

### v1 の事実誤認の訂正 (Codex指摘)
- v1 は「現状は base_version で分布を絞っている」と書いたが**誤り**。現状の
  `get_distribution` / `get_comp_insights` は **base_version でも raid_key でも measurements を
  絞っておらず、全期間・全シーズンの norm_damage をプールしている** (04_hardening.sql の
  RPC 本体を参照)。season 絞りは "修正" ではなく **新規追加**。
- 分布混在の本質は baseline 混在ではない (norm_damage は baseline 非依存)。
  **ボス/ロスター regime の混在**こそが欠陥。

## 確定方針 (ユーザー判断済み)

1. **1シーズン = 1つの regime = 1つの分布プール**。分布・採用率・編成ランキング・ゲートを
   season で区切る。
2. **過去シーズンは次シーズン開始時に全削除** (下記ライフサイクル)。凍結保存はしない。
   → リテンション/容量/長期プライバシーの悩みが消える。
3. **シーズン間 (between) の期間だけ、直前シーズンの結果を read-only 表示** (最終順位を見せる
   ピーク需要をカバー)。次シーズンが開いたら消える。
4. **base_version + raid_key を単一の `season` キーに統合** (下記の条件付きで安全に)。
5. **しきい値を per-season 向けに引き下げ** (分布50 / 同一編成15 / 編成データ10) +
   **珍しい編成の開示下限** (5人未満は個別数値を伏せる)。
6. **閉じた/準備中シーズンへの送信をサーバー側で拒否** (site.json のUI制御だけに頼らない)。

## シーズンのライフサイクル (retention と write-guard を統合)

```
[シーズンN 開催中] status=open, active_season=N
    measurements に N のデータが溜まる。分布/集計は N のみ。
      ↓ レイド終了
[シーズン間 between] status=between, active_season=null
    送信はサーバーが拒否 (active_season=null)。N のデータはまだ残す。
    stats / 結果は displaySeason=N を read-only 表示 (最終結果)。
      ↓ 本家PADでふるり基準が確定
[シーズンN+1 開始] ★切替オペレーション★
    (a) 旧データ削除:  delete from public.measurements;  (= N を破棄)
    (b) 新基準投入:    base.json/raid.json を N+1 に更新 → gen-02-sql → 02_stats.local.sql 実行
                       (fururi_bases に N+1 を INSERT)
    (c) 状態切替:      active_season=N+1, status=open
    → N+1 が 0 から開始。
```
- **DB が常に保持するのは高々1シーズン分** (open中は当該/between中は直前)。
- 「削除」= 公開前に打つ `delete from public.measurements;` と同じ操作。運用手順に組み込む。

## サーバー側の状態管理 (site_state テーブル新設)

UI (site.json) だけでは閉じたシーズンへの書き込みを止められない (改造/古いクライアント)。
**DB に唯一の真実を持つ:**

```sql
create table public.site_state (
    id             boolean primary key default true check (id),  -- 1行のみ
    status         text not null check (status in ('open','between','maintenance')),
    active_season  text,          -- open のとき書き込みを許すシーズン。between/maintenance は null
    display_season text,          -- between/maintenance で read-only 表示するシーズン
    message        text
);
```
- `submit_measurements` に **active-season ガード**を追加:
  `status='open' かつ 送信の season = active_season` でなければ例外で拒否。
  → 閉じた/準備中/別シーズンへの送信を DB が弾く。
- anon は site_state を **SELECT のみ可** (クライアントが表示モードを知るため)。UPDATE は
  SQL Editor からのみ (運営)。
- `data/site.json` は**廃止**し、クライアントは site_state を読む (真実は1か所)。
  ※ Codex 指摘「静的JSONは真実の二重化になる」への対応。

## データモデルの変更

### season キー (base_version + raid_key を統合)
- 形式は **既存の `raid_key_format` (`^\d{4}-\d{2}$`) を踏襲し `YYYY-MM`**。
  Codex 指摘の `2026-07b` 形式衝突を回避 (月内複数レイドが本当に必要になったら、その時に
  制約ごと拡張する。今は YYYY-MM で固定)。
- `measurements.base_version` を **`season` に rename** (not null 維持)。`raid_key` 列と
  その index・format 制約は**撤去** (役割は season に統合)。
- `fururi_bases` の PK を `(season, attribute)` に rename。`measurements_compute` の参照も更新。
- **統合の安全条件 (Codex指摘への対応):**
  - **baseline はシーズン開始後は不変**というルールを運用に明記。
    `fururi_bases` の `ON CONFLICT DO UPDATE` で開催中に baseline を書き換えると、保存済み
    `score` と後続 RPC 出力が食い違う。→ 開催中の同一 season への baseline 上書きは禁止
    (訂正が必要なら between に戻してから)。
  - season 文字列が有効でも「表示ボスが送信 season と一致する」保証はDBにない。
    → active_season ガードで「今開いている season 以外は書けない」ことを担保し、実質1:1を強制。

### RPC のシーズン絞り込み
- `get_distribution` / `get_comp_insights` の引数を **`p_season` に統一** (旧 `p_base_version` /
  `p_raid_key` は撤去)。baseline 換算にも measurements 絞りにも同じ `p_season` を使う。
- measurements 集計に **`season = p_season` フィルタを追加**。
  → 削除運用で母集団は基本1シーズンだが、フィルタも入れて defense-in-depth。
- **旧シグネチャは明示的に DROP** (Codex指摘: 引数変更は新オーバーロードを生む。
  04 で両RPCを再定義しているので、変更は 04 に集約し旧関数を drop してから作る)。

### 120日窓の扱い
- **canonical なシーズン結果から 120日窓を撤去** (`p_days` を廃止)。
  Codex 指摘: 窓が残ると過去シーズン結果が時間で n=0 に減衰する。削除運用でも、between 中の
  表示が時間経過で欠けるのを防ぐため撤去する。`created_at` は監査用に列としては残す。

### しきい値 (per-season・shared.js と SQL を同期)
- 分布 (属性別) = **50** / 同一編成の分布 = **15** / 編成データ全体 = **10**
- **珍しい編成の開示下限 = 5** (新規): 採用数 5人未満の編成は best/median の個別数値を出さず
  「n人が使用」だけ表示。Codex指摘「n=1編成が正確なスコアを晒す」への対応。
- `shared.js` の THRESHOLDS と SQL 関数内定数を一致させる (実ゲートはサーバーが `need` で駆動)。

### インデックス (Codex指摘)
- season-first の index を張る (例 `(season, attribute)`)。旧 `(base_version, attribute)` /
  `(raid_key, attribute)` は不要になるので整理。

## ボスの表示順・名前 (raid.json 刷新)
- `order`: 5属性の表示順を追加 → ユニオンレイドのボスパネル順に一致。
  `app.js` の固定 `ATTRS` / `stats.js` の属性順を raid.order から描画。
- `bosses`: 実ボス名に修正。**属性マッピングをユーザーに確認してから**確定
  (ドリアン/ドクター/アルトアイゼン/リビルドオベリスク/クラーケン の各属性)。
- season キーも統合形に。

## クライアントの変更
- 起動時に **site_state を読み**、status で全体を出し分け:
  - open: 通常。送信は active_season。分布/集計は active_season。
  - between: 送信UIを隠し「次シーズン準備中」。stats/結果は display_season を read-only。
  - maintenance: 全体「工事中です」。
- `submitSet` / `fetchDistribution` / `fetchCompInsights` は **単一の season** を渡す
  (base.version と raid.raidKey の独立送信をやめる)。
- 前回結果 (localStorage) は **season で無効化** (season が変わったら前回バナーを出さない)。
- ゲート表示は「今シーズン あと◯人で解禁」に (need はサーバー由来)。

## Codex 指摘のうち本設計で"採らない/不要"としたもの
- **過去シーズンの凍結保存 (永続化)** → 削除運用にしたので不要。
- **リテンション方針の精緻化** → 「次シーズンで全削除」で確定。長期保存しない。
- missing baseline は「silent な整合性破壊」ではない (トリガが弾く) — v1の過剰表現を撤回済み。

## 実装スコープ (Opus)
1. **SQL (04 に集約 + 新規)**:
   - `measurements`: base_version→season rename・raid_key 撤去・season format 制約・season-first index
   - `fururi_bases`: PK rename・`measurements_compute` 更新
   - 旧 `get_distribution`/`get_comp_insights` を DROP → `p_season` 版を再定義
     (season フィルタ・120日窓撤去・閾値50/15/10・編成開示下限5・gated の need 返却)
   - `site_state` テーブル + anon SELECT ポリシー
   - `submit_measurements` に active-season ガード
2. **data**: `site.json` 廃止 (site_state に移行)・`raid.json` に order 追加/ボス確定
3. **クライアント**: site_state 出し分け・単一 season・順序・しきい値同期・前回結果の season 無効化
4. **README**: シーズン切替ランブック (削除→基準投入→open) を記載
5. **tests / e2e**: season 絞りの回帰・閾値リセット・between/maintenance 表示・
   閉じた季節への送信拒否・編成開示下限。

## 実装前にユーザーへ最終確認が要る点
- ボス5体の属性マッピング (raid.json 確定に必要)。
- 切替オペレーションを「毎回 SQL Editor で手作業」で回すか (当面それでよいはず)。
