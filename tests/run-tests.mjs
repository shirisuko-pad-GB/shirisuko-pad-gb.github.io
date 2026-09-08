#!/usr/bin/env node
// クライアント側テスト:  node tests/run-tests.mjs
// ふるり値の計算式はサーバー側 (supabase/02_stats.sql) にしかないため、
// ここでは クライアントユーティリティ と 秘匿データの混入ガード を検証する。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topPercentFromCounts, ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput, damageToBString } from '../js/calc.js';
import { escapeHtml, sanitizeCharacters, CHAR_IMG_RE, THRESHOLDS } from '../js/shared.js';
import { makeCharResolver, burstsOf, tileHTML, splitName, USE_CHAR_IMAGES, charImgSrc, CHAR_ID_RE } from '../js/tiles.js';
import { detectLang, t, _setLangForTest, LANGS, DEFAULT_LANG } from '../js/i18n.js';
import { MESSAGES } from '../js/messages.js';
import { attrName, ATTR_INFO } from '../js/shared.js';

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
    for (const f of ['app.js', 'backend.js', 'calc.js', 'shared.js', 'stats.js', 'sharecard.js', 'tiles.js']) {
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

test('damageToBString: 修正フォーム再充填の往復が正確 (指数表記を出さない)', () => {
    // 通常帯 (最短往復表現)
    assertEq(damageToBString(20e9), '20');
    assertEq(damageToBString(13123456789), '13.123456789');
    // 極小値も指数表記 ("1e-9") にならず parseDamageInput を通る (Codex指摘の端ケース)
    for (const raw of [20e9, 13123456789, 999999999999, 1180000000, 500000, 1000, 999, 1.5, 1]) {
        const s = damageToBString(raw);
        assert(/^\d*\.?\d+$/.test(s), `指数・不正表記になった: ${raw} -> ${JSON.stringify(s)}`);
        const back = parseDamageInput(s);
        assert(back != null && Math.abs(back - raw) < 1e-9 * Math.max(1, raw),
            `往復がズレた: ${raw} -> ${s} -> ${back}`);
    }
    assertEq(damageToBString(0), '');
    assertEq(damageToBString(NaN), '');
});

console.log('バースト編成 (B1/B2/B3/BΛ・サブバースト対応):');

// テスト用: img名から入れる枠の配列を返す ("B1a"→['B1'], "B3B1a"→['B3','B1'], "BΛa"/"??"→null)
const burstsOfImg = (img) => {
    if (img.startsWith('BΛ')) return null;
    const bs = img.match(/B[123]/g);
    return bs && bs.length > 0 ? bs : null;
};

test('テンプレートは全て5枠で、枠は B1/B2/B3/自由(null) のみ', () => {
    assert(BURST_TEMPLATES.length >= 2, 'テンプレートが足りません');
    for (const t of BURST_TEMPLATES) {
        assertEq(t.slots.length, 5, `${t.id} の枠数`);
        for (const s of t.slots) assert(s === null || ['B1', 'B2', 'B3'].includes(s), `${t.id} に不正な枠 ${s}`);
    }
    assertEq(templateById('standard').slots.join(','), 'B1,B2,B3,B3,B3');
    assertEq(templateById('存在しないID').id, BURST_TEMPLATES[0].id, 'フォールバック');
});

test('burstMatchesSlot: Λ・未分類 (null) は全枠OK、確定バーストは一致枠のみ', () => {
    assertEq(burstMatchesSlot(['B1'], 'B1'), true);
    assertEq(burstMatchesSlot(['B1'], 'B3'), false);
    assertEq(burstMatchesSlot(null, 'B1'), true);         // Λ・未分類は弾かない
    assertEq(burstMatchesSlot(['B3', 'B1'], 'B1'), true); // サブバーストの枠もOK
    assertEq(burstMatchesSlot(['B3', 'B1'], 'B2'), false);
    assertEq(burstMatchesSlot(['B2'], null), true);       // 自由枠は何でもOK
});

test('burstsOf (tiles.js): 主+サブの配列 / Λ・未分類は null', () => {
    assertEq(JSON.stringify(burstsOf({ burst: 'B3', burstAlt: 'B1' })), '["B3","B1"]');
    assertEq(JSON.stringify(burstsOf({ burst: 'B2', burstAlt: null })), '["B2"]');
    assertEq(burstsOf({ burst: 'BΛ', burstAlt: null }), null);
    assertEq(burstsOf({ burst: null, burstAlt: null }), null);
    assertEq(burstsOf(null), null);
});

test('reslotChars: B1B2B3B3B3 テンプレに正しく配置される', () => {
    const { slots, dropped } = reslotChars(['B3a', 'B1a', 'B3b', 'B2a', 'B3c'], burstsOfImg, templateById('standard').slots);
    assertEq(slots[0], 'B1a');
    assertEq(slots[1], 'B2a');
    assertEq(slots.slice(2).join(','), 'B3a,B3b,B3c');
    assertEq(dropped.length, 0);
});

test('reslotChars: 枠に収まらないキャラは dropped、Λは空き枠に入る', () => {
    const { slots, dropped } = reslotChars(['B2a', 'B2b', 'BΛa'], burstsOfImg, templateById('standard').slots);
    assertEq(slots[1], 'B2a');
    assert(dropped.includes('B2b'), 'B2 2体目は standard に入らない');
    assert(slots.includes('BΛa'), 'Λ はどこかの枠に入る');
});

test('reslotChars: サブバースト持ちは主の枠を優先し、あぶれたらサブの枠へ', () => {
    // 主B3が空いていれば B3 枠へ (B1枠に吸われない)
    const a = reslotChars(['B3B1a', 'B2a'], burstsOfImg, templateById('standard').slots);
    assertEq(a.slots[2], 'B3B1a', '主バーストの枠を優先する');
    assertEq(a.slots[0], null, 'B1枠は空いたまま');
    // B3枠が全て埋まっていれば B1 枠に落ちる
    const b = reslotChars(['B3a', 'B3b', 'B3c', 'B3B1a', 'B2a'], burstsOfImg, templateById('standard').slots);
    assertEq(b.slots[0], 'B3B1a', 'サブバーストの枠に退避する');
    assertEq(b.dropped.length, 0);
});

test('reslotChars: 貪欲法では落ちる成立配置もバックトラックで見つける (Codex反例)', () => {
    // [B1,B3] [B2,B1] [B2,B1] [B3,B1] [B1,B2] は double2 (B1,B2,B2,B3,B3) に完全配置できる
    const imgs = ['B1B3a', 'B2B1a', 'B2B1b', 'B3B1a', 'B1B2a'];
    const { slots, dropped } = reslotChars(imgs, burstsOfImg, templateById('double2').slots);
    assertEq(dropped.length, 0, `完全配置できるはずが dropped: ${dropped.join(',')}`);
    assertEq(slots.filter(Boolean).length, 5);
    // standard (B2枠1つ) には B2系3体は収まらない → detectTemplate は double2 を選ぶ
    assertEq(detectTemplate(imgs, burstsOfImg), 'double2');
});

test('detectTemplate: 構成からテンプレを自動判定', () => {
    assertEq(detectTemplate(['B1a', 'B2a', 'B3a', 'B3b', 'B3c'], burstsOfImg), 'standard');
    assertEq(detectTemplate(['B1a', 'B2a', 'B2b', 'B3a', 'B3b'], burstsOfImg), 'double2');
    assertEq(detectTemplate(['B1a', 'B1b', 'B1c', 'B1d', 'B1e'], burstsOfImg), 'free');
});

console.log('characters.json v2 (キャラデータ):');

const charData = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));

