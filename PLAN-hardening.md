# shirisu-pad-global セキュリティ堅牢化プラン (Phase 1 + 2)

作成: Fable 5 (2026-07-15) / 実装担当: Claude Opus に引き継ぎ

## 背景 (このプランの根拠)

2つの独立レビュー (Fable の全体レビュー + Codex gpt-5.6-sol の検証) を突き合わせた結果、
公開サイトとして SNS 拡散する前に塞ぐべき問題が判明した。**4つのレッド級 (XSS / DoS /
Sybil汚染 / 生データ露出) が、たった2つの根に集約される**:

- **根1**: `measurements.characters` が anon から無検証で書ける (`with check (true)`・CHECKなし)
  → ストアドXSS・不正JSONによる集計RPCのDoS・データ汚染 の共通原因
- **根2**: `anon_select using(true)` で生測定行 (client_id/damage/slv/編成/時刻) が全公開
  → プライバシー露出・ゲート回避・Sybilの温床

両レビュー一致の重要問題に加え、Codex の独自発見3つ (RPC-DoS / 生データ全公開 /
ゲートがクライアント表示のみ) を取り込む。詳細な分類は会話ログ参照。

## 秘匿ルール (厳守 — 既存の最重要制約)

- `slv-ratio` は未公開の検証データ。**リポジトリ・サイト・Supabase公開範囲に置かない**。
  計算はサーバー側 (SECURITY DEFINER 関数) のみ。この作業で計算式をクライアントに戻さないこと
- 実行用SQLシードは `node scripts/gen-02-sql.mjs` が生成する `02_stats.local.sql` (gitignore)。
  `supabase/02_stats.sql` 本体はシード無しテンプレートのまま
- tests/run-tests.mjs の混入ガードを壊さない (slv-ratio がリポジトリに現れたら CI が落ちる)

---

## Phase 1 — SNS拡散前に必須 (レッド級を塞ぐ)

### 1-1. characters を入口で検証 (XSS + DoS + 汚染の根を断つ) 🔴

**サーバー側 (新規 `supabase/04_hardening.sql` に集約)**:
- `measurements.characters` に CHECK 制約を追加:
  - `null` もしくは「**要素数ちょうど5・全要素が `^[0-9a-f]{32}\.webp$` にマッチする text 配列**」のみ許可
  - `jsonb_typeof(characters) = 'array'` かつ 各要素が期待パターン、を満たさない INSERT は拒否
  - 実装は `check ( characters is null or ( jsonb_typeof(characters)='array' and jsonb_array_length(characters)=5 and not exists (select 1 from jsonb_array_elements(characters) e where jsonb_typeof(e)<>'string' or e#>>'{}' !~ '^[0-9a-f]{32}\.webp$') ) )`
  - ※画像ファイル名は 32桁hex + .webp 形式 (character-images/ の実物で確認済み)。
    パターンは実データに合わせて Opus が `ls character-images` で最終確認すること
- **既存の不正行が残っていても集計RPCが落ちない防御** (二重化): `get_comp_insights` の
  `jsonb_array_elements_text(characters)` を、配列以外をスキップする形にガード
  (`where jsonb_typeof(characters)='array'` を rows CTE に追加)。
  → CHECK で入口を塞ぎ、RPC側でも既存汚染に耐える

**クライアント側 (`js/backend.js`)**:
- `submitSet` で送る前に characters をバリデーション (5要素・hex.webp形式)。
  不正なら characters を null にフォールバック (送信自体は通す)

### 1-2. innerHTML のエスケープ (XSS sink を塞ぐ・二重防御) 🔴

- `js/stats.js`: 編成ランキング・キャラ採用率で `characters?.[img]?.name` や `img` を
  `innerHTML` テンプレートに入れている箇所を**全てエスケープ**。
  共有ユーティリティ `escapeHtml(s)` を新設 (下記 3-1 の共有モジュールに置く) して通す
- `js/app.js`: 同様に DB由来でなくても `nameOf(img)` を alt/title/表示に入れている箇所、
  および **1-3 の自己XSS** をまとめて対応
