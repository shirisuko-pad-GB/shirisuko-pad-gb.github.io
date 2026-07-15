#!/usr/bin/env node
// クライアント側テスト:  node tests/run-tests.mjs
// ふるり値の計算式はサーバー側 (supabase/02_stats.sql) にしかないため、
// ここでは クライアントユーティリティ と 秘匿データの混入ガード を検証する。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topPercentFromCounts, ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput } from '../js/calc.js';
import { escapeHtml, sanitizeCharacters, CHAR_IMG_RE, THRESHOLDS } from '../js/shared.js';

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

console.log('parseDamageInput (B単位のダメージ入力):');

test('B単位の少数入力 → 生ダメージ', () => {
    assertEq(parseDamageInput('13.18'), 13.18e9);
    assertEq(parseDamageInput('18.99'), 18.99e9);
    assertEq(parseDamageInput('0.5'), 0.5e9);
    assertEq(parseDamageInput('.5'), 0.5e9);
});

test('フル桁の貼り付け → そのまま生ダメージ (カンマ・空白許容)', () => {
    assertEq(parseDamageInput('33333109055'), 33333109055);
    assertEq(parseDamageInput('33,333,109,055'), 33333109055);
    assertEq(parseDamageInput(' 13 180 000 000 '), 13180000000);
});

test('末尾のB表記は明示的にB単位', () => {
    assertEq(parseDamageInput('13.18B'), 13.18e9);
    assertEq(parseDamageInput('99b'), 99e9);
});

test('不正入力・0以下は null', () => {
    assertEq(parseDamageInput(''), null);
    assertEq(parseDamageInput('abc'), null);
    assertEq(parseDamageInput('0'), null);
    assertEq(parseDamageInput('13.18.5'), null);
    assertEq(parseDamageInput('-5'), null);
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

console.log('shared: escapeHtml (XSS対策):');

test('HTML特殊文字を全てエスケープ', () => {
    assertEq(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assertEq(escapeHtml('a"b\'c&d<e>f'), 'a&quot;b&#39;c&amp;d&lt;e&gt;f');
    assertEq(escapeHtml('"><script>'), '&quot;&gt;&lt;script&gt;');
});

test('null/undefined/数値も安全に文字列化', () => {
    assertEq(escapeHtml(null), '');
    assertEq(escapeHtml(undefined), '');
    assertEq(escapeHtml(42), '42');
});

test('属性値の脱出を防ぐ (ダメージ入力の自己XSS)', () => {
    // value="${escapeHtml(a.damage)}" に埋めても属性を破れない
    assertEq(escapeHtml('12" onfocus="alert(1)'), '12&quot; onfocus=&quot;alert(1)');
});

console.log('shared: THRESHOLDS (しきい値の一元管理):');

test('しきい値が3種そろっていて正の整数', () => {
    for (const k of ['dist', 'comp', 'insights']) {
        assert(Number.isInteger(THRESHOLDS[k]) && THRESHOLDS[k] > 0, `THRESHOLDS.${k} が不正`);
    }
    // per-season 向けに引き下げた値。SQL (05_seasons.sql) の get_distribution=50/15・
    // get_comp_insights=10 と一致させること。
    assertEq(THRESHOLDS.dist, 50);
    assertEq(THRESHOLDS.comp, 15);
    assertEq(THRESHOLDS.insights, 10);
});

console.log('shared: sanitizeCharacters (編成の入口検証):');

const validImg = 'a'.repeat(32) + '.webp';
const valid5 = Array.from({ length: 5 }, (_, i) => (i.toString(16).repeat(32)).slice(0, 32) + '.webp');

test('正規の5要素配列はそのまま通す', () => {
    const out = sanitizeCharacters(valid5);
    assertEq(Array.isArray(out), true);
    assertEq(out.length, 5);
});

test('CHAR_IMG_RE は 32桁hex.webp のみ一致', () => {
    assert(CHAR_IMG_RE.test(validImg), '正規名が弾かれた');
    assert(!CHAR_IMG_RE.test('AAAA'.repeat(8) + '.webp'), '大文字hexを通した');
    assert(!CHAR_IMG_RE.test('../secret.webp'), 'パストラバーサルを通した');
    assert(!CHAR_IMG_RE.test(validImg + '"'), '末尾の引用符を通した');
});

test('不正な編成は null (XSSペイロード/要素数違い/型違い)', () => {
    assertEq(sanitizeCharacters(['<img onerror=alert(1)>']), null);
    assertEq(sanitizeCharacters([validImg, validImg, validImg, validImg]), null);   // 4要素
    assertEq(sanitizeCharacters([validImg, validImg, validImg, validImg, validImg, validImg]), null); // 6要素
    assertEq(sanitizeCharacters([validImg, validImg, validImg, validImg, 123]), null); // 非文字列混入
    assertEq(sanitizeCharacters('not-an-array'), null);
    assertEq(sanitizeCharacters(null), null);
    assertEq(sanitizeCharacters([validImg, validImg, validImg, validImg, '"><script>']), null);
});

console.log('シーズン設定の整合性:');

test('raid.json: order は5属性・重複なし / bosses が order を網羅 / season は YYYY-MM で base.version と一致', () => {
    const raid = JSON.parse(readFileSync(join(ROOT, 'data', 'raid.json'), 'utf8'));
    const base = JSON.parse(readFileSync(join(ROOT, 'data', 'base.json'), 'utf8'));
    assertEq(raid.order.length, 5, 'order 5個');
    assertEq(new Set(raid.order).size, 5, 'order 重複なし');
    assert(raid.order.every(a => ATTRS.includes(a)), 'order は正規の属性のみ');
    assert(raid.order.every(a => typeof raid.bosses[a] === 'string' && raid.bosses[a].length > 0), 'bosses が order を網羅');
    assert(/^\d{4}-\d{2}$/.test(raid.season), 'season は YYYY-MM');
    assertEq(raid.season, base.version, 'raid.season は base.version と一致させる');
});

test('クライアントとサーバーのしきい値が一致 (THRESHOLDS ↔ 05_seasons.sql)', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '05_seasons.sql'), 'utf8');
    // get_distribution: case when p_comp_key is null then 50 else 15
    assert(new RegExp(`then\\s+${THRESHOLDS.dist}\\s+else\\s+${THRESHOLDS.comp}`).test(sql),
        `05_seasons.sql の分布閾値が THRESHOLDS.dist(${THRESHOLDS.dist})/comp(${THRESHOLDS.comp}) と一致しない`);
    // get_comp_insights: v_thresh int := 10
    assert(new RegExp(`v_thresh\\s+int\\s*:=\\s*${THRESHOLDS.insights}\\b`).test(sql),
        `05_seasons.sql の編成閾値が THRESHOLDS.insights(${THRESHOLDS.insights}) と一致しない`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
