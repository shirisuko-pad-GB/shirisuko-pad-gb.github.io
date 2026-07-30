#!/usr/bin/env node
// 見え方確認用の仮データ投入 (運営用・本番 Supabase に submit RPC 経由で送信)。
//
//   node scripts/seed-demo.mjs --from 0 --to 200 [--dry] [../shirisu-padのパス]
//
// - 仮ユーザーは client_id が dddddddd-dddd-4ddd-8ddd-XXXXXXXXXXXX の連番UUID。
//   ★ 全削除: SQL Editor で
//       delete from public.measurements where client_id::text like 'dddddddd-dddd-4ddd-8ddd-%';
// - 各ユーザーはランダムな3属性に1凸ずつ (= 1セット3件・set_id 付き) 送信する。
//   --from 0 --to 350 で全属性 n≈210 になる (350人 × 3属性 ÷ 5属性)。
// - スコアはユーザー地力 (対数正規) × 属性別の「ボスの通しやすさ」係数 × ノイズ。
//   ダメージは slv-ratio (ローカル秘匿ファイル) から逆算するので分布が本物と同じ形になる。
// - 編成は presets.json の使用実績上位キャラから標準テンプレ (B1,B2,B3,B3,B3) で生成した
//   「使われていそうな」プール (人気編成ほど高頻度・並び順の揺れあり)。25%は編成なし。
// - 決定的乱数 (ユーザー番号がシード) — 同じ範囲を再実行しても同じデータになる。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const FROM = parseInt(argVal('--from', '0'));
const TO = parseInt(argVal('--to', '200'));
const DRY = args.includes('--dry');
const padDir = args.filter(a => !a.startsWith('--') && a !== String(FROM) && a !== String(TO)).pop()
    ?? join(ROOT, '..', 'shirisu-pad');

// ---- 接続情報・データ ----
const backendSrc = readFileSync(join(ROOT, 'js', 'backend.js'), 'utf8');
const URL_ = backendSrc.match(/https:\/\/[a-z]+\.supabase\.co/)[0];
const KEY = backendSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)[0];
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));
const presets = JSON.parse(readFileSync(join(ROOT, 'data', 'presets.json'), 'utf8'));
const charData = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));
const ratioPath = join(padDir, 'data', 'slv-ratio.json');
if (!existsSync(ratioPath)) { console.error(`slv-ratio が見つかりません: ${ratioPath}`); process.exit(1); }
const RATIO = JSON.parse(readFileSync(ratioPath, 'utf8')).data;

const ATTRS = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];
// 属性ごとの「ボスの通しやすさ」(中央値がボスで違う状況を再現 — 3凸総合の補正デモ用)
const BOSS_EASE = { FIRE: 1.00, WATER: 0.88, ELECTRIC: 1.15, IRON: 0.95, WIND: 0.82 };

// ---- 決定的乱数 (mulberry32) ----
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// ---- 編成プール (属性ごと8編成 + 並び順バリエーション) ----
function burstOf(id) { return charData.chars[id]?.burst ?? null; }
function poolFor(attr) {
    const top = (presets.attributes?.[attr]?.topChars ?? []).map(c => c.img)
        .filter(id => charData.chars[id]);
    const by = (b) => top.filter(id => burstOf(id) === b);
    const b1 = by('B1').slice(0, 3), b2 = by('B2').slice(0, 3), b3 = by('B3').slice(0, 6);
    const lam = top.filter(id => burstOf(id) === 'BΛ').slice(0, 1);
    if (b1.length < 1 || b2.length < 1 || b3.length + lam.length < 3) return [];
    const comps = [];
    for (let j = 0; j < 8; j++) {
        const three = [];
        for (let k = 0; k < 6 && three.length < 3; k++) {
            const cand = (j + k) % 2 === 0 ? b3[(j + k) % b3.length] : (lam[0] && j % 3 === 2 && !three.includes(lam[0]) ? lam[0] : b3[(j * 2 + k) % b3.length]);
            if (cand && !three.includes(cand)) three.push(cand);
        }
        if (three.length < 3) continue;
        comps.push([b1[j % b1.length], b2[(j >> 1) % b2.length], ...three]);
    }
    // 重複編成 (同じ5人) を除去
    const seen = new Set();
    return comps.filter(c => { const k = [...c].sort().join('|'); if (seen.has(k) || new Set(c).size !== 5) return false; seen.add(k); return true; });
}
const POOLS = Object.fromEntries(ATTRS.map(a => [a, poolFor(a)]));

