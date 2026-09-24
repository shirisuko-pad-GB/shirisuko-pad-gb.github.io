#!/usr/bin/env node
// スクショ読み取り (js/ocr.js) の実画像テスト — 手元専用。
//   node tests/ocr-local.mjs              # 既定モデルで
//   node tests/ocr-local.mjs --lang fast  # 軽量モデル (4.0.0_fast) で比較
//
// ⚠ フィクスチャ (tests/ocr-fixtures.local/*.jpg) は他の方の名前が写る実スクショなので
//   gitignore 済み・公開リポジトリに入れない。無ければ skip して 0 で終わる。
//   期待値はこのファイルに書く (画像そのものは残さない)。
// 仕組みは e2e.mjs と同じ (静的配信 → headless Chrome → 結果を POST で回収)。
// ⚠ Chrome は CDN (jsdelivr / tessdata) に取りに行くので、ネットワークが要る。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveServable, listenLocal } from '../scripts/lib/local-static.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8933;
const FIX = join(ROOT, 'tests', 'ocr-fixtures.local');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const args = process.argv.slice(2);
const langArg = args[args.indexOf('--lang') + 1];
const LANG_PATH = args.includes('--lang') && langArg === 'fast' ? 'https://tessdata.projectnaptha.com/4.0.0_fast' : null;

// 期待値 (属性・ダメージB)。ファイルが無いものは skip
const EXPECT = {
    'phantom-lv3.jpg': [['WATER', 35.51], ['FIRE', 37.41], ['ELECTRIC', 54.64]],
    'navi01-lv1.jpg': [['IRON', 11.96], ['ELECTRIC', 11.22], ['WIND', 9.49]],
};

if (!existsSync(FIX)) { console.log('ocr-local: フィクスチャ無し (tests/ocr-fixtures.local/) — skip'); process.exit(0); }
const files = readdirSync(FIX).filter(f => /\.(jpe?g|png)$/i.test(f));
if (!files.length) { console.log('ocr-local: 画像が無い — skip'); process.exit(0); }

const HARNESS = `<!DOCTYPE html><meta charset="utf-8"><title>ocr local</title>
<script type="module">
import { readRaidScreenshot } from '/js/ocr.js';
const files = ${JSON.stringify(files)};
const out = [];
for (const f of files) {
  const blob = await (await fetch('/tests/ocr-fixtures.local/' + encodeURIComponent(f))).blob();
  const t0 = performance.now();
  const r = await readRaidScreenshot(blob, { langPath: ${JSON.stringify(LANG_PATH)} ?? undefined });
  out.push({ file: f, ms: Math.round(performance.now() - t0), ...r });
}
// --- UI レベル: index.html の 📷 ボタン経由で凸カードに入るか (1枚目のフィクスチャで) ---
const ui = { file: files[0] };
try {
  const f = document.createElement('iframe'); f.style.cssText = 'width:375px;height:2000px;border:0'; f.src = '/index.html';
  document.body.appendChild(f);
  await new Promise(r => { f.onload = r; });
  await new Promise(r => setTimeout(r, 2000));
  const fw = f.contentWindow, fd = f.contentDocument;
  const set = (el, v) => { el.value = v; el.dispatchEvent(new fw.Event('input', { bubbles: true })); };
  set(fd.getElementById('slv'), 585);
  const blob = await (await fetch('/tests/ocr-fixtures.local/' + encodeURIComponent(files[0]))).blob();
  const dt = new fw.DataTransfer(); dt.items.add(new fw.File([blob], files[0], { type: blob.type || 'image/jpeg' }));
  const input = fd.getElementById('ocrFile'); input.files = dt.files;
  input.dispatchEvent(new fw.Event('change', { bubbles: true }));
  for (let i = 0; i < 180; i++) {   // 最大90秒
    await new Promise(r => setTimeout(r, 500));
    const cards = [...fd.querySelectorAll('.atk-card')];
    const filled = cards.map(c => ({ attr: c.querySelector('.attr-btn.active')?.dataset.attr ?? null, dmg: c.querySelector('.atk-damage')?.value ?? '' }));
    if (filled.length >= 3 && filled.every(x => x.attr && x.dmg)) { ui.cards = filled; break; }
    if (i === 179) ui.cards = filled;
  }
  ui.submitEnabled = !fd.getElementById('submitBtn').disabled;
  ui.resultShown = !!fd.querySelector('.result-card');   // 自動送信していない証拠 (結果カードが出ていない)
  ui.btnLabel = fd.getElementById('ocrBtn').textContent;
} catch (e) { ui.err = String(e && e.message || e); }
await fetch('/__result__', { method: 'POST', body: JSON.stringify({ module: out, ui }) });
</script>`;