test('v2形式: chars のID・name・burst・burstAlt・element が正当', () => {
    assertEq(charData._format, 2, '_format が 2 ではありません');
    const entries = Object.entries(charData.chars);
    assert(entries.length >= 190, `キャラ数が少なすぎます (${entries.length})`);
    for (const [id, v] of entries) {
        assert(CHAR_IMG_RE.test(id), `不正なIDキー: ${id}`);
        assert(typeof v.name === 'string' && v.name.length > 0, `${id} に name がありません`);
        assert(v.burst === null || ['B1', 'B2', 'B3', 'BΛ'].includes(v.burst), `${v.name} の burst が不正: ${v.burst}`);
        assert(v.burstAlt === null || ['B1', 'B2', 'B3', 'BΛ'].includes(v.burstAlt), `${v.name} の burstAlt が不正`);
        assert(v.burstAlt === null || v.burstAlt !== v.burst, `${v.name} の burstAlt が主バーストと同じ`);
        assert(v.element === null || ATTRS.includes(v.element), `${v.name} の element が不正: ${v.element}`);
    }
});

test('aliases は全て chars の代表IDを指す', () => {
    for (const [alias, canon] of Object.entries(charData.aliases)) {
        assert(CHAR_IMG_RE.test(alias), `不正な別名ID: ${alias}`);
        assert(charData.chars[canon], `別名 ${alias} の参照先 ${canon} が存在しません`);
    }
});

test('makeCharResolver: 代表ID/別名IDを解決し、未知IDは null', () => {
    const infoOf = makeCharResolver(charData);
    const [canonId, v] = Object.entries(charData.chars)[0];
    assertEq(infoOf(canonId)?.name, v.name);
    const aliasEntry = Object.entries(charData.aliases)[0];
    if (aliasEntry) assertEq(infoOf(aliasEntry[0])?.id, aliasEntry[1], '別名IDが代表IDに解決される');
    assertEq(infoOf('f'.repeat(32) + '.webp'), null);
});

