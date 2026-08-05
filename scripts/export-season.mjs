#!/usr/bin/env node
// シーズン確定スナップショットのエクスポート (本家PAD連携用・運営が手動実行)。
//
//   node scripts/export-season.mjs            # 現行シーズン (base.json の version)
//   node scripts/export-season.mjs 2026-08    # シーズン指定
//
// 公開RPC (get_distribution / get_comp_insights) から属性ごとの
// 全体中央値と「採用5人以上の全編成」を取得し、data/export/<season>.json に書く。
// **出力は全て既に公開されている情報のみ** (ふるり値単位・n>=5 プライバシー下限は
// サーバー側ゲートのまま)。norm 換算は本家側がローカルの slv-ratio で行う。
//
// 運用 (README「PAD ⇄ GB の月次連携フロー」/ Codex設計監査 2026-08-05):
//  - シーズン終了後の凍結版として1回だけ生成して commit する (差分監視リスクを避ける)
//  - 本家はこのファイルを自リポジトリに vendored コピーして使う (実行時fetchしない)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendSrc = readFileSync(join(ROOT, 'js', 'backend.js'), 'utf8');
const URL_ = backendSrc.match(/https:\/\/[a-z]+\.supabase\.co/)[0];
const KEY = backendSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)[0];
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));
const raid = JSON.parse(readFileSync(join(ROOT, 'data', 'raid.json'), 'utf8'));
const charData = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));

const SEASON = process.argv[2] ?? base.version;
const ATTRS = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];

if (SEASON === base.version && raid.season !== SEASON) {
    console.error(`raid.json (${raid.season}) と base.json (${base.version}) のシーズンが不一致`);
    process.exit(1);
}

// キャラID → 正規ID + 日本語名 (本家側は名前で突き合わせ、IDは照合検証用)
const resolve = (id) => {
    const canon = charData.chars[id] ? id : charData.aliases?.[id];
    const c = charData.chars[canon];
    return c ? { gbId: canon, name: c.name } : { gbId: id, name: null };
};

const rpc = async (fn, body) => {
    const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
    return res.json();
};

const out = {
    schemaVersion: 1,
    season: SEASON,
    generatedAt: new Date().toISOString(),
    methodology: {
        unit: 'fururi',
        attackBenchmark: 'per-client best per attribute (シーズン内・1端末1票)',
        compBenchmark: '編成つき提出のみの per-client best',
        excluded: ['finish (締め凸)', 'shadow-range (score_bounds 外)'],
        attributeMedianFloor: 50,
        compCohortFloor: 10,
        compMedianFloor: 5,
    },
    base: {
        version: base.version,
        basePlayer: base.basePlayer,
        baseSlv: base.baseSlv,
        attributes: Object.fromEntries(ATTRS.map(a => [a, {
            bossCode: base.bases[a]?.bossCode ?? null,
            bossName: raid.bosses?.[a] ?? null,
            baseDamage: base.bases[a]?.damage ?? null,
            source: base.bases[a]?.source ?? null,
        }])),
    },
    attributes: {},
};

let warned = false;
for (const attr of ATTRS) {
    // 全体の中央値 (p_score はダミー — median/n だけ使う)
    const dist = await rpc('get_distribution', { p_attribute: attr, p_season: SEASON, p_score: 1.0 });
    if (dist.gated || !Number.isFinite(dist.median)) {
        console.error(`⚠ ${attr}: 分布未解禁 (n=${dist.n}) — 属性中央値なしで出力します`);
        warned = true;
    }
    // 編成 (上限20 — 実測で全属性とも n>=5 の編成は20位以内に収まる。収まらなくなったら
    // 20位の n が 5 以上になるので下の検査で落ちる)
    const ins = await rpc('get_comp_insights', { p_attribute: attr, p_season: SEASON, p_top_comps: 20 });
    const comps = (ins.comps ?? []).filter(c => Number.isFinite(c.median));   // median有 = n>=5
    const tail = (ins.comps ?? [])[ins.comps?.length - 1];
    if (ins.comps?.length === 20 && tail?.n >= 5) {
        throw new Error(`${attr}: n>=5 の編成が20件を超えている可能性 — p_top_comps の上限拡張が必要`);
    }
    out.attributes[attr] = {
        attackBenchmark: {
            n: dist.n ?? 0,
            medianFururi: Number.isFinite(dist.median) ? +dist.median.toFixed(4) : null,
            loFururi: Number.isFinite(dist.lo) ? +dist.lo.toFixed(4) : null,
            hiFururi: Number.isFinite(dist.hi) ? +dist.hi.toFixed(4) : null,
        },
        compCohortN: ins.n ?? 0,
        comps: comps.map(c => {
            const members = (Array.isArray(c.chars) ? c.chars : []).map(resolve);
            members.forEach(m => { if (!m.name) { console.error(`⚠ ${attr}: 名前未解決 ${m.gbId}`); warned = true; } });
            return {
                compKey: members.map(m => m.gbId).sort().join('|'),
                members: members.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ja')),
                n: c.n,
                medianFururi: +Number(c.median).toFixed(4),
                arrangements: (Array.isArray(c.arr) ? c.arr : []).slice(0, 3).map(x => ({
                    memberGbIdsInOrder: x.chars,
                    n: x.n,
                })),
            };
        }),
    };
    console.log(`${attr}: 全体 n=${out.attributes[attr].attackBenchmark.n}` +
        ` 中央値=${out.attributes[attr].attackBenchmark.medianFururi}` +
        ` / 編成 ${comps.length}件 (母数${ins.n})`);
}

mkdirSync(join(ROOT, 'data', 'export'), { recursive: true });
const file = join(ROOT, 'data', 'export', `${SEASON}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`\n✅ ${file} を書き出しました${warned ? ' (⚠ 警告あり — 上のログを確認)' : ''}`);
console.log('次の手順: git add data/export → commit → push (凍結版)。本家へは vendored コピーする');
