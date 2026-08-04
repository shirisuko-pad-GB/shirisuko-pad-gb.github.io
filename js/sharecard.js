// シェアカードの Canvas 描画 (自己完結・状態を持たない純処理)。
// v6 (2026-07-31): v5 + 各列に「使った編成 (5人タイル)」と「編成内% (同一編成の中央値比)」。
//   - 主役 = 中央値比% / サブ = ふるり値
//   - 凸した数だけ属性列が並び、複数凸なら「総合」列 (各凸の中央値比の平均) を最後に足す
//   - 各列にミニ分布 + 「あなた」マーカー ("だいたいこの辺" が分かる)
//   - 編成内%は同一編成の提出がしきい値未満なら解禁待ちの案内に劣化
//   - ふるり値の属性またぎ合算はしない (運営判断)
//   - 属性は色+漢字 (絵文字なし)。カードは常に暗色 (テーマ非依存)
// SNS に流れる画像なのでゲームアセットは使わず、権利表記を必ず焼き込む。
import { ATTR_INFO, SITE_URL, THRESHOLDS } from './shared.js';
import { drawTileCanvas, sortForDisplay, charImgSrc } from './tiles.js';

const F = "'Poppins', 'Noto Sans JP', sans-serif";
const INK = '#14161A';
const CREAM = '#F6F1CD';

// 分布が解禁済みか (bins と median が揃っているか — 欠損応答での例外を防ぐ)
const distReady = (d) => d && !d.gated && Array.isArray(d.bins) && Number.isFinite(d.median);

// ユニオンロゴ (推しりをすこれ部 — メンバー作の背景透過版)。読めなければ静かに省く
let logoImg = null, logoTried = false;
function loadLogo() {
    if (logoTried) return Promise.resolve(logoImg);
    logoTried = true;
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { logoImg = img; resolve(img); };
        img.onerror = () => resolve(null);
        img.src = './assets/union-logo.png';
    });
}

// キャラ顔画像のロード (同一オリジンの character-images/ のみ — Canvas を汚染しない)。
// 失敗・画像なしは null → drawTileCanvas が自作タイルにフォールバック
const charImgCache = new Map();
function loadCharImg(info) {
    const src = charImgSrc(info);
    if (!src) return Promise.resolve(null);
    if (charImgCache.has(src)) return charImgCache.get(src);
    const p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
    charImgCache.set(src, p);
    return p;
}

// ミニ分布: シルエットバー + 自分のビンだけ属性色 (バッジ・高さ盛りは無し —
// 色変えだけで伝わる & 分布の形を歪めない。最低4pxの床は全バー共通)
function drawMini(ctx, { x, y, w, h, bins, myBin, color }) {
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
}

// 大きい数字 (単位は小さく添える)。桁が多いときは列幅に収まるまで縮小 (荒らし自認スコア対策)。
// unit を渡すと「123 %」のように単位付き、null なら数字だけ (ふるり値の主役表示)
function drawBigNum(ctx, x, y, text, size, color, maxW, unit = '%') {
    const t = String(text);
    let px = size;
    ctx.font = `800 ${px}px ${F}`;
    const unitW = unit ? px * 0.42 : 0;
    while (px > 20 && maxW && ctx.measureText(t).width + unitW > maxW) {
        px -= 4;
        ctx.font = `800 ${px}px ${F}`;
    }
    ctx.fillStyle = color;
    ctx.fillText(t, x, y);
    if (unit) {
        const w = ctx.measureText(t).width;
        ctx.font = `800 ${Math.round(px * 0.42)}px ${F}`;
        ctx.fillText(unit, x + w + 6, y);
    }
}

// 編成内% の1行 (同一編成の分布が解禁済みなら%、未解禁なら案内)。編成未入力は null
function compLineOf(r) {
    if (!r.characters?.length || !r.compDist) return null;
    const cd = r.compDist;
    if (!cd.gated && Number.isFinite(cd.median) && cd.median > 0) {
        return { text: `編成内 ${Math.round((r.score / cd.median) * 100)}% · ${cd.n}人`, ready: true };
    }
    return { text: `編成内%は${cd.need ?? THRESHOLDS.comp}人で解禁`, ready: false };
}