test('BΛ はレッドフードのみ (1キャラ限定の特殊仕様)', () => {
    const lambdaNames = new Set(Object.values(charData.chars).filter(v => v.burst === 'BΛ').map(v => v.name));
    assertEq(lambdaNames.size, 1, `BΛ キャラが複数います: ${[...lambdaNames].join(', ')}`);
    assert([...lambdaNames][0].includes('レッドフード'), `BΛ がレッドフードではありません: ${[...lambdaNames][0]}`);
});

test('element-map.json: 属性キーが正当で、同じ名前が複数属性に居ない', () => {
    const em = JSON.parse(readFileSync(join(ROOT, 'data', 'element-map.json'), 'utf8'));
    const seen = new Map();
    for (const attr of ATTRS) {
        assert(Array.isArray(em[attr]), `element-map に ${attr} がありません`);
        for (const name of em[attr]) {
            assert(!seen.has(name), `「${name}」が ${seen.get(name)} と ${attr} の両方にいます`);
            seen.set(name, attr);
        }
    }
    assert(seen.size >= 190, `属性表の件数が少なすぎます (${seen.size})`);
});

console.log('tiles.js (自作キャラタイル):');

test('tileHTML: キャラ名のXSSペイロードが無害化される', () => {
    const evil = { id: 'a'.repeat(32) + '.webp', name: '<img src=x onerror=alert(1)>：<script>', burst: 'B3', burstAlt: null, element: 'FIRE' };
    const html = tileHTML(evil);
    assert(!html.includes('<script'), 'scriptタグが素通りしています');
    assert(html.includes('&lt;'), 'エスケープされていません');
});