// 人気度: 先頭ほど使われる (zipf風)
function pickComp(r, attr) {
    if (r() < 0.25) return null;                        // 25% は編成なし
    const pool = POOLS[attr];
    if (pool.length === 0) return null;
    const w = pool.map((_, i) => 1 / (i + 1) ** 1.3);
    const sum = w.reduce((s, x) => s + x, 0);
    let t = r() * sum, idx = 0;
    for (; idx < w.length - 1 && t > w[idx]; t -= w[idx], idx++);
    const comp = [...pool[idx]];
    // 並び順の揺れ: 35% で B3 枠 (3..5枠目) の順を入れ替える
    if (r() < 0.35) { const t3 = comp[2]; comp[2] = comp[3]; comp[3] = t3; }
    if (r() < 0.15) { const t4 = comp[3]; comp[3] = comp[4]; comp[4] = t4; }
    return comp;
}

const hex12 = (n) => n.toString(16).padStart(12, '0');
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- 1ユーザー分のセットを組む ----
function buildSet(u) {
    const r = rng(20260730 + u * 7919);
    const clientId = `dddddddd-dddd-4ddd-8ddd-${hex12(u)}`;
    const setId = `eeeeeeee-eeee-4eee-8eee-${hex12(u)}`;
    const slv = clamp(Math.round(500 + normal(r) * 55), 340, 620);
    const skill = Math.exp(Math.log(0.95) + normal(r) * 0.22);          // ユーザー地力
    const attrs = [...ATTRS].sort(() => r() - 0.5).slice(0, 3);         // 3属性に凸
    return attrs.map((attr, i) => {
        const score = clamp(skill * BOSS_EASE[attr] * Math.exp(normal(r) * 0.08), 0.15, 2.6);
        const b = base.bases[attr];
        const damage = Math.round(score * b.damage * (RATIO[String(slv)] / RATIO[String(base.baseSlv)]));
        return {
            attribute: attr, slv, damage, season: base.version,
            characters: pickComp(r, attr),
            client_id: clientId, set_id: setId, set_slot: i + 1,
        };
    });
}

// ---- 送信 ----
const rpc = async (rows) => {
    const res = await fetch(`${URL_}/rest/v1/rpc/submit_measurements`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_rows: rows }),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
};

const counts = Object.fromEntries(ATTRS.map(a => [a, 0]));
let withComp = 0, sent = 0, failed = 0;
for (let u = FROM; u < TO; u++) {
    const rows = buildSet(u);
    rows.forEach(row => { counts[row.attribute]++; if (row.characters) withComp++; });
    if (!DRY) {
        try { await rpc(rows); sent++; }
        catch (e) { failed++; if (failed <= 3) console.error(`user ${u}: ${e.message}`); }
    }
    if ((u - FROM + 1) % 50 === 0) console.log(`  ${u - FROM + 1}/${TO - FROM} 人処理…`);
}
console.log(`${DRY ? '[dry] ' : ''}ユーザー ${FROM}〜${TO - 1}: セット送信 ${DRY ? 0 : sent}件 (失敗${failed})`);
console.log('属性別の凸数: ' + ATTRS.map(a => `${a}=${counts[a]}`).join(' ') + ` / 編成つき ${withComp}`);
console.log(`★ 全削除SQL: delete from public.measurements where client_id::text like 'dddddddd-dddd-4ddd-8ddd-%';`);
