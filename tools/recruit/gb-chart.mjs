// しりすこPAD GB のエクスポート (attribute,slv,damage) → 属性別「SLv 帯 × ダメージ → 上位%」の HTML (PNG 用ページ + 閲覧用ページ)
// 使い方: node gb-chart.mjs <input.csv|json> <outDir> [--band 50] [--min 5] [--ref 15] [--season 2026-10] [--round 第45回]
import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const input = args[0], outDir = args[1];
if (!input || !outDir) { console.error('usage: node gb-chart.mjs <input> <outDir> [--band 50] [--min 5]'); process.exit(1); }
const opt = { band: 50, min: 5, ref: 15, season: '2026-10', round: '第45回' };
for (let i = 2; i < args.length; i += 2) { const k = args[i].replace(/^--/, ''); if (k in opt) opt[k] = typeof opt[k] === 'number' ? Number(args[i + 1]) : args[i + 1]; }

// ---- 入力 (CSV / TSV / JSON) ----
function parseInput(text) {
    text = text.replace(/^﻿/, '').trim();
    if (text.startsWith('[')) {
        return JSON.parse(text).map(r => Array.isArray(r) ? { a: r[0], slv: +r[1], dmg: +r[2] } : { a: r.attribute, slv: +r.slv, dmg: +r.damage });
    }
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
    const cells = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const head = cells(lines[0]).map(h => h.toLowerCase());
    const ia = head.indexOf('attribute'), is = head.indexOf('slv'), id = head.indexOf('damage');
    if (ia < 0 || is < 0 || id < 0) throw new Error('列 attribute / slv / damage が見つかりません: ' + lines[0]);
    return lines.slice(1).map(cells).map(c => ({ a: c[ia].toUpperCase(), slv: +c[is], dmg: +c[id] }));
}
const rawText = fs.readFileSync(input, 'utf8');
const isBands = /^\uFEFF?\s*attribute\s*[,\t;]\s*lo\s*[,\t;]\s*n\s*[,\t;]/i.test(rawText.trim().split(/\r?\n/)[0] || '');
const rows = isBands ? [] : parseInput(rawText).filter(r => r.a && Number.isFinite(r.slv) && Number.isFinite(r.dmg) && r.dmg > 0);
function parseBands(text) {
    const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(l => l.trim());
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const cells = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
    const head = cells(lines[0]).map(h => h.toLowerCase());
    const ix = k => { const i = head.indexOf(k); if (i < 0) throw new Error('列 ' + k + ' がありません: ' + lines[0]); return i; };
    const ia = ix('attribute'), il = ix('lo'), inn = ix('n'), imin = ix('dmin'), iq = ix('q'), imax = ix('dmax');
    const out = new Map();
    for (const l of lines.slice(1)) {
        const c = cells(l); const a = c[ia].toUpperCase(); const fine = c[iq].split('|').map(Number);
        if (fine.length !== 19 || fine.some(v => !Number.isFinite(v))) throw new Error('q は 19 個の数のはず: ' + l);
        const lo = +c[il];
        (out.get(a) || out.set(a, []).get(a)).push({ lo, hi: lo + opt.band - 1, span: 1, label: `${lo}–${lo + opt.band - 1}`, n: +c[inn], q: [fine[1], fine[4], fine[9], fine[14], fine[17]], fine, min: +c[imin], max: +c[imax] });
    }
    return out;
}
const bandRows = isBands ? parseBands(rawText) : null;