// ★ 権利方針 (2026-08-31): takedown 方式で掲載中。フラグの値はここでは固定しない —
//   撤去要請が来たとき「USE_CHAR_IMAGES = false の1行 push」だけで CI が通り即日デプロイ
//   できることが最優先 (README「撤去手順」)。代わりに、どちらの値でも表示が矛盾しないことを見る
test('tileHTML: 画像はフラグON かつ 正規id かつ hasImg のときだけ出る (id経由XSSガード込み)', () => {
    const okId = 'a'.repeat(32) + '.webp';
    const ok = tileHTML({ id: okId, name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE', hasImg: true });
    if (USE_CHAR_IMAGES) {
        assert(ok.includes('<img') && ok.includes(`./character-images/${okId}`), '掲載中なのに正規idで画像タイルが出ない');
        assertEq(charImgSrc({ id: okId, hasImg: true }), `./character-images/${okId}`, 'charImgSrc が画像パスを返さない');
    } else {
        assert(!ok.includes('<img'), '掲載停止中なのに画像タイルが出ている');
        assert(ok.includes('gb-tile-base'), '自作タイルへフォールバックしていない');
        assertEq(charImgSrc({ id: okId, hasImg: true }), null, '掲載停止中に charImgSrc が src を返している');
    }
    // hasImg なしはフラグに関係なく自作タイル
    const noImg = tileHTML({ id: okId, name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE' });
    assert(!noImg.includes('<img') && noImg.includes('gb-tile-base'), 'hasImg なしで画像タイルが出ている');
    // 壊れた id (属性インジェクション狙い) → フラグに関係なく画像を出さず自作タイルに落ちる
    const evilId = tileHTML({ id: 'x" onerror="alert(1)', name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE', hasImg: true });
    assert(!evilId.includes('<img'), '不正idで img タグが出てはいけない');
    assert(!evilId.includes('onerror'), 'onerror が素通りしています');
    assertEq(charImgSrc({ id: 'x" onerror="alert(1)', hasImg: true }), null, '不正idで charImgSrc が src を返している');
    assert(!CHAR_ID_RE.test('x" onerror="alert(1)'), '不正idが id 形式ガードを通過している');
    assert(!CHAR_ID_RE.test('../../etc/passwd.webp'), 'パス混入が id 形式ガードを通過している');
    assert(CHAR_ID_RE.test(okId), '正規idが弾かれている');
});

test('tileHTML: 未知キャラ・属性未分類はグレーの安全表示', () => {
    assert(tileHTML(null).includes('gb-tile--unknown'), '未知IDがunknown表示にならない');
    const noEl = tileHTML({ name: 'テスト', burst: 'B1', burstAlt: null, element: null });
    assert(noEl.includes('gb-tile--unknown') && noEl.includes('属性？'), '属性未分類の表示がない');
});

test('splitName: 全角/半角コロンで衣装違いを分離', () => {
    assertEq(splitName('ヘルム：アクアマリン').base, 'ヘルム');
    assertEq(splitName('ヘルム：アクアマリン').variant, 'アクアマリン');
    assertEq(splitName('ラピ:レッドフード').variant, 'レッドフード');
    assertEq(splitName('アリス').variant, null);
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

test('raid.json のボス名が本家の登場履歴 (boss-catalog) に実在する', () => {
    const raid = JSON.parse(readFileSync(join(ROOT, 'data', 'raid.json'), 'utf8'));
    const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'boss-catalog.json'), 'utf8'));
    for (const [attr, name] of Object.entries(raid.bosses)) {
        assert(catalog.bosses[name], `${attr} のボス「${name}」が boss-catalog にありません (typoの可能性。新ボスなら new-season.mjs を再実行)`);
    }
});

test('site.json: xAccount の形式と recruit の構造', () => {
    const site = JSON.parse(readFileSync(join(ROOT, 'data', 'site.json'), 'utf8'));
    assert(site.xAccount === '' || /^[A-Za-z0-9_]{1,15}$/.test(site.xAccount),
        `xAccount が不正です (英数字と_のみ・@なし): ${site.xAccount}`);
    assert(typeof site.recruit?.enabled === 'boolean', 'recruit.enabled が boolean ではありません');
    assert(typeof site.recruit?.title === 'string', 'recruit.title がありません');
    assert(typeof site.recruit?.note === 'string', 'recruit.note がありません');
    // partners (任意): name 必須・url は https のみ・banner は assets/ 配下のみ
    for (const p of site.partners ?? []) {
        assert(typeof p.name === 'string' && p.name, 'partners[].name がありません');
        assert(typeof p.url === 'string' && /^https:\/\//.test(p.url), `partners「${p.name}」の url が https 文字列ではありません`);
        if (p.banner != null) {
            // 実装 (js/app.js renderPartners) と同じ許可条件
            assert(typeof p.banner === 'string' && !p.banner.includes('..')
                && /^\.\/assets\/[\w./-]+\.(png|webp|jpg|jpeg)$/.test(p.banner),
                `partners「${p.name}」の banner が許可形式ではありません (./assets/ 配下の png/webp/jpg のみ・.. 禁止)`);
        }
    }
});

test('キャラ画像アセットの整合ガード (hasImg ↔ character-images/ の一致・撤去レバー・権利表記)', () => {
    // 属性アイコン等のUI用ゲームアセットは引き続き同梱しない (自作SVG/絵文字のまま)
    assert(!existsSync(join(ROOT, 'assets', 'attr')), 'assets/attr/ が復活しています (UI用ゲームアイコンは同梱禁止)');
    // 掲載可否のレバー (撤去レバー) は常に存在すること (値は固定しない — 上の権利方針コメント参照)
    const tiles = readFileSync(join(ROOT, 'js', 'tiles.js'), 'utf8');
    assert(/export const USE_CHAR_IMAGES = (true|false);/.test(tiles),
        'tiles.js に USE_CHAR_IMAGES フラグ (掲載可否のレバー) がありません');
    // レバーに連動すべき経路: build (false なら画像を出力しない) と recap ツール (false なら顔画像を読まない)
    const build = readFileSync(join(ROOT, 'scripts', 'build-characters.mjs'), 'utf8');
    assert(/USE_CHAR_IMAGES = \/\^export const USE_CHAR_IMAGES = true;\\r\?\$\/m\.test\(/.test(build),
        'build-characters.mjs が tiles.js の USE_CHAR_IMAGES を読んでいません (撤去時に画像を再コピーしてしまう)');
    const recap = readFileSync(join(ROOT, 'tools', 'recap.html'), 'utf8');
    assert(/import \{[^}]*\bUSE_CHAR_IMAGES\b[^}]*\} from '\.\.\/js\/tiles\.js'/.test(recap) && /if \(!USE_CHAR_IMAGES\) return false;/.test(recap),
        'tools/recap.html が USE_CHAR_IMAGES に連動していません (撤去後も ?art=1 で顔画像が出る)');
    const charData = JSON.parse(readFileSync(join(ROOT, 'data', 'characters.json'), 'utf8'));
    const files = existsSync(join(ROOT, 'character-images'))
        ? readdirSync(join(ROOT, 'character-images')).filter(f => f.endsWith('.webp')) : [];
    for (const f of files) {
        assert(/^[0-9a-f]{32}[.]webp$/.test(f), `character-images/${f} が 32hex.webp 形式ではありません`);
        assert(charData.chars[f]?.hasImg, `character-images/${f} が characters.json の hasImg と対応していません (孤児ファイル)`);
    }
    for (const [id, c] of Object.entries(charData.chars)) {
        if (c.hasImg) assert(files.includes(id), `hasImg の ${c.name} (${id}) の画像ファイルがありません`);
    }
    // 著作権 + 削除対応の表記: シェアカード (SNS拡散面) と 両ページの footer に焼き込まれている。
    // カードの文言は辞書 (messages.js) にあるので、**両言語ぶん**を見る —
    // 英語のカードだけ権利表記が抜ける、が takedown 方式では致命的
    const sc = readFileSync(join(ROOT, 'js', 'sharecard.js'), 'utf8');
    assert(/t\('card\.copyright'\)/.test(sc), 'sharecard.js が権利表記を描いていません');
    assert(/t\('card\.fanmade'\)/.test(sc), 'sharecard.js が削除対応の表記を描いていません');
    for (const lang of LANGS) {
        const m = MESSAGES[lang];
        assert(m['card.copyright']?.includes('© SHIFT UP CORP.'),
            `${lang} のカード権利表記に著作権表記がありません`);
        assert(m['card.fanmade'], `${lang} のカードに «非公式・削除対応» の表記がありません`);
    }
    // 日本語は従来どおり「削除対応」、英語は removed on request の言い回しで同義
    assert(/削除対応|削除・修正/.test(MESSAGES.ja['card.fanmade']), 'ja の削除対応の明記がありません');
    assert(/remov/i.test(MESSAGES.en['card.fanmade']), 'en の削除対応の明記がありません');
    for (const page of ['index.html', 'stats.html']) {
        const h = readFileSync(join(ROOT, page), 'utf8');
        assert(h.includes('© SHIFT UP CORP.'), `${page} の footer に著作権表記がありません`);
        assert(/削除・修正|速やかに削除/.test(h), `${page} に削除対応の明記がありません`);
    }
});

test('クライアントとサーバーのしきい値が一致 (THRESHOLDS ↔ 集計RPCの最終定義 = 09)', () => {
    // 集計RPCの最終定義は 09_finish_flag.sql (05/08 は歴史)。全てに同じ閾値があることを確認
    for (const file of ['05_seasons.sql', '08_shadow_stats.sql', '09_finish_flag.sql']) {
        const sql = readFileSync(join(ROOT, 'supabase', file), 'utf8');
        assert(new RegExp(`then\\s+${THRESHOLDS.dist}\\s+else\\s+${THRESHOLDS.comp}`).test(sql),
            `${file} の分布閾値が THRESHOLDS.dist(${THRESHOLDS.dist})/comp(${THRESHOLDS.comp}) と一致しない`);
        assert(new RegExp(`v_thresh\\s+int\\s*:=\\s*${THRESHOLDS.insights}\\b`).test(sql),
            `${file} の編成閾値が THRESHOLDS.insights(${THRESHOLDS.insights}) と一致しない`);
    }
});

// シャドウ除外の構造検査 (08 で導入・09 が最終定義 — 両方が同じ構造を保つこと)
for (const file of ['08_shadow_stats.sql', '09_finish_flag.sql']) {
    test(`${file}: シャドウ除外と score_bounds 既定値の整合`, () => {
        const sql = readFileSync(join(ROOT, 'supabase', file), 'utf8');
        // 両RPCとも「per-client ベスト選抜の前」に妥当範囲でフィルタしていること (位置まで検査 —
        // 集約後に移すと荒らし票が本人の正当票を隠すため、出現数だけでなく順序を見る)
        // 冒頭コメントにも関数名が出るため、関数定義行をアンカーに切り出す
        const defDist = sql.indexOf('create or replace function public.get_distribution');
        const defIns = sql.indexOf('create or replace function public.get_comp_insights');
        assert(defDist >= 0 && defIns > defDist, `${file} に関数定義が見つからない`);
        const dist = sql.slice(defDist, defIns);
        const ins = sql.slice(defIns);
        const before = (part, label, anchor) => {
            const f = part.indexOf('between v_min and v_max');
            const a = part.indexOf(anchor);
            assert(f >= 0, `${label}: シャドウ除外が無い`);
            assert(a >= 0 && f < a, `${label}: シャドウ除外が per-client 選抜 (${anchor}) より後にある`);
        };
        before(dist, 'get_distribution', 'group by client_id');
        before(ins, 'get_comp_insights', 'order by client_id, norm_damage desc');
        // フォールバック既定 [0.01, 5.0] がテーブル既定と一致
        assert(sql.includes("coalesce(b.min_score, 0.01)") && sql.includes("coalesce(b.max_score, 5.0)"),
            'フォールバック既定が [0.01, 5.0] ではない');
        // 「最高」(生max) を公開しない
        assert(!/['"]best['"]/.test(sql), `${file} に best (生max) の公開が残っている`);
    });
}

test('09_finish_flag: 締め凸の除外・互換・データ保全', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '09_finish_flag.sql'), 'utf8');
    // 追加のみのマイグレーション (既存データを消す・書き換える文が無いこと)
    assert(/add column if not exists is_finish boolean not null default false/.test(sql),
        'is_finish の追加が additive (default false) でない');
    assert(!/\b(drop|truncate|delete\s+from|update\s+public\.measurements)\b/i.test(sql),
        '09 に破壊的な文が含まれている');
    // 両集計RPCが締め凸を除外している (per-client 選抜より前)
    const defDist = sql.indexOf('create or replace function public.get_distribution');
    const defIns = sql.indexOf('create or replace function public.get_comp_insights');
    const dist = sql.slice(defDist, defIns);
    const ins = sql.slice(defIns);
    for (const [part, label, anchor] of [[dist, 'get_distribution', 'group by client_id'],
                                         [ins, 'get_comp_insights', 'order by client_id, norm_damage desc']]) {
        // 行頭の実述語のみマッチ (コメント中の言及では通らないように — Codex指摘)
        const m = /^\s*and not is_finish\b/m.exec(part);
        assert(m, `${label}: 締め凸除外の述語 (and not is_finish) が無い`);
        assert(m.index < part.indexOf(anchor), `${label}: 締め凸除外が per-client 選抜より後にある`);
    }
    // submit は is_finish 省略時 false (旧クライアント互換)
    assert(/coalesce\(\(v_row ->> 'is_finish'\)::boolean, false\)/.test(sql),
        'submit の is_finish が省略時 false になっていない');
    // 中央値TOPは10件・エラーDETAIL落とし (07由来) を維持
    assert(/order by med desc limit 10/.test(sql), '中央値TOPが10件になっていない');
    assert(/exception when others then/.test(sql) && /sqlerrm/.test(sql),
        '07のエラーDETAIL落としが 09 の submit に引き継がれていない');
});

test('11_total_distribution: 読み取り専用 + 除外フィルタの位置 + 母集団=有効3凸以上', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '11_total_distribution.sql'), 'utf8');
    // 読み取り専用 (書き込み・スキーマ変更を含まない)。
    // drop は「自関数の旧シグネチャ掃除 (drop function if exists get_total_distribution)」のみ許可
    assert(!/\b(insert into|update |delete from|alter table|truncate)\b/i.test(sql),
        '11 に書き込み・スキーマ変更が含まれている');
    const drops = sql.match(/drop\s+[^;]+/gi) || [];
    assert(drops.every(d => /^drop function if exists public\.get_total_distribution/i.test(d)),
        '想定外の drop 文がある');
    assert(/returns json language plpgsql stable/.test(sql), 'stable (読み取り専用) 宣言が無い');
    // 締め凸・シャドウ除外が per-client ベスト選抜 (group by) より前にある
    const f1 = /^\s*and not m\.is_finish\b/m.exec(sql);
    const f2 = sql.indexOf('between bounds.mn and bounds.mx');
    const g = sql.indexOf('group by m.client_id, m.attribute');
    assert(f1 && f2 >= 0 && g >= 0 && f1.index < g && f2 < g,
        '除外フィルタが per-client ベスト選抜より後にある');
    // 母集団 = 有効な凸が3属性以上の人だけ
    assert(/where atk >= 3/.test(sql), '母集団の「有効3凸以上」条件が無い');
    // 本人の位置はサーバーが client_id から計算 (クライアント計算値を信用しない)
    assert(/client_id = p_client_id/.test(sql), '本人の総合がサーバー計算になっていない');
    // 基準不完全な seed ではフェイルクローズ (部分集計を返さない)
    assert(/incomplete bases for season/.test(sql), '基準欠落時のフェイルクローズが無い');
    // PUBLIC の既定 execute を剥がし anon にだけ grant
    assert(/revoke all on function public\.get_total_distribution.* from public/.test(sql) &&
           /grant execute on function public\.get_total_distribution.* to anon/.test(sql),
        'revoke/grant が正しくない');
});

test('10_own_edits: 自分の行しか触れない (client_idスコープ) + 原子的置き換え', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '10_own_edits.sql'), 'utf8');
    // 新規RPCのみ (スキーマ変更・既存RPCの上書きを含まない)
    assert(!/\b(alter table|drop |truncate)\b/i.test(sql), '10 にスキーマ変更が含まれている');
    assert(!/create or replace function public\.(submit_measurements|get_distribution|get_comp_insights)\b/.test(sql),
        '10 が既存RPCを上書きしている');
    // UPDATE (mark_own_finish) は client_id + season + attribute の3条件必須
    const upd = /update public\.measurements[\s\S]*?where([\s\S]*?);/.exec(sql);
    assert(upd && ['client_id = p_client_id', 'season = p_season', 'attribute = p_attribute']
        .every(c => upd[1].includes(c)), 'mark_own_finish の UPDATE が3条件で絞られていない');
    // DELETE (correct) も3条件必須 — これが欠けると他人の行を消せてしまう
    const del = /delete from public\.measurements[\s\S]*?where([\s\S]*?);/.exec(sql);
    assert(del && ['client_id = v_client', 'season = v_active', 'attribute = v_attr']
        .every(c => del[1].includes(c)), 'correct の DELETE が3条件で絞られていない');
    // シーズン open チェックが両RPCにある
    assert((sql.match(/submissions are closed/g) || []).length >= 2, 'open チェックが両RPCに揃っていない');
    // INSERT は 07 と同じ例外ハンドラ (DETAIL漏洩ガード + 失敗時ロールバックで元の行が残る)
    assert(/exception when others then[\s\S]*?sqlerrm/.test(sql), 'correct の INSERT が例外ハンドラで包まれていない');
    // grant は anon への execute のみ + PUBLIC の既定 execute を明示的に剥がす (Codex指摘)
    assert((sql.match(/grant execute on function/g) || []).length === 2 && !/grant\s+(all|insert|update|delete)\s+on\s+table/i.test(sql),
        'grant が RPC execute 以外に及んでいる');
    assert((sql.match(/revoke all on function .* from public/g) || []).length === 2,
        'PUBLIC への既定 execute が revoke されていない');
    // correct は既存行がある場合のみ (この RPC で行を新規作成できない = Sybil量産ガード)
    assert(/if v_replaced = 0 then raise exception/.test(sql),
        'correct の「既存行のみ」ガードが無い');
});

