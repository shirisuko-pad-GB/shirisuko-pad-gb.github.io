#!/usr/bin/env node
// クライアント側テスト:  node tests/run-tests.mjs
// ふるり値の計算式はサーバー側 (supabase/02_stats.sql) にしかないため、
// ここでは クライアントユーティリティ と 秘匿データの混入ガード を検証する。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { topPercentFromCounts, ATTRS, BURST_TEMPLATES, templateById, burstMatchesSlot, reslotChars, detectTemplate, parseDamageInput } from '../js/calc.js';
import { escapeHtml, sanitizeCharacters, CHAR_IMG_RE, THRESHOLDS } from '../js/shared.js';
import { makeCharResolver, burstsOf, tileHTML, splitName } from '../js/tiles.js';

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

test('tileHTML: 画像タイルは正規の32hex.webp のときだけ img を出す (id経由XSSガード)', () => {
    // 正規 id + hasImg → 画像タイル
    const ok = tileHTML({ id: 'a'.repeat(32) + '.webp', name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE', hasImg: true });
    assert(/<img class="gb-tile-img" src="\.\/character-images\/a{32}\.webp"/.test(ok), '正規idで画像タイルが出ていない');
    // 壊れた id (属性インジェクション狙い) + hasImg → 画像を出さず自作タイルに落ちる
    const evilId = tileHTML({ id: 'x" onerror="alert(1)', name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE', hasImg: true });
    assert(!evilId.includes('<img'), '不正idで img タグが出てはいけない');
    assert(!evilId.includes('onerror'), 'onerror が素通りしています');
    // hasImg なし → 画像を出さない
    assert(!tileHTML({ id: 'a'.repeat(32) + '.webp', name: 'テスト', burst: 'B1', burstAlt: null, element: 'FIRE' }).includes('<img'),
        'hasImg なしで画像タイルになっている');
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
        assert(/^https:\/\//.test(p.url ?? ''), `partners「${p.name}」の url が https ではありません`);
        if (p.banner != null) assert(/^\.\/assets\//.test(p.banner), `partners「${p.name}」の banner が assets 配下ではありません`);
    }
});

test('キャラ画像の掲載方針 (2026-07-31 削除対応前提) の整合ガード', () => {
    // 属性アイコン等のUI用ゲームアセットは引き続き同梱しない (自作SVG/絵文字のまま)
    assert(!existsSync(join(ROOT, 'assets', 'attr')), 'assets/attr/ が復活しています (UI用ゲームアイコンは同梱禁止)');
    // キャラ画像は「即時撤去レバー + 生成物の整合」を条件に掲載する
    const tiles = readFileSync(join(ROOT, 'js', 'tiles.js'), 'utf8');
    assert(/export const USE_CHAR_IMAGES = (true|false);/.test(tiles),
        'tiles.js に USE_CHAR_IMAGES フラグ (削除要請時の即時撤去レバー) がありません');
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
    // 著作権 + 削除対応の表記: シェアカード (SNS拡散面) と 両ページの footer に焼き込まれている
    const sc = readFileSync(join(ROOT, 'js', 'sharecard.js'), 'utf8');
    assert(sc.includes('© SHIFT UP CORP.'), 'sharecard.js に著作権表記がありません');
    assert(/削除対応|削除・修正/.test(sc), 'sharecard.js に削除対応の明記がありません');
    for (const page of ['index.html', 'stats.html']) {
        const h = readFileSync(join(ROOT, page), 'utf8');
        assert(h.includes('© SHIFT UP CORP.'), `${page} の footer に著作権表記がありません`);
        assert(/削除・修正|速やかに削除/.test(h), `${page} に削除対応の明記がありません`);
    }
});

test('クライアントとサーバーのしきい値が一致 (THRESHOLDS ↔ 集計RPCの最終定義 = 08)', () => {
    // 集計RPCの最終定義は 08_shadow_stats.sql (05 は歴史)。両方に同じ閾値があることを確認
    for (const file of ['05_seasons.sql', '08_shadow_stats.sql']) {
        const sql = readFileSync(join(ROOT, 'supabase', file), 'utf8');
        assert(new RegExp(`then\\s+${THRESHOLDS.dist}\\s+else\\s+${THRESHOLDS.comp}`).test(sql),
            `${file} の分布閾値が THRESHOLDS.dist(${THRESHOLDS.dist})/comp(${THRESHOLDS.comp}) と一致しない`);
        assert(new RegExp(`v_thresh\\s+int\\s*:=\\s*${THRESHOLDS.insights}\\b`).test(sql),
            `${file} の編成閾値が THRESHOLDS.insights(${THRESHOLDS.insights}) と一致しない`);
    }
});

test('08_shadow_stats: シャドウ除外と score_bounds 既定値の整合', () => {
    const sql = readFileSync(join(ROOT, 'supabase', '08_shadow_stats.sql'), 'utf8');
    // 両RPCとも「per-client ベスト選抜の前」に妥当範囲でフィルタしていること (位置まで検査 —
    // 集約後に移すと荒らし票が本人の正当票を隠すため、出現数だけでなく順序を見る)
    // 冒頭コメントにも関数名が出るため、関数定義行をアンカーに切り出す
    const defDist = sql.indexOf('create or replace function public.get_distribution');
    const defIns = sql.indexOf('create or replace function public.get_comp_insights');
    assert(defDist >= 0 && defIns > defDist, '08 に関数定義が見つからない');
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
    assert(!/['"]best['"]/.test(sql), '08 に best (生max) の公開が残っている');
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
    const h1 = idx.match(/<h1>([\s\S]*?)<\/h1>/)?.[1]?.replace(/<[^>]+>/g, '') ?? '';
    assert(h1.includes('しりすこPAD'), `h1 がサイト名になっていません: ${h1}`);
    assert(!h1.includes('ふるり値'), `h1 に「ふるり値」が入っています (サブタイトルに置くこと): ${h1}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
