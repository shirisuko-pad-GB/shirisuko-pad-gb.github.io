#!/usr/bin/env node
// シーズン切替の1コマンド化: 本家PADから「今回のボス5体」を自動取得して
// raid.json / base.json / boss-catalog.json を生成し、gen-seed → update-roster まで連続実行する。
//
// 使い方:  node scripts/new-season.mjs [shirisu-padのパス] [--season-id 26]
//   (省略時 ../しりすこPAD。--season-id は本家シーズンIDの明示指定 — 現行シーズンの再生成や検証に使う)
//
// データの出所:
//   - ボス5体: 本家 Supabase bosses (アクティブな実シーズン)
//   - スコアの単位: 固定 (SLv 600 換算の B)。2026-11 から基準者ふるりの値は使わない (下の 3) 参照)。
//     すこれ値の基準はレイド後に scripts/sukore-base.mjs で足す
//
// ⚠ これを実行しても DB はまだ変わらない。残りの手順 (実行後に表示):
//   1) supabase/seed.local.sql を SQL Editor で実行  2) commit & push  3) site_state を open

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 逐次パーサー: フラグは値のインデックスごと消費する (値と同名の位置引数を巻き込まない)
const args = process.argv.slice(2);
let padDirArg = null, seasonIdOverride = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slv') { console.error('--slv は不要になりました (2026-11 から基準者の SLv は使いません)'); process.exit(1); }
    else if (args[i] === '--season-id') seasonIdOverride = parseInt(args[++i]);
    else if (args[i].startsWith('--')) { console.error(`不明なオプション: ${args[i]}`); process.exit(1); }
    else if (padDirArg === null) padDirArg = args[i];
}
const padDir = padDirArg ?? join(ROOT, '..', 'しりすこPAD');

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

// ---- 3) スコアの単位 → base.json ----
// 2026-11 (第46回) から基準者ふるりの値 (模擬/実凸) は使わない — 常連が増えて分布がすぐ埋まるため、
// 画面は「中央値比 %」と、ユニオン集計後の「すこれ値」(scripts/sukore-base.mjs) だけで見せる。
// サーバーのスコアは「SLv 600 換算のダメージ (B)」という中立の単位にする
// (fururi_bases に 1B @ SLv REF_SLV を入れる。トリガ・集計RPCは今までどおり base で割るだけ)。
// 単位はシーズン中に変えない — 端末に残った score と RPC の中央値の比 (= 中央値比) がずれないように。
const REF_SLV = 600;
const UNIT_DAMAGE = 1e9;
const bases = Object.fromEntries(bosses.map(b => [String(b.weakness).toUpperCase(), { bossCode: b.boss_code, damage: UNIT_DAMAGE }]));
const base = {
    version: seasonKey,
    description: `スコアの単位 (scripts/new-season.mjs の生成物)。score = SLv ${REF_SLV} 換算のダメージ (B)。基準者は置かない。` +
        'sukore = すこれ基準 (ユニオンの真ん中のメンバー・同じ単位) — レイド後に scripts/sukore-base.mjs が書く。無いうちは null',
    unit: 'slv-b',
    baseSlv: REF_SLV,
    bases,
    sukore: null,
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

// ---- 5) 書き出し + 後続スクリプト (途中失敗時は書いたファイルを元に戻す) ----
// 後続 (gen-seed / update-roster) が書く seed.local.sql・characters.json・presets.json も戻す対象に入れる
// (base だけ旧シーズンに戻って、次シーズン用の seed が残ると、誤って流したときに食い違う — Codex指摘)
const outFiles = ['raid.json', 'base.json', 'boss-catalog.json'].map(f => join(ROOT, 'data', f));
const sideFiles = [join(ROOT, 'supabase', 'seed.local.sql'), join(ROOT, 'data', 'characters.json'), join(ROOT, 'data', 'presets.json')];
const backups = [...outFiles, ...sideFiles].map(p => existsSync(p) ? readFileSync(p) : null);
try {
    writeFileSync(outFiles[0], JSON.stringify(raid, null, 2) + '\n', 'utf8');
    writeFileSync(outFiles[1], JSON.stringify(base, null, 2) + '\n', 'utf8');
    writeFileSync(outFiles[2], JSON.stringify(bossCatalog, null, 1) + '\n', 'utf8');
    console.log(`raid.json:  ${order.map(a => `${a}→${raid.bosses[a]}`).join(' / ')}`);
    console.log(`base.json:  単位 = SLv ${REF_SLV} 換算 B (基準者なし・すこれ基準はレイド後に sukore-base.mjs)`);
    console.log(`boss-catalog.json: ${Object.keys(bossCatalog.bosses).length}ボス`);

    console.log('--- gen-seed (seed.local.sql 生成) ---');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-seed.mjs'), join(padDir, 'data', 'slv-ratio.json')], { stdio: 'inherit' });   // 本家パスを引き継ぐ (フォルダ名が既定と違う環境対応)
    console.log('--- update-roster (キャラ・使用率の更新) ---');
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'update-roster.mjs'), padDir], { stdio: 'inherit' });
} catch (e) {
    [...outFiles, ...sideFiles].forEach((p, i) => {
        if (backups[i] !== null) writeFileSync(p, backups[i]);
        else if (existsSync(p)) rmSync(p);   // 実行前に無かったファイル (初回の seed.local.sql) は消す
    });
    console.error('❌ 後続処理が失敗したため raid.json / base.json / boss-catalog.json / seed.local.sql /');
    console.error('   characters.json / presets.json を元に戻しました。character-images/ は git restore character-images で戻せます');
    throw e;
}

console.log(`
========= 残りの手順 (README ランブック) =========
 1. (前シーズン処理がまだなら) SQL Editor:
      update public.site_state set status='between', active_season=null,
          display_season='<前シーズン>', updated_at=now();
      delete from public.measurements;
 2. SQL Editor で supabase/seed.local.sql を実行 (${seasonKey} の基準投入)
    あわせてシャドウ集計の妥当範囲行を追加 (無ければ既定 [0.01, 5.0] = 0.01B〜5B で、ほぼ全員が外れる):
      insert into public.score_bounds (season, min_score, max_score)
      values ('${seasonKey}', 1.0, 80.0) on conflict do nothing;   -- 単位は SLv ${REF_SLV} 換算 B (過去3シーズンの p1〜p99 = 6〜38B)
 3. node tests/run-tests.mjs で整合を確認 → commit & push
 4. SQL Editor で open:
      update public.site_state set status='open', active_season='${seasonKey}',
          display_season=null, updated_at=now();
==================================================`);