test('07: submit の INSERT が例外ハンドラで包まれている (エラーDETAILの行内容漏洩ガード)', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '07_sanitize_errors.sql'), 'utf8');
    // INSERT → exception ハンドラ → sqlerrm 再送出 (DETAIL を落とす) の並びがあること
    assert(/insert into public\.measurements[\s\S]*?exception when others then[\s\S]*?raise exception '%', sqlerrm using errcode = sqlstate/.test(sql),
        '07_sanitize_errors.sql に INSERT の例外ハンドラ (DETAIL 除去) がありません');
    // 05 と同じガードが移植されていること (07 が最終定義なので欠けると機能退行)
    for (const guard of ['submissions are closed', 'invalid batch size', 'client_id required', 'season not open']) {
        assert(sql.includes(guard), `07_sanitize_errors.sql に 05 由来のガード「${guard}」がありません`);
    }
    // 99チェッカーに 07 の判定行があること
    const check = readFileSync(join(ROOT, 'supabase', '99_check_applied.sql'), 'utf8');
    assert(check.includes("'07_sanitize_errors'"), '99_check_applied.sql に 07 の判定行がありません');
});

test('サイト名の整合 (manifest ↔ title ↔ apple-title ↔ h1)', () => {
    const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
    const SITE = 'しりすこPAD GB';
    assertEq(mf.name, SITE, 'manifest.name');
    assertEq(mf.short_name, SITE, 'manifest.short_name');
    for (const page of ['index.html', 'stats.html']) {
        const h = readFileSync(join(ROOT, page), 'utf8');
        const appleTitle = h.match(/name="apple-mobile-web-app-title" content="([^"]+)"/)?.[1];
        assertEq(appleTitle, SITE, `${page} apple-mobile-web-app-title`);
        const title = h.match(/<title>([^<]+)<\/title>/)?.[1] ?? '';
        assert(title.includes('しりすこPAD'), `${page} の <title> にサイト名がありません: ${title}`);
    }
    // トップの主役はサイト名・「ふるり値チェッカー」はサブ (h1 に入れない)
    const idx = readFileSync(join(ROOT, 'index.html'), 'utf8');
    // h1 は英語対応で data-i18n-html 属性を持つので、タグの属性は問わない
    const h1 = idx.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, '') ?? '';
    assert(h1.includes('しりすこPAD'), `h1 がサイト名になっていません: ${h1}`);
    assert(!h1.includes('ふるり値'), `h1 に「ふるり値」が入っています (サブタイトルに置くこと): ${h1}`);
});

