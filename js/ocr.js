// BlaBlaLINK の「凸一覧」スクショから (属性, ダメージ) を読み取る (端末内・AI不使用)。
//
// 【方針 — 2026-09-24 ユーザー決定】
//   ・AI (画像認識API) は使わない。公開サイトで大多数が使うので費用を青天井にしない。
//     Tesseract (端末内で動く従来型OCR・無料) だけを使う
//   ・あくまで補助。読み取り結果は入力欄に入れるだけで、送信は本人が確認してから (自動送信しない)
//   ・画像は端末内で処理し、どこにも送信しない (公開サイトの前提: 外部入力を常に疑う)
//   ・ボスレベルは読めるが記録しない (内部で行の目印に使うだけ)
//
// 【何を・どう読むか — 実スクショ2枚 (iPhone・ライト表示) で 6/6 正解した方式】
//   素のOCRは日本語が混ざって崩れる。狙いを2つに絞る:
//   ① ダメージ … 「数字とカンマだけ」に文字種を絞ったOCR → 12,345,678,901 の形を拾う
//   ② ボス     … 文字は読まない。行の目印に「Level N」(素のOCRで安定して読める) を使い、
//                その行の左にある属性アイコンの「色」で判定する (赤/緑/青/紫/金 の5色)。
//                ボス自身の属性 → 殴るPT属性 (弱点) は ATTR_INFO.enemy の逆引き
//   ③ 対応づけ … 各ダメージの「直上の Level 行」がそのボス
//   1回目の素朴な色判定は、キャラタイルの星 (黄) と1人目の赤髪を「アイコン」と誤認した。
//   「Level」の位置を先に確定してから色を見る、が正解 (色だけでは行を特定できない)。
//
// 【未検証・弱いところ】 他端末・Android・ダーク表示は未検証 (追加スクショ待ち)。
//   ダーク表示は「Level が1つも読めなければ反転して再試行」で一応の保険を掛けている。
//   読めなければ空を返して手入力に戻る (ここが落ちても送信経路は従来どおり)。
//
// 座標はすべて幅 W に対する比率で持つ (端末の解像度差を吸収するため)。基準は 1179px 幅の iPhone。

import { ATTR_INFO } from './shared.js';

// ---------- 純関数 (テスト対象) ----------

// 画素の色相から属性アイコンの色を判定する。null = 背景・文字・淡い色。
// しきい値は実スクショの計測値: 赤アイコン 340〜15°, 金の六角形 (D.M.T.R.) は 30° 前後,
// 緑 120°, 青 210°, 紫 270°。彩度 (max-min) と明るさが低い画素は除外。
export function classifyHue(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 60 || d < 60) return null;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 15 || h >= 340) return 'FIRE';
    if (h >= 22 && h < 65) return 'IRON';
    if (h >= 95 && h < 160) return 'WIND';
    if (h >= 195 && h < 235) return 'WATER';
    if (h >= 255 && h < 300) return 'ELECTRIC';
    return null;
}

// ボス自身の属性 → そのボスを殴るPT属性 (弱点)。ATTR_INFO[pt].enemy が唯一の相性表
export function ptOfBossAttr(bossAttr) {
    const hit = Object.entries(ATTR_INFO).find(([, v]) => v.enemy === bossAttr);
    return hit ? hit[0] : null;
}

// OCR の単語が「桁区切りのダメージ」なら B 単位 (0.01B 丸め) を返す。違えば null。
// 10億〜 (4グループ以上) を要求: 3グループ (百万台) は戦闘力などの誤拾いなので弾く
export function parseDamageWord(text) {
    const t = String(text ?? '').trim();
    if (!/^\d{1,3}(?:,\d{3}){3,}$/.test(t)) return null;
    const raw = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw / 1e7) / 100;   // 35,512,860,640 → 35.51
}

// 「Level N」の単語か (OCR の読み揺れ Leve1 / LeveI / Level| も許容)
export function isLevelWord(text) {
    return /^Leve[l1I|]$/i.test(String(text ?? '').trim());
}

// 対応づけ: 各ダメージに「直上のボス行」を割り当てる。行に色が無ければその凸は捨てる。
// anchors: [{yc, attribute}] / damages: [{yc, damageB, conf}] → 上から順に最大 max 件
export function pairAnchorsWithDamages(anchors, damages, max = 3) {
    const rows = anchors.filter(a => a && Number.isFinite(a.yc)).sort((a, b) => a.yc - b.yc);
    const out = [];
    for (const d of [...damages].sort((a, b) => a.yc - b.yc)) {
        const cand = rows.filter(r => r.yc < d.yc);
        const above = cand.length ? cand[cand.length - 1] : null;   // .at() は iOS 15.4 未満に無い
        if (!above || !above.attribute) continue;
        // 同じボス行に2つ以上ダメージが付いたら (読み違い) 最初の1つだけ採る
        if (out.some(o => o.anchorY === above.yc)) continue;
        out.push({ attribute: above.attribute, damageB: d.damageB, conf: d.conf ?? null, anchorY: above.yc });
        if (out.length >= max) break;
    }
    return out.map(({ anchorY, ...o }) => o);
}

// ---------- 画像処理 (ブラウザ専用) ----------

