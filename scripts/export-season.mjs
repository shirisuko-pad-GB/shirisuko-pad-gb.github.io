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
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
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
// get_comp_insights に頼む編成数 = サーバー側のクランプ (15_comp_insights_cap.sql) と同じ値。
// 2026-11 の水冷で n>=5 の編成が旧上限 20 を超えたので 50 に (tests/run-tests.mjs が SQL と突き合わせる)
const TOP_COMPS = 50;

// base/raid はローカルファイル = 現行シーズンの値しか持っていない。過去シーズンを
// 指定すると「過去の集計 × 現行の基準ダメージ/ボス名」の混在ファイルができてしまうため
// 拒否する (過去分が要るときは当時のコミットを checkout して実行 — Codex指摘)
if (SEASON !== base.version || raid.season !== SEASON) {
    console.error(`シーズン不一致: 指定=${SEASON} / base.json=${base.version} / raid.json=${raid.season}`);
    console.error('過去シーズンのエクスポートは、そのシーズン時点のコミットを checkout して実行してください');
    process.exit(1);
}

// キャラID → 正規ID + 日本語名 (本家側は名前で突き合わせ、IDは照合検証用)。
// alias 経由の解決は件数を数えて最後に報告する (古い alias が誤った名前を黙って出す
// リスクの可視化 — Codex指摘。名前が引けない ID は最終的にエクスポート失敗にする)
let aliasResolved = 0;
const resolve = (id) => {
    let canon = id;
    if (!charData.chars[canon] && charData.aliases?.[id]) { canon = charData.aliases[id]; aliasResolved++; }
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
        // スコアの単位: 'fururi' (〜2026-10・基準者ふるりの値との比) / 'slv-b' (2026-11〜・SLv baseSlv 換算の B)。
        // medianFururi などのフィールド名は互換のためそのまま (中身の単位はここで判断する)
        unit: base.unit ?? 'fururi',
        attackBenchmark: 'per-client best per attribute (シーズン内・1端末1票)',
        compBenchmark: '編成つき提出のみの per-client best',
        excluded: ['finish (締め凸)', 'shadow-range (score_bounds 外)'],
        attributeMedianFloor: base.unit === 'slv-b' ? 20 : 50,   // 14_lower_thresholds で 50→20 (2026-11〜)
        compCohortFloor: 10,
        compMedianFloor: 5,
    },
    base: {
        version: base.version,
        basePlayer: base.basePlayer ?? null,   // 2026-11〜 は基準者なし
        baseSlv: base.baseSlv,
        union: base.union ?? null,     // ユニオン基準 (属性ごとの ref/n — 同じ単位)
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
    // 編成: 採用 n>=5 の編成を全部 (返却は n の降順)。
    // 末尾がまだ n>=5 なら、その先にも n>=5 の編成が残っているかもしれない = 全部取れた保証がない
    // (末尾が n<5 なら、それより後ろは全部 n<5 なので取りこぼしは無い)。
    // 15 未適用だとサーバーが 20 件で切るので、件数が TOP_COMPS 未満でも旧上限 20 以上なら疑う
    const ins = await rpc('get_comp_insights', { p_attribute: attr, p_season: SEASON, p_top_comps: TOP_COMPS });
    const list = Array.isArray(ins.comps) ? ins.comps : [];
    const comps = list.filter(c => Number.isFinite(c.median));   // median有 = n>=5
    const tail = list[list.length - 1];
    if (tail?.n >= 5 && list.length >= 20) {
        const why = list.length < TOP_COMPS
            ? `${list.length} 件で切れている = サーバーの上限がまだ 20 の可能性 (supabase/15_comp_insights_cap.sql を SQL Editor で適用)`
            : `p_top_comps の上限 ${TOP_COMPS} を超えている (15 のクランプと TOP_COMPS を一緒に広げる)`;
        throw new Error(`${attr}: n>=5 の編成を全部取れていない可能性 — ${why}`);
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
            members.forEach(m => { if (!m.name) { console.error(`✖ ${attr}: 名前未解決 ${m.gbId}`); warned = true; } });
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
        // サーバーの同順位は返却順が不定 → ファイル側で決定的に並べ直す (Codex指摘)
        }).sort((a, b) => b.n - a.n || b.medianFururi - a.medianFururi || a.compKey.localeCompare(b.compKey)),
    };
    console.log(`${attr}: 全体 n=${out.attributes[attr].attackBenchmark.n}` +
        ` 中央値=${out.attributes[attr].attackBenchmark.medianFururi}` +
        ` / 編成 ${comps.length}件 (母数${ins.n})`);
}

// 名前未解決が1件でもあれば書き出さない (本家側で誤マッチ・欠落編成を生むため — Codex指摘)
const unresolved = Object.values(out.attributes)
    .flatMap(a => a.comps).flatMap(c => c.members).filter(m => !m.name).length;
if (unresolved > 0) {
    console.error(`\n✖ 名前未解決 ${unresolved}件 — characters.json を更新してから再実行してください (書き出し中止)`);
    process.exit(1);
}
if (aliasResolved > 0) console.log(`ℹ alias 経由の解決 ${aliasResolved}件 (名前が正しいか抜き取り確認を推奨)`);

mkdirSync(join(ROOT, 'data', 'export'), { recursive: true });
const file = join(ROOT, 'data', 'export', `${SEASON}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
// サイトが「前シーズンの人気編成」を探すための一覧 (js/calc.js pickPrevSeason が読む)。
// ファイル名から機械的に作るので、手で編集しない
// 名前が季節っぽいだけのファイル (テスト用の再出力など) を拾わないよう、中身も確認する:
// season がファイル名と一致し、schemaVersion と5属性の comps を持つものだけ (Codex指摘)
const seasons = readdirSync(join(ROOT, 'data', 'export'))
    .filter(f => /^\d{4}-\d{2}\.json$/.test(f))
    .filter(f => {
        try {
            const j = JSON.parse(readFileSync(join(ROOT, 'data', 'export', f), 'utf8'));
            return j.season === f.slice(0, 7) && Number.isInteger(j.schemaVersion)
                && ATTRS.every(a => Array.isArray(j.attributes?.[a]?.comps));
        } catch { return false; }
    })
    .map(f => f.slice(0, 7)).sort();
writeFileSync(join(ROOT, 'data', 'export', 'index.json'), JSON.stringify({
    _readme: 'scripts/export-season.mjs の生成物。data/export/ にある凍結版シーズンの一覧。'
        + 'サイトは現行シーズンより前の最新を「前回の人気編成」に使う (js/calc.js pickPrevSeason)。手で編集しない',
    seasons,
}, null, 2) + '\n');
console.log(`\n✅ ${file} を書き出しました${warned ? ' (⚠ 警告あり — 上のログを確認)' : ''}`);
console.log('次の手順: git add data/export → commit → push (凍結版)。本家へは vendored コピーする');