console.log('\n表示言語 (英語対応):');

test('言語の決め方: URL > 保存値 > 端末 > 既定', () => {
    // 共有リンク (?lang=en) が最優先 — 英語圏の人に渡したリンクは英語で開く
    assertEq(detectLang('?lang=en', 'ja', 'ja-JP'), 'en', 'URL が最優先');
    assertEq(detectLang('?lang=ja', 'en', 'en-US'), 'ja', 'URL が最優先(逆)');
    // URL に無ければ、前に選んだ言語
    assertEq(detectLang('', 'en', 'ja-JP'), 'en', '保存値');
    // どちらも無ければ端末の言語。日本語圏だけ ja で、他は英語に寄せる
    assertEq(detectLang('', null, 'ja-JP'), 'ja', '端末 ja');
    assertEq(detectLang('', null, 'en-US'), 'en', '端末 en');
    assertEq(detectLang('', null, 'ko-KR'), 'en', '日本語以外は英語');
    assertEq(detectLang('', null, ''), DEFAULT_LANG, '情報なしは既定');
    // 知らない値は無視して次の手段へ落ちる (?lang=xx で壊れない)
    assertEq(detectLang('?lang=xx', null, 'ja-JP'), 'ja', '未知の lang は無視');
    assertEq(detectLang('?lang=en', 'zzz', ''), 'en', '壊れた保存値でも動く');
});