// Tesseract の配信元を版数ごと固定する (勝手に上がって挙動が変わらないように)。
// 初回だけ core (約4MB) と英語データを取りに行く。以後はブラウザキャッシュ。
// 英語データは軽量版 4.0.0_fast (約2MB)。標準版 (約11MB) と実スクショで精度が同じだったので
// スマホの初回待ちを短くする方を取った (tests/ocr-local.mjs --lang で両方を比較できる)
const TESS_VER = '5.1.1';
const TESS = {
    script: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/tesseract.min.js`,
    workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VER}/dist/worker.min.js`,
    corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VER}`,
    langPath: 'https://tessdata.projectnaptha.com/4.0.0_fast',
};
const MAX_W = 1400;          // これ以上は縮小してから読む (端末の負荷を抑える。1179px 基準で十分読めている)
const MIN_W = 700;           // これ未満は読めない可能性が高い (警告だけ出して試す)
// アイコン探索窓 (Level 行の左・少し上)。1179px 幅での実測 x 12〜24% / y -75〜+15px を比率に
const ICON_X0 = 0.12, ICON_X1 = 0.24, ICON_Y0 = -0.064, ICON_Y1 = 0.013;

let tessPromise = null;
function loadTesseract() {
    if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
    if (tessPromise) return tessPromise;
    tessPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = TESS.script; s.async = true;
        s.onload = () => globalThis.Tesseract ? resolve(globalThis.Tesseract) : reject(new Error('Tesseract が読み込めませんでした'));
        s.onerror = () => reject(new Error('OCR ライブラリの取得に失敗しました (通信を確認してください)'));
        document.head.appendChild(s);
    }).catch(e => { tessPromise = null; throw e; });
    return tessPromise;
}

let workerPromise = null;
async function getWorker(onProgress, langPath = TESS.langPath) {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
        const T = await loadTesseract();
        return T.createWorker('eng', 1, {
            workerPath: TESS.workerPath, corePath: TESS.corePath, langPath,
            logger: (m) => { if (onProgress && m?.status) onProgress(m.status, m.progress ?? null); },
        });
    })().catch(e => { workerPromise = null; throw e; });
    return workerPromise;
}

// File/Blob → 読み取り用キャンバス (幅を MAX_W 以下に揃える)
async function toCanvas(file) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_W / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c;
}

// グレースケール + コントラスト (invert=true でダーク表示を反転して読む)
function preprocess(src, invert) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const im = ctx.getImageData(0, 0, c.width, c.height), p = im.data;
    for (let i = 0; i < p.length; i += 4) {
        let v = (p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114);
        v = Math.max(0, Math.min(255, (v - 128) * 1.3 + 128));   // コントラスト
        if (invert) v = 255 - v;
        p[i] = p[i + 1] = p[i + 2] = v;
    }
    ctx.putImageData(im, 0, 0);
    return new Promise(res => c.toBlob(res, 'image/png'));
}

// Level 行の左にある属性アイコンの色 (元のカラー画像で見る)
function iconAttrAt(colorCtx, W, H, yc) {
    const cnt = {};
    const y0 = Math.max(0, Math.round(yc + ICON_Y0 * W)), y1 = Math.min(H, Math.round(yc + ICON_Y1 * W));
    const x0 = Math.round(W * ICON_X0), x1 = Math.round(W * ICON_X1);
    if (y1 <= y0 || x1 <= x0) return null;
    const im = colorCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    for (let i = 0; i < im.length; i += 8) {           // 1画素おき
        const k = classifyHue(im[i], im[i + 1], im[i + 2]);
        if (k) cnt[k] = (cnt[k] || 0) + 1;
    }
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 10 ? top[0] : null;       // 画素が少なすぎれば「色不明」
}

/**
 * スクショ1枚から凸を読み取る。失敗しても例外を投げず {attacks: [], warnings} を返す。
 * @param {Blob} file
 * @param {{onProgress?: (status: string, progress: number|null) => void, max?: number}} opts
 * @returns {Promise<{attacks: {attribute: string, damageB: number, conf: number|null}[], warnings: string[]}>}
 */
export async function readRaidScreenshot(file, { onProgress, max = 3, langPath } = {}) {   // langPath は検証用 (既定は固定URL)
    const warnings = [];
    try {
        const color = await toCanvas(file);
        const W = color.width, H = color.height;
        if (W < MIN_W) warnings.push('small');
        const cctx = color.getContext('2d', { willReadFrequently: true });
        const worker = await getWorker(onProgress, langPath);

        // ① 行の目印 (Level N) — 素の英語OCR。読めなければ反転 (ダーク表示) で再試行
        let anchors = [];
        for (const invert of [false, true]) {
            const blob = await preprocess(color, invert);
            await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });   // PSM.AUTO
            const plain = await worker.recognize(blob);
            anchors = plain.data.words.filter(w => isLevelWord(w.text)).map(w => ({ yc: (w.bbox.y0 + w.bbox.y1) / 2 }));
            if (anchors.length) { if (invert) warnings.push('inverted'); break; }
        }
        if (!anchors.length) return { attacks: [], warnings: [...warnings, 'no_rows'] };
        for (const a of anchors) a.attribute = ptOfBossAttr(iconAttrAt(cctx, W, H, a.yc));

        // ② ダメージ — 数字とカンマだけ
        const blob = await preprocess(color, warnings.includes('inverted'));
        await worker.setParameters({ tessedit_char_whitelist: '0123456789,', tessedit_pageseg_mode: '11' });   // PSM.SPARSE_TEXT
        const digits = await worker.recognize(blob);
        const damages = digits.data.words
            .map(w => ({ damageB: parseDamageWord(w.text), yc: (w.bbox.y0 + w.bbox.y1) / 2, conf: Math.round(w.confidence) }))
            .filter(d => d.damageB != null);

        // ③ 対応づけ
        const attacks = pairAnchorsWithDamages(anchors, damages, max);
        if (!attacks.length) warnings.push('no_pairs');
        if (anchors.some(a => !a.attribute)) warnings.push('icon_unknown');
        return { attacks, warnings };
    } catch (e) {
        console.warn('OCR失敗:', e);
        return { attacks: [], warnings: [...warnings, 'error'] };
    }
}