- 方針: 「文字列を DOM に入れるときは textContent かエスケープ」を徹底。
  img の src に使う画像ファイル名も、1-1 でバリデーション済みでも二重にエスケープ

### 1-3. 自己XSS: ダメージ入力の属性再注入 (4-7) 🟡→今回まとめて

- `js/app.js` の `attackCardHTML` で `value="${a.damage}"` と生値を属性に戻している。
  `escapeHtml` を通す (実害は自分の画面のみだが 1-2 と同じ習慣で一括対応)

### 1-4. anon の生データ SELECT を遮断 (露出の根を断つ) 🔴

**`supabase/04_hardening.sql`**:
- `drop policy "anon_select" on public.measurements;` (01_schema.sql の生SELECT許可を撤去)
- 影響確認: 現状クライアントは生SELECTを使っていないはず (fetchDistribution/fetchCompInsights は
  RPC経由)。Opus は `js/backend.js` を grep して `/rest/v1/measurements?...select` の
  直接GETが無いことを確認してから撤去すること。もし残っていれば RPC 化してから
- RPC は SECURITY DEFINER なので anon_select 撤去後も分布・集計は動く (要E2E確認)

**注意**: `submitSet` は `?select=score` で **INSERT の返り値**として score を受け取っている。
これは INSERT 由来の returning であって SELECT ポリシーではない (`Prefer: return=representation`)。
anon_select 撤去後も動くはずだが、**Supabaseは返却に select 権限を要求する場合がある**ため、
Opus は必ず本番で「送信して score が返ること」を実測すること。もし 401/403 になるなら、
score だけを返す SECURITY DEFINER の INSERT用RPC (`submit_measurement`) に切り替える
(この分岐は実測してから判断)。

---

## Phase 2 — バズ後の完全性を守る

### 2-1. ゲートと集計をサーバー側で強制 (4-2 / B-3 / A-3) 🟠

**`supabase/04_hardening.sql` の RPC を改修**:
- `get_distribution` / `get_comp_insights` に **しきい値をサーバー側で持たせる**。
  `n` が閾値未満なら **分布本体 (bins/median/lo/hi/上位%材料) を返さず `{n, gated:true}` だけ返す**。
  → クライアントの MIN_N_* は「表示制御」から「サーバーが出さないから出せない」へ格上げ。
  閾値は RPC 引数ではなく関数内定数 (属性別=100 / 編成=30 / 採用率=10) にして改ざん不可に
- `js/app.js` / `js/stats.js`: `gated` を受けたらゲート表示 (現行のゲートUIを流用)。
  MIN_N_* 定数は表示メッセージ用に残すが、判定はサーバーの `gated` を正とする

### 2-2. Sybil を弱める: client_id のサーバー付与 (4-2 / Codex補強) 🟠

- **client_id はクライアント申告を廃し、可能な範囲でサーバー導出にする**。完全防御は
  Edge Function/IP が必要で今回は過剰なので、現実解として:
  - `measurements.client_id` を **not null 化 + クライアント送信を維持しつつ**、
    集計の1票キーを「client_id 単独」ではなく複数シグナルの組にする案は複雑なので Phase 2 では見送り
  - 今回の実効対策: **`client_id` を null 送信できないようにする** (04で `alter column set not null`、
    かつ RPC の `coalesce(client_id::text, id::text)` の `id` フォールバックを撤去 →
    Codex 指摘「client_id 省略で毎行別票」を塞ぐ)。
  - レート制限 (同一 client_id/属性の短時間多重INSERT抑制) は簡易トリガで:
    同一 client_id × attribute × base_version は **UPSERT的に最新1件へ集約**する案を検討
    (=1端末1票をDBレベルで物理的に保証)。ただし3凸セットや再測定の扱いに影響するため、
    **Opus は現行の集計 (max/median) と矛盾しないか確認し、リスクが高ければ「同一キーの
    INSERTを1日1回に制限するトリガ」に留める**。判断は実装時に。
