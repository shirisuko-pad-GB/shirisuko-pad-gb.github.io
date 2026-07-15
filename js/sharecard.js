// シェアカードの Canvas 描画 (自己完結・状態を持たない純処理)。
// results (測定結果の配列) を受け取り、canvas に描いて PNG Blob を返す。
import { ATTR_INFO, SITE_URL } from './shared.js';
import { topPercentFromCounts } from './calc.js';

const F = "'Noto Sans JP', sans-serif";

function loadImage(src) {
    return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
    });
}

// 分布が解禁済みか (サーバーが bins を返しているか)
const distReady = (d) => d && !d.gated && Array.isArray(d.bins);

export async function buildShareCard(results, canvas) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const multi = results.length > 1;
    const mainInfo = ATTR_INFO[results[0].attribute];
    const mainColor = multi ? '#46A0FF' : mainInfo.color;
    const mainScore = multi
        ? results.reduce((s, r) => s + r.score, 0) / results.length
        : results[0].score;

    // 背景
    ctx.fillStyle = '#14161A';
    ctx.fillRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, mainColor);
    grad.addColorStop(1, mainColor + '55');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, 14);
    const rg = ctx.createRadialGradient(W - 140, 130, 0, W - 140, 130, 320);
    rg.addColorStop(0, mainColor + '40');
    rg.addColorStop(1, mainColor + '00');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#8A9097';
    ctx.font = `900 30px ${F}`;
    ctx.fillText('SHIRISUKO PAD GB', 70, 92);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `900 56px ${F}`;
    ctx.fillText(multi ? `ふるり値 (${results.length}凸平均)` : 'ふるり値', 70, 210);
    ctx.fillStyle = mainColor;
    ctx.font = `900 190px ${F}`;
    ctx.fillText(mainScore.toFixed(2), 70, 400);

    if (multi) {
        let x = 74;
        for (const r of results) {
            const inf = ATTR_INFO[r.attribute];
            try { ctx.drawImage(await loadImage(inf.icon), x, 440, 48, 48); } catch { /* アイコンなしでも続行 */ }
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `900 40px ${F}`;
            const t = ` ${r.score.toFixed(2)}`;
            ctx.fillText(t, x + 50, 478);
            x += 50 + ctx.measureText(t).width + 40;
        }
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 30px ${F}`;
        ctx.fillText(`SLv ${results[0].slv}`, 70, 570);
    } else {
        const r = results[0];
        try { ctx.drawImage(await loadImage(mainInfo.icon), 74, 440, 56, 56); } catch { /* アイコンなしでも続行 */ }
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `900 44px ${F}`;
        ctx.fillText(`${mainInfo.jp}PT`, 146, 484);
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 32px ${F}`;
        ctx.fillText(`SLv ${r.slv} / ${(r.damage / 1e9).toFixed(2)} B`, 340, 484);
        const pct = distReady(r.dist) ? topPercentFromCounts(r.dist.above, r.dist.n) : null;
        if (pct != null) {
            ctx.fillStyle = mainColor;
            ctx.font = `900 46px ${F}`;
            const pctText = `上位 ${pct}%`;
            const pctW = ctx.measureText(pctText).width;
            ctx.fillText(pctText, 70, 580);
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 30px ${F}`;
            ctx.fillText(`(${r.dist.n}人中)`, 70 + pctW + 24, 578);
        }
    }

    ctx.fillStyle = '#6B7178';
    ctx.font = `700 28px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 60, H - 44);
    ctx.textAlign = 'left';

    return new Promise(res => canvas.toBlob(res, 'image/png'));
}