let resolveResult;
const resultReady = new Promise(r => (resolveResult = r));
const server = createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/__result__') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => { res.end('ok'); try { resolveResult(JSON.parse(body)); } catch { resolveResult(null); } });
        return;
    }
    if (url === '/__harness__') { res.setHeader('content-type', 'text/html'); return res.end(HARNESS); }
    const file = await resolveServable(ROOT, url);
    if (!file) { res.statusCode = 404; return res.end('not found'); }
    try { res.setHeader('content-type', MIME[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
    catch { res.statusCode = 500; res.end('err'); }
});

function findChrome() {
    return [process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ].filter(Boolean).find(p => existsSync(p));
}

await listenLocal(server, PORT);
const chrome = findChrome();
if (!chrome) { console.error('Chrome/Edge が見つかりません (CHROME_PATH で指定可)'); server.close(); process.exit(2); }
const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--user-data-dir=${join(tmpdir(), 'spg-ocr-local')}`, `http://127.0.0.1:${PORT}/__harness__`], { windowsHide: true, stdio: 'ignore' });
const result = await Promise.race([resultReady, new Promise(r => setTimeout(() => r('__timeout__'), 180000))]);
try { child.kill(); } catch {}
server.close();
if (result === '__timeout__' || !result) { console.error('ocr-local: タイムアウト/結果回収失敗'); process.exit(1); }

let pass = 0, fail = 0;
console.log(`ocr-local (${LANG_PATH ? '軽量 _fast' : '既定'} モデル):`);
const { module: modResults, ui } = result;
for (const r of modResults) {
    const want = EXPECT[r.file];
    const got = r.attacks.map(a => `${a.attribute} ${a.damageB.toFixed(2)}`);
    const wantS = want ? want.map(([a, b]) => `${a} ${b.toFixed(2)}`) : null;
    const ok = wantS ? JSON.stringify(got) === JSON.stringify(wantS) : null;
    const mark = ok === null ? '~' : ok ? '✓' : '✗';
    if (ok === true) pass++; else if (ok === false) fail++;
    console.log(`  ${mark} ${r.file}  ${r.ms}ms  → ${got.join(' / ') || '(読めず)'}${r.warnings.length ? `  [${r.warnings.join(',')}]` : ''}`);
    if (ok === false) console.log(`      期待: ${wantS.join(' / ')}`);
}
// UI: 1枚目のフィクスチャを 📷 ボタン経由で入れ、凸カード3枚が期待どおり埋まるか
{
    const want = EXPECT[ui.file];
    const got = (ui.cards || []).map(c => `${c.attr} ${c.dmg}`);
    const wantS = want ? want.map(([a, b]) => `${a} ${b.toFixed(2)}`) : null;
    // 埋まったら送信ボタンは押せる状態になる (押すのは本人)。自動送信していないことは結果カードが無いことで見る
    const ok = !ui.err && wantS && JSON.stringify(got) === JSON.stringify(wantS) && ui.submitEnabled === true && ui.resultShown === false;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? '✓' : '✗'} UI: 📷 → 凸カードに ${got.join(' / ') || '(空)'}${ui.err ? `  ! ${ui.err}` : ''}`);
    if (!ok && wantS) console.log(`      期待: ${wantS.join(' / ')} / 送信ボタン有効=${ui.submitEnabled} / 自動送信なし(結果カード無し)=${ui.resultShown === false}`);
}
console.log(`\nocr-local: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
