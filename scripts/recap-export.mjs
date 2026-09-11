#!/usr/bin/env node
// シーズン結果発表カード (tools/recap.html) を PNG に書き出す (運営が手動実行)。
//
//   node scripts/recap-export.mjs --avgslv 745 --avgslv-users 1186
//   ... --season 2026-09 --raid 44     # 既定は base.json のシーズン / 回数は recap.html の対応表
//   ... --only summary                 # 1枚だけ作り直す
//
// 【既定の形 — 2026-09-12 ユーザー確定。変えないこと】
//   ・**1422x800 (16:9)** … X に4枚並べると 16:9 に中央トリミングされるため、最初からこの比率で描く。
//     3:2 や 6:5 のままだと見出しや下段が切れる (第44回の実投稿で確認)
//   ・**キャラ絵つき** … 掲載方針が takedown 方式に戻った 2026-08-31 以降はこちらが既定
//   ・**4枚を1つのブラウザ・1回の取得で描く** … 別々に取得すると、その間に提出が入って
//     「①は2957件・④は2958件」のようにカード間で数字がズレる (シーズンを open のまま
//     集計するので必ず起きる)
//   従来の形に戻したいときだけ --narrow (1200幅) / --tiles (自作タイル) を付ける。
//   変種は data/recap/<season>/<変種名>/ に分けて出す (既定は season 直下)。
//
// なぜ要るか: 第43回まではブラウザで4枚を手で保存していた。毎回同じ手順なので
// 「誰がやっても同じ画像が出る」ように headless 化した
// (e2e.mjs / card-preview.mjs と同じ仕組み: 静的配信 → Chrome → canvas を dataURL で回収)。
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
// PNG は gitignore (毎シーズン約1.5MB)。代わりに data/recap/<season>/stats.json を commit する。
// なぜ: シーズン切替で measurements を全削除するため、後から「前回はどうだったか」を
// 一切たどれなくなる (第45回の集計時に第44回と比べられず実際に困った — 2026-09-11)。

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolveServable, listenLocal } from './lib/local-static.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RECAP_PORT || 8944);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon', '.css': 'text/css' };

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] ?? null : null; };
// 既定は 16:9 + キャラ絵 (上の「既定の形」)。従来に戻すときだけ打ち消す
const ART = !args.includes('--tiles');
const WIDE = !args.includes('--narrow');
const season = opt('season') ?? JSON.parse(await readFile(join(ROOT, 'data', 'base.json'), 'utf8')).version;
const raidNo = opt('raid');
const avgSlv = opt('avgslv');
const avgSlvUsers = opt('avgslv-users');   // 平均SLvの母集団 (RPC の users とは母集団が違うので併記する)
const only = opt('only');
// --wide: X に4枚並べたときのトリミング (16:9 中央切り) を避けるため、最初から 16:9 で描く
const WIDE_H = 800, WIDE_W = Math.round(WIDE_H * 16 / 9);   // 1422x800 = 16:9

// 投稿順 (recap.html の並びと同じ): ①総まとめ ②使われた ③強かった ④人気かつ強い
const KINDS = [
    { key: 'summary', canvas: 'c1', status: 's1', label: '①総まとめ', h: 800 },
    { key: 'usage', canvas: 'c2', status: 's2', label: '②使用率が高かった編成', h: 800 },
    { key: 'median', canvas: 'c3', status: 's3', label: '③中央値が高かった編成', h: 800 },
    { key: 'practical', canvas: 'c4', status: 's4', label: '④人気かつ強かった編成', h: 1000 },
].filter(k => !only || k.key === only);
if (!KINDS.length) { console.error(`--only は ${['summary', 'usage', 'median', 'practical'].join(' / ')} のいずれか`); process.exit(1); }

