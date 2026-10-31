#!/usr/bin/env node
// しりすこ基準 (= しりすこ値の 1.00) を本家PADの月次JSONから作って data/base.json に書く。
// レイド後 (本家に data/<シーズン>.json が入ってから) に実行 → テスト → commit & push で、
// 測定画面・統計に「しりすこ値」が出る (それまでは中央値比 % だけ)。DB は触らない。
//
//   使い方: node scripts/shirisuko-base.mjs [shirisu-padのパス]           # 確かめるだけ (何も書かない)
//           node scripts/shirisuko-base.mjs [shirisu-padのパス] --apply   # base.json に書く
//   (パス省略時 ../しりすこPAD。本家は読むだけ)
//
// 計算: ボス (= GB の属性) ごとに、メンバーそれぞれの「締め凸を除いたベスト凸」を SLv 補正し、
//   その真ん中 (中央値) をとる。サーバーの score と同じ単位 (SLv baseSlv 換算の B) で持つので
//   しりすこ値 = score ÷ ref。単位は変えないので、先に送った人の結果にもあとから しりすこ値 が付く。
//   メンバーが MIN_MEMBERS 人未満のボスは基準を作らない (その属性は中央値比だけ)。
// ⚠ SLv補正テーブル (slv-ratio) は本家の手元ファイルから読むだけ。base.json に書くのは
//   ボスごとの中央値 1 つと人数だけ (表そのもの・個人の値は出さない)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_MEMBERS = 5;

const args = process.argv.slice(2);
let padDirArg = null, apply = false;
for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a.startsWith('--')) { console.error(`不明なオプション: ${a}`); process.exit(1); }
    else if (padDirArg === null) padDirArg = a;
}
const padDir = padDirArg ?? join(ROOT, '..', 'しりすこPAD');

const basePath = join(ROOT, 'data', 'base.json');
const base = JSON.parse(readFileSync(basePath, 'utf8'));
const season = base.version;
if (base.unit !== 'slv-b') {
    console.error(`base.json の単位が slv-b ではありません (${base.unit ?? '旧形式 = ふるり基準'}) — 先に new-season.mjs で今シーズンを作ってください`);
    process.exit(1);
}
const monthPath = join(padDir, 'data', `${season}.json`);
if (!existsSync(monthPath)) {
    console.error(`本家の月次JSONがまだありません: ${monthPath}\n(全員の凸が終わって本家に取り込まれてから実行してください)`);
    process.exit(1);
}
const ratio = JSON.parse(readFileSync(join(padDir, 'data', 'slv-ratio.json'), 'utf8')).data;
const ratioOf = (slv) => {
    const r = Number(ratio[String(slv)]);
    return Number.isInteger(slv) && r > 0 ? r : null;
};
const baseRatio = ratioOf(base.baseSlv);
if (!baseRatio) { console.error(`SLv補正テーブルに基準SLv ${base.baseSlv} がありません`); process.exit(1); }

const month = JSON.parse(readFileSync(monthPath, 'utf8'));
const players = Array.isArray(month.players) ? month.players : [];
if (!players.length) { console.error('月次JSONにメンバーがいません'); process.exit(1); }

const median = (xs) => {
    const a = [...xs].sort((x, y) => x - y);
    const n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
};

// ボスコード → (メンバー名 → SLv補正後のベスト)
const bestByBoss = new Map();
const noSlv = [];
for (const p of players) {
    const r = ratioOf(Number(p.syncLevel));
    if (!r) { noSlv.push(String(p.player)); continue; }
    for (const a of Array.isArray(p.attacks) ? p.attacks : []) {
        const d = Number(a.damage);
        if (!a.bossCode || !(d > 0)) continue;
        if (a.isKill) continue;                                   // 締め凸 = ボスを倒した凸は削りの値なので除く
        if (a.difficulty && a.difficulty !== 'HARD') continue;    // ハード以外は混ぜない
        const norm = d / r;
        const m = bestByBoss.get(a.bossCode) ?? new Map();
        m.set(p.player, Math.max(m.get(p.player) ?? 0, norm));
        bestByBoss.set(a.bossCode, m);
    }
}
if (noSlv.length) console.warn(`⚠ SLv が分からない (または補正テーブル外の) メンバーは数えていません: ${noSlv.join(', ')}`);

const attrs = {};
const lines = [];
for (const [attr, b] of Object.entries(base.bases)) {
    const m = bestByBoss.get(b.bossCode);
    const n = m?.size ?? 0;
    if (n < MIN_MEMBERS) { lines.push(`  ${attr.padEnd(8)} ${b.bossCode.padEnd(9)} ${n}人 — ${MIN_MEMBERS}人未満なので基準なし`); continue; }
    const ref = median(m.values()) * baseRatio / Number(b.damage);
    attrs[attr] = { ref: +ref.toFixed(4), n };
    lines.push(`  ${attr.padEnd(8)} ${b.bossCode.padEnd(9)} ${String(n).padStart(2)}人  真ん中 = ${ref.toFixed(2)}B (SLv ${base.baseSlv} 換算)`);
}
const unknownBoss = [...bestByBoss.keys()].filter(code => !Object.values(base.bases).some(b => b.bossCode === code));
if (unknownBoss.length) console.warn(`⚠ 今シーズンのボスに無いボスコードの凸があります (数えていません): ${unknownBoss.join(', ')}`);

console.log(`しりすこ基準 (${season} / 月次JSON ${players.length}人):`);
console.log(lines.join('\n'));
if (!Object.keys(attrs).length) { console.error('基準を作れる属性がありません'); process.exit(1); }

const shirisuko = {
    source: `しりすこPAD data/${season}.json (締め凸を除く各メンバーのベスト凸の中央値)`,
    builtAt: new Date().toLocaleDateString('sv-SE'),   // 手元の日付 (YYYY-MM-DD)。toISOString は UTC なので日本の朝は前日になる
    minMembers: MIN_MEMBERS,
    attrs,
};
if (base.shirisuko?.attrs) {
    const diff = Object.keys({ ...base.shirisuko.attrs, ...attrs })
        .filter(a => base.shirisuko.attrs[a]?.ref !== attrs[a]?.ref)
        .map(a => `${a}: ${base.shirisuko.attrs[a]?.ref ?? 'なし'} → ${attrs[a]?.ref ?? 'なし'}`);
    console.log(diff.length ? `前回からの変化: ${diff.join(' / ')}` : '前回と同じです');
}
if (!apply) {
    console.log('(確かめただけ。書き込むときは --apply)');
    process.exit(0);
}
writeFileSync(basePath, JSON.stringify({ ...base, shirisuko }, null, 2) + '\n', 'utf8');
console.log('→ data/base.json に書きました。node tests/run-tests.mjs → commit & push で画面に出ます');
