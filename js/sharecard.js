// シェアカードの Canvas 描画 (自己完結・状態を持たない純処理)。
// results (測定結果の配列) を受け取り、canvas に描いて PNG Blob を返す。
// SNS に流れる画像なので、ゲームアセットは一切使わない (絵文字 + 自作タイルのみ) —
// 権利表記 (非公式ファンコンテンツ / © SHIFT UP CORP.) を必ず焼き込む。
import { ATTR_INFO, SITE_URL } from './shared.js';
import { drawTileCanvas } from './tiles.js';

const F = "'Poppins', 'Noto Sans JP', sans-serif";

// 分布が解禁済みか (サーバーが bins を返しているか)
const distReady = (d) => d && !d.gated && Array.isArray(d.bins);

// opts.infoOf: キャラID → キャラ情報 (未指定なら編成タイルは描かない)
export async function buildShareCard(results, canvas, { infoOf = null } = {}) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const multi = results.length > 1;
    const mainInfo = ATTR_INFO[results[0].attribute];
    const mainColor = multi ? '#EFDD3C' : mainInfo.color;   // 複数凸はスキンのアクセント黄
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
    ctx.fillText(multi ? `ふるり値 (${results.length}凸)` : 'ふるり値', 70, 200);

    if (multi) {
        // 凸した数ぶんのカラム (2凸なら2列)。各列 = 属性 / スコア / 中央値比%
        const n = results.length;
        const colW = (W - 140) / n;
        results.forEach((r, i) => {
            const x0 = 70 + i * colW;
            const inf = ATTR_INFO[r.attribute];
            if (i > 0) {   // 区切り線
                ctx.strokeStyle = 'rgba(255,255,255,0.12)';
                ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(x0 - 24, 250); ctx.lineTo(x0 - 24, 430); ctx.stroke();
            }
            ctx.fillStyle = '#B6BBC1';
            ctx.font = `900 32px ${F}`;
            ctx.fillText(`${inf.emoji} ${inf.jp}PT`, x0, 280);
            ctx.fillStyle = inf.color;
            ctx.font = `900 ${n === 3 ? 84 : 96}px ${F}`;
            ctx.fillText(r.score.toFixed(2), x0, 375);
            const mp = distReady(r.dist) && r.dist.median > 0 ? Math.round((r.score / r.dist.median) * 100) : null;
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 27px ${F}`;
            ctx.fillText(mp != null ? `中央値比 ${mp}%` : `中央値 集計待ち`, x0, 425);
        });
        // 3凸合計: 各属性の中央値 (=そのボスの通しやすさ) で補正した総合指標。
        // 全属性の分布が解禁されているときだけ出す (Σスコア ÷ Σ中央値)
        const meds = results.map(r => (distReady(r.dist) && r.dist.median > 0) ? r.dist.median : null);
        const sum = results.reduce((s, r) => s + r.score, 0);
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 26px ${F}`;
        ctx.fillText(`${n}凸合計 ${sum.toFixed(2)} / SLv ${results[0].slv}`, 70, 505);
        if (meds.every(m => m != null)) {
            const totalPct = Math.round((sum / meds.reduce((s, m) => s + m, 0)) * 100);
            ctx.fillStyle = '#EFDD3C';
            ctx.font = `900 68px ${F}`;
            const tt = `総合 中央値比 ${totalPct}%`;
            ctx.fillText(tt, 70, 585);
            ctx.fillStyle = '#6B7178';
            ctx.font = `700 22px ${F}`;
            ctx.fillText('(ボスの通しやすさを中央値で補正した総合値)', 70 + ctx.measureText(tt).width + 20, 578);
        }
    } else {
        const r = results[0];
        ctx.fillStyle = mainColor;
        ctx.font = `900 190px ${F}`;
        ctx.fillText(mainScore.toFixed(2), 70, 400);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `900 44px ${F}`;
        ctx.fillText(`${mainInfo.emoji} ${mainInfo.jp}PT`, 74, 484);
        ctx.fillStyle = '#A4AAB0';
        ctx.font = `700 32px ${F}`;
        ctx.fillText(`SLv ${r.slv} / ${(r.damage / 1e9).toFixed(2)} B`, 340, 484);
        // 順位ではなく「中央値=100%としたときの%」を出す (運営方針 2026-07-30)
        const mp = distReady(r.dist) && r.dist.median > 0 ? Math.round((r.score / r.dist.median) * 100) : null;
        if (mp != null) {
            ctx.fillStyle = mainColor;
            ctx.font = `900 46px ${F}`;
            const pctText = `中央値比 ${mp}%`;
            const pctW = ctx.measureText(pctText).width;
            ctx.fillText(pctText, 70, 580);
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 30px ${F}`;
            ctx.fillText(`(${r.dist.n}人)`, 70 + pctW + 24, 578);
        }
        // 編成タイル (登録があるときだけ・右側に5枚)
        if (infoOf && Array.isArray(r.characters) && r.characters.length === 5) {
            const size = 96, gap = 10;
            const x0 = W - 60 - (size * 5 + gap * 4);
            for (let i = 0; i < 5; i++) {
                drawTileCanvas(ctx, infoOf(r.characters[i]), x0 + i * (size + gap), 470, size, F);
            }
        }
    }

    // 権利表記 + URL (SNS拡散面の必須表記)
    ctx.fillStyle = '#6B7178';
    ctx.font = `700 22px ${F}`;
    ctx.fillText('非公式ファンコンテンツ | 勝利の女神：NIKKE © SHIFT UP CORP.', 70, H - 44);
    ctx.font = `700 28px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 60, H - 44);
    ctx.textAlign = 'left';

    return new Promise(res => canvas.toBlob(res, 'image/png'));
}