// ---- 属性 ----
const ATTRS = [
    { key: 'FIRE', name: '灼熱', color: '#e34948' },
    { key: 'WATER', name: '水冷', color: '#2a78d6' },
    { key: 'WIND', name: '風圧', color: '#008300' },
    { key: 'ELECTRIC', name: '電撃', color: '#6250d6' },
    { key: 'IRON', name: '鉄甲', color: '#eda100' },
    { key: 'TOTAL', name: '3凸合計', color: '#52514e', total: true },
];
const Q = [0.1, 0.25, 0.5, 0.75, 0.9];
const quantile = (sorted, p) => { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
function bandsOf(list) {
    const m = new Map();
    for (const r of list) { const lo = Math.floor(r.slv / opt.band) * opt.band; (m.get(lo) || m.set(lo, []).get(lo)).push(r.dmg); }
    const mk = (lo, v, span, label) => {
        const s = v.slice().sort((a, b) => a - b);
        return { lo, hi: lo + opt.band * span - 1, span, label: label || `${lo}–${lo + opt.band - 1}`, n: s.length, q: Q.map(p => quantile(s, p)), fine: Array.from({ length: 19 }, (_, i) => quantile(s, (i + 1) / 20)), min: s[0], max: s[s.length - 1] };
    };
    const all = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([lo, v]) => mk(lo, v, 1));
    // 上端: 人数が下限に満たない帯が続くなら 1 つにまとめる (例 950+)。合計も下限未満なら非表示
    let top = all.length - 1; const sparse = [];
    while (top >= 0 && all[top].n < opt.min) { sparse.unshift(all[top]); top--; }
    const kept = all.slice(0, top + 1); let merged = null;
    if (sparse.length >= 2) {
        const v = sparse.flatMap(b => m.get(b.lo)); const lo = sparse[0].lo;
        if (v.length >= opt.min) merged = mk(lo, v, (sparse[sparse.length - 1].lo - lo) / opt.band + 1, `${lo}+`);
    }
    const bands = kept.filter(b => b.n >= opt.min).concat(merged ? [merged] : []);
    const dropped = kept.filter(b => b.n < opt.min).concat(merged ? [] : sparse);
    return { bands, dropped };
}
const data = ATTRS.map(a => {
    if (bandRows) {
        const all = (bandRows.get(a.key) || []).sort((x, y) => x.lo - y.lo);
        return { ...a, n: all.reduce((t, b) => t + b.n, 0), bands: all.filter(b => b.n >= opt.min), dropped: all.filter(b => b.n < opt.min) };
    }
    const list = rows.filter(r => r.a === a.key); return { ...a, n: list.length, ...bandsOf(list) };
});
const total = data.filter(d => !d.total).reduce((t, d) => t + d.n, 0);
const shown = data.filter(d => !d.total || d.n > 0);

// ---- 描画 ----
const C = { surface: '#fcfcfb', page: '#f1f0ec', ink: '#0b0b0b', ink2: '#52514e', ink3: '#8c8a84', grid: '#e6e4df', axis: '#cfcdc6',
    l350: '#5598e7', l500: '#256abf', l700: '#0d366b', fill: '#2a78d6' };
const fmtB = v => { const b = v / 1e9; return (b >= 100 ? b.toFixed(0) : b.toFixed(1).replace(/\.0$/, '')) + 'B'; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const r = raw / p; return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p; }

