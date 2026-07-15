#!/usr/bin/env node
// 常設 E2E ハーネス (npm 依存なし)。
//   node tests/e2e.mjs
// 仕組み:
//   1) リポジトリを静的配信 (Node 内蔵 http) + 結果受信用 POST /__result__
//   2) headless Chrome で検査ページを開く。検査ページは iframe に index.html を 375px 幅で載せ
//      (Windows headless は viewport 最小 500px のため iframe 経由で狭幅を再現)、UIを駆動して
//      結果を /__result__ へ POST し返す (dump-dom/virtual-time のタイミング依存を回避)
//   3) サーバーは POST を受けたら Chrome を終了して assert
//
// 実 Supabase に接続して測定→分布ゲート→前回結果の再確認まで通す。
// バックエンド未接続なら送信系は skip 扱い。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.css': 'text/css' };

const HARNESS_HTML = `<!DOCTYPE html><meta charset="utf-8">
<iframe id="f" src="/index.html" style="width:375px;height:2400px;border:0"></iframe>
<script>
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const R = { steps: [] };
const check = (name, cond) => R.steps.push({ name, pass: !!cond });
(async () => {
  const f = document.getElementById('f');
  const reload = () => new Promise(res => { f.onload = () => res(); f.contentWindow.location.reload(); });
  try {
    await wait(1800);
    // 冪等化: 前回実行の保存結果を消す (client_id は残す → 本番の集計票を増やさない)。
    // 消したうえで再読込し、まっさらな初期状態から検証する。
    f.contentWindow.localStorage.removeItem('spg_last_result');
    await reload(); await wait(2000);
    let fw = f.contentWindow, fd = fw.document;
    check('初回バナー非表示', fd.getElementById('recallBanner').style.display === 'none');
    check('属性ボタン5個', fd.querySelectorAll('.atk-card [data-attr]').length === 5);
    check('横オーバーフローなし (375px)', fd.documentElement.scrollWidth <= 375);
    const set = (el, v) => { el.value = v; el.dispatchEvent(new fw.Event('input', { bubbles: true })); };
    set(fd.getElementById('slv'), 544);
    fd.querySelectorAll('.atk-card')[0].querySelector('[data-attr="FIRE"]').click();
    await wait(250);
    set(fd.querySelectorAll('.atk-card')[0].querySelector('.atk-damage'), '13.18');
    await wait(150);
    check('送信ボタン有効化', fd.getElementById('submitBtn').disabled === false);
    fd.getElementById('submitBtn').click();
    await wait(6000);
    const scoreEl = fd.querySelector('.result-card .score-big');
    const errored = [...fd.querySelectorAll('.card h2')].some(h => h.textContent.includes('測定できません'));
    R.backendUp = !errored && !!scoreEl;
    if (R.backendUp) {
      check('スコア 1.00 (基準ダメージ入力)', scoreEl.textContent === '1.00');
      check('分布ゲート表示', /で解禁/.test(fd.querySelector('.result-card')?.textContent || ''));
      check('前回結果を localStorage 保存', !!fw.localStorage.getItem('spg_last_result'));
      await reload(); await wait(2200);
      fw = f.contentWindow; fd = fw.document;
      check('再訪でバナー表示', fd.getElementById('recallBanner').style.display === 'block');
      const rbtn = fd.getElementById('recallBtn');
      check('再確認ボタンあり', !!rbtn);
      if (rbtn) { rbtn.click(); await wait(4500);
        check('再確認で結果を再表示 (新規送信なし)', fd.querySelector('.result-card .score-big')?.textContent === '1.00'); }
    } else {
      R.steps.push({ name: '(バックエンド未接続: 送信系 skip)', skip: true });
    }
    check('DOMに onerror 属性なし (XSS)', !/onerror\\s*=/i.test(fd.body.innerHTML));
  } catch (e) { R.error = String((e && e.stack) || e); }
  try { await fetch('/__result__', { method: 'POST', body: JSON.stringify(R) }); } catch {}
})();
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
    if (url === '/__harness__') { res.setHeader('content-type', 'text/html'); return res.end(HARNESS_HTML); }
    try {
        const p = join(ROOT, decodeURIComponent(url));
        if (!p.startsWith(ROOT) || !existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('content-type', MIME[extname(p)] || 'application/octet-stream');
        res.end(await readFile(p));
    } catch { res.statusCode = 500; res.end('err'); }
});

function findChrome() {
    return [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].filter(Boolean).find(p => existsSync(p));
}

await new Promise(r => server.listen(PORT, r));
const chrome = findChrome();
if (!chrome) { console.error('Chrome/Edge が見つかりません (CHROME_PATH で指定可)'); server.close(); process.exit(2); }

const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--user-data-dir=${join(tmpdir(), 'spg-e2e-' + PORT)}`,
    `http://localhost:${PORT}/__harness__`,
], { windowsHide: true, stdio: 'ignore' });

const timeout = new Promise(r => setTimeout(() => r('__timeout__'), 60000));
const result = await Promise.race([resultReady, timeout]);
try { child.kill(); } catch {}
server.close();

if (result === '__timeout__' || !result) {
    console.error('E2E: タイムアウト/結果回収失敗 (Chrome・ネットワークを確認)');
    process.exit(1);
}

let pass = 0, fail = 0;
for (const s of result.steps) {
    if (s.skip) { console.log(`  ~ ${s.name}`); continue; }
    if (s.pass) { pass++; console.log(`  ✓ ${s.name}`); } else { fail++; console.log(`  ✗ ${s.name}`); }
}
if (result.error) console.error('  ! ' + result.error);
console.log(`\nE2E: ${pass} passed, ${fail} failed${result.backendUp === false ? ' (backend未接続)' : ''}`);
process.exit(fail === 0 && !result.error ? 0 : 1);
