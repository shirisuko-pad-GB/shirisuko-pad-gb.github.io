#!/usr/bin/env node
// クライアント側テスト:  node tests/run-tests.mjs
// ふるり値の計算式はサーバー側 (supabase/02_stats.sql) にしかないため、
// ここでは クライアントユーティリティ と 秘匿データの混入ガード を検証する。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topPercentFromCounts, ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate } from '../js/calc.js';

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

console.log('バースト編成 (B1/B2/B3/BΛ):');

// テスト用: img名の先頭2文字をバーストとして返す ("B1a" → "B1", "??" → null)
const burstOf = (img) => ['B1', 'B2', 'B3', 'BΛ'].find(b => img.startsWith(b)) ?? null;

test('テンプレートは全て5枠で、枠は B1/B2/B3/自由(null) のみ', () => {
    assert(BURST_TEMPLATES.length >= 2, 'テンプレートが足りません');
    for (const t of BURST_TEMPLATES) {
        assertEq(t.slots.length, 5, `${t.id} の枠数`);
        for (const s of t.slots) assert(s === null || ['B1', 'B2', 'B3'].includes(s), `${t.id} に不正な枠 ${s}`);
    }
    assertEq(templateById('standard').slots.join(','), 'B1,B2,B3,B3,B3');
    assertEq(templateById('存在しないID').id, BURST_TEMPLATES[0].id, 'フォールバック');
});

test('burstMatchesSlot: Λと未分類は全枠OK、確定バーストは一致枠のみ', () => {
    assertEq(burstMatchesSlot('B1', 'B1'), true);
    assertEq(burstMatchesSlot('B1', 'B3'), false);
    assertEq(burstMatchesSlot('BΛ', 'B1'), true);
    assertEq(burstMatchesSlot('BΛ', 'B3'), true);
    assertEq(burstMatchesSlot(null, 'B2'), true);   // 未分類は弾かない
    assertEq(burstMatchesSlot('B2', null), true);   // 自由枠は何でもOK
});

test('reslotChars: B1B2B3B3B3 テンプレに正しく配置される', () => {
    const { slots, dropped } = reslotChars(['B3a', 'B1a', 'B3b', 'B2a', 'B3c'], burstOf, templateById('standard').slots);
    assertEq(slots[0], 'B1a');
    assertEq(slots[1], 'B2a');
    assertEq(slots.slice(2).join(','), 'B3a,B3b,B3c');
    assertEq(dropped.length, 0);
});

test('reslotChars: 枠に収まらないキャラは dropped、Λは空き枠に入る', () => {
    const { slots, dropped } = reslotChars(['B2a', 'B2b', 'BΛa'], burstOf, templateById('standard').slots);
    assertEq(slots[1], 'B2a');
    assert(dropped.includes('B2b'), 'B2 2体目は standard に入らない');
    assert(slots.includes('BΛa'), 'Λ はどこかの枠に入る');
});

test('detectTemplate: 構成からテンプレを自動判定', () => {
    assertEq(detectTemplate(['B1a', 'B2a', 'B3a', 'B3b', 'B3c'], burstOf), 'standard');
    assertEq(detectTemplate(['B1a', 'B2a', 'B2b', 'B3a', 'B3b'], burstOf), 'double2');
    assertEq(detectTemplate(['B1a', 'B1b', 'B1c', 'B1d', 'B1e'], burstOf), 'free');
});

console.log('characters.json (編成ピッカーのバーストデータ):');

test('characters.json が存在し、burst 値が正当', () => {
    const c = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));
    const entries = Object.entries(c);
    assert(entries.length > 0, 'characters.json が空です');
    for (const [img, v] of entries) {
        assert(/^[\w-]+\.webp$/.test(img), `不正な画像キー: ${img}`);
        assert(typeof v.name === 'string' && v.name.length > 0, `${img} に name がありません`);
        assert(v.burst === null || ['B1', 'B2', 'B3', 'BΛ'].includes(v.burst), `${img} の burst が不正: ${v.burst}`);
    }
});

test('BΛ はレッドフードのみ (1キャラ限定の特殊仕様)', () => {
    const c = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));
    const lambdaNames = new Set(Object.values(c).filter(v => v.burst === 'BΛ').map(v => v.name));
    assertEq(lambdaNames.size, 1, `BΛ キャラが複数います: ${[...lambdaNames].join(', ')}`);
    assert([...lambdaNames][0].includes('レッドフード'), `BΛ がレッドフードではありません: ${[...lambdaNames][0]}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
