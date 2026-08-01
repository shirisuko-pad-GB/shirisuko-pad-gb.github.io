#!/usr/bin/env node
// シーズン切替の1コマンド化: 本家PADから「今回のボス5体」と「ふるり基準 (実凸/模擬)」を
// 自動取得して raid.json / base.json / boss-catalog.json を生成し、
// gen-seed → update-roster まで連続実行する。
//
// 使い方:  node scripts/new-season.mjs [shirisu-padのパス] [--slv 544] [--season-id 26]
//   (省略時 ../shirisu-pad。--slv は月次JSONが無いときの基準SLv上書き。
//    --season-id は本家シーズンIDの明示指定 — 現行シーズンの再生成や検証に使う)
//
// データの出所 (README「シーズン切替の運用ランブック」の手転記2箇所を自動化):
//   - ボス5体: 本家 Supabase bosses (アクティブな実シーズン)
//   - 基準ダメージ: 本家 fururi_simulation_scores (模擬・優先) → 月次JSON のふるり実凸
//   - 基準SLv: 月次JSON の syncLevel (無ければ --slv 指定が必須)
//
// ⚠ これを実行しても DB はまだ変わらない。残りの手順 (実行後に表示):
//   1) supabase/seed.local.sql を SQL Editor で実行  2) commit & push  3) site_state を open

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 逐次パーサー: フラグは値のインデックスごと消費する (値と同名の位置引数を巻き込まない)
const args = process.argv.slice(2);
let padDirArg = null, slvOverride = null, seasonIdOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slv') slvOverride = parseInt(args[++i]);
    else if (args[i] === '--season-id') seasonIdOverride = parseInt(args[++i]);
    else if (args[i].startsWith('--')) { console.error(`不明なオプション: ${args[i]}`); process.exit(1); }
    else if (padDirArg === null) padDirArg = args[i];
}
const padDir = padDirArg ?? join(ROOT, '..', 'shirisu-pad');

if (!existsSync(join(padDir, 'js', 'supabase-client.js'))) {
    console.error(`shirisu-pad が見つかりません: ${padDir}`);
    process.exit(1);
}
const clientSrc = readFileSync(join(padDir, 'js', 'supabase-client.js'), 'utf8');
const url = clientSrc.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = clientSrc.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) { console.error('本家の接続情報を読み取れませんでした'); process.exit(1); }

async function padGet(path) {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
}

// ---- 1) 対象シーズン: アクティブな実シーズン (無ければ hard_date 最新の実シーズン) ----
const seasons = (await padGet('seasons?select=id,month_key,hard_date,is_active,is_test&order=hard_date.asc'))
    .filter(s => !s.is_test);
const target = seasonIdOverride != null
    ? seasons.find(s => s.id === seasonIdOverride)
    : (seasons.findLast(s => s.is_active) ?? seasons.at(-1));
if (!target) { console.error('本家に対象シーズンがありません'); process.exit(1); }
const seasonKey = /^\d{4}-\d{2}$/.test(target.month_key ?? '')
    ? target.month_key
    : String(target.hard_date).slice(0, 7);
console.log(`対象シーズン: 本家ID ${target.id} (hard ${target.hard_date}) → GBシーズンキー ${seasonKey}`);

// ---- 2) ボス5体 → raid.json ----
const bosses = await padGet(`bosses?select=boss_number,boss_code,name,attribute,weakness&season_id=eq.${target.id}&order=boss_number.asc`);
if (bosses.length !== 5) { console.error(`ボスが5体ではありません (${bosses.length}体)`); process.exit(1); }
const order = bosses.map(b => String(b.weakness).toUpperCase());
if (new Set(order).size !== 5) { console.error(`弱点属性が5種になっていません: ${order}`); process.exit(1); }
const raid = {
    _readme: [
        'scripts/new-season.mjs の生成物 (本家 bosses 由来)。手動編集する場合は README のランブック参照。',
        'season: base.json の version と一致させること。order: 属性パネルの表示順 (ボスの並び)。',
        'bosses: PT属性 → そのPTで殴る相手ボスの名前。',
    ],
    season: seasonKey,
    order,
    bosses: Object.fromEntries(bosses.map(b => [String(b.weakness).toUpperCase(), b.name])),
};

// ---- 3) ふるり基準: 模擬 (優先) → 月次JSONの実凸 ----
const sims = await padGet(`fururi_simulation_scores?select=boss_code,damage_raw&season_id=eq.${target.id}`);
const simByCode = new Map(sims.map(s => [s.boss_code, Number(s.damage_raw)]));
const monthPath = join(padDir, 'data', `${seasonKey}.json`);
let actualByCode = new Map(), monthSlv = null;
if (existsSync(monthPath)) {
    const month = JSON.parse(readFileSync(monthPath, 'utf8'));
    const fururi = (month.players || []).find(p => p.player === 'ふるり');
    if (fururi) {
        monthSlv = fururi.syncLevel ?? null;
        for (const a of fururi.attacks || []) {
            const d = Number(a.damage);
            if (a.bossCode && d > 0) {
                // 同一ボスに複数凸があれば大きい方 (締め凸の削りを基準にしない)
                if (!actualByCode.has(a.bossCode) || actualByCode.get(a.bossCode) < d) actualByCode.set(a.bossCode, d);
            }
        }
    }
} else {
    console.log(`(月次JSON ${seasonKey}.json はまだ無い — 模擬スコアだけで基準を組みます)`);
}
const baseSlv = slvOverride ?? monthSlv;
if (!(baseSlv >= 1)) {
    console.error('基準SLv が分かりません。--slv <ふるりの現在SLv> を指定してください');
    process.exit(1);
}

