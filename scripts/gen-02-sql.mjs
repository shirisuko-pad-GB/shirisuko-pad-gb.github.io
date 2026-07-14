#!/usr/bin/env node
// supabase/02_stats.sql (テンプレート) のシード部分を埋めて、実行用の
// supabase/02_stats.local.sql を生成する。
//
// ⚠ slv-ratio は未公開の検証データ (めいでる+ふるり)。
//    - slv-ratio.json はこのリポジトリにはコミットしない (gitignore 済み)
//    - 生成物 02_stats.local.sql もコミットしない (gitignore 済み)
//    - Supabase の SQL Editor へは 02_stats.local.sql の中身を貼って実行する
//
// 使い方: node scripts/gen-02-sql.mjs [slv-ratio.jsonのパス]
//   パス省略時は ../shirisu-pad/data/slv-ratio.json を読む
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(ROOT, 'supabase', '02_stats.sql');
const outPath = join(ROOT, 'supabase', '02_stats.local.sql');
const ratioPath = process.argv[2] || join(ROOT, '..', 'shirisu-pad', 'data', 'slv-ratio.json');

const ratio = JSON.parse(readFileSync(ratioPath, 'utf8')).data;
const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));

const ratioRows = Object.keys(ratio)
    .map(Number).sort((a, b) => a - b)
    .map(slv => `(${slv},${ratio[String(slv)]})`);
// 10個ずつ改行して読みやすく
const ratioSeed = ratioRows.reduce((acc, r, i) => acc + r + ((i + 1) % 10 === 0 ? ',\n' : ','), '').replace(/,\n?$/, '');

const baseSeed = Object.entries(base.bases)
    .map(([attr, b]) => `('${base.version}', '${attr}', ${base.baseSlv}, ${b.damage})`)
    .join(',\n');

let sql = readFileSync(templatePath, 'utf8');
if (!sql.includes('--SLV_RATIO_SEED--') || !sql.includes('--FURURI_BASES_SEED--')) {
    console.error('テンプレートにプレースホルダが見つかりません。supabase/02_stats.sql を確認してください。');
    process.exit(1);
}
sql = '-- ⚠ 生成物 (シード入り)。コミット禁止 — SQL Editor で実行したら不要\n' +
    sql.replace('--SLV_RATIO_SEED--', ratioSeed).replace('--FURURI_BASES_SEED--', baseSeed);
writeFileSync(outPath, sql, 'utf8');
console.log(`02_stats.local.sql: slv_ratio ${ratioRows.length}行 / fururi_bases ${Object.keys(base.bases).length}行 (version=${base.version})`);
console.log(`→ ${outPath} の中身を SQL Editor で実行してください (このファイルはコミットされません)`);
