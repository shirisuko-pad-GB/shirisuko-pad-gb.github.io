#!/usr/bin/env node
// 月次の baseline 投入用に「データのみ」の SQL を生成する: supabase/seed.local.sql
//   - slv_ratio (秘匿の検証データ) の upsert
//   - fururi_bases (このシーズンの基準) の upsert  ← season キー
// ※ 関数 (トリガ/RPC) は一切含めない。関数の定義は 05_seasons.sql が唯一の正。
//    これにより「月次 seed を流すと 04/05 の強化が上書きされる」バグを回避する。
//
// ⚠ slv-ratio は未公開の検証データ。生成物 seed.local.sql は gitignore 済み・コミット禁止。
//
// 使い方: node scripts/gen-seed.mjs [slv-ratio.jsonのパス]
//   パス省略時は ../shirisu-pad/data/slv-ratio.json を読む
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(ROOT, 'supabase', 'seed.local.sql');
const ratioPath = process.argv[2] || join(ROOT, '..', 'shirisu-pad', 'data', 'slv-ratio.json');

const ratio = JSON.parse(readFileSync(ratioPath, 'utf8')).data;
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));
const season = base.version;

const ratioRows = Object.keys(ratio)
    .map(Number).sort((a, b) => a - b)
    .map(slv => `(${slv},${ratio[String(slv)]})`);
const ratioSeed = ratioRows.reduce((acc, r, i) => acc + r + ((i + 1) % 10 === 0 ? ',\n' : ','), '').replace(/,\n?$/, '');

const baseSeed = Object.entries(base.bases)
    .map(([attr, b]) => `('${season}', '${attr}', ${base.baseSlv}, ${b.damage})`)
    .join(',\n');

const sql = `-- ⚠ 生成物 (シード入り・データのみ)。コミット禁止 — SQL Editor で実行したら不要。
-- 関数定義は含まない (05_seasons.sql が唯一の正)。テーブルは 01/05 で作成済みの前提。
-- season = ${season}

insert into public.slv_ratio (slv, ratio) values
${ratioSeed}
on conflict (slv) do update set ratio = excluded.ratio;

insert into public.fururi_bases (season, attribute, base_slv, base_damage) values
${baseSeed}
on conflict (season, attribute) do update
    set base_slv = excluded.base_slv, base_damage = excluded.base_damage;
`;

writeFileSync(outPath, sql, 'utf8');
console.log(`seed.local.sql: slv_ratio ${ratioRows.length}行 / fururi_bases ${Object.keys(base.bases).length}行 (season=${season})`);
console.log(`→ ${outPath} の中身を SQL Editor で実行 (シーズンの基準を投入。関数は上書きしない)`);
