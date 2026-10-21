// 募集の目安表 (SLv 100 刻み × 属性・3 段の基準) を 1 枚の HTML に
import fs from 'node:fs';
const [,, input, outHtml, mode] = process.argv;
const bare = mode === '--bare';   // 表だけ (題・説明・注記なし)
const rows = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(',')).map(c => ({ a: c[0].toUpperCase(), slv: +c[1], d: +c[2] }));
const A = [
    { key: 'FIRE', name: '灼熱', color: '#e34948', fg: '#fff' },
    { key: 'WATER', name: '水冷', color: '#2a78d6', fg: '#fff' },
    { key: 'WIND', name: '風圧', color: '#008300', fg: '#fff' },
    { key: 'ELECTRIC', name: '電撃', color: '#6250d6', fg: '#fff' },
    { key: 'IRON', name: '鉄甲', color: '#eda100', fg: '#1a1400' },
    { key: 'TOTAL', name: '3凸合計', color: '#3a3936', fg: '#fff', total: true },
];
if (!rows.some(r => r.a === 'TOTAL')) A.pop();   // 合計データが無ければ列を出さない
const q = (s, p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const B = v => (v / 1e9).toFixed(v >= 100e9 ? 0 : 1).replace(/\.0$/, '') + 'B';
const bands = [[500, 599, '500–599'], [600, 699, '600–699'], [700, 799, '700–799'], [800, 899, '800–899'], [900, 1199, '900+']];
const tiers = [[0.75, '上位25%', 'この帯で強い'], [0.5, '中央値', 'この帯の真ん中'], [0.25, '上位75%', 'ここを下回ると低め']];
const stat = {};
for (const [lo, hi, label] of bands) for (const a of A) {
    const s = rows.filter(r => r.a === a.key && r.slv >= lo && r.slv <= hi).map(r => r.d).sort((x, y) => x - y);
    stat[label + a.key] = { n: s.length, v: tiers.map(([p]) => s.length >= 5 ? q(s, p) : null) };
}
const total = rows.filter(r => r.a !== 'TOTAL').length;
const hex2rgba = (h, al) => `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${al})`;
let body = '';
for (const [lo, hi, label] of bands) {
    tiers.forEach(([p, tname, tdesc], ti) => {
        const mid = ti === 1;
        body += `<tr class="${ti === 0 ? 'first' : ''} ${mid ? 'mid' : ''}">`;
        if (ti === 0) body += `<td class="band" rowspan="3"><span class="lv">${label}</span><span class="lvs">SLv</span></td>`;
        body += `<td class="tier"><b>${tname}</b><small>${tdesc}</small></td>`;
        for (const a of A) { const st = stat[label + a.key]; const v = st.v[ti]; body += `<td class="v" style="background:${hex2rgba(a.color, mid ? 0.16 : 0.07)}">${v == null ? '–' : B(v)}</td>`; }
        body += '</tr>';
    });
}
const nLine = bands.map(([lo, hi, label]) => `${label}: ${A.map(a => stat[label + a.key].n).join('・')}`).join('　');
const nHead = A.map(a => a.name).join('・');
const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>募集の目安 SLv帯×属性</title><style>
html, body { margin: 0; width: 1200px; background: #f1f0ec; color: #0b0b0b; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.page { box-sizing: border-box; padding: 26px 28px 22px; }
.card { background: #fcfcfb; border: 1px solid #e3e1db; border-radius: 14px; padding: 22px 24px 16px; }
h1 { margin: 0; font-size: 24px; font-weight: 900; letter-spacing: -0.01em; }
.sub { margin: 6px 0 0; font-size: 13px; color: #52514e; }
.how { margin: 12px 0 0; font-size: 14px; line-height: 1.6; }
.how b { font-weight: 800; }
table { border-collapse: separate; border-spacing: 0; width: 100%; margin-top: 14px; font-variant-numeric: tabular-nums; }
th { font-size: 17px; font-weight: 900; padding: 10px 8px; text-align: center; border-bottom: 2px solid #cfcdc6; }
th.attr { border-radius: 10px 10px 0 0; }
th.h { color: #52514e; font-size: 12.5px; font-weight: 700; text-align: left; }
td { padding: 7px 10px; border-bottom: 1px solid #e6e4df; font-size: 17px; }
tr.first td { border-top: 2px solid #cfcdc6; }
td.band { text-align: center; vertical-align: middle; width: 124px; background: #f6f5f1; white-space: nowrap; }
td.band .lv { display: block; font-size: 20px; font-weight: 900; letter-spacing: -0.02em; }
td.band .lvs { display: block; font-size: 11px; color: #8c8a84; font-weight: 700; letter-spacing: .06em; }
td.tier { width: 170px; font-size: 13px; line-height: 1.3; }
td.tier b { display: block; font-size: 14.5px; font-weight: 800; }
td.tier small { color: #52514e; font-size: 11.5px; }
td.v { text-align: right; font-weight: 600; width: 118px; }
tr.mid td.v { font-weight: 900; font-size: 19px; }
tr.mid td.tier b { font-size: 15.5px; }
.note { margin: 12px 0 0; font-size: 11.5px; color: #8c8a84; line-height: 1.6; }
</style></head><body><div class="page"${bare ? ' style="padding:16px"' : ''}><div class="card"${bare ? ' style="padding:10px 14px 8px"' : ''}>
${bare ? '' : `<h1>新メンバー募集の目安 · SLv 帯 × 属性の 1 凸ダメージ${A.some(a => a.total) ? ' と 3凸合計' : ''}</h1>
<p class="sub">しりすこPAD GB の利用者データ (第45回 · 2026-10 · ${total.toLocaleString()} 票 · 1 人 1 票のシーズンベスト · 締め凸は除外) から</p>
<p class="how"><b>見方:</b> 応募者のリザルトの SLv の行と属性の列を見る${A.some(a => a.total) ? ' (3凸合計は 1 日の 3 凸の合計で見る。強いバッファーをどの凸に使ったかの影響が消える)' : ''}。<b>中央値</b> (太字) 以上なら その SLv として平均以上、<b>上位25%</b> 以上なら 強い、<b>上位75%</b> を下回るなら 低め。</p>`}
<table${bare ? ' style="margin-top:0"' : ''}>
<thead><tr><th class="h">SLv</th><th class="h">基準</th>${A.map(a => `<th class="attr" style="background:${a.color};color:${a.fg}">${a.name}</th>`).join('')}</tr></thead>
<tbody>${body}</tbody>
</table>
${bare ? '' : `<p class="note">各帯の人数 (${nHead}): ${nLine}。${A.some(a => a.total) ? '3凸合計は 3 凸とも通常の凸だった日の合計で、1 人 1 票 (合計が最大の日)。' : ''}900+ は SLv 900〜1,152 をまとめた帯。500 台は人数が少なめなので目安。ボスの顔ぶれが変わる次回以降は数値が動く。</p>`}
</div></div></body></html>`;
fs.writeFileSync(outHtml, html);
console.log('ok', total);