const SEASON_DIR = join(ROOT, 'data', 'recap', season);
// 既定以外の形は混ざらないよう別フォルダへ (既定は season 直下)
const variant = [WIDE ? null : 'narrow', ART ? null : 'tiles'].filter(Boolean).join('-');
const OUT = variant ? join(SEASON_DIR, variant) : SEASON_DIR;
await mkdir(OUT, { recursive: true });

// recap.html を iframe で開き、描画完了 (ステータスが ✅) を待って canvas を回収するラッパ。
// ⚠ recap.html を書き換えないのが狙い (運営ツールの中身は1つに保つ)
// recap.html を iframe で開き、描画完了 (各ステータスが ✅) を待って canvas を回収するラッパ。
// ⚠ 4枚を1つのブラウザで描く (auto=all)。別々に開くとその間に提出が入り、
//    「①は2957件・④は2958件」のようにカード間で数字がズレる
const wrapper = () => {
    const q = new URLSearchParams({ auto: 'all', bare: '1', season });
    if (raidNo) q.set('raid', raidNo);
    if (avgSlv) q.set('avgslv', avgSlv);
    if (ART) q.set('art', '1');
    if (WIDE) { q.set('w', String(WIDE_W)); q.set('h', String(WIDE_H)); }
    const want = JSON.stringify(KINDS.map(k => ({ key: k.key, canvas: k.canvas, status: k.status })));
    return `<!DOCTYPE html><meta charset="utf-8"><title>recap</title>
<iframe id="f" src="/tools/recap.html?${q}" style="width:1900px;height:4200px;border:0"></iframe>
<script>
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const WANT = ${want};
(async () => {
  const f = document.getElementById('f');
  const post = (b) => fetch('/__png__', { method: 'POST', body: JSON.stringify(b) });
  try {
    await new Promise(r => { f.onload = r; });
    const d = f.contentDocument;
    const left = new Set(WANT.map(w => w.key));
    for (let i = 0; i < 240 && left.size; i++) {
      for (const w of WANT) {
        if (!left.has(w.key)) continue;
        const st = d.getElementById(w.status)?.textContent || '';
        if (st.includes('✅')) {
          left.delete(w.key);
          const cv = d.getElementById(w.canvas);
          await post({ key: w.key, url: cv.toDataURL('image/png'), w: cv.width, h: cv.height });
        } else if (st.includes('❌') || /失敗|エラー/.test(st)) {
          left.delete(w.key);
          await post({ key: w.key, err: st });
        }
      }
      if (left.size) await wait(500);
    }
    for (const k of left) await post({ key: k, err: 'タイムアウト (120秒)' });
  } catch (e) {
    for (const w of WANT) await post({ key: w.key, err: String(e && e.message || e) });
  }
})();
</script>`;
};

const results = new Map();
let resolveDone;
const done = new Promise(r => { resolveDone = r; });

