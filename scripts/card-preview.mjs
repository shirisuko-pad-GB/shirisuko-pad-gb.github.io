#!/usr/bin/env node
// シェアカードの見た目を PNG に落とす (目視確認用)。
//   node scripts/card-preview.mjs            # ja と en の両方
//   node scripts/card-preview.mjs en         # 片方だけ
//
// **なぜ要るか**: カードは 1200x800 の固定レイアウトで、4列のときは1列 209px しかない。
// 英語は同じ意味でも 1.5〜2倍長いので、日本語で組んだ座標に流すと溢れる。
// 単体テストでは «描いた絵» が分からないため、実ブラウザで描いて画像で見る。
// (e2e.mjs と同じ仕組み: 静的配信 → headless Chrome → 結果を POST で回収)
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveServable, listenLocal } from './lib/local-static.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8932;
const OUT = process.env.CARD_OUT || ROOT;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.css': 'text/css' };

const langs = process.argv[2] ? [process.argv[2]] : ['ja', 'en'];

// 見た目が一番厳しい形を作る: 3凸 + 総合列 (= 1列 209px) で、
// 締め凸あり・編成あり・分布は解禁済みと未解禁の両方を混ぜる。
const MOCK = `
const bins = [2, 6, 14, 22, 31, 25, 17, 9, 4, 1];
const chars = window.__CHARS__;
const results = [
    { attribute: 'IRON', score: 1.24, damage: 22.0e9, slv: 585, isFinish: false,
      characters: chars.slice(0, 5),
      dist: { gated: false, bins, median: 1.08, n: 214, my_bin: 6 },
      compDist: { gated: false, median: 1.15, n: 31 } },
    { attribute: 'WATER', score: 0.92, damage: 18.3e9, slv: 585, isFinish: false,
      characters: chars.slice(5, 10),
      dist: { gated: false, bins, median: 1.02, n: 198, my_bin: 4 },
      compDist: { gated: true, n: 7, need: 15 } },
    { attribute: 'ELECTRIC', score: 1.41, damage: 24.6e9, slv: 585, isFinish: true,
      characters: chars.slice(10, 15),
      dist: { gated: true, n: 38, need: 50 },
      compDist: null },
];
`;

const page = (lang) => `<!DOCTYPE html><meta charset="utf-8">
<title>card preview ${lang}</title>
<canvas id="c" width="1200" height="800"></canvas>
<script type="module">
import { buildShareCard } from '/js/sharecard.js';
import { _setLangForTest } from '/js/i18n.js';
import { makeCharResolver } from '/js/tiles.js';

const res = await fetch('/data/characters.json');
const data = await res.json();
const infoOf = makeCharResolver(data);
window.__CHARS__ = Object.keys(data.chars).slice(0, 15);
${MOCK}
_setLangForTest('${lang}');
await buildShareCard(results, document.getElementById('c'), {
    infoOf, totalDist: { users: 1043, n: 126 },
});
const url = document.getElementById('c').toDataURL('image/png');
await fetch('/__card__', { method: 'POST', body: JSON.stringify({ lang: '${lang}', url }) });
</script>`;

let resolveDone;
const done = new Promise((r) => { resolveDone = r; });
const got = [];

const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__card__') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
            const { lang, url } = JSON.parse(body);
            const png = Buffer.from(url.split(',')[1], 'base64');
            const file = join(OUT, `card-${lang}.png`);
            await writeFile(file, png);
            got.push(file);
            res.end('ok');
            if (got.length === langs.length) resolveDone();
        });
        return;
    }
    const m = req.url.match(/^\/__page__\/(\w+)$/);
    if (m) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(page(m[1]));
        return;
    }
    const file = await resolveServable(ROOT, req.url);
    if (!file) { res.statusCode = 404; res.end('404'); return; }
    try {
        const buf = await readFile(file);
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        res.end(buf);
    } catch { res.statusCode = 404; res.end('404'); }
});

function findChrome() {
    return [
        process.env.CHROME_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].filter(Boolean).find((p) => existsSync(p));
}

await listenLocal(server, PORT);   // 外から触れないようループバック固定
const chrome = findChrome();
if (!chrome) { console.error('Chrome/Edge が見つかりません (CHROME_PATH で指定可)'); server.close(); process.exit(2); }

const kids = langs.map((lang) => spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--user-data-dir=${join(tmpdir(), 'spg-card-' + lang)}`,
    `http://127.0.0.1:${PORT}/__page__/${lang}`,   // サーバは IPv4 ループバック固定
], { windowsHide: true, stdio: 'ignore' }));

const timeout = new Promise((r) => setTimeout(() => r('__timeout__'), 60000));
const out = await Promise.race([done, timeout]);
for (const k of kids) { try { k.kill(); } catch { /* 既に終了 */ } }
server.close();

if (out === '__timeout__') {
    console.error('タイムアウト (描けたのは:', got.join(', ') || 'なし', ')');
    process.exit(1);
}
console.log('書き出し:', got.join('\n           '));
