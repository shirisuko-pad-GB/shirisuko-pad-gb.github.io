// シェアカードの Canvas 描画 (自己完結・状態を持たない純処理)。
// v5 (2026-07-31 モック承認版):
//   - 主役 = 中央値比% / サブ = ふるり値
//   - 凸した数だけ属性列が並び、複数凸なら「総合」列 (各凸の中央値比の平均) を最後に足す
//   - 各列にミニ分布 + 「あなた」マーカー ("だいたいこの辺" が分かる)
//   - ふるり値の属性またぎ合算はしない (運営判断)
//   - 属性は色+漢字 (絵文字なし)。カードは常に暗色 (テーマ非依存)
// SNS に流れる画像なのでゲームアセットは使わず、権利表記を必ず焼き込む。
import { ATTR_INFO, SITE_URL } from './shared.js';

const F = "'Poppins', 'Noto Sans JP', sans-serif";
const INK = '#14161A';
const CREAM = '#F6F1CD';

// 分布が解禁済みか (サーバーが bins を返しているか)
const distReady = (d) => d && !d.gated && Array.isArray(d.bins);

// ミニ分布: シルエットバー + 自分のビンだけ属性色 + 白い「あなた」バッジ
function drawMini(ctx, { x, y, w, h, bins, myBin, color, badge }) {
    const n = bins.length;
    const gap = 3;
    const bw = (w - gap * (n - 1)) / n;
    const max = Math.max(...bins, 1);
    for (let i = 0; i < n; i++) {
        const bh = Math.max(4, (bins[i] / max) * h);
        ctx.fillStyle = i === myBin - 1 ? color : 'rgba(255,255,255,0.13)';
        ctx.beginPath();
        ctx.roundRect(x + i * (bw + gap), y + h - bh, bw, bh, [bw / 2, bw / 2, 0, 0]);
        ctx.fill();
    }
    // 「あなた」バッジ (白ピル + 足)
    const cx = Math.min(x + w - 40, Math.max(x + 40, x + (myBin - 0.5) / n * w));
    ctx.font = `800 16px ${F}`;
    const tw = ctx.measureText(badge).width;
    const pw = tw + 22, ph = 26;
    const px = Math.min(x + w - pw, Math.max(x, cx - pw / 2));
    const py = y - ph - 10;
    ctx.fillStyle = '#F2F2EE';
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 13); ctx.fill();
    ctx.fillRect(cx - 1, py + ph, 2, 8);
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(badge, px + 11, py + 19);
}

// 大きい% (単位の%だけ小さく)
function drawBigPct(ctx, x, y, pct, size, color) {
    ctx.fillStyle = color;
    ctx.font = `800 ${size}px ${F}`;
    const t = pct != null ? String(pct) : '—';
    ctx.fillText(t, x, y);
    if (pct != null) {
        const w = ctx.measureText(t).width;
        ctx.font = `800 ${Math.round(size * 0.42)}px ${F}`;
        ctx.fillText('%', x + w + 6, y);
    }
}