const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/__png__') {
        let body = '';
        let over = false;
        req.on('data', c => {
            if (over) return;
            body += c;
            if (body.length > 40 * 1024 * 1024) { over = true; body = ''; req.destroy(); }   // 1200x1000 の PNG でも数MB
        });
        req.on('end', async () => {
            res.end('ok');
            if (over) return;
            let payload;
            try { payload = JSON.parse(body); } catch { payload = { key: '?', err: '応答を解釈できません' }; }
            // key は自前のラッパが送る固定値のみ受ける (書き込み先をURLから決めさせない)
            if (!KINDS.some(k => k.key === payload.key)) return;
            try {
                if (payload.err) {
                    results.set(payload.key, { err: payload.err });
                } else {
                    const b64 = String(payload.url ?? '').split(',')[1];
                    if (!b64) throw new Error('画像データが空です');
                    const png = Buffer.from(b64, 'base64');
                    const file = join(OUT, `${payload.key}.png`);
                    await writeFile(file, png);
                    results.set(payload.key, { file, kb: Math.round(png.length / 1024), size: `${payload.w}x${payload.h}` });
                }
            } catch (e) {
                // 壊れた応答でプロセスごと落とさない (その1枚を失敗として記録する)
                results.set(payload.key, { err: `応答を保存できません: ${e?.message ?? e}` });
            }
            if (results.size === KINDS.length) resolveDone();
        });
        return;
    }
    if (req.url.split('?')[0] === '/__wrap__') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(wrapper());
    }
    const file = await resolveServable(ROOT, req.url);
    if (!file) { res.statusCode = 404; return res.end('404'); }
    try {
        const buf = await readFile(file);
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
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

await listenLocal(server, PORT);   // 外から触れないようループバック固定
const chrome = findChrome();
if (!chrome) { console.error('Chrome/Edge が見つかりません (CHROME_PATH で指定可)'); server.close(); process.exit(2); }

console.log(`シーズン ${season}${raidNo ? ` (第${raidNo}回)` : ''} / 平均SLv ${avgSlv ?? '(未指定 — ①は「—」表示)'}`
    + ` / ${WIDE ? `${WIDE_W}x${WIDE_H} (16:9)` : '1200幅 (従来)'} / ${ART ? 'キャラ絵' : '自作タイル'}`);
// Chrome は1つだけ。4枚とも同じ取得結果から描く (カード間の数字のズレを防ぐ)
const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--user-data-dir=${join(tmpdir(), 'spg-recap')}`,
    `http://127.0.0.1:${PORT}/__wrap__`,   // サーバは IPv4 ループバック固定なので名前解決に頼らない
], { windowsHide: true, stdio: 'ignore' });
for (let i = 0; i < 300 && results.size < KINDS.length; i++) await new Promise(r => setTimeout(r, 500));
for (const k of KINDS) if (!results.has(k.key)) results.set(k.key, { err: 'タイムアウト (150秒)' });
try { child.kill(); } catch { /* 既に落ちている */ }
server.close();

