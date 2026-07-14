#!/usr/bin/env node
// shirisu-pad の月次JSON群から presets.json (属性別キャラ使用率 + TOP編成) を生成し、
// 参照されているキャラ画像を character-images/ へコピーする。
//
// 使い方:  node scripts/build-data.mjs ../shirisu-pad
//   (引数 = shirisu-pad リポジトリのパス。data/20*.json と character-images/ を読む)

import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
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

// "./character-images/<hash>.webp" → "<hash>.webp" (属性アイコン等の混入は除外)
function imgName(url) {
    if (typeof url !== 'string') return null;
    const m = url.match(/character-images\/([\w-]+\.webp)$/);
    return m ? m[1] : null;
}

const monthFiles = readdirSync(join(padDir, 'data'))
    .filter(f => /^20\d{2}-\d{2}\.json$/.test(f))
    .sort();

const charCount = {};   // {attr: Map<img, count>}
const compCount = {};   // {attr: Map<sortedKey, {chars, count, lastMonth}>}
ATTRS.forEach(a => { charCount[a] = new Map(); compCount[a] = new Map(); });
const usedImages = new Set();

for (const file of monthFiles) {
    const json = JSON.parse(readFileSync(join(padDir, 'data', file), 'utf8'));
    for (const p of json.players || []) {
        for (const a of p.attacks || []) {
            const attr = BOSS_TO_ATTR[a.bossCode];
            if (!attr) continue;
            const chars = (a.characters || []).map(imgName).filter(Boolean);
            chars.forEach(c => {
                usedImages.add(c);
                charCount[attr].set(c, (charCount[attr].get(c) || 0) + 1);
            });
            if (chars.length === 5) {
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

// 使用実績のある画像だけコピー
const imgDir = join(ROOT, 'character-images');
mkdirSync(imgDir, { recursive: true });
let copied = 0, missing = 0;
for (const img of usedImages) {
    const src = join(padDir, 'character-images', img);
    if (existsSync(src)) { copyFileSync(src, join(imgDir, img)); copied++; }
    else missing++;
}
console.log(`character-images: ${copied}枚コピー (元リポジトリに無い参照: ${missing})`);
