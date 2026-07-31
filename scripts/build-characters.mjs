#!/usr/bin/env node
// PAD の Supabase nikke_characters (名前・バースト・サブバースト・旧アイコンID) と
// data/element-map.json (名前 → 属性) を突き合わせて data/characters.json を生成する。
//
// v2 (2026-07): サイトからゲーム画像を全廃したため、キャラは「ID + 名前 + バースト + 属性」の
// データだけを持ち、画面は js/tiles.js が自作タイルとして描画する。
//   - ID は 32桁hex + .webp 形式を維持 (サーバーの characters CHECK 制約と互換):
//       画像があった時代のキャラ → 旧アイコンファイル名の md5 を継承 (過去シーズンの編成と連続)
//       画像が無かったキャラ     → md5(canonical_name) の合成ID
//   - 同一キャラの旧アイコン違いは aliases (別ID → 代表ID) として全部残す
//     (過去に送信された編成・localStorage の前回結果を名前解決できるように)
//
// 使い方:  node scripts/build-characters.mjs ../shirisu-pad
//   (引数 = shirisu-pad リポジトリのパス。js/supabase-client.js から PAD の接続情報を読む)
//
// 月次メンテ:
//   「⚠ 属性未分類」  → game8 の属性別キャラ一覧で調べて data/element-map.json に追記
//   「⚠ バースト未分類」→ 本家PADの設定タブ → キャラ管理で登録 (こちらが唯一の正)

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const padDir = process.argv[2];
if (!padDir || !existsSync(join(padDir, 'js', 'supabase-client.js'))) {
    console.error('使い方: node scripts/build-characters.mjs <shirisu-padのパス>');
    process.exit(1);
}

// PAD の接続情報 (publishable key は公開前提のキー)
const clientSrc = readFileSync(join(padDir, 'js', 'supabase-client.js'), 'utf8');
const url = clientSrc.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = clientSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) {
    console.error('supabase-client.js から URL / key を読み取れませんでした');
    process.exit(1);
}

// コロン等の表記ゆれを吸収して照合する
const norm = (s) => String(s).replace(/：/g, ':').replace(/\s+/g, '').trim();
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

// 属性表 (名前 → FIRE/WATER/ELECTRIC/IRON/WIND)
const elementMap = JSON.parse(readFileSync(join(ROOT, 'data', 'element-map.json'), 'utf8'));
const elementOfName = new Map();
for (const el of ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND']) {
    for (const name of elementMap[el] || []) elementOfName.set(norm(name), el);
}

// 非常用バーストのフォールバック (本家DBが未設定のときだけ使う)
const burstMap = JSON.parse(readFileSync(join(ROOT, 'data', 'burst-map.json'), 'utf8'));
const fallbackBurst = new Map();
for (const b of ['B1', 'B2', 'B3', 'BΛ']) {
    for (const name of burstMap[b] || []) fallbackBurst.set(norm(name), b);
}

const res = await fetch(
    `${url}/rest/v1/nikke_characters?select=canonical_name,burst,burst_alt,icon_paths,is_confirmed,sighting_count&order=canonical_name.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!res.ok) {
    console.error(`nikke_characters の取得に失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
}
const rows = await res.json();

const characters = {};          // 代表ID → {name, burst, burstAlt, element, hasImg}
const aliases = {};             // 旧アイコンID → 代表ID
const iconCandidates = new Map();   // 代表ID → PADにあるかもしれないアイコンファイル名の候補列
const noElement = [];
const noBurst = [];
const seenName = new Map();     // norm(name) → 代表ID (名前重複の検出)

for (const row of rows) {
    const name = row.canonical_name;
    // OCRゴースト除外: 未確認 + 観測1回以下 + バースト/アイコン情報ゼロ の行は
    // スクショ誤読の自動登録である可能性が高い (例: 2026-07-31 の「テラ:クリリ」)。
    // 本家キャラ管理で確認済みにするか情報が付けば次のビルドから取り込まれる
    if (!row.is_confirmed && (row.sighting_count ?? 0) <= 1 && !row.burst && !(row.icon_paths?.length)) {
        console.warn(`⚠ OCRゴースト疑いでスキップ: ${name} (未確認・観測${row.sighting_count ?? 0}回) — 実在キャラなら本家キャラ管理で確認済みに`);
        continue;
    }
    const icons = (row.icon_paths || [])
        .map(p => String(p).match(/character-images\/([0-9a-f]{32}\.webp)$/)?.[1])
        .filter(Boolean)
        .sort();
    const id = icons[0] ?? `${md5(name)}.webp`;
    if (seenName.has(norm(name))) {
        console.warn(`⚠ 名前重複 (本家DBの整理推奨): ${name} — 後勝ちで上書きせずスキップ`);
        continue;
    }
    seenName.set(norm(name), id);
    const burst = row.burst ?? fallbackBurst.get(norm(name)) ?? null;
    const element = elementOfName.get(norm(name)) ?? null;
    characters[id] = { name, burst, burstAlt: row.burst_alt ?? null, element };
    iconCandidates.set(id, icons);   // 画像コピー候補 (代表→変種の順)
    for (const icon of icons.slice(1)) aliases[icon] = id;
    if (!element) noElement.push(name);
    if (!burst) noBurst.push(name);
}