test('t(): 訳・差し込み・単複・未訳のフォールバック', () => {
    _setLangForTest('en');
    assertEq(t('card.overall'), 'Overall', '英訳');
    assertEq(t('card.fururi_val', { v: '1.23' }), 'Fururi 1.23', '差し込み');
    assertEq(t('card.users_n', { n: 1 }), '1 user', '単数');
    assertEq(t('card.users_n', { n: 5 }), '5 users', '複数');
    // 鍵ごと無ければ鍵をそのまま返す (未訳が画面で目立ち、気づける)
    assertEq(t('does.not.exist'), 'does.not.exist', '未知の鍵');
    _setLangForTest('ja');
    assertEq(t('card.overall'), '総合', '日本語に戻る');
    assertEq(t('common.refreshing'), '更新中…', 'ja の値');
});

test('属性名が言語で切り替わる (ATTR_INFO の全キーに訳がある)', () => {
    for (const key of Object.keys(ATTR_INFO)) {
        _setLangForTest('ja');
        assertEq(attrName(key), ATTR_INFO[key].jp, `ja ${key}`);
        _setLangForTest('en');
        const en = attrName(key);
        assert(/^[A-Za-z]+$/.test(en), `en ${key} が英語になっていない: ${en}`);
    }
    _setLangForTest('ja');
    assertEq(attrName('SOMETHING'), '属性？', '知らないキーは落とす');
});