function chartSvg(d, { w, h, compact }) {
    const bands = d.bands; if (!bands.length) return `<svg width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="${C.ink2}" font-size="14">データが足りません</text></svg>`;
    const L = 58, R = compact ? 92 : 126, T = 14, B = compact ? 58 : 58;
    const x0 = bands[0].lo, x1 = bands[bands.length - 1].lo + opt.band;
    const X = v => L + (v - x0) / (x1 - x0) * (w - L - R);
    const vmax = Math.max(...bands.map(b => b.q[4]));
    const step = niceStep(vmax * 1.06 / 5); const ymax = Math.ceil(vmax * 1.06 / step) * step;
    const Y = v => T + (1 - v / ymax) * (h - T - B);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Hiragino Sans, Hiragino Kaku Gothic ProN, Noto Sans JP, system-ui, sans-serif" style="display:block">`;
    // grid + y labels
    for (let v = 0; v <= ymax + 1e-6; v += step) {
        s += `<line x1="${L}" x2="${w - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? C.axis : C.grid}" stroke-width="1"/>`;
        s += `<text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="${compact ? 11 : 12}" fill="${C.ink2}" style="font-variant-numeric:tabular-nums">${fmtB(v)}</text>`;
    }
    // contiguous segments
    const segs = []; let cur = [];
    for (const b of bands) { if (cur.length && b.lo !== cur[cur.length - 1].lo + opt.band * cur[cur.length - 1].span) { segs.push(cur); cur = []; } cur.push(b); }
    if (cur.length) segs.push(cur);
    const cx = b => X(b.lo + opt.band / 2);
    for (const seg of segs) {
        if (seg.length === 1) {   // 孤立した帯: 線が引けないので帯幅の棒で 5 分位を示す
            const b = seg[0], x = cx(b), hw = (X(b.lo + opt.band) - X(b.lo)) * 0.3;
            s += `<rect x="${x - hw}" y="${Y(b.q[4])}" width="${hw * 2}" height="${Math.max(1, Y(b.q[0]) - Y(b.q[4]))}" fill="${C.fill}" fill-opacity="0.08"/>`;
            s += `<rect x="${x - hw}" y="${Y(b.q[3])}" width="${hw * 2}" height="${Math.max(1, Y(b.q[1]) - Y(b.q[3]))}" fill="${C.fill}" fill-opacity="0.16"/>`;
            const bar = (qi, color, width, dash) => `<line x1="${x - hw}" x2="${x + hw}" y1="${Y(b.q[qi])}" y2="${Y(b.q[qi])}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
            s += bar(4, C.l350, 2, '6 4') + bar(0, C.l350, 2, '6 4') + bar(3, C.l500, 2) + bar(1, C.l500, 2) + bar(2, C.l700, 2.5);
            s += `<circle cx="${x}" cy="${Y(b.q[2])}" r="3.5" fill="${C.l700}" stroke="${C.surface}" stroke-width="2"/>`;
            continue;
        }
        const poly = (qi, qj) => seg.map(b => `${cx(b)},${Y(b.q[qi])}`).concat(seg.slice().reverse().map(b => `${cx(b)},${Y(b.q[qj])}`)).join(' ');
        s += `<polygon points="${poly(4, 0)}" fill="${C.fill}" fill-opacity="0.08"/>`;
        s += `<polygon points="${poly(3, 1)}" fill="${C.fill}" fill-opacity="0.16"/>`;
        const line = (qi, color, width, dash) => `<polyline points="${seg.map(b => `${cx(b)},${Y(b.q[qi])}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
        s += line(4, C.l350, 2, '6 4') + line(0, C.l350, 2, '6 4') + line(3, C.l500, 2) + line(1, C.l500, 2) + line(2, C.l700, 2.5);
        for (const b of seg) s += `<circle cx="${cx(b)}" cy="${Y(b.q[2])}" r="3.5" fill="${C.l700}" stroke="${C.surface}" stroke-width="2"/>`;
    }
    // x labels (帯が多いときは下端の数字だけにして重なりを避ける)
    const short = compact || bands.length > 13;
    for (const b of bands) {
        const weak = b.n < opt.ref;
        s += `<text x="${cx(b)}" y="${h - B + 18}" text-anchor="middle" font-size="${compact ? 11 : 12}" fill="${C.ink}" style="font-variant-numeric:tabular-nums">${short ? (b.span > 1 ? b.label : b.lo) : b.label}</text>`;
        if (!compact || (bands.indexOf(b) % 2 === 0)) s += `<text x="${cx(b)}" y="${h - B + 33}" text-anchor="middle" font-size="${compact ? 10 : 10.5}" fill="${C.ink3}" style="font-variant-numeric:tabular-nums">${compact ? '' : 'n='}${b.n}${weak ? '※' : ''}</text>`;
    }
    const yWhat = d.total ? '1 日の 3 凸の合計' : '1凸のダメージ';
    s += `<text x="${L}" y="${h - 6}" font-size="10.5" fill="${C.ink3}">${compact ? `横軸: SLv の帯 (${opt.band} 刻み)・下の数字は人数 (1 つおき)` : short ? `横軸: SLv の帯の下端 (${opt.band} 刻み・例 700 = 700〜749)・下は人数 n　縦軸: ${yWhat}` : `横軸: SLv (${opt.band} 刻みの帯)・下は人数 n　縦軸: ${yWhat}`}</text>`;
    // direct labels at the right end
    const last = bands[bands.length - 1]; const names = ['上位90%', '上位75%', '中央値', '上位25%', '上位10%'];
    const labs = Q.map((_, i) => ({ y: Y(last.q[i]), i })).sort((a, b) => a.y - b.y);
    const gap = compact ? 14 : 16;
    for (let k = 1; k < labs.length; k++) if (labs[k].y < labs[k - 1].y + gap) labs[k].y = labs[k - 1].y + gap;
    const over = labs[labs.length - 1].y - (h - B - 2); if (over > 0) for (const l of labs) l.y -= over;
    for (const l of labs) {
        const strong = l.i === 2;
        s += `<text x="${w - R + 10}" y="${l.y + 4}" font-size="${compact ? 11 : 12}" font-weight="${strong ? 700 : 500}" fill="${C.ink}">${names[l.i]}<tspan fill="${C.ink2}" font-weight="400" style="font-variant-numeric:tabular-nums"> ${fmtB(last.q[l.i])}</tspan></text>`;
    }
    // hover targets (HTML 閲覧用)
    for (const b of bands) s += `<rect class="hit" x="${X(b.lo)}" y="${T}" width="${X(b.lo + opt.band) - X(b.lo)}" height="${h - T - B}" fill="transparent" data-label="${b.label}" data-n="${b.n}" data-q="${b.q.map(v => fmtB(v)).join('|')}"/>`;
    return s + '</svg>';
}

const legend = `<div class="legend">
  <span><svg width="34" height="12"><line x1="2" y1="6" x2="32" y2="6" stroke="${C.l700}" stroke-width="2.5"/><circle cx="17" cy="6" r="3.5" fill="${C.l700}" stroke="${C.surface}" stroke-width="2"/></svg>中央値 (ちょうど真ん中の人)</span>
  <span><svg width="34" height="12"><line x1="2" y1="6" x2="32" y2="6" stroke="${C.l500}" stroke-width="2"/></svg>上位25% / 上位75%</span>
  <span><svg width="34" height="12"><line x1="2" y1="6" x2="32" y2="6" stroke="${C.l350}" stroke-width="2" stroke-dasharray="6 4"/></svg>上位10% / 上位90%</span>
  <span><svg width="34" height="12"><rect x="2" y="1" width="30" height="10" fill="${C.fill}" fill-opacity="0.16"/></svg>真ん中 50% の人がいる範囲</span>
</div>`;

function tableHtml(d) {
    if (!d.bands.length) return '';
    return `<table class="q"><thead><tr><th>SLv 帯</th><th>人数</th><th>上位10%</th><th>上位25%</th><th>中央値</th><th>上位75%</th><th>上位90%</th></tr></thead><tbody>` +
        d.bands.map(b => `<tr><td>${b.label}</td><td>${b.n}${b.n < opt.ref ? '※' : ''}</td>${[4, 3, 2, 1, 0].map(i => `<td${i === 2 ? ' class="mid"' : ''}>${fmtB(b.q[i])}</td>`).join('')}</tr>`).join('') + `</tbody></table>`;
}
const chip = (d, big) => `<span class="chip${big ? ' big' : ''}"><i style="background:${d.color}"></i>${d.name}<small>${d.key}</small></span>`;
const subtitle = d => d.total
    ? `しりすこPAD GB · ${opt.round} (${opt.season}) · 同じ日の 3 凸の合計 · ${d.n} 人 · 1人1票 (合計が最大の日) · 締め凸を含む日は除外`
    : `しりすこPAD GB · ${opt.round} (${opt.season}) · ${d.name}の利用者 ${d.n} 人 · 1人1票 (シーズンベスト) · 締め凸は除外`;
const droppedNote = d => d.dropped.length ? `n が ${opt.min} 人未満の帯は非表示: ${d.dropped.map(b => `${b.label} (${b.n}人)`).join('・')}。` : '';
const howTo = `<p class="how"><b>見方:</b> 横軸で自分の SLv の帯を探し、自分のダメージ (属性のページは 1 凸、3凸合計のページは 1 日の 3 凸の合計) が どの線より上かを見る。中央値の線より上なら「上位50%に入る」、上位25% の線より上なら「上位25%に入る」。※ 人数が ${opt.ref} 人未満の帯は参考値。</p>`;

const css = `
:root { color-scheme: light; }
html, body { margin: 0; background: ${C.page}; color: ${C.ink}; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.page { box-sizing: border-box; padding: 26px 28px 24px; }
.card { background: ${C.surface}; border: 1px solid #e3e1db; border-radius: 14px; padding: 20px 22px 18px; }
h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 16px; font-weight: 800; display: flex; align-items: center; gap: 10px; }
.sub { margin: 6px 0 0; font-size: 12.5px; color: ${C.ink2}; }
.how { margin: 10px 0 0; font-size: 13px; line-height: 1.6; color: ${C.ink}; }
.how b { font-weight: 800; }
.chip { display: inline-flex; align-items: center; gap: 7px; font-weight: 800; font-size: 15px; background: #f3f2ee; border: 1px solid #e3e1db; border-radius: 999px; padding: 4px 12px 4px 8px; }
.chip.big { font-size: 20px; padding: 5px 14px 5px 10px; }
.chip i { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.chip small { font-weight: 600; font-size: .72em; color: ${C.ink2}; letter-spacing: .04em; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 22px; margin: 6px 0 0 58px; font-size: 12px; color: ${C.ink2}; }
.legend span { display: inline-flex; align-items: center; gap: 7px; }
.chart { position: relative; margin-top: 14px; }
table.q { border-collapse: collapse; margin-top: 16px; font-size: 12.5px; font-variant-numeric: tabular-nums; width: 100%; }
table.q th, table.q td { text-align: right; padding: 5px 10px; border-bottom: 1px solid ${C.grid}; }
table.q th { font-weight: 700; color: ${C.ink2}; font-size: 11.5px; border-bottom: 1px solid ${C.axis}; }
table.q td:first-child, table.q th:first-child { text-align: left; }
table.q td.mid { font-weight: 800; }
.note { margin: 10px 0 0; font-size: 11.5px; color: ${C.ink3}; line-height: 1.6; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.panel { background: ${C.surface}; border: 1px solid #e3e1db; border-radius: 14px; padding: 14px 14px 10px; }
.panel .sub { font-size: 11.5px; }
.info { display: flex; flex-direction: column; gap: 10px; justify-content: center; }
.info p { margin: 0; font-size: 13px; line-height: 1.65; }
.tip { position: absolute; pointer-events: none; background: ${C.ink}; color: #fff; font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 8px; display: none; white-space: nowrap; z-index: 2; font-variant-numeric: tabular-nums; }
.lookup { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: end; background: ${C.surface}; border: 1px solid #e3e1db; border-radius: 14px; padding: 14px 18px; margin-bottom: 18px; }
.lookup label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: ${C.ink2}; font-weight: 700; }
.lookup input, .lookup select { font: inherit; font-size: 15px; padding: 7px 10px; border: 1px solid ${C.axis}; border-radius: 8px; background: #fff; width: 120px; }
.lookup output { font-size: 18px; font-weight: 800; min-width: 220px; padding-bottom: 6px; }
`;
const tipJs = `<script>
(() => {
  document.querySelectorAll('.chart').forEach(ch => {
    const tip = document.createElement('div'); tip.className = 'tip'; ch.appendChild(tip);
    ch.querySelectorAll('rect.hit').forEach(r => {
      r.addEventListener('mousemove', e => {
        const q = r.dataset.q.split('|');
        tip.innerHTML = '<b>SLv ' + r.dataset.label + '</b> · ' + r.dataset.n + '人<br>上位10%: ' + q[4] + '<br>上位25%: ' + q[3] + '<br>中央値: ' + q[2] + '<br>上位75%: ' + q[1] + '<br>上位90%: ' + q[0];
        const b = ch.getBoundingClientRect(); tip.style.display = 'block';
        tip.style.left = Math.min(e.clientX - b.left + 14, b.width - 180) + 'px'; tip.style.top = (e.clientY - b.top + 12) + 'px';
      });
      r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    });
  });
})();
</script>`;

const head = (title, width) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${css}${width ? `html, body { width: ${width}px; }` : ''}</style></head><body>`;

// --- 属性ごとの PNG 用ページ (1200px) ---
fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true });
for (const d of shown) {
    const html = head(`${d.name} SLv帯別ダメージ`, 1200) + `<div class="page"><div class="card">
<h1>${chip(d, true)}<span>SLv 帯ごとのダメージと上位%</span></h1>
<p class="sub">${esc(subtitle(d))}</p>
${howTo}
<div class="chart">${chartSvg(d, { w: 1148, h: 440, compact: false })}</div>
${legend}
${tableHtml(d)}
<p class="note">各線はその帯の人を上から並べたときの境目。「上位10%」の線の値以上を出した人がその帯の 10%。${droppedNote(d)}</p>
</div></div></body></html>`;
    fs.writeFileSync(path.join(outDir, 'pages', `${d.name}.html`), html);
}
// --- 全属性 1 枚 (1600px) ---
{
    const panels = shown.map(d => `<div class="panel"><h2>${chip(d)}<span>${d.n} 人${d.total ? ' · 1 日の 3 凸の合計' : ''}</span></h2><div class="chart">${chartSvg(d, { w: 744, h: 330, compact: true })}</div></div>`).join('');
    const html = head('全属性 SLv帯別ダメージ', 1600) + `<div class="page">
<h1>SLv 帯ごとのダメージと上位% <span style="font-size:14px;font-weight:600;color:${C.ink2}">しりすこPAD GB · ${esc(opt.round)} (${esc(opt.season)}) · のべ ${total} 票 · 1人1票 (シーズンベスト) · 締め凸は除外</span></h1>
<div class="grid two" style="margin-top:14px">${panels}
<div class="panel info" style="grid-column: 1 / -1; padding: 18px 24px"><p><b>見方:</b> 横軸で自分の SLv の帯を探し、自分のダメージ (属性は 1 凸、3凸合計は 1 日の 3 凸の合計) がどの線より上かを見る。太線が中央値 (ちょうど真ん中の人)、その外側が上位25% / 75%、破線が上位10% / 90%。</p>${legend.replace('margin: 6px 0 0 58px', '')}<p class="note">横軸は SLv を ${opt.band} 刻みにした帯、各帯の下は人数 (n)。n が ${opt.min} 人未満の帯は非表示、${opt.ref} 人未満 (※) は参考値。</p></div>
</div></div></body></html>`;
    fs.writeFileSync(path.join(outDir, 'pages', '全属性.html'), html);
}
// --- 閲覧用 (ホバー + 上位%の計算) ---
{
    const lookupData = Object.fromEntries(shown.map(d => [d.key, { name: d.name, band: opt.band, bands: d.bands.map(b => ({ lo: b.lo, hi: b.hi, label: b.label, n: b.n, fine: b.fine, min: b.min, max: b.max })) }]));
    const html = head('GB 募集基準 SLv帯別ダメージ') + `<div class="page" style="max-width:1200px;margin:0 auto">
<h1>SLv 帯ごとのダメージと上位%</h1>
<p class="sub">しりすこPAD GB · ${esc(opt.round)} (${esc(opt.season)}) · のべ ${total} 票 · 1人1票 (シーズンベスト) · 締め凸は除外 · 帯は SLv ${opt.band} 刻み · n&lt;${opt.min} の帯は非表示</p>
<div class="lookup" style="margin-top:14px">
  <label>属性<select id="lk-a">${shown.map(d => `<option value="${d.key}">${d.name}</option>`).join('')}</select></label>
  <label>SLv<input id="lk-s" type="number" min="1" max="1183" placeholder="650"></label>
  <label>ダメージ (B)<input id="lk-d" type="number" step="0.1" min="0" placeholder="20"></label>
  <output id="lk-o">SLv とダメージを入れると上位%が出ます</output>
</div>
${shown.map(d => `<div class="card" style="margin-bottom:18px">
<h2>${chip(d, true)}<span>${d.name} · ${d.n} 人</span></h2>
<div class="chart">${chartSvg(d, { w: 1104, h: 400, compact: false })}</div>
${legend}
${tableHtml(d)}
<p class="note">${droppedNote(d) || ''}</p>
</div>`).join('')}
${howTo}
</div>
<script>const DATA = ${JSON.stringify(lookupData)};</script>
${tipJs}
<script>
(() => {
  const a = document.getElementById('lk-a'), s = document.getElementById('lk-s'), d = document.getElementById('lk-d'), o = document.getElementById('lk-o');
  const calc = () => {
    const D = DATA[a.value]; const slv = +s.value, dmg = +d.value * 1e9;
    if (!slv || !dmg) { o.textContent = 'SLv とダメージを入れると上位%が出ます'; return; }
    const b = D.bands.find(x => slv >= x.lo && slv <= x.hi); const lo = b ? b.lo : Math.floor(slv / D.band) * D.band;
    if (!b) { o.textContent = 'SLv ' + lo + '–' + (lo + D.band - 1) + ' の帯はデータ不足'; return; }
    const pts = [[0, b.min], ...b.fine.map((v, i) => [(i + 1) / 20, v]), [1, b.max]];
    let f = dmg <= b.min ? 0 : dmg >= b.max ? 1 : 0;
    if (dmg > b.min && dmg < b.max) for (let i = 1; i < pts.length; i++) if (dmg <= pts[i][1]) { const [p0, v0] = pts[i - 1], [p1, v1] = pts[i]; f = v1 === v0 ? p1 : p0 + (p1 - p0) * (dmg - v0) / (v1 - v0); break; }
    const top = Math.max(1, Math.min(99, Math.round((1 - f) * 100)));
    o.textContent = D.name + ' · SLv ' + b.label + ' の ' + b.n + ' 人の中で 上位 ' + top + '%';
  };
  [a, s, d].forEach(el => el.addEventListener('input', calc));
})();
</script></body></html>`;
    fs.writeFileSync(path.join(outDir, 'GB_募集基準_SLv帯別ダメージ.html'), html);
}
console.log(JSON.stringify({ total, attrs: data.map(d => ({ key: d.key, n: d.n, bands: d.bands.length, dropped: d.dropped.map(b => `${b.lo}:${b.n}`) })) }));