// 手動オーバーライド (本家DBに紐付かない旧画像ID → 名前)。既知キャラの別IDなら alias に。
const overridePath = join(ROOT, 'data', 'name-overrides.json');
if (existsSync(overridePath)) {
    const overrides = JSON.parse(readFileSync(overridePath, 'utf8'));
    for (const [img, name] of Object.entries(overrides)) {
        if (img.startsWith('_') || !name || characters[img] || aliases[img]) continue;
        const canonId = seenName.get(norm(name));
        if (canonId) {
            aliases[img] = canonId;
            iconCandidates.get(canonId)?.push(img);   // 手動紐付けの旧画像もコピー候補に
        }
        else console.warn(`⚠ name-overrides の「${name}」は本家DBに存在しません (削除推奨)`);
    }
}

// ---- キャラ画像のコピー (掲載方針 2026-07-31: 公式へ許諾照会済み・削除対応前提で掲載) ----
// 優先順: ① BlablaLINK 図鑑アイコン (assets/blabla-icons/<resource_id>.webp × data/blabla-map.json —
//          透過128px統一・全所持キャラ分) → ② 本家PADのOCR由来アイコン (フォールバック)。
// GB側は常に <代表ID>.webp の名前で持つ。画像が無いキャラは hasImg なし → 自作タイル表示。
// 掲載を取りやめる場合は tiles.js の USE_CHAR_IMAGES を false に (画像削除はこのディレクトリごと)。
const imgDir = join(ROOT, 'character-images');
mkdirSync(imgDir, { recursive: true });
// blabla-map: resource_id → 日本語名 (str | 配列) を norm名→ridファイル に反転
const blablaByName = new Map();
const blablaPath = join(ROOT, 'data', 'blabla-map.json');
if (existsSync(blablaPath)) {
    const bm = JSON.parse(readFileSync(blablaPath, 'utf8'));
    for (const [rid, e] of Object.entries(bm.icons ?? {})) {
        const f = join(ROOT, 'assets', 'blabla-icons', `${rid}.webp`);
        if (!existsSync(f)) { console.warn(`⚠ blabla-map の rid=${rid} (${e.en}) の画像がありません`); continue; }
        for (const jp of (Array.isArray(e.jp) ? e.jp : [e.jp])) blablaByName.set(norm(jp), f);
    }
}
let copied = 0, fromBlabla = 0;
for (const [id, cands] of iconCandidates) {
    const bl = blablaByName.get(norm(characters[id].name));
    if (bl) {
        copyFileSync(bl, join(imgDir, id));
        characters[id].hasImg = true;
        copied++; fromBlabla++;
        continue;
    }
    const src = cands.find(f => existsSync(join(padDir, 'character-images', f)));
    if (src) {
        copyFileSync(join(padDir, 'character-images', src), join(imgDir, id));
        characters[id].hasImg = true;
        copied++;
    }
}
// 参照されなくなった旧ファイルを掃除 (キャラ削除・代表ID変更への追従)。
// ただし今回1枚もコピーできていない場合は異常 (API空応答・本家画像ディレクトリ欠け) なので
// 掃除しない — 破壊的な全削除を防ぐ (掲載中の画像を巻き込まない安全弁)
let removed = 0;
if (copied === 0) {
    console.warn('⚠ 画像を1枚もコピーできませんでした → 掃除をスキップ (本家 character-images/ とAPI応答を確認)');
} else {
    for (const f of readdirSync(imgDir)) {
        if (f.endsWith('.webp') && !characters[f]?.hasImg) { unlinkSync(join(imgDir, f)); removed++; }
    }
}
console.log(`character-images: ${copied}キャラ分コピー (BlablaLINK図鑑: ${fromBlabla} / 本家OCR: ${copied - fromBlabla} / 画像なし=タイル表示: ${Object.keys(characters).length - copied}) 掃除: ${removed}件`);

writeFileSync(join(ROOT, 'data', 'characters.json'), JSON.stringify({
    _format: 2,
    _readme: 'build-characters.mjs の生成物。chars: 代表ID→キャラ情報 (hasImg=character-images/に画像あり) / aliases: 旧アイコンID→代表ID',
    chars: characters,
    aliases,
}, null, 1), 'utf8');

const stats = { B1: 0, B2: 0, B3: 0, 'BΛ': 0, null: 0 };
Object.values(characters).forEach(c => stats[c.burst ?? 'null']++);
console.log(`characters.json: ${Object.keys(characters).length}キャラ ` +
    `(B1=${stats.B1} B2=${stats.B2} B3=${stats.B3} Λ=${stats['BΛ']} バースト未分類=${stats.null}) ` +
    `別名ID=${Object.keys(aliases).length}件`);
for (const name of noBurst) {
    console.warn(`⚠ バースト未分類: ${name} — 本家PADのキャラ管理で登録してください`);
}
for (const name of noElement) {
    console.warn(`⚠ 属性未分類: ${name} — data/element-map.json に追記してください (グレー表示になります)`);
}
