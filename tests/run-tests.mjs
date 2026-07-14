#!/usr/bin/env node
// クライアント側テスト:  node tests/run-tests.mjs
// ふるり値の計算式はサーバー側 (supabase/02_stats.sql) にしかないため、
// ここでは クライアントユーティリティ と 秘匿データの混入ガード を検証する。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topPercentFromCounts, ATTRS } from '../js/calc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function test(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg || ''} expected=${expected} got=${actual}`);
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

console.log('秘匿データの混入ガード (slv-ratio は未公開の検証データ):');

test('data/slv-ratio.json がリポジトリに存在しない', () => {
    assert(!existsSync(join(ROOT, 'data', 'slv-ratio.json')),
        'data/slv-ratio.json が存在します。コミット厳禁 — 削除してください (計算はサーバー側のみ)');
});

test('supabase/02_stats.sql にシードが埋め込まれていない (テンプレートのまま)', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '02_stats.sql'), 'utf8');
    assert(sql.includes('--SLV_RATIO_SEED--'),
        '02_stats.sql にシードが埋め込まれています。テンプレートに戻してください (実行用は 02_stats.local.sql)');
});

test('.gitignore が秘匿ファイルを除外している', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    assert(gi.includes('data/slv-ratio.json'), '.gitignore に data/slv-ratio.json がありません');
    assert(gi.includes('supabase/02_stats.local.sql'), '.gitignore に 02_stats.local.sql がありません');
});

test('クライアントJSが slv-ratio を参照していない', () => {
    for (const f of ['app.js', 'backend.js', 'calc.js']) {
        const src = readFileSync(join(ROOT, 'js', f), 'utf8');
        assert(!src.includes('slv-ratio'), `js/${f} が slv-ratio を参照しています`);
    }
});

console.log('topPercentFromCounts:');

test('above/n から上位%を計算 (自分含む・最低1%)', () => {
    assertEq(topPercentFromCounts(0, 4), 25);     // 自分が最高 → (0+1)/4
    assertEq(topPercentFromCounts(0, 1), 100);    // 自分だけ
    assertEq(topPercentFromCounts(5, 10), 60);    // 上に5人 → (5+1)/10
    assertEq(topPercentFromCounts(0, 200), 1);    // 丸めても最低1%
});

test('不正入力は null', () => {
    assertEq(topPercentFromCounts(0, 0), null);
    assertEq(topPercentFromCounts(NaN, 10), null);
});

console.log('ATTRS:');

test('5属性が定義されている', () => {
    assertEq(ATTRS.length, 5);
    assertEq(new Set(ATTRS).size, 5);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
