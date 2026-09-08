// シェアカードの Canvas 描画 (自己完結・状態を持たない純処理)。
// v6 (2026-07-31): v5 + 各列に「使った編成 (5人タイル)」と「編成内% (同一編成の中央値比)」。
//   - 主役 = 中央値比% / サブ = ふるり値
//   - 凸した数だけ属性列が並び、複数凸なら「総合」列 (各凸の中央値比の平均) を最後に足す
//   - 各列にミニ分布 + 「あなた」マーカー ("だいたいこの辺" が分かる)
//   - 編成内%は同一編成の提出がしきい値未満なら解禁待ちの案内に劣化
//   - ふるり値の属性またぎ合算はしない (運営判断)
//   - 属性は色+漢字 (絵文字なし)。カードは常に暗色 (テーマ非依存)
// SNS に流れる画像なのでゲームアセットは使わず、権利表記を必ず焼き込む。
// v7 (2026-09-08): 表示言語に追従 (英語圏からの要望)。カードは幅 1200px 固定で
//   4列時の1列が 209px しかないため、**英語で溢れる文字は fitText で自動的に縮める**。
//   訳文そのものも短い言い回しを選んである (messages.js)。
import { ATTR_INFO, SITE_URL, THRESHOLDS, attrName } from './shared.js';
import { t } from './i18n.js';
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

// 幅に収まるまでフォントを細らせて描く。**英語対応で必須** — 日本語前提の固定座標に
// 1.5〜2倍長い英訳を流すと、隣の列や画像の外へはみ出す。
// 返り値は実際に使った px (呼ぶ側が次の行の位置を決められるように)。
function fitText(ctx, text, x, y, maxW, startPx, weight = 700, minPx = 12) {
    let px = startPx;
    ctx.font = `${weight} ${px}px ${F}`;
    while (px > minPx && ctx.measureText(text).width > maxW) {
        px -= 1;
        ctx.font = `${weight} ${px}px ${F}`;
    }
    ctx.fillText(text, x, y);
    return px;
}

// 編成内% の1行 (同一編成の分布が解禁済みなら%、未解禁なら案内)。編成未入力は null
function compLineOf(r) {
    if (!r.characters?.length || !r.compDist) return null;
    const cd = r.compDist;
    if (!cd.gated && Number.isFinite(cd.median) && cd.median > 0) {
        return { text: t('card.in_comp', { pct: Math.round((r.score / cd.median) * 100), n: cd.n }), ready: true };
    }
    return { text: t('card.in_comp_locked', { n: cd.need ?? THRESHOLDS.comp }), ready: false };
}

// 締め凸列のマーキング (打ち切りダメージ = 参考値、を視覚で伝える)。
// 確定デザイン (ユーザー選定 2026-08-04): グレー破線枠 + 控えめな「締め凸」表記
// (暗背景・グレー細枠・グレー文字の小ピル — 主張しすぎない)
function drawFinishMark(ctx, { fx, fy, fw, fh }) {
    const GRAY = '#8A9097';
    ctx.save();
    ctx.strokeStyle = GRAY;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 7]);
    ctx.beginPath(); ctx.roundRect(fx, fy, fw, fh, 18); ctx.stroke();
    ctx.setLineDash([]);
    // 「締め凸」小ピル (枠の上辺右に載せる — 破線を隠すため暗背景で塗ってから細枠)
    ctx.font = `700 15px ${F}`;
    const label = t('card.finisher');
    const pw = ctx.measureText(label).width + 22, ph = 26;
    const px = fx + fw - pw - 14, py = fy - ph / 2;
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, ph / 2); ctx.fill();
    ctx.strokeStyle = GRAY;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(px, py, pw, ph, ph / 2); ctx.stroke();
    ctx.fillStyle = GRAY;
    ctx.textAlign = 'center';
    ctx.fillText(label, px + pw / 2, py + 18.5);
    ctx.textAlign = 'left';
    ctx.restore();
}

