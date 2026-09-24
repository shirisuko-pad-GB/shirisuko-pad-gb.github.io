#!/usr/bin/env node
// Tesseract.js のアセットを自サイトに同梱する (取得元と版数を固定し、ハッシュを台帳に残す)。
//   node scripts/vendor-tesseract.mjs          # 取得して vendor/tesseract-<ver>/ と manifest.json を書く
//   node scripts/vendor-tesseract.mjs --check  # 手元のファイルが台帳のハッシュと一致するか (tests も同じ検査をする)
//   node scripts/vendor-tesseract.mjs --accept-new  # 上流を意図的に更新するとき (新ハッシュを EXPECTED_SHA256 へ)
//
// なぜ同梱するか (Codex監査 2026-09-24・High): CDN から実行時に読むと、CDN/パッケージが
// 汚染されたときにページ全権 (選んだ画像・入力・Supabase の公開キー経路) を渡してしまう。
// 版数固定 (@5.1.1) は「どの版を頼むか」を決めるだけでバイト列は検証しない。
// worker/core/言語データはライブラリが内部で URL 取得するため SRI も効かない → 自サイト配信が唯一の解。
//
// 同梱するもの (createWorker('eng', 1 = LSTM_ONLY) が実際に読むファイルだけ):
//   tesseract.min.js / worker.min.js …… 本体とワーカー
//   tesseract-core-simd-lstm.wasm.js …… WebAssembly SIMD 対応端末用 (iOS 16.4+ / Chrome 91+)
//   tesseract-core-lstm.wasm.js …………… 非 SIMD 端末用 (iOS 15 系など)。無いと旧端末で読めない
//   eng.traineddata.gz (4.0.0_fast) …… 英語データの軽量版 (標準版 11MB と精度が同じだった)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TESS_VERSION = '5.1.1';
export const VENDOR_DIR = `vendor/tesseract-${TESS_VERSION}`;
const SOURCES = {
    'tesseract.min.js': `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`,
    'worker.min.js': `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`,
    'tesseract-core-simd-lstm.wasm.js': `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}/tesseract-core-simd-lstm.wasm.js`,
    'tesseract-core-lstm.wasm.js': `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}/tesseract-core-lstm.wasm.js`,
    'eng.traineddata.gz': 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz',
};
// 取得したバイト列に期待する SHA-256 (レビュー済みの値をここで固定する — Codex指摘)。
// 取得時にこれと突き合わせ、違えば書き込まない。上流を意図的に更新するときだけ --accept-new で
// 新しい値を受け入れ、表示されたハッシュをこの表に貼り直してコミットする (manifest は実行時/テスト用の写し)
const EXPECTED_SHA256 = {
    'tesseract.min.js': 'a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8',
    'worker.min.js': 'aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc',
    'tesseract-core-simd-lstm.wasm.js': 'ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf',
    'tesseract-core-lstm.wasm.js': '8f04aa0cc81e7bde33f80e92fa01a7a665f0b4884d098acf5de9c7104a11dfaa',
    'eng.traineddata.gz': '18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b',
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const dir = join(ROOT, VENDOR_DIR);
const manifestPath = join(dir, 'manifest.json');

if (process.argv.includes('--check')) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    let bad = 0;
    for (const [name, meta] of Object.entries(m.files)) {
        const p = join(dir, name);
        const h = existsSync(p) ? sha256(readFileSync(p)) : null;
        const ok = h === meta.sha256;
        if (!ok) bad++;
        console.log(`  ${ok ? '✓' : '✗'} ${name}  ${h ? h.slice(0, 12) : '(なし)'}${ok ? '' : ` ≠ 台帳 ${meta.sha256.slice(0, 12)}`}`);
    }
    process.exit(bad ? 1 : 0);
}

const ACCEPT_NEW = process.argv.includes('--accept-new');
mkdirSync(dir, { recursive: true });
const files = {};
const fetched = {};
for (const [name, url] of Object.entries(SOURCES)) {
    const res = await fetch(url);
    if (!res.ok) { console.error(`✗ ${name}: ${res.status} ${url}`); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());
    const h = sha256(buf);
    if (EXPECTED_SHA256[name] && EXPECTED_SHA256[name] !== h && !ACCEPT_NEW) {
        console.error(`✗ ${name}: 上流のハッシュが期待値と違います (期待 ${EXPECTED_SHA256[name].slice(0, 12)} / 取得 ${h.slice(0, 12)})。`);
        console.error('  上流が差し替わっています。意図した更新なら --accept-new を付け、表示されたハッシュを EXPECTED_SHA256 に貼り直してください。何も書き込みません');
        process.exit(1);
    }
    fetched[name] = { buf, h, url };
}
// 全部の照合が通ってから書く (途中で止まって古い/新しいが混ざらないように)
for (const [name, { buf, h, url }] of Object.entries(fetched)) {
    writeFileSync(join(dir, name), buf);
    files[name] = { bytes: buf.length, sha256: h, source: url };
    console.log(`  ✓ ${name}  ${(buf.length / 1048576).toFixed(2)} MB  ${h.slice(0, 12)}${EXPECTED_SHA256[name] === h ? '' : '  (新しいハッシュ — EXPECTED_SHA256 を更新すること)'}`);
}
writeFileSync(manifestPath, JSON.stringify({
    _readme: 'scripts/vendor-tesseract.mjs の生成物。取得元・版数・SHA-256 の台帳。tests/run-tests.mjs が手元のファイルと突き合わせる (差し替え検知)。手で編集しない',
    version: TESS_VERSION,
    fetchedAt: new Date().toISOString().slice(0, 10),
    files,
}, null, 2) + '\n');
console.log(`\n${VENDOR_DIR}/manifest.json を書きました (合計 ${(Object.values(files).reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1)} MB)`);
