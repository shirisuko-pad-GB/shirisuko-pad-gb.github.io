// キャラタイル描画 (DOM / Canvas 両対応・状態を持たない純処理)。
//
// 表示は「キャラ画像 (あれば) + バースト帯」のハイブリッド。画像が無いキャラは
// 従来の自作タイル (バースト帯 + キャラ名 + 属性の背景色) に自動フォールバックする。
// ここが唯一のタイル実装 — 画面側で似た描画を再実装しないこと。
//
// 【掲載方針 2026-08-10 更新 — README「権利方針」が正】
// 二次創作ガイドライン第1条4項「当社オリジナルコンテンツをそのまま再現、複製、コピー、
// トレースする行為は二次創作活動と認められません」に照らし、**キャラ画像の掲載を停止**した。
// 権利元 (SHIFT UP CORP. / business@shiftup.co.kr) へ許諾を申請中で、
// 許諾が得られた場合のみ USE_CHAR_IMAGES を true に戻す。**独断で戻さないこと。**
// (2026-07-31 の「削除対応前提で掲載」は、公式回答が「ガイドライン参照」で確定したため撤回)
//
// ⚠ name は本家DB由来の外部入力として扱い、必ずエスケープして DOM に入れる。

import { escapeHtml, ATTR_INFO } from './shared.js';

// キャラ画像を使うか。false = 全面自作タイル (バースト帯 + キャラ名 + 属性色)。
// ★ 許諾が出るまで false 固定 (上のコメント参照)
export const USE_CHAR_IMAGES = false;

// キャラID = 画像ファイル名の許容形式 (build 生成の 32hex.webp のみ)。
// characters.json は実行時 fetch なので、壊れた id が src/onerror に混入しないよう再検証する
const CHAR_ID_RE = /^[0-9a-f]{32}\.webp$/;

// 画像パス (代表IDのみ画像を持つ。hasImg は build-characters.mjs が付与)。
// id が許容形式でなければ画像なし扱い = 自作タイルにフォールバック (XSS の入口を塞ぐ)
export function charImgSrc(info) {
    if (!USE_CHAR_IMAGES || !info?.hasImg || !CHAR_ID_RE.test(info.id ?? '')) return null;
    return `./character-images/${info.id}`;
}

// バースト固有色 (ゲームのバーストスキル色に準拠: B1=緑 / B2=黄 / B3=赤)。Λ は紫。
export const BURST_COLORS = { B1: '#1FA95C', B2: '#F2B705', B3: '#E5484D', 'BΛ': '#8B5CF6' };
// 黄帯は白文字が飛ぶので黒文字にする
export const BURST_DARK_TEXT = new Set(['B2']);
export const BURST_SHORT = { B1: 'B1', B2: 'B2', B3: 'B3', 'BΛ': 'Λ' };

const UNKNOWN_COLOR = '#8A9097';

// characters.json (v2: {chars, aliases} / v1: img→{name,burst}) から ID→キャラ情報 の解決関数を作る。
// 返る info: {id, name, burst, burstAlt, element} / 未知IDは null
export function makeCharResolver(charData) {
    if (!charData) return () => null;
    if (charData._format === 2) {
        const { chars, aliases } = charData;
        return (id) => {
            const canon = chars[id] ? id : aliases[id];
            const c = chars[canon];
            return c ? { id: canon, ...c } : null;
        };
    }
    // 旧v1形式 (img→{name,burst}) へのフォールバック
    return (id) => {
        const c = charData[id];
        return c ? { id, name: c.name, burst: c.burst ?? null, burstAlt: null, element: null } : null;
    };
}

// キャラが入れるバースト枠の一覧 (Λ・未分類は null を返し「どこでも可」扱い)
export function burstsOf(info) {
    if (!info || !info.burst || info.burst === 'BΛ') return null;
    return info.burstAlt ? [info.burst, info.burstAlt] : [info.burst];
}

// 「ヘルム：アクアマリン」→ {base:'ヘルム', variant:'アクアマリン'}
export function splitName(name) {
    const p = String(name ?? '').split(/[：:]/);
    return { base: p[0] || '？', variant: p.slice(1).join(':') || null };
}

// 編成の表示順: バースト順 (B1→B2→B3→Λ→不明) → 名前。保存値はID順不同ソートで
// 並びに意味がないため、見せるときはこの順に揃える (結果カード・シェアカード共通)。
const BURST_RANK = { B1: 0, B2: 1, B3: 2, 'BΛ': 3 };
export function sortForDisplay(ids, infoOf) {
    return [...ids].sort((a, b) => {
        const ia = infoOf(a), ib = infoOf(b);
        const ra = BURST_RANK[ia?.burst] ?? 4, rb = BURST_RANK[ib?.burst] ?? 4;
        return ra - rb || String(ia?.name ?? '').localeCompare(String(ib?.name ?? ''), 'ja');
    });
}

function colorsOf(info) {
    const el = info?.element;
    return {
        attr: el && ATTR_INFO[el] ? ATTR_INFO[el].color : UNKNOWN_COLOR,
        known: !!(el && ATTR_INFO[el]),
    };
}

