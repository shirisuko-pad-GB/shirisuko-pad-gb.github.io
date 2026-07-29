// キャラタイル描画 (DOM / Canvas 両対応・状態を持たない純処理)。
//
// サイトはゲーム画像を一切使わない方針 (NIKKE 二次創作ガイドライン準拠)。
// キャラは「バースト帯 (ゲーム準拠色) + キャラ名 + 属性の背景色」の自作タイルで表現する。
// ここが唯一のタイル実装 — 画面側で似た描画を再実装しないこと。
//
// ⚠ name は本家DB由来の外部入力として扱い、必ずエスケープして DOM に入れる。

import { escapeHtml, ATTR_INFO } from './shared.js';

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
export function drawTileCanvas(ctx, info, x, y, size, fontFamily) {
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
    if (b) {
        ctx.fillStyle = BURST_COLORS[b];
        ctx.fillRect(x, y, size, stripH);
        ctx.fillStyle = BURST_DARK_TEXT.has(b) ? 'rgba(20,22,26,0.82)' : '#FFFFFF';
        ctx.font = `900 ${Math.round(stripH * 0.72)}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.fillText(BURST_SHORT[b], x + size / 2, y + stripH * 0.78);
    }
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