// 締め凸列のマーキング (打ち切りダメージ = 参考値、を視覚で伝える)。
// style: 'frame' = 属性色の枠囲い / 'dashed' = ニュートラル破線枠 / 'tint' = 属性色の薄い面
function drawFinishMark(ctx, { style, fx, fy, fw, fh, color }) {
    ctx.save();
    if (style === 'tint') {
        ctx.fillStyle = color + '14';   // 属性色 8%
        ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 18); ctx.fill();
    } else {
        ctx.strokeStyle = style === 'dashed' ? '#8A9097' : color;
        ctx.lineWidth = 3;
        if (style === 'dashed') ctx.setLineDash([9, 7]);
        ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 18); ctx.stroke();
        ctx.setLineDash([]);
    }
    // 「締め凸」ピル (枠の上辺右に載せる)
    ctx.font = `800 17px ${F}`;
    const label = '締め凸';
    const pw = ctx.measureText(label).width + 26, ph = 32;
    const px = fx + fw - pw - 14, py = fy - ph / 2;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, ph / 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(label, px + pw / 2, py + 22);
    ctx.textAlign = 'left';
    ctx.restore();
}

export async function buildShareCard(results, canvas, opts = {}) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const infoOf = typeof opts.infoOf === 'function' ? opts.infoOf : null;
    const finishStyle = opts.finishStyle ?? 'frame';
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const multi = results.length > 1;
    const ratios = results.map(r =>
        (distReady(r.dist) && r.dist.median > 0) ? r.score / r.dist.median : null);
    // 総合は締め凸を除いた凸だけで平均 (締め凸は打ち切りダメージで構造的に低いため)
    const scoredIdx = results.map((r, i) => r.isFinish ? null : i).filter(x => x != null);
    const scoredRatios = scoredIdx.map(i => ratios[i]);
    const anyFinish = scoredIdx.length < results.length;
    const totalPct = multi && scoredRatios.length > 0 && scoredRatios.every(x => x != null)
        ? Math.round((scoredRatios.reduce((s, x) => s + x, 0) / scoredRatios.length) * 100) : null;

    // 編成の顔画像を先にまとめてロード (Canvas 描画は同期のため)。無い顔は自作タイルで描く
    const charFaces = new Map();   // 代表ID → HTMLImageElement
    if (infoOf) {
        const ids = [...new Set(results.flatMap(r => r.characters ?? []).map(id => infoOf(id)?.id).filter(Boolean))];
        await Promise.all(ids.map(async (cid) => {
            const img = await loadCharImg(infoOf(cid));
            if (img) charFaces.set(cid, img);
        }));
    }

    // 背景 + 上端バー (属性色 + 総合のクリーム)
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);
    const barColors = results.map(r => ATTR_INFO[r.attribute].color);
    if (multi) barColors.push(CREAM);
    const segW = W / barColors.length;
    barColors.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * segW, 0, segW + 1, 14); });

    // 上段を1行の意味のある帯に: 左 = サイト名 / 右 = Developed by 推しりをすこれ部 (ロゴ)。
    // ロゴはユニオン名入りのワードマークなので、文字は「Developed by」だけ添える
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8A9097';
    ctx.font = `800 28px ${F}`;
    ctx.fillText('SHIRISUKO PAD GB', 70, 90);
    const logo = await loadLogo();
    if (logo) {
        const lh = 56;
        const lw = Math.round(lh * logo.width / logo.height);
        const lx = W - 70 - lw;
        ctx.drawImage(logo, lx, 90 - lh + 14, lw, lh);   // ブランド行とベースラインを揃える
        ctx.fillStyle = '#8A9097';
        ctx.font = `700 22px ${F}`;
        ctx.textAlign = 'right';
        ctx.fillText('Developed by', lx - 16, 84);
        ctx.textAlign = 'left';
    }
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
        ctx.lineTo(left + i * cw, 650);
        ctx.stroke();
    }

    // % がSNSでの主役。行 (ふるり値・実ダメージ・編成タイル) を詰めた分だけ数字を大きく取る
    const bigSize = multi ? (cols.length >= 4 ? 84 : 96) : 128;
    cols.forEach((c, i) => {
        const x0 = left + i * cw + (i > 0 ? pad : 0);
        const iw = cw - (i > 0 ? pad : 0) - pad;
        if (c.type === 'sum') {
            // 総合の母集団 = 締め凸を除いた凸 (打ち切りダメージを平均に混ぜない)
            const scored = results.filter(r2 => !r2.isFinish);
            ctx.fillStyle = CREAM;
            ctx.font = `800 26px ${F}`;
            ctx.fillText('総合', x0, 252);
            // 未解禁 (分布50人未満) の間は % が出せないので、平均ふるり値を主役にする
            // (結果カードと同じ主従ルール。SNSに「—」だけの巨大ダッシュを流さない)
            const avgBase = scored.length ? scored : results;
            const avgScore = avgBase.reduce((s2, r2) => s2 + r2.score, 0) / avgBase.length;
            if (totalPct != null) drawBigNum(ctx, x0, 252 + bigSize + 4, totalPct, bigSize, CREAM, iw);
            else drawBigNum(ctx, x0, 252 + bigSize + 4, avgScore.toFixed(2), bigSize, CREAM, iw, null);
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 18px ${F}`;
            ctx.fillText(totalPct != null ? '各凸の中央値比を同じ重みで平均' : `平均ふるり値 (${avgBase.length}凸)`,
                x0, 252 + bigSize + 36);
            ctx.fillStyle = '#A4AAB0';
            ctx.font = `700 22px ${F}`;
            const sumLabel = anyFinish ? `${scored.length}凸 (締め凸除く) / SLv ${results[0].slv}`
                                       : `${results.length}凸 / SLv ${results[0].slv}`;
            ctx.fillText(sumLabel, x0, 514);   // 属性列の編成内%と同じ高さ
            // のべ比較人数 = 各属性分布の n の合計 (どれだけの提出と比べたかが一目で分かる)
            const totalN = results.filter(r2 => distReady(r2.dist)).reduce((s2, r2) => s2 + r2.dist.n, 0);
            if (totalN > 0) {
                ctx.fillStyle = '#8A9097';
                ctx.font = `700 19px ${F}`;
                ctx.fillText(`のべ ${totalN}人の提出と比較`, x0, 548);
            }
            ctx.fillStyle = '#6B7178';
            ctx.font = `700 16px ${F}`;
            if (anyFinish) ctx.fillText('締め凸は分布・総合に不参加 (参考)', x0, 584);
            ctx.fillText('ボスの通りやすさは属性ごとの', x0, anyFinish ? 610 : 596);
            ctx.fillText('中央値で補正済み。編成内%は', x0, anyFinish ? 634 : 622);
            ctx.fillText('同じ5人との比較 (並び順は不問)', x0, anyFinish ? 658 : 648);
            return;
        }
        const { r, ratio } = c;
        const info = ATTR_INFO[r.attribute];
        const mp = ratio != null ? Math.round(ratio * 100) : null;
        // 締め凸マーキング (コンテンツより先に描く — tint は背景面のため)
        if (r.isFinish) {
            drawFinishMark(ctx, {
                style: finishStyle, color: info.color,
                fx: x0 - 14, fy: 224, fw: iw + 28, fh: multi ? 442 : 502,
            });
        }
        ctx.fillStyle = info.color;
        ctx.font = `800 ${multi ? 26 : 30}px ${F}`;
        ctx.fillText(`${info.jp}PT`, x0, multi ? 252 : 270);
        const bigY = (multi ? 252 : 270) + bigSize + 4;
        // damage/slv は localStorage 復元の古い保存に無いことがある → 欠けは静かに省く (NaN対策)
        const dmgB = Number.isFinite(r.damage) ? `${(r.damage / 1e9).toFixed(2)} B` : null;
        // 解禁前は % が無いのでふるり値を主役に (結果カードと同じ主従)
        if (mp != null) drawBigNum(ctx, x0, bigY, mp, bigSize, info.color, iw);
        else drawBigNum(ctx, x0, bigY, r.score.toFixed(2), bigSize, info.color, iw, null);
        ctx.fillStyle = '#8A9097';
        ctx.font = `700 ${multi ? 19 : 24}px ${F}`;
        if (multi) {
            // 2行だったふるり値・実ダメージを1行に (空いた分を % の拡大に回す)。
            // 列幅 iw を超えると隣列に食い込むので、縮小 → それでも無理なら実ダメージを落とす
            const head = mp != null ? `ふるり値 ${r.score.toFixed(2)}` : 'ふるり値';
            const fitLine = (txt, startPx) => {
                let px = startPx;
                ctx.font = `700 ${px}px ${F}`;
                while (px > 13 && ctx.measureText(txt).width > iw) { px -= 1; ctx.font = `700 ${px}px ${F}`; }
                return ctx.measureText(txt).width <= iw;
            };
            const full = [head, dmgB].filter(Boolean).join(' · ');
            if (!fitLine(full, 19)) fitLine(head, 19);   // 収まらなければ実ダメージを省く
            ctx.fillText(ctx.measureText(full).width <= iw ? full : head, x0, bigY + 34);
        } else {
            // 単発は列幅が広いので1行にまとめる (SLv は総合列が無いのでここに出す)
            const parts = [mp != null ? `ふるり値 ${r.score.toFixed(2)}` : 'ふるり値',
                Number.isFinite(r.slv) ? `SLv ${r.slv}` : null, dmgB].filter(Boolean);
            ctx.fillText(parts.join(' · '), x0, bigY + 44);
        }
        // 使った編成 (順不同で保存 — 表示はバースト順に揃える) + 編成内% (同一編成の中央値比)
        const tilesY = multi ? 442 : 448;
        const gapT = 4;
        const ts = Math.min(multi ? 42 : 58, Math.floor((iw - gapT * 4) / 5));
        const canTiles = infoOf && r.characters?.length;
        if (canTiles) {
            sortForDisplay(r.characters, infoOf).forEach((id, ti) => {
                const cinfo = infoOf(id);
                drawTileCanvas(ctx, cinfo, x0 + ti * (ts + gapT), tilesY, ts, F, charFaces.get(cinfo?.id) ?? null);
            });
        }
        const compLine = compLineOf(r);
        if (compLine) {
            const clY = tilesY + (canTiles ? ts : 0) + (multi ? 30 : 34);
            ctx.fillStyle = compLine.ready ? '#F1F2F4' : '#6B7178';
            ctx.font = `700 ${multi ? 17 : 20}px ${F}`;
            ctx.fillText(compLine.text, x0, clY);
        }
        // ミニ分布 (解禁前は出さず、案内だけ)
        const histY = multi ? 524 : 566;
        const histH = multi ? 96 : 114;
        if (distReady(r.dist)) {
            drawMini(ctx, {
                x: x0, y: histY, w: iw, h: histH,
                bins: r.dist.bins, myBin: r.dist.my_bin, color: info.color,
            });
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 17px ${F}`;
            ctx.fillText(`中央値 ${r.dist.median.toFixed(2)} · ${r.dist.n}人`, x0, histY + histH + 30);
        } else {
            // 未解禁: 分布の領域が空くと間延びするので、解禁までの進捗を描く
            // (「あと◯人」が見えると拡散の動機にもなる)
            // need は 0 や欠損でも 0除算にならないよう下限1 (実運用はサーバー既定の50)
            const need = Math.max(1, Number.isFinite(r.dist?.need) ? r.dist.need : THRESHOLDS.dist);
            const now = Math.max(0, Math.min(need, Number.isFinite(r.dist?.n) ? r.dist.n : 0));
            const barH = 14, barY = histY + histH - barH - 4;
            ctx.fillStyle = '#8A9097';
            ctx.font = `700 ${multi ? 17 : 20}px ${F}`;
            ctx.fillText(`みんなの分布まで あと${Math.max(0, need - now)}人`, x0, barY - 16);
            ctx.fillStyle = 'rgba(255,255,255,0.13)';
            ctx.beginPath(); ctx.roundRect(x0, barY, iw, barH, barH / 2); ctx.fill();
            const w = Math.max(barH, iw * (now / need));
            ctx.fillStyle = info.color;
            ctx.beginPath(); ctx.roundRect(x0, barY, w, barH, barH / 2); ctx.fill();
            ctx.fillStyle = '#6B7178';
            ctx.font = `700 16px ${F}`;
            ctx.fillText(`現在 ${now} / ${need}人`, x0, histY + histH + 30);
        }
    });

    // 権利表記 + URL (SNS拡散面の必須表記 — キャラ画像の著作権の在りどころを明記)。
    // 表記が長くなったため左側は2段組 (URL と重ねない)
    ctx.fillStyle = '#6B7178';
    ctx.font = `700 17px ${F}`;
    ctx.fillText('非公式ファンコンテンツ — 掲載に問題がある場合は削除対応します', 70, H - 58);
    ctx.fillText('キャラクター画像・名称: 勝利の女神：NIKKE © SHIFT UP CORP.', 70, H - 30);
    ctx.font = `700 24px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 70, H - 30);
    ctx.textAlign = 'left';

    return new Promise(res => canvas.toBlob(res, 'image/png'));
}
