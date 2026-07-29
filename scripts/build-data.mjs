#!/usr/bin/env node
// shirisu-pad の月次JSON群から presets.json (属性別キャラ使用率 + TOP編成) を生成する。
//
// v2 (2026-07): ゲーム画像を扱わなくなったため画像コピーは廃止。
// 月次JSONに残っている旧アイコンIDは data/characters.json の aliases で代表IDに正規化してから
// 集計する (アイコン違いが別キャラ扱いで票割れしない)。
// ※ 実行順: build-characters.mjs → このスクリプト (update-roster.mjs が面倒を見る)
//
// 使い方:  node scripts/build-data.mjs ../shirisu-pad

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const padDir = process.argv[2];
if (!padDir || !existsSync(join(padDir, 'data'))) {
    console.error('使い方: node scripts/build-data.mjs <shirisu-padのパス>');
    process.exit(1);
}

// bossCode → PT属性 (shirisu-pad index.html の BOSS_ATTRIBUTES と同じ対応)
const BOSS_TO_ATTR = {
    'A.N.M.I.': 'FIRE',
    'H.S.T.A.': 'WATER',
    'P.S.I.D.': 'ELECTRIC',
    'Z.E.U.S.': 'IRON',
    'D.M.T.R.': 'WIND',
};
const ATTRS = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];

const charData = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));
if (charData._format !== 2) {
    console.error('characters.json が v2 形式ではありません。先に build-characters.mjs を実行してください');
    process.exit(1);
}
// 任意のID (代表/別名) → 代表ID。未知のIDは null (集計から除外)
function canonId(img) {
    if (charData.chars[img]) return img;
    return charData.aliases[img] ?? null;
}

// "./character-images/<hash>.webp" → "<hash>.webp"
function imgName(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/character-images\/([\w-]+\.webp)$/);
    return m ? m[1] : null;
}

const monthFiles = readdirSync(join(padDir, 'data'))
    .filter(f => /^20\d{2}-\d{2}\.json$/.test(f))
    .sort();

const charCount = {};   // {attr: Map<id, count>}
const compCount = {};   // {attr: Map<sortedKey, {chars, count, lastMonth}>}
ATTRS.forEach(a => { charCount[a] = new Map(); compCount[a] = new Map(); });
let unknownIds = 0;

for (const file of monthFiles) {
    const json = JSON.parse(readFileSync(join(padDir, 'data', file), 'utf8'));
    for (const p of json.players || []) {
        for (const a of p.attacks || []) {
            const attr = BOSS_TO_ATTR[a.bossCode];
            if (!attr) continue;
            const chars = (a.characters || []).map(imgName).map(img => {
                if (!img) return null;
                const id = canonId(img);
                if (!id) unknownIds++;
                return id;
            }).filter(Boolean);
            chars.forEach(c => charCount[attr].set(c, (charCount[attr].get(c) || 0) + 1));
            if (chars.length === 5 && new Set(chars).size === 5) {
                const key = [...chars].sort().join('|');
                const cur = compCount[attr].get(key);
                if (cur) { cur.count++; cur.lastMonth = file.replace('.json', ''); }
                else compCount[attr].set(key, { chars, count: 1, lastMonth: file.replace('.json', '') });
            }
        }
    }
}

const presets = { generatedFrom: monthFiles.map(f => f.replace('.json', '')), attributes: {} };
for (const attr of ATTRS) {
    const topChars = [...charCount[attr].entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([img, count]) => ({ img, count }));
    const topComps = [...compCount[attr].values()]
        .sort((a, b) => b.count - a.count || (a.lastMonth < b.lastMonth ? 1 : -1))
        .slice(0, 3)
        .map(({ chars, count, lastMonth }) => ({ chars, count, lastMonth }));
    presets.attributes[attr] = { topChars, topComps };
}

writeFileSync(join(ROOT, 'data', 'presets.json'), JSON.stringify(presets, null, 1), 'utf8');
console.log(`presets.json: ${ATTRS.map(a => `${a}=${presets.attributes[a].topChars.length}体`).join(' ')}`);
if (unknownIds > 0) {
    console.warn(`⚠ characters.json に無いアイコンID参照 ${unknownIds}件 (集計から除外。本家DBのキャラ登録漏れの可能性)`);
}
