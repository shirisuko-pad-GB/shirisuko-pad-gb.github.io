#!/usr/bin/env node
// PAD の Supabase nikke_characters (画像 → キャラ名) + data/name-overrides.json (手動の画像 → 名前)
// と data/burst-map.json (名前 → バースト) を突き合わせて
// data/characters.json (画像 → {name, burst}) を生成する。
//
// 使い方:  node scripts/build-characters.mjs ../shirisu-pad
//   (引数 = shirisu-pad リポジトリのパス。js/supabase-client.js から PAD の接続情報を読む)
//
// 月次メンテ:
//   「⚠ バースト未分類」 → data/burst-map.json に追記 (出典: game8)
//   「⚠ 名前なし画像」   → tools/annotate.html で名前を付けて data/name-overrides.json に貼る

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// コロンの全角/半角ゆれを吸収して照合する
const norm = (s) => s.replace(/：/g, ':').trim();

const burstMap = JSON.parse(readFileSync(join(ROOT, 'data', 'burst-map.json'), 'utf8'));
const burstOfName = new Map();
for (const burst of ['B1', 'B2', 'B3', 'BΛ']) {
    for (const name of burstMap[burst] || []) burstOfName.set(norm(name), burst);
}

const res = await fetch(
    `${url}/rest/v1/nikke_characters?select=canonical_name,icon_paths,sighting_count&order=sighting_count.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } });
if (!res.ok) {
    console.error(`nikke_characters の取得に失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
}
const rows = await res.json();

// sighting_count 昇順で処理 → 同じ画像を複数名が持つ場合は観測数の多い名前が勝つ
const characters = {};
const unmapped = new Set();
for (const row of rows) {
    const burst = burstOfName.get(norm(row.canonical_name)) ?? null;
    const icons = (row.icon_paths || [])
        .map(p => p.match(/character-images\/([\w-]+\.webp)$/)?.[1])
        .filter(Boolean);
    if (!burst && icons.length > 0 && row.sighting_count > 0) unmapped.add(row.canonical_name);
    for (const img of icons) characters[img] = { name: row.canonical_name, burst };
}

// 手動オーバーライド (PAD に名前がない画像) — PAD 由来より優先
const overridePath = join(ROOT, 'data', 'name-overrides.json');
if (existsSync(overridePath)) {
    const overrides = JSON.parse(readFileSync(overridePath, 'utf8'));
    for (const [img, name] of Object.entries(overrides)) {
        if (img.startsWith('_') || !name) continue;
        const burst = burstOfName.get(norm(name)) ?? null;
        characters[img] = { name, burst };
        if (!burst) unmapped.add(name);
    }
}

writeFileSync(join(ROOT, 'data', 'characters.json'), JSON.stringify(characters, null, 1), 'utf8');

const stats = { B1: 0, B2: 0, B3: 0, 'BΛ': 0, null: 0 };
Object.values(characters).forEach(c => stats[c.burst ?? 'null']++);
console.log(`characters.json: 画像${Object.keys(characters).length}件 ` +
    `(B1=${stats.B1} B2=${stats.B2} B3=${stats.B3} Λ=${stats['BΛ']} 未分類=${stats.null})`);
for (const name of unmapped) {
    console.warn(`⚠ バースト未分類: ${name} — data/burst-map.json に追記してください`);
}

// 同梱している画像のうち名前が付いていないもの → 注釈ツールへ誘導
const nameless = readdirSync(join(ROOT, 'character-images'))
    .filter(f => f.endsWith('.webp') && !characters[f]);
if (nameless.length > 0) {
    console.warn(`⚠ 名前なし画像 ${nameless.length}件 — tools/annotate.html で名前を付けて data/name-overrides.json に貼ってください`);
}
const unverified = burstMap._unverified || [];
if (unverified.length > 0) {
    console.warn(`ℹ 推定のまま未確認: ${unverified.join(', ')} (game8で確認したら burst-map.json の _unverified から除去)`);
}

// 注釈ツール (tools/annotate.html) 用の作業キュー
const unverifiedSet = new Set(unverified.map(norm));
const review = Object.entries(characters)
    .filter(([, c]) => unverifiedSet.has(norm(c.name)))
    .map(([img, c]) => ({ img, name: c.name, burst: c.burst }));
writeFileSync(join(ROOT, 'data', 'annotate-queue.json'), JSON.stringify({
    generatedNote: 'build-characters.mjs の生成物。nameless=名前なし画像 / review=推定未確認',
    nameless,
    review,
    knownNames: [...new Set(Object.values(characters).map(c => c.name))].sort(),
}, null, 1), 'utf8');
