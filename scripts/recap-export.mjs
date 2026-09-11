#!/usr/bin/env node
// シーズン結果発表カード (tools/recap.html) を PNG に書き出す (運営が手動実行)。
//
//   node scripts/recap-export.mjs --avgslv 720            # 現行シーズン・4枚
//   node scripts/recap-export.mjs --avgslv 720 --season 2026-09 --raid 44
//   node scripts/recap-export.mjs --only summary          # 1枚だけ
//   node scripts/recap-export.mjs --art                   # キャラ絵つき (ローカル専用)
//
// なぜ要るか: 第43回まではブラウザで開いて4枚を手で保存していた。毎回同じ手順を踏むので、
// 「誰がやっても同じ画像が出る」ように headless 化した (e2e.mjs / card-preview.mjs と同じ仕組み:
//  静的配信 → headless Chrome → canvas を dataURL で回収)。
//
// ⚠ recap.html 自体は改造しない。iframe 越しに (同一オリジンなので) canvas を読むだけ。
// ⚠ 平均SLv は公開RPCに無いので --avgslv で渡す (省略すると ① のその欄が「—」になる)。
//    SQL Editor で:
//      with per as (select client_id, max(slv) slv from public.measurements
//                   where season='<シーズン>' group by client_id)
//      select count(*) users, round(avg(slv)) avg_slv from per;
//    → --avgslv <avg_slv> --avgslv-users <users> の2つを渡す (users は stats.json に残すだけ)
// ⚠ 出力は集計値のみ (個人の記録は載せない — 運営判断 2026-08-10。recap.html 冒頭の注意書きが正)。
//
// PNG は gitignore (毎シーズン約1MB)。代わりに同じフォルダの stats.json を commit する。
// なぜ: シーズン切替で measurements を全削除するため、後から「前回はどうだったか」を
// 一切たどれなくなる (第45回の集計時に第44回と比べられず実際に困った — 2026-09-11)。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RECAP_PORT || 8944);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon', '.css': 'text/css' };

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? null : null; };
const ART = args.includes('--art');
const season = opt('season') ?? JSON.parse(await readFile(join(ROOT, 'data', 'base.json'), 'utf8')).version;
const raidNo = opt('raid');
const avgSlv = opt('avgslv');
const avgSlvUsers = opt('avgslv-users');   // 平均SLvの母集団 (RPC の users とは母集団が違うので併記する)
const only = opt('only');

// 投稿順 (recap.html の並びと同じ): ①総まとめ ②使われた ③強かった ④人気かつ強い
const KINDS = [
    { key: 'summary', canvas: 'c1', status: 's1', label: '①総まとめ' },
    { key: 'usage', canvas: 'c2', status: 's2', label: '②使用率が高かった編成' },
    { key: 'median', canvas: 'c3', status: 's3', label: '③中央値が高かった編成' },
    { key: 'practical', canvas: 'c4', status: 's4', label: '④人気かつ強かった編成' },
].filter(k => !only || k.key === only);
if (!KINDS.length) { console.error(`--only は ${['summary', 'usage', 'median', 'practical'].join(' / ')} のいずれか`); process.exit(1); }

const OUT = join(ROOT, 'data', 'recap', season);
await mkdir(OUT, { recursive: true });

// recap.html を iframe で開き、描画完了 (ステータスが ✅) を待って canvas を回収するラッパ。
// ⚠ recap.html を書き換えないのが狙い (運営ツールの中身は1つに保つ)
const wrapper = (k) => {
    const q = new URLSearchParams({ auto: k.key, bare: '1', season });
    if (raidNo) q.set('raid', raidNo);
    if (avgSlv) q.set('avgslv', avgSlv);
    if (ART) q.set('art', '1');
    return `<!DOCTYPE html><meta charset="utf-8"><title>recap ${k.key}</title>
<iframe id="f" src="/tools/recap.html?${q}" style="width:1240px;height:1100px;border:0"></iframe>
<script>
const wait = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const f = document.getElementById('f');
  let err = null;
  try {
    await new Promise(r => { f.onload = r; });
    const d = f.contentDocument;
    // 描画完了を待つ (取得〜Canvas描画は数秒かかる)
    for (let i = 0; i < 120; i++) {
      const st = d.getElementById('${k.status}')?.textContent || '';
      if (st.includes('✅')) break;
      if (/失敗|エラー/.test(st)) { err = st; break; }
      await wait(500);
      if (i === 119) err = 'タイムアウト (60秒)';
    }
    if (!err) {
      const cv = d.getElementById('${k.canvas}');
      const url = cv.toDataURL('image/png');
      await fetch('/__png__', { method: 'POST', body: JSON.stringify({ key: '${k.key}', url, w: cv.width, h: cv.height }) });
      return;
    }
  } catch (e) { err = String(e && e.message || e); }
  await fetch('/__png__', { method: 'POST', body: JSON.stringify({ key: '${k.key}', err }) });
})();
</script>`;
};

const results = new Map();
let resolveDone;
const done = new Promise(r => { resolveDone = r; });