- ※ここは設計の分岐がある。Opus は 2-1 を先に確実に入れ、2-2 は「client_id NOT NULL 化 +
  id フォールバック撤去」までを確実実装し、レート制限は影響を見て段階投入してよい

### 2-3. RPC 引数のクランプ + raid_key 検証 (4-6) 🟠

- `get_distribution` / `get_comp_insights` の可変引数を関数内で clamp:
  `p_bins` → 5..50、`p_days` → 1..400、`p_top_chars` → 1..60、`p_top_comps` → 1..20
  (`least/greatest` で丸める)
- `raid_key` は自由文字列のまま集計フィルタに使われる。**既知のraid_keyのみ許可**する簡易策:
  `raid_key ~ '^[0-9]{4}-[0-9]{2}$'` の形式CHECKを measurements に追加 (04)。
  ゴミ値でのレイド別集計汚染を防ぐ

---

## Phase 3 は今回スコープ外 (保守性) — メモのみ

ATTR_INFO/しきい値/属性色の共有モジュール化 (3-1で escapeHtml と一緒に最小限だけ着手)、
マイグレーション番号とクライアントの version 照合、常設E2E。これらは別タスク。
ただし **3-1 の共有モジュール (js/shared.js) は escapeHtml を置く受け皿として今回新設**し、
ATTR_INFO 等の完全統合は将来に回す (今回は escapeHtml + 必要な定数のみ)。

---

## 実装順序 (依存関係)

1. `supabase/04_hardening.sql` を新規作成 (1-1 CHECK / 1-4 policy drop / 2-1 ゲート /
   2-2 client_id / 2-3 clamp+raid_key)。**冪等に書く** (drop policy if exists、
   add column if not exists、CHECK は制約名を付けて存在チェック)
2. `js/shared.js` 新設 (escapeHtml)。stats.js/app.js から import
3. `js/backend.js`: characters バリデーション (1-1) / gated 対応 (2-1) /
   生SELECT不使用の確認 (1-4)
4. `js/stats.js` / `js/app.js`: エスケープ (1-2/1-3) / gated 表示 (2-1)
5. tests/run-tests.mjs: escapeHtml の単体テスト + characters バリデーションのテスト追加
6. README: 04_hardening.sql をセットアップ手順に追加、脅威モデルと対策を明記

## 検証 (必須・この順で)

- `node tests/run-tests.mjs` 全パス (秘匿ガード含む)
- `node --check` 全JS
- **ユーザーに `04_hardening.sql` を SQL Editor で実行してもらう** (Phase1+2 の要)
- 本番REST/RPCで実測 (Opus が PowerShell で):
  - 正常な characters (5×hex.webp) INSERT → 成功・score返却
  - 不正 characters (`["<img onerror=...>"]` / スカラー / 4要素) INSERT → **CHECK で拒否**
  - 生SELECT `GET /measurements?select=*` → **401/403 (anon_select撤去の確認)**
  - `get_distribution` を n<100 の属性で呼ぶ → **gated:true で bins が返らない**
  - client_id 省略 INSERT → 拒否 (not null)
  - RPC に `p_bins=99999` → クランプされて 50 本以内
- headless Chrome E2E (iframe 375px 埋め込み方式・500px最小幅の罠に注意):
  送信→score→分布ゲート表示、stats.html の3セクション、XSSペイロードが無害化されること
- デプロイ後、本番URLで目視

## リスク・判断が要る分岐 (Opus へ申し送り)

- **1-4 の anon_select 撤去で submitSet の score 返却が 401 になる可能性**。実測して、
  なるなら INSERT用 SECURITY DEFINER RPC に切替 (プラン 1-4 参照)
- **2-2 のレート制限/UPSERT集約は集計仕様と衝突しうる**。client_id NOT NULL化 +
  id フォールバック撤去までは確実に。物理的1票保証は影響を見て段階投入
- CHECK の hex パターンは character-images の実ファイル名で最終確認 (32桁hexと仮定)