export async function buildShareCard(results, canvas, opts = {}) {
    if (!Array.isArray(results) || results.length === 0) return null;
    const infoOf = typeof opts.infoOf === 'function' ? opts.infoOf : null;
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
    const title = multi ? t('card.results_n', { n: results.length }) : t('card.results');
    ctx.fillText(title, 70, 168);
    const titleW = ctx.measureText(title).width;   // 注記フォントに切り替える前に幅を測る
    ctx.fillStyle = '#8A9097';
    ctx.font = `700 21px ${F}`;
    // 注記はタイトルの右に置く。英語はタイトルも注記も長いので、右端 (W-70) を
    // 越えるようなら**縮めて**収める (改行するとロゴ帯と干渉する)
    const noteText = t('card.median_is_100');
    const noteX = 70 + titleW + 28;
    fitText(ctx, noteText, noteX, 164, W - 70 - noteX, 21);

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
            ctx.fillText(t('card.overall'), x0, 252);
            // 未解禁 (分布50人未満) の間は % が出せないので、平均ふるり値を主役にする
            // (結果カードと同じ主従ルール。SNSに「—」だけの巨大ダッシュを流さない)。
            // 全凸締め凸のときも平均ふるり値だが「参考」を明示 (Codex指摘 — 総合を装わない)
            const allFinish = scored.length === 0;
            const avgBase = allFinish ? results : scored;
            const avgScore = avgBase.reduce((s2, r2) => s2 + r2.score, 0) / avgBase.length;
            if (totalPct != null) drawBigNum(ctx, x0, 252 + bigSize + 4, totalPct, bigSize, CREAM, iw);
            else drawBigNum(ctx, x0, 252 + bigSize + 4, avgScore.toFixed(2), bigSize, CREAM, iw, null);
            ctx.fillStyle = '#8A9097';
            const subNote = totalPct != null ? t('card.overall_note')
                : allFinish ? t('card.avg_fururi_all_finish')
                            : t('card.avg_fururi_n', { n: avgBase.length });
            fitText(ctx, subNote, x0, 252 + bigSize + 36, iw, 18);
            ctx.fillStyle = '#A4AAB0';
            const sumLabel = allFinish ? t('card.sub_all_finish', { n: results.length, slv: results[0].slv })
                : anyFinish ? t('card.sub_excl_finish', { n: scored.length, slv: results[0].slv })
                            : t('card.sub_plain', { n: results.length, slv: results[0].slv });
            fitText(ctx, sumLabel, x0, 514, iw, 22);   // 属性列の編成内%と同じ高さ
            // 比較規模: ユニーク利用者数 + 総合分布の母集団 (3凸完走勢)。
            // 11未適用・取得失敗時は従来の「のべ人数」に劣化 (同一人物の重複カウントあり)
            const td = opts.totalDist;
            ctx.fillStyle = '#8A9097';
            if (td?.users > 0) {
                fitText(ctx, t('card.users_n', { n: td.users }), x0, 548, iw, 19);
                if (Number.isFinite(td.n) && td.n > 0) {
                    fitText(ctx, t('card.vs_completed', { n: td.n }), x0, 576, iw, 19);
                }
            } else {
                const totalN = results.filter(r2 => distReady(r2.dist)).reduce((s2, r2) => s2 + r2.dist.n, 0);
                if (totalN > 0) fitText(ctx, t('card.vs_submissions', { n: totalN }), x0, 548, iw, 19);
            }
            ctx.fillStyle = '#6B7178';
            if (anyFinish) fitText(ctx, t('card.finish_excluded'), x0, 600, iw, 16);
            fitText(ctx, t('card.note_line1'), x0, anyFinish ? 624 : 596, iw, 16);
            fitText(ctx, t('card.note_line2'), x0, anyFinish ? 648 : 622, iw, 16);
            fitText(ctx, t('card.note_line3'), x0, anyFinish ? 672 : 648, iw, 16);
            return;
        }
        const { r, ratio } = c;
        const info = ATTR_INFO[r.attribute];
        const mp = ratio != null ? Math.round(ratio * 100) : null;
        // 締め凸マーキング (グレー破線枠 — コンテンツと重ならないので先に描いてよい)
        if (r.isFinish) {
            drawFinishMark(ctx, { fx: x0 - 14, fy: 224, fw: iw + 28, fh: multi ? 442 : 502 });
        }
        ctx.fillStyle = info.color;
        // 「灼熱PT」→ 英語は「Fire team」。英語の方が長いので幅に収める
        fitText(ctx, t('card.team_of', { code: attrName(r.attribute) }),
            x0, multi ? 252 : 270, iw, multi ? 26 : 30, 800);
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
            const head = mp != null ? t('card.fururi_val', { v: r.score.toFixed(2) }) : t('card.fururi');
            const full = [head, dmgB].filter(Boolean).join(' · ');
            // 収まらなければ実ダメージを省いて、ふるり値だけにする
            ctx.font = `700 13px ${F}`;
            const fits = ctx.measureText(full).width <= iw;
            fitText(ctx, fits ? full : head, x0, bigY + 34, iw, 19, 700, 13);
        } else {
            // 単発は列幅が広いので1行にまとめる (SLv は総合列が無いのでここに出す)
            const parts = [mp != null ? t('card.fururi_val', { v: r.score.toFixed(2) }) : t('card.fururi'),
                Number.isFinite(r.slv) ? `SLv ${r.slv}` : null, dmgB].filter(Boolean);
            fitText(ctx, parts.join(' · '), x0, bigY + 44, iw, 24);
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
            fitText(ctx, compLine.text, x0, clY, iw, multi ? 17 : 20);
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
            fitText(ctx, t('card.median_n', { v: r.dist.median.toFixed(2), n: r.dist.n }),
                x0, histY + histH + 30, iw, 17);
        } else {
            // 未解禁: 分布の領域が空くと間延びするので、解禁までの進捗を描く
            // (「あと◯人」が見えると拡散の動機にもなる)
            // need は 0 や欠損でも 0除算にならないよう下限1 (実運用はサーバー既定の50)
            const need = Math.max(1, Number.isFinite(r.dist?.need) ? r.dist.need : THRESHOLDS.dist);
            const now = Math.max(0, Math.min(need, Number.isFinite(r.dist?.n) ? r.dist.n : 0));
            const barH = 14, barY = histY + histH - barH - 4;
            ctx.fillStyle = '#8A9097';
            fitText(ctx, t('card.until_dist', { n: Math.max(0, need - now) }), x0, barY - 16,
                iw, multi ? 17 : 20);
            ctx.fillStyle = 'rgba(255,255,255,0.13)';
            ctx.beginPath(); ctx.roundRect(x0, barY, iw, barH, barH / 2); ctx.fill();
            const w = Math.max(barH, iw * (now / need));
            ctx.fillStyle = info.color;
            ctx.beginPath(); ctx.roundRect(x0, barY, w, barH, barH / 2); ctx.fill();
            ctx.fillStyle = '#6B7178';
            fitText(ctx, t('card.progress_n', { now, need }), x0, histY + histH + 30, iw, 16);
        }
    });

    // 権利表記 + URL (SNS拡散面の必須表記 — キャラ画像の著作権の在りどころを明記)。
    // 表記が長くなったため左側は2段組 (URL と重ねない)
    ctx.fillStyle = '#6B7178';
    // 右下の URL と重ならないところまで (英語の権利表記は日本語より長い)
    const legalW = W - 70 - 360;
    fitText(ctx, t('card.fanmade'), 70, H - 58, legalW, 17);
    fitText(ctx, t('card.copyright'), 70, H - 30, legalW, 17);
    ctx.font = `700 24px ${F}`;
    ctx.textAlign = 'right';
    ctx.fillText(SITE_URL.replace('https://', '').replace(/\/$/, ''), W - 70, H - 30);
    ctx.textAlign = 'left';

    return new Promise(res => canvas.toBlob(res, 'image/png'));
}
