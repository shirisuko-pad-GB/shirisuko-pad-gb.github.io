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
// anchors: [{yc, attribute}] / damages: [{yc, damageB, conf}] → 上から順に最大 max 件。
// maxGap: 行からダメージまでの縦距離の上限 (px)。実測 0.134W に対しブロック間隔は 0.318W なので
// 0.24W を渡すと、Level を1つ読み落としても次ブロックのダメージが前の行に付かない (Codex指摘)
export const PAIR_MAX_GAP_W = 0.24;
export function pairAnchorsWithDamages(anchors, damages, max = Infinity, maxGap = Infinity) {
    const rows = anchors.filter(a => a && Number.isFinite(a.yc)).sort((a, b) => a.yc - b.yc);
    const out = [];
    for (const d of [...damages].sort((a, b) => a.yc - b.yc)) {
        const cand = rows.filter(r => r.yc < d.yc && d.yc - r.yc <= maxGap);
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

// Tesseract のアセットは自サイトに同梱したものだけを使う (vendor/tesseract-<ver>/ — scripts/vendor-tesseract.mjs)。
// CDN から実行時に読むと、CDN/パッケージ汚染時にページ全権 (画像・入力・Supabase の公開キー経路) を
// 渡してしまう (Codex監査・High)。worker/core/言語データはライブラリが内部で URL 取得するため
// SRI も効かず、自サイト配信が唯一の解。版数と SHA-256 は manifest.json が台帳 (tests が突き合わせる)。
// 初回タップ時だけ読み込む (本体 0.06MB + worker 0.12MB + core 3.8MB + 英語データ 1.9MB。sw.js が cache-first)。
// 英語データは軽量版 4.0.0_fast (標準版 11MB と実スクショで精度が同じ — tests/ocr-local.mjs --lang で比較可)
const TESS_VER = '5.1.1';
const TESS_DIR = new URL(`../vendor/tesseract-${TESS_VER}/`, import.meta.url).href.replace(/\/$/, '');
const TESS = {
    script: `${TESS_DIR}/tesseract.min.js`,
    workerPath: `${TESS_DIR}/worker.min.js`,
    corePath: TESS_DIR,   // ライブラリが SIMD の有無で tesseract-core-simd-lstm / -lstm .wasm.js を選ぶ
    langPath: TESS_DIR,   // eng.traineddata.gz
};
// 受け付ける画像の上限 (縦長・巨大画像でタブごと落ちないように — Codex指摘)。
// スクショは 3MP 前後・数MB。ヘッダから寸法を先読みして、大きければ縮小しながらデコードする
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PX = 4e6;          // ここまで縮小してから処理する (縦長スクショ 1179x3400 でも幅は保てる。
                             //  処理中はカラー+前処理+ImageData で画素×12B ≈ 48MB — スマホでも収まる範囲)
const HARD_MAX_PX = 40e6;    // これ以上は読まない (デコードだけで数百MB)
const UNKNOWN_DIMS_MAX_BYTES = 2 * 1024 * 1024;   // ヘッダで寸法が分からない形式はこの大きさまで
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
            workerBlobURL: false,   // 同一オリジンの worker.min.js をそのまま起動 (Blob 経由の間接読み込みをしない)
            logger: (m) => { if (onProgress && m?.status) onProgress(m.status, m.progress ?? null); },
        });
    })().catch(e => { workerPromise = null; throw e; });
    return workerPromise;
}

// ヘッダから寸法だけ読む (PNG / JPEG / WebP)。分からなければ null。
// JPEG は SOF マーカーが EXIF/ICC の後ろに来ることがあるので、渡されたバイト列の中を
// 長さ付きセグメントで飛びながら最後まで探す (デコードではないので 20MB でも一瞬)
export function probeImageDims(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const be16 = (i) => (b[i] << 8) | b[i + 1];
    const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { w: be32(16), h: be32(20) };
    if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8) {   // JPEG: SOFn マーカーを探す
        let i = 2;
        while (i + 9 < b.length && b[i] === 0xFF) {
            const m = b[i + 1];
            if (m === 0xFF) { i += 1; continue; }                                  // パディング
            if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }   // 長さ無し
            const len = be16(i + 2);
            if (len < 2) return null;
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: be16(i + 5), w: be16(i + 7) };
            i += 2 + len;
        }
        return null;
    }
    if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (tag === 'VP8X') return { w: 1 + le24(24), h: 1 + le24(27) };
        if (tag === 'VP8 ') return { w: be16(26) & 0x3FFF, h: be16(28) & 0x3FFF };
        if (tag === 'VP8L' && b[20] === 0x2F) {   // 可逆: 署名 0x2F の後に 14bit 幅-1 / 14bit 高さ-1 (LE ビット詰め)
            const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
            return { w: (bits & 0x3FFF) + 1, h: ((bits >>> 14) & 0x3FFF) + 1 };
        }
        return null;
    }
    return null;
}

