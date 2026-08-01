#!/usr/bin/env node
// 基準者 (ふるり) 自身の記録を分布の1票目として投入する。
//   node scripts/seed-base-vote.mjs            # dry-run
//   node scripts/seed-base-vote.mjs --apply    # 実行
//
// なぜ入れるか: 公開直後の分布が完全に空だと「1人目の提出」が中央値になってしまう。
// 基準者の記録 (data/base.json = 模擬の実績・編成つき) を最初の1票として置くことで、
// 分布の起点が「基準 = ふるり値 1.00」になり、解禁前でも比較の足場ができる。
//
// 冪等: 固定 client_id (…-0001) の1端末1票なので、再実行しても票は増えない
// (同一属性のベスト1件だけが集計対象。値も同じなので分布は変わらない)。
// シーズンが open で active_season が base.json の version と一致している必要がある。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const backend = readFileSync(join(ROOT, 'js', 'backend.js'), 'utf8');
const url = backend.match(/https:\/\/[a-z]+\.supabase\.co/)?.[0];
const key = backend.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0];
const HEADERS = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));
// 基準者の票は「基準者専用の固定端末ID」。仮データ (dddddddd-…) とは別系統にして、
// 仮データ一括削除 SQL に巻き込まれないようにする
const CLIENT_ID = '00000000-0000-4000-8000-000000000001';

const st = await (await fetch(`${url}/rest/v1/site_state?select=status,active_season`, { headers: HEADERS })).json();
console.log(`site_state: status=${st[0]?.status} active_season=${st[0]?.active_season} / base.json=${base.version}`);
if (st[0]?.status !== 'open' || st[0]?.active_season !== base.version) {
    console.error('❌ シーズンが open かつ base.json と一致していません (先に open にしてください)');
    process.exit(1);
}

const rows = Object.entries(base.bases).map(([attribute, b]) => ({
    attribute,
    slv: base.baseSlv,
    damage: b.damage,
    season: base.version,
    characters: Array.isArray(b.team) && b.team.length === 5 ? [...b.team].sort() : null,
    client_id: CLIENT_ID,
    set_id: null,
    set_slot: null,
}));
console.log(`投入予定 ${rows.length}件 (${base.basePlayer} SLv ${base.baseSlv}):`);
for (const r of rows) console.log(`  ${r.attribute} ${(r.damage / 1e9).toFixed(2)}B 編成${r.characters ? 'あり' : 'なし'}`);
if (!APPLY) { console.log('\n(dry-run。--apply で実行)'); process.exit(0); }

// 1リクエスト最大3行の制約に合わせて分割送信
let ok = 0;
for (let i = 0; i < rows.length; i += 3) {
    const chunk = rows.slice(i, i + 3);
    const res = await fetch(`${url}/rest/v1/rpc/submit_measurements`, {
        method: 'POST', headers: HEADERS, body: JSON.stringify({ p_rows: chunk }),
    });
    const text = await res.text();
    if (!res.ok) { console.error(`✗ ${chunk.map(c => c.attribute).join(',')}: ${res.status} ${text}`); continue; }
    const scores = JSON.parse(text).map(x => Number(x.score).toFixed(2));
    console.log(`✓ ${chunk.map((c, k) => `${c.attribute}=${scores[k]}`).join(' ')}`);
    ok += chunk.length;
}
console.log(`\n完了: ${ok}/${rows.length}件 (基準者のふるり値は定義上すべて 1.00 になるのが正)`);