test('辞書: en の鍵は ja にも必ずある (綴り間違いの検出)', () => {
    const ja = new Set(Object.keys(MESSAGES.ja));
    const orphan = Object.keys(MESSAGES.en).filter((k) => !ja.has(k));
    assertEq(orphan.length, 0, `ja に無い鍵が en にあります: ${orphan.join(', ')}`);
    for (const lang of LANGS) assert(MESSAGES[lang], `辞書に ${lang} がありません`);
});

test('辞書: 差し込み {name} が ja と en で食い違わない', () => {
    // 片方だけ {n} を書き忘れると、英語だけ数字が消える (画面では気づきにくい)
    const holes = (v) => {
        const text = (v && typeof v === 'object') ? Object.values(v).join(' ') : String(v ?? '');
        return new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    };
    const bad = [];
    for (const [key, en] of Object.entries(MESSAGES.en)) {
        const a = holes(MESSAGES.ja[key]);
        const b = holes(en);
        if (a.size !== b.size || [...a].some((x) => !b.has(x))) {
            bad.push(`${key} (ja:${[...a]} / en:${[...b]})`);
        }
    }
    assertEq(bad.length, 0, `差し込みが食い違う鍵: ${bad.join(' , ')}`);
});

test('辞書: HTML の data-i18n が指す鍵が実在する', () => {
    // 鍵の綴りを間違えると t() は «鍵そのもの» を返す = 画面に 'ui.submit' と出てしまう。
    // 静的文言は起動時に一括で差し替わるので、綴り違いはページ全体に一気に出る
    const missing = [];
    for (const page of ['index.html', 'stats.html']) {
        const h = readFileSync(join(ROOT, page), 'utf8');
        const keys = [
            ...[...h.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]),
            ...[...h.matchAll(/data-i18n-html="([^"]+)"/g)].map((m) => m[1]),
            // data-i18n-attr="placeholder:ui.slv_ph alt:ui.card_alt" → 鍵だけ取り出す
            ...[...h.matchAll(/data-i18n-attr="([^"]+)"/g)]
                .flatMap((m) => m[1].split(/\s+/).map((p) => p.slice(p.indexOf(':') + 1))),
        ];
        assert(keys.length > 0, `${page} に data-i18n がありません (置換の取りこぼし?)`);
        for (const k of keys) {
            for (const lang of LANGS) {
                if (MESSAGES[lang][k] === undefined) missing.push(`${page}: ${k} (${lang})`);
            }
        }
    }
    assertEq(missing.length, 0, `辞書に無い鍵を HTML が指しています: ${missing.join(' , ')}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