const bases = {};
const missing = [];
for (const b of bosses) {
    const attr = String(b.weakness).toUpperCase();
    const sim = simByCode.get(b.boss_code);
    const act = actualByCode.get(b.boss_code);
    const damage = sim ?? act;   // 模擬優先 (本家 buildFururiBaseMap と同じ運用ルール)
    if (!(damage > 0)) { missing.push(`${attr} (${b.boss_code} / ${b.name})`); continue; }
    bases[attr] = { bossCode: b.boss_code, damage, source: sim != null ? 'simulation' : 'actual' };
}
if (missing.length > 0) {
    console.error(`❌ ふるり基準が揃っていません: ${missing.join(', ')}`);
    console.error('   本家の模擬タブで登録するか、実凸後の月次JSONを待ってから再実行してください。');
    console.error('   (基準が揃うまで site_state は between/maintenance のまま open にしないこと)');
    process.exit(1);
}
const base = {
    version: seasonKey,
    description: 'ふるり値の基準データ (scripts/new-season.mjs の生成物)。基準者(ふるり)の属性別ダメージ @ 基準SLv。模擬登録がある属性は模擬値を採用',
    basePlayer: 'ふるり',
    baseSlv,
    bases,
};

// ---- 4) ボスカタログ (全実シーズンの登場履歴 — raid.json の typo 検証・参考用) ----
const realIds = seasons.map(s => s.id);
const allBosses = await padGet('bosses?select=season_id,name,attribute,weakness');
const catalog = {};
for (const b of allBosses) {
    if (!realIds.includes(b.season_id)) continue;   // テストシーズン除外
    (catalog[b.name] ??= new Set()).add(String(b.attribute));
}
const bossCatalog = {
    _readme: 'scripts/new-season.mjs の生成物。本家の全実シーズンに登場したボス名 → ボス自身の属性の履歴 (同名でも属性はシーズンで変わる)。テストが raid.json のボス名 typo 検証に使う。',
    bosses: Object.fromEntries(Object.keys(catalog).sort().map(n => [n, [...catalog[n]].sort()])),
};

// ---- 5) 書き出し + 後続スクリプト (途中失敗時は書いた3ファイルを元に戻す) ----
const outFiles = ['raid.json', 'base.json', 'boss-catalog.json'].map(f => join(ROOT, 'data', f));
const backups = outFiles.map(p => existsSync(p) ? readFileSync(p) : null);
try {
    writeFileSync(outFiles[0], JSON.stringify(raid, null, 2) + '\n', 'utf8');
    writeFileSync(outFiles[1], JSON.stringify(base, null, 2) + '\n', 'utf8');
    writeFileSync(outFiles[2], JSON.stringify(bossCatalog, null, 1) + '\n', 'utf8');
    console.log(`raid.json:  ${order.map(a => `${a}→${raid.bosses[a]}`).join(' / ')}`);
    console.log(`base.json:  SLv ${baseSlv} / ` +
        Object.entries(bases).map(([a, v]) => `${a}=${(v.damage / 1e9).toFixed(2)}B(${v.source === 'simulation' ? '模擬' : '実凸'})`).join(' '));
    console.log(`boss-catalog.json: ${Object.keys(bossCatalog.bosses).length}ボス`);

    console.log('--- gen-seed (seed.local.sql 生成) ---');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-seed.mjs'), join(padDir, 'data', 'slv-ratio.json')], { stdio: 'inherit' });   // 本家パスを引き継ぐ (フォルダ名が既定と違う環境対応)
    console.log('--- update-roster (キャラ・使用率の更新) ---');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'update-roster.mjs'), padDir], { stdio: 'inherit' });
} catch (e) {
    outFiles.forEach((p, i) => { if (backups[i] !== null) writeFileSync(p, backups[i]); });
    console.error('❌ 後続処理が失敗したため raid.json / base.json / boss-catalog.json を元に戻しました。');
    console.error('   (characters.json / presets.json は update-roster を再実行すれば再生成されます)');
    throw e;
}

console.log(`
========= 残りの手順 (README ランブック) =========
 1. (前シーズン処理がまだなら) SQL Editor:
      update public.site_state set status='between', active_season=null,
          display_season='<前シーズン>', updated_at=now();
      delete from public.measurements;
 2. SQL Editor で supabase/seed.local.sql を実行 (${seasonKey} の基準投入)
    あわせてシャドウ集計の妥当範囲行を追加 (無ければ既定 [0.01, 5.0] で動作):
      insert into public.score_bounds (season, min_score, max_score)
      values ('${seasonKey}', 0.1, 2.5) on conflict do nothing;   -- 運用値 (実測レンジを見て調整)
 3. node tests/run-tests.mjs で整合を確認 → commit & push
 4. SQL Editor で open:
      update public.site_state set status='open', active_season='${seasonKey}',
          display_season=null, updated_at=now();
==================================================`);