// File/Blob → 読み取り用キャンバス。大きい画像は「縮小しながら」デコードして、素のサイズで
// メモリを確保しない (幅 MAX_W・総画素 MAX_PX 以下に揃える)
async function toCanvas(file) {
    if (file.size === 0) throw new Error('empty');
    if (file.size > MAX_BYTES) throw new Error('too_large');
    // JPEG は SOF が EXIF/ICC の後ろに来ることがあるのでファイル全体を渡す (走査だけ・デコードしない)。
    // それ以外はヘッダ先頭で足りる
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isJpeg = head[0] === 0xFF && head[1] === 0xD8;
    const dims = probeImageDims(new Uint8Array(await (isJpeg ? file : file.slice(0, 65536)).arrayBuffer()));
    let opts;
    if (dims && dims.w > 0 && dims.h > 0) {
        if (dims.w * dims.h > HARD_MAX_PX) throw new Error('too_large');
        const scale = Math.min(1, MAX_W / dims.w, Math.sqrt(MAX_PX / (dims.w * dims.h)));
        if (scale < 1) {
            const rw = Math.round(dims.w * scale), rh = Math.round(dims.h * scale);
            if (rw < 1 || rh < 1) throw new Error('too_large');   // 極端な縦横比 (縮小で 0px になる) は読まない
            opts = { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' };
        }
    } else if (file.size > UNKNOWN_DIMS_MAX_BYTES) {
        // 寸法が分からない形式 (HEIC / GIF / TIFF 等) は、素のサイズでデコードする前に上限を掛けられない。
        // 小さいファイルだけ試し、大きいものは読まない (縦長・巨大画像でタブごと落ちる経路を塞ぐ)
        throw new Error('too_large');
    }
    const bmp = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
    if (bmp.width * bmp.height > HARD_MAX_PX) { bmp.close?.(); throw new Error('too_large'); }   // ヘッダが読めなかった形式の保険
    const scale = Math.min(1, MAX_W / bmp.width, Math.sqrt(MAX_PX / (bmp.width * bmp.height)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
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
    return new Promise(res => c.toBlob((blob) => { c.width = c.height = 0; res(blob); }, 'image/png'));   // 用済みのバッファは即解放
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
 * attacks は上限を掛けずに返す (何件読めたかを呼び出し側が知れるように。3凸への切り詰めは app.js)。
 * warnings: small / inverted / no_rows / no_pairs / orphan (行に付かないダメージがあった) /
 *           icon_unknown (色が判定できない行があった) / too_large / error
 * @param {Blob} file
 * @param {{onProgress?: (status: string, progress: number|null) => void, langPath?: string}} opts
 * @returns {Promise<{attacks: {attribute: string, damageB: number, conf: number|null}[], warnings: string[], rows: number}>}
 */
export async function readRaidScreenshot(file, { onProgress, langPath } = {}) {   // langPath は検証用 (既定は同梱データ)
    const warnings = [];
    try {
        let color;
        try { color = await toCanvas(file); }
        catch (e) { return { attacks: [], warnings: [...warnings, e?.message === 'too_large' ? 'too_large' : 'error'], rows: 0 }; }
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
        if (!anchors.length) return { attacks: [], warnings: [...warnings, 'no_rows'], rows: 0 };
        for (const a of anchors) a.attribute = ptOfBossAttr(iconAttrAt(cctx, W, H, a.yc));

        // ② ダメージ — 数字とカンマだけ
        const blob = await preprocess(color, warnings.includes('inverted'));
        await worker.setParameters({ tessedit_char_whitelist: '0123456789,', tessedit_pageseg_mode: '11' });   // PSM.SPARSE_TEXT
        const digits = await worker.recognize(blob);
        const damages = digits.data.words
            .map(w => ({ damageB: parseDamageWord(w.text), yc: (w.bbox.y0 + w.bbox.y1) / 2, conf: Math.round(w.confidence) }))
            .filter(d => d.damageB != null);

        // ③ 対応づけ (縦距離の上限つき — Level の読み落としで隣のブロックに付けない)
        const attacks = pairAnchorsWithDamages(anchors, damages, Infinity, PAIR_MAX_GAP_W * W);
        if (!attacks.length) warnings.push('no_pairs');
        if (damages.length > attacks.length) warnings.push('orphan');
        if (anchors.some(a => !a.attribute)) warnings.push('icon_unknown');
        return { attacks, warnings, rows: anchors.length };
    } catch (e) {
        console.warn('OCR失敗:', e);
        return { attacks: [], warnings: [...warnings, 'error'], rows: 0 };
    }
}