// 集計値のスナップショット (PNG は捨てても数値は残す)。公開RPCで誰でも取れる値のみ。
// --only で一部だけ作ったときは既存を壊さないようマージする
const statsPath = join(SEASON_DIR, 'stats.json');   // 記録はシーズンに1つ (変種ごとに散らさない)
let statsOk = false;
try {
    const prev = existsSync(statsPath) ? JSON.parse(await readFile(statsPath, 'utf8')) : {};
    const snap = await (async () => {
        const backend = await readFile(join(ROOT, 'js', 'backend.js'), 'utf8');
        const u = backend.match(/https:\/\/[a-z]+\.supabase\.co/)[0];
        const key = backend.match(/sb_publishable_[A-Za-z0-9_-]+/)[0];
        // ⚠ 失敗を null に潰さない。潰すと「空の snapshot で過去の記録を上書きして成功終了」になり、
        //    シーズン削除前の唯一の記録を失う (Codex指摘)
        const rpc = async (fn, body) => {
            const r = await fetch(`${u}/rest/v1/rpc/${fn}`, {
                method: 'POST', body: JSON.stringify(body),
                headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            });
            if (!r.ok) throw new Error(`${fn} → ${r.status} ${(await r.text()).slice(0, 120)}`);
            return r.json();
        };
        const attrs = ['FIRE', 'WATER', 'ELECTRIC', 'IRON', 'WIND'];
        const per = {};
        for (const a of attrs) {
            const d = await rpc('get_distribution', { p_attribute: a, p_season: season, p_score: 1 });
            if (d && !d.gated) per[a] = { n: d.n, median: d.median };   // 未解禁は中身が返らない (0件ではない)
        }
        const tot = await rpc('get_total_distribution', { p_season: season });
        if (!Object.keys(per).length) throw new Error('解禁済みの属性が1つもありません (集計前？)');
        return { attributes: per, users: tot?.users ?? null, finishers: tot?.n ?? null, totalMedian: tot?.median ?? null };
    })();
    // 回数は tools/recap.html の対応表を唯一の正とする (カードの表記と食い違わせない)
    let raidFromTable = null;
    try {
        const html = await readFile(join(ROOT, 'tools', 'recap.html'), 'utf8');
        const m2 = html.match(/SEASON_RAID_NO\s*=\s*\{([^}]*)\}/);
        const m3 = m2 && m2[1].match(new RegExp(`['"\`]${season}['"\`]\\s*:\\s*(\\d+)`));
        if (m3) raidFromTable = Number(m3[1]);
    } catch { /* 読めなければ下で警告 */ }
    if (!raidNo && raidFromTable == null && prev.raidNo == null) {
        console.warn(`  ⚠ 第何回か分かりません (tools/recap.html の SEASON_RAID_NO に '${season}' が無い) — --raid で指定してください`);
    }
    // ⚠ 引き継ぐのは「今回指定されなかった値」だけ。capturedAt と RPC 由来は必ず今回の値になるので、
    //    avgSlv だけ古いまま残ると日付と中身が食い違う (Codex指摘) → 引き継いだ場合は日付も残す
    const inheritedSlv = !avgSlv && prev.avgSlv != null;
    const out = {
        _readme: '結果発表カードの集計値スナップショット (scripts/recap-export.mjs の生成物)。'
            + 'シーズン切替で measurements は全削除されるため、次シーズンとの比較はこのファイルが唯一の記録。',
        season,
        raidNo: raidNo ? Number(raidNo) : (raidFromTable ?? prev.raidNo ?? null),
        capturedAt: new Date().toISOString().slice(0, 10),
        avgSlv: avgSlv ? Number(avgSlv) : (prev.avgSlv ?? null),
        // 平均SLvを更新したのに母集団だけ前回値、という時点の混在を作らない (Codex指摘)
        avgSlvUsers: avgSlvUsers ? Number(avgSlvUsers) : (avgSlv ? null : (prev.avgSlvUsers ?? null)),
        avgSlvCapturedAt: avgSlv ? new Date().toISOString().slice(0, 10) : (prev.avgSlvCapturedAt ?? null),
        ...snap,
        note: 'users/finishers は締め凸と score_bounds 外を除いた有効提出ベース (get_total_distribution)。'
            + 'avgSlv は measurements 直読みの SQL 由来で母集団が少し広く、取得日も別 (avgSlvCapturedAt)。'
            + 'シーズンが open の間は提出が増え続けるため、各値は capturedAt 時点のスナップショット'
            + ' (属性ごとのRPCは逐次取得なので厳密には同時刻ではない)。'
            + 'median はふるり値スケールの生値 — カードは属性中央値=100%の相対表示で、用途が違う。',
    };
    if (inheritedSlv) console.warn(`  ⚠ 平均SLv は前回値 ${prev.avgSlv} を引き継ぎました (--avgslv 未指定・取得日 ${prev.avgSlvCapturedAt ?? '不明'})`);
    await writeFile(statsPath, JSON.stringify({ ...prev, ...out }, null, 2) + '\n', 'utf8');
    console.log(`  ✓ 集計値スナップショット → ${statsPath.replace(ROOT + '/', '')}`);
    statsOk = true;
} catch (e) {
    console.error('  ✗ stats.json を書けませんでした (画像は出ています):', e?.message ?? e);
}

let fail = statsOk ? 0 : 1;   // 数値が残らないまま「成功」で終わらせない (シーズン削除前の唯一の記録)
for (const k of KINDS) {
    const r = results.get(k.key);
    if (!r) { console.error(`  ✗ ${k.label}: 結果を回収できませんでした`); fail++; }
    else if (r.err) { console.error(`  ✗ ${k.label}: ${r.err}`); fail++; }
    else console.log(`  ✓ ${k.label}  ${r.size}  ${r.kb}KB  → ${r.file.replace(ROOT + '/', '')}`);
}
if (!fail) console.log(`\n${KINDS.length}枚を ${OUT.replace(ROOT + '/', '')}/ に書き出しました (投稿順は ①→②→③→④)`);
process.exit(fail ? 1 : 0);