// DOM 用タイル HTML。opts:
//   strip: バースト帯を出すか (枠側に帯がある場所では false)
//   xs:    小サイズ (プリセット顔・編成ランキング) — 名前1行だけの簡易表示
export function tileHTML(info, { strip = true, xs = false } = {}) {
    if (!info) {
        return `<span class="gb-tile gb-tile--unknown${xs ? ' gb-tile--xs' : ''}" style="--tile-ac:${UNKNOWN_COLOR};">` +
            `<span class="gb-tile-body"><span class="gb-tile-base">？</span></span></span>`;
    }
    const { base, variant } = splitName(info.name);
    const { attr, known } = colorsOf(info);
    const b = info.burst;
    const stripHtml = strip && b
        ? `<span class="gb-tile-strip${BURST_DARK_TEXT.has(b) ? ' dark' : ''}" style="background:${BURST_COLORS[b]};">${BURST_SHORT[b]}</span>`
        : '';
    const title = escapeHtml(info.name);
    const src = charImgSrc(info);   // id は build 生成の 32hex.webp のみ (CHAR_IMG_RE 相当) — 外部入力は混ざらない
    if (src) {
        // 画像タイル: 顔 + バースト帯。名前は下端の薄幕オーバーレイ (xs は tooltip のみ)
        const overlay = xs ? '' : `<span class="gb-tile-body gb-tile-body--overlay">` +
            `<span class="gb-tile-base">${escapeHtml(base)}</span>` +
            (variant ? `<span class="gb-tile-var">${escapeHtml(variant)}</span>` : '') +
            `</span>`;
        return `<span class="gb-tile gb-tile--img${xs ? ' gb-tile--xs' : ''}" style="--tile-ac:${attr};" title="${title}">` +
            stripHtml +
            `<img class="gb-tile-img" src="${escapeHtml(src)}" alt="${title}" loading="lazy">` +
            overlay +
            (known ? `<span class="gb-tile-dot" style="background:${attr};"></span>` : '') +
            `</span>`;
    }
    if (xs) {
        return `<span class="gb-tile gb-tile--xs${known ? '' : ' gb-tile--unknown'}" style="--tile-ac:${attr};" title="${title}">` +
            `${stripHtml}<span class="gb-tile-body"><span class="gb-tile-base">${escapeHtml(base)}</span></span></span>`;
    }
    return `<span class="gb-tile${known ? '' : ' gb-tile--unknown'}" style="--tile-ac:${attr};" title="${title}">` +
        stripHtml +
        `<span class="gb-tile-body">` +
        `<span class="gb-tile-base">${escapeHtml(base)}</span>` +
        (variant ? `<span class="gb-tile-var">${escapeHtml(variant)}</span>` : '') +
        (known ? '' : `<span class="gb-tile-var">属性？</span>`) +
        `</span>` +
        (known ? `<span class="gb-tile-dot" style="background:${attr};"></span>` : '') +
        `</span>`;
}

// Canvas 用タイル描画 (シェアカード)。size = 一辺 px。
// img (HTMLImageElement) を渡すと顔画像タイルになる (名前は描かない — 顔で伝わる)。
export function drawTileCanvas(ctx, info, x, y, size, fontFamily, img = null) {
    const r = size * 0.14;
    const { base, variant } = info ? splitName(info.name) : { base: '？', variant: null };
    const { attr } = colorsOf(info);
    // 背景 (ダークカード上なので属性色を濃いめに混ぜる)
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, r);
    ctx.fillStyle = '#22262E';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = attr + '3D';   // 属性色 24% 重ね
    ctx.fillRect(x, y, size, size);
    // バースト帯
    const b = info?.burst;
    const stripH = Math.round(size * 0.24);
    if (img) {
        // 顔画像 (帯の下に正方形で収める。元画像は正方形前提だが cover 相当で描く)
        const bodyH = size - stripH;
        const scale = Math.max(size / img.width, bodyH / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        ctx.drawImage(img, x + (size - dw) / 2, y + stripH + (bodyH - dh) / 2, dw, dh);
    }
    if (b) {
        ctx.fillStyle = BURST_COLORS[b];
        ctx.fillRect(x, y, size, stripH);
        ctx.fillStyle = BURST_DARK_TEXT.has(b) ? 'rgba(20,22,26,0.82)' : '#FFFFFF';
        ctx.font = `900 ${Math.round(stripH * 0.72)}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.fillText(BURST_SHORT[b], x + size / 2, y + stripH * 0.78);
    }
    if (img) { ctx.restore(); ctx.textAlign = 'left'; return; }
    // 名前 (ベース名 + 衣装違い)
    ctx.fillStyle = '#F1F2F4';
    const bodyY = y + stripH + (size - stripH) / 2;
    const fit = (text, px, maxW) => {
        ctx.font = `900 ${px}px ${fontFamily}`;
        while (px > 7 && ctx.measureText(text).width > maxW) {
            px -= 1;
            ctx.font = `900 ${px}px ${fontFamily}`;
        }
        return text;
    };
    ctx.textAlign = 'center';
    if (variant) {
        fit(base, Math.round(size * 0.19), size - 6);
        ctx.fillText(base, x + size / 2, bodyY);
        ctx.fillStyle = 'rgba(241,242,244,0.75)';
        fit(variant, Math.round(size * 0.13), size - 6);
        ctx.fillText(variant, x + size / 2, bodyY + size * 0.17);
    } else {
        fit(base, Math.round(size * 0.2), size - 6);
        ctx.fillText(base, x + size / 2, bodyY + size * 0.06);
    }
    ctx.restore();
    ctx.textAlign = 'left';
}