export async function buildShareCard(results, canvas /*, opts */) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const multi = results.length > 1;
    const ratios = results.map(r =>
        (distReady(r.dist) && r.dist.median > 0) ? r.score / r.dist.median : null);
    const totalPct = multi && ratios.every(x => x != null)
        ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) : null;

    // 背景 + 上端バー (属性色 + 総合のクリーム)
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);
    const barColors = results.map(r => ATTR_INFO[r.attribute].color);
    if (multi) barColors.push(CREAM);
    const segW = W / barColors.length;
    barColors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * segW, 0, segW + 1, 14); });

    // ブランド + タイトル + 注記
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8A9097';
    ctx.font = `800 28px ${F}`;
    ctx.fillText('SHIRISUKO PAD GB', 70, 90);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 46px ${F}`;
    const title = multi ? `測定結果 (${results.length}凸)` : '測定結果';
    ctx.fillText(title, 70, 168);
    const titleW = ctx.measureText(title).width;   // 注記フォントに切り替える前に幅を測る
    ctx.fillStyle = '#8A9097';
    ctx.font = `700 21px ${F}`;
    ctx.fillText('中央値 = みんなの真ん中 = 100%', 70 + titleW + 28, 164);

    // 列構成: 凸の数 + (複数凸なら) 総合列
    const cols = results.map((r, i) => ({ type: 'atk', r, ratio: ratios[i] }));
    if (multi) cols.push({ type: 'sum' });
    const left = 70, span = W - 140;
    const cw = span / cols.length;
    const pad = 28;

    // 区切り線
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 2;
    for (let i = 1; i < cols.length; i++) {
        ctx.beginPath();
        ctx.moveTo(left + i * cw, 226);
        ctx.lineTo(left + i * cw, 566);
        ctx.stroke();
    }

    const bigSize = multi ? (cols.length >= 4 ? 62 : 72) : 104;
    cols.forEach((c, i) => {
        const x0 = left + i * cw + (i > 0 ? pad : 0);
        const iw = cw - (i > 0 ? pad : 0) - pad;
        if (c.type === 'sum') {
            ctx.fillStyle = CREAM;
            ctx.font = `800 24px ${F}`;
            ctx.fillText('総合', x0, 262);
            drawBigPct(ctx, x0, 262 + bigSize + 8, totalPct, bigSize, CREAM);
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 19px ${F}`;
            ctx.fillText('各凸の中央値比の平均', x0, 262 + bigSize + 44);
            ctx.fillStyle = '#A4AAB0';
            ctx.font = `700 22px ${F}`;
            ctx.fillText(`${results.length}凸 / SLv ${results[0].slv}`, x0, 470);
            ctx.fillStyle = '#6B7178';
            ctx.font = `700 16px ${F}`;
            ctx.fillText('ボスの通りやすさは属性ごとの', x0, 504);
            ctx.fillText('中央値で補正済み', x0, 528);
            return;
        }
        const { r, ratio } = c;
        const info = ATTR_INFO[r.attribute];
        const mp = ratio != null ? Math.round(ratio * 100) : null;
        ctx.fillStyle = info.color;
        ctx.font = `800 ${multi ? 24 : 30}px ${F}`;
        ctx.fillText(`${info.jp}PT`, x0, multi ? 262 : 270);
        const bigY = (multi ? 262 : 270) + bigSize + 8;
        drawBigPct(ctx, x0, bigY, mp, bigSize, info.color);
        ctx.fillStyle = '#8A9097';
        ctx.font = `700 ${multi ? 19 : 24}px ${F}`;
        ctx.fillText(`ふるり値 ${r.score.toFixed(2)}`, x0, bigY + (multi ? 36 : 44));
        // ミニ分布 (解禁前は出さず、案内だけ)
        const histY = multi ? 448 : 452;
        const histH = multi ? 76 : 96;
        if (distReady(r.dist)) {
            drawMini(ctx, {
                x: x0, y: histY, w: iw, h: histH,
                bins: r.dist.bins, myBin: r.dist.my_bin, color: info.color,
                badge: mp != null ? `あなた ${mp}%` : 'あなた',
            });
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 17px ${F}`;
            ctx.fillText(`中央値 ${r.dist.median.toFixed(2)} · ${r.dist.n}人`, x0, histY + histH + 30);
        } else {
            ctx.fillStyle = '#6B7178';
            ctx.font = `700 17px ${F}`;
            ctx.fillText(`みんなの分布は${r.dist?.need ?? 50}人で解禁`, x0, histY + histH + 30);
        }
    });

    // 権利表記 + URL (SNS拡散面の必須表記)
    ctx.fillStyle = '#6B7178';
    ctx.font = `700 20px ${F}`;
    ctx.fillText('非公式ファンコンテンツ | 勝利の女神：NIKKE © SHIFT UP CORP.', 70, H - 34);
    ctx.font = `700 24px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 70, H - 34);
    ctx.textAlign = 'left';

    return new Promise(res => canvas.toBlob(res, 'image/png'));
}
