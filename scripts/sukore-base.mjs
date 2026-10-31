#!/usr/bin/env node
// すこれ基準 (= すこれ値の 1.00) を本家PADの月次JSONから作って data/base.json に書く。
// レイド後 (本家に data/<シーズン>.json が入ってから) に実行 → テスト → commit & push で、
// 測定画面・統計に「すこれ値」が出る (それまでは中央値比 % だけ)。DB は触らない。
//
//   使い方: node scripts/sukore-base.mjs [shirisu-padのパス]           # 確かめるだけ (何も書かない)
//           node scripts/sukore-base.mjs [shirisu-padのパス] --apply   # base.json に書く
//           ... --skip-no-slv   # SLv が無い・補正表の範囲外のメンバーを、名前を出したうえで数えずに進める
//                               # (既定は止まる。本家の月次JSONは GB から直さないので、除外は明示したときだけ)
//   (パス省略時 ../しりすこPAD。本家は読むだけ)
//
// 計算: ボス (= GB の属性) ごとに、メンバーそれぞれの「締め凸を除いたベスト凸」を SLv 補正し、
//   その真ん中 (中央値) をとる。サーバーの score と同じ単位 (SLv baseSlv 換算の B) で持つので
//   すこれ値 = score ÷ ref。単位は変えないので、先に送った人の結果にもあとから すこれ値 が付く。
//   メンバーが MIN_MEMBERS 人未満のボスは基準を作らない (その属性は中央値比だけ)。
// ⚠ SLv補正テーブル (slv-ratio) は本家の手元ファイルから読むだけ。base.json に書くのは
//   ボスごとの中央値 1 つと人数だけ (表そのもの・個人の値は出さない)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_MEMBERS = 5;

const args = process.argv.slice(2);
let padDirArg = null, apply = false, skipNoSlv = false;
for (const a of args) {
    if (a === '--apply') apply = true;
    else if (a === '--skip-no-slv') skipNoSlv = true;
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

// 月次JSONは公開する基準の元なので、形のおかしい行が1つでもあれば何も書かずに止める
// (黙って飛ばすと、壊れた行が中央値に混ざったり人数の下限を満たしたりする — Codex指摘)
const MAX_DAMAGE = 1e12;   // DB の damage 上限 (06_input_bounds: 1000B 未満) と同じ
const problems = [];
const noSlv = [];   // --skip-no-slv のときだけ使う (数えないメンバー)
const seenPlayers = new Set();
for (const [i, p] of players.entries()) {
    const who = typeof p?.player === 'string' ? p.player.trim() : '';
    if (!who) { problems.push(`players[${i}]: 名前がない`); continue; }
    if (seenPlayers.has(who)) problems.push(`${who}: 同じ名前が2回ある`);
    seenPlayers.add(who);
    // SLv が無い・範囲外も壊れた行として止める (黙って除くと、残りの人数だけで基準ができてしまう — Codex指摘)
    if (!ratioOf(p.syncLevel)) (skipNoSlv ? noSlv : problems).push(skipNoSlv ? who : `${who}: SLv が無いか補正表の範囲外 (${p.syncLevel}) — 除いて進めるなら --skip-no-slv`);
    if (p.attacks != null && !Array.isArray(p.attacks)) { problems.push(`${who}: attacks が配列でない`); continue; }
    for (const [j, a] of (p.attacks ?? []).entries()) {
        const at = `${who} attacks[${j}]`;
        if (typeof a?.bossCode !== 'string' || !/^[A-Z][A-Z.]{1,15}$/.test(a.bossCode)) problems.push(`${at}: bossCode が不正 (${a?.bossCode})`);
        if (typeof a?.damage !== 'number' || !Number.isFinite(a.damage) || a.damage < 0 || a.damage >= MAX_DAMAGE) problems.push(`${at}: damage が不正 (${a?.damage})`);
        if (a?.isKill != null && typeof a.isKill !== 'boolean') problems.push(`${at}: isKill が true/false でない`);
        if (a?.difficulty != null && typeof a.difficulty !== 'string') problems.push(`${at}: difficulty が文字列でない`);
    }
}
if (problems.length) {
    console.error(`❌ 月次JSONに形のおかしい行があります (何も書いていません):\n  ${problems.slice(0, 20).join('\n  ')}` +
        (problems.length > 20 ? `\n  …ほか ${problems.length - 20} 件` : ''));
    process.exit(1);
}

// ボスコード → (メンバー名 → SLv補正後のベスト)
const bestByBoss = new Map();
for (const p of players) {
    const who = p.player.trim();
    const r = ratioOf(p.syncLevel);
    if (!r) continue;   // --skip-no-slv で除くと決めたメンバー (上で名前を出す)
    for (const a of p.attacks ?? []) {
        if (!(a.damage > 0)) continue;                            // 0 = 記録だけ (ダメージ未入力) の凸
        if (a.isKill) continue;                                   // 締め凸 = ボスを倒した凸は削りの値なので除く
        if (a.difficulty && a.difficulty !== 'HARD') continue;    // ハード以外は混ぜない
        const norm = a.damage / r;
        const m = bestByBoss.get(a.bossCode) ?? new Map();
        m.set(who, Math.max(m.get(who) ?? 0, norm));
        bestByBoss.set(a.bossCode, m);
    }
}
if (noSlv.length) console.warn(`⚠ --skip-no-slv: SLv が無い (または補正表の範囲外の) メンバーを数えていません: ${noSlv.join(', ')}`);

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

console.log(`すこれ基準 (${season} / 月次JSON ${players.length}人):`);
console.log(lines.join('\n'));
if (!Object.keys(attrs).length) { console.error('基準を作れる属性がありません'); process.exit(1); }

const sukore = {
    source: `しりすこPAD data/${season}.json (締め凸を除く各メンバーのベスト凸の中央値)`,
    builtAt: new Date().toLocaleDateString('sv-SE'),   // 手元の日付 (YYYY-MM-DD)。toISOString は UTC なので日本の朝は前日になる
    minMembers: MIN_MEMBERS,
    attrs,
};
if (base.sukore?.attrs) {
    const diff = Object.keys({ ...base.sukore.attrs, ...attrs })
        .filter(a => base.sukore.attrs[a]?.ref !== attrs[a]?.ref)
        .map(a => `${a}: ${base.sukore.attrs[a]?.ref ?? 'なし'} → ${attrs[a]?.ref ?? 'なし'}`);
    console.log(diff.length ? `前回からの変化: ${diff.join(' / ')}` : '前回と同じです');
}
if (!apply) {
    console.log('(確かめただけ。書き込むときは --apply)');
    process.exit(0);
}
writeFileSync(basePath, JSON.stringify({ ...base, sukore }, null, 2) + '\n', 'utf8');
console.log('→ data/base.json に書きました。node tests/run-tests.mjs → commit & push で画面に出ます');