const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__png__') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
            res.end('ok');
            let payload;
            try { payload = JSON.parse(body); } catch { payload = { key: '?', err: '応答を解釈できません' }; }
            if (payload.err) {
                results.set(payload.key, { err: payload.err });
            } else {
                const png = Buffer.from(payload.url.split(',')[1], 'base64');
                const file = join(OUT, `${payload.key}.png`);
                await writeFile(file, png);
                results.set(payload.key, { file, kb: Math.round(png.length / 1024), size: `${payload.w}x${payload.h}` });
            }
            if (results.size === KINDS.length) resolveDone();
        });
        return;
    }
    const m = req.url.match(/^\/__wrap__\/(\w+)$/);
    if (m) {
        const k = KINDS.find(x => x.key === m[1]);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(k ? wrapper(k) : '404');
    }
    try {
        const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
        if (!path.startsWith(ROOT)) { res.statusCode = 403; return res.end('no'); }
        const buf = await readFile(path);
        res.setHeader('Content-Type', MIME[extname(path)] ?? 'application/octet-stream');
        res.end(buf);
    } catch { res.statusCode = 404; res.end('404'); }
});

function findChrome() {
    return [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ].filter(Boolean).find(p => existsSync(p));
}

await new Promise(r => server.listen(PORT, r));
const chrome = findChrome();
if (!chrome) { console.error('Chrome/Edge が見つかりません (CHROME_PATH で指定可)'); server.close(); process.exit(2); }

console.log(`シーズン ${season}${raidNo ? ` (第${raidNo}回)` : ''} / 平均SLv ${avgSlv ?? '(未指定 — ①は「—」表示)'}${ART ? ' / キャラ絵あり' : ''}`);
// 1枚ずつ順に回す (同時に開くと同じ RPC を4倍叩くため)
const kids = [];
for (const k of KINDS) {
    const child = spawn(chrome, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
        `--user-data-dir=${join(tmpdir(), 'spg-recap-' + k.key)}`,
        `http://localhost:${PORT}/__wrap__/${k.key}`,
    ], { windowsHide: true, stdio: 'ignore' });
    kids.push(child);
    // 前の1枚が終わってから次へ (結果が来るまで待つ)
    const before = results.size;
    for (let i = 0; i < 140 && results.size === before; i++) await new Promise(r => setTimeout(r, 500));
}

await Promise.race([done, new Promise(r => setTimeout(r, 5000))]);
kids.forEach(c => { try { c.kill(); } catch { /* 既に落ちている */ } });
server.close();

// 集計値のスナップショット (PNG は捨てても数値は残す)。公開RPCで誰でも取れる値のみ。
// --only で一部だけ作ったときは既存を壊さないようマージする
const statsPath = join(OUT, 'stats.json');
try {
    const prev = existsSync(statsPath) ? JSON.parse(await readFile(statsPath, 'utf8')) : {};
    const snap = await (async () => {
        const backend = await readFile(join(ROOT, 'js', 'backend.js'), 'utf8');
        const u = backend.match(/https:\/\/[a-z]+\.supabase\.co/)[0];
        const key = backend.match(/sb_publishable_[A-Za-z0-9_-]+/)[0];
        const rpc = async (fn, body) => {
            const r = await fetch(`${u}/rest/v1/rpc/${fn}`, {
                method: 'POST', body: JSON.stringify(body),
                headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            });
            return r.ok ? r.json() : null;
        };
        const attrs = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];
        const per = {};
        for (const a of attrs) {
            const d = await rpc('get_distribution', { p_attribute: a, p_season: season, p_score: 1 });
            if (d && !d.gated) per[a] = { n: d.n, median: d.median };
        }
        const tot = await rpc('get_total_distribution', { p_season: season });
        return { attributes: per, users: tot?.users ?? null, finishers: tot?.n ?? null, totalMedian: tot?.median ?? null };
    })();
    const out = {
        _readme: '結果発表カードの集計値スナップショット (scripts/recap-export.mjs の生成物)。'
            + 'シーズン切替で measurements は全削除されるため、次シーズンとの比較はこのファイルが唯一の記録。',
        season,
        raidNo: raidNo ? Number(raidNo) : null,
        capturedAt: new Date().toISOString().slice(0, 10),
        avgSlv: avgSlv ? Number(avgSlv) : (prev.avgSlv ?? null),
        avgSlvUsers: avgSlvUsers ? Number(avgSlvUsers) : (prev.avgSlvUsers ?? null),
        ...snap,
        note: 'users/finishers は締め凸と score_bounds 外を除いた有効提出ベース (get_total_distribution)。'
            + 'avgSlv は measurements 直読みの SQL 由来で母集団が少し広い。',
    };
    await writeFile(statsPath, JSON.stringify({ ...prev, ...out }, null, 2) + '\n', 'utf8');
    console.log(`  ✓ 集計値スナップショット → ${statsPath.replace(ROOT + '/', '')}`);
} catch (e) {
    console.warn('  ⚠ stats.json を書けませんでした (画像は出ています):', e?.message ?? e);
}

let fail = 0;
for (const k of KINDS) {
    const r = results.get(k.key);
    if (!r) { console.error(`  ✗ ${k.label}: 結果を回収できませんでした`); fail++; }
    else if (r.err) { console.error(`  ✗ ${k.label}: ${r.err}`); fail++; }
    else console.log(`  ✓ ${k.label}  ${r.size}  ${r.kb}KB  → ${r.file.replace(ROOT + '/', '')}`);
}
if (!fail) console.log(`\n${KINDS.length}枚を ${OUT.replace(ROOT + '/', '')}/ に書き出しました (投稿順は ①→②→③→④)`);
process.exit(fail ? 1 : 0);
