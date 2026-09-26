// スクショ読み取りの Tips 用: BlaBlaLINK「凸一覧」画面を模した略図 (自作 SVG・純関数)。
//
// なぜ略図か: 実スクショは他の方の名前が写るので載せられず、ゲームの UI 画像も権利方針で
// 自作以外は使わない (CLAUDE.md 絶対ルール②)。形と「どこを読むか」だけ伝わればよいので自作で描く。
// 色は実画面に寄せた固定パレット (PAL) — サイトのテーマには追随させない (下記)。
//
// 読み取り箇所 ①属性アイコンの色 ②「Level」の位置 ③ダメージ を破線で囲って番号を振る
// (js/ocr.js が実際に見ている3点と一致させること — 図と実装がズレると案内が嘘になる)。
//
// 引数は全部呼び出し側から渡す (ATTR_INFO の色・raid.json のボス名)。ボス名は本家DB由来なので必ずエスケープ。

import { escapeHtml } from './shared.js';

const W = 360;
const BLOCK_H = 96, BLOCK_GAP = 8, TOP = 34;

// 略図の色は BlaBlaLINK の実画面に寄せた固定パレット (白地・薄灰のブロック・オレンジの HARD/番号・
// 属性色のアイコン・金の星)。サイトのトークンに追随させない理由: これは「他アプリの画面」の再現で、
// 実物と同じ色に見えることが案内の価値だから (ダーク表示でも白いカードのまま = 埋め込んだスクショの体裁)。
// 読み取り箇所の破線と①②③も同じオレンジで揃える (ユーザー指定 2026-09-26: 白・オレンジ・属性色を基調)
const PAL = {
    bg: '#FFFFFF', panel: '#F5F5F5', line: '#E4E4E4', ink: '#1F1F1F', sub: '#6B7178', faint: '#A8AEB4',
    orange: '#F26B2B', gold: '#F2B705', tag: '#2A2A2A', tile: '#ECECEC', tileLv: '#FBE9A6',
};

/**
 * @param {{ blocks: {numeral: string, color: string, boss: string, code: string, level: number, damage: string}[], label?: string }} p
 *   blocks は 3件 (凸1〜3)。color は属性アイコンの色 (ATTR_INFO[bossAttr].color)、code は「H.S.T.A.」形式。
 *   label は読み上げ用の説明 (表示言語に合わせて呼び出し側が渡す — Codex指摘)
 * @returns {string} インライン SVG
 */
export function ocrTipsSvg({ blocks, label = 'BlaBlaLINK 凸一覧のイメージ図' }) {
    const bs = (Array.isArray(blocks) ? blocks : []).slice(0, 3);
    const H = TOP + bs.length * (BLOCK_H + BLOCK_GAP) + 6;
    // キャラタイル: 薄灰の角丸 + 金の星 + 下端の淡い黄色帯 (実画面の LV 表示の雰囲気)
    const tile = (x, y) => `<rect x="${x}" y="${y}" width="30" height="30" rx="5" fill="${PAL.tile}" stroke="${PAL.line}"/>` +
        `<text x="${x + 15}" y="${y + 11}" font-size="7.5" text-anchor="middle" fill="#D99A00">★★★</text>` +
        `<rect x="${x + 1}" y="${y + 21}" width="28" height="8" rx="3" fill="${PAL.tileLv}"/>`;
    const mark = (x, y, n) => `<circle cx="${x}" cy="${y}" r="7" fill="${PAL.orange}"/>` +
        `<text x="${x}" y="${y + 3.2}" font-size="8.5" font-weight="900" text-anchor="middle" fill="#FFFFFF">${n}</text>`;
    const block = (b, i) => {
        const y = TOP + i * (BLOCK_H + BLOCK_GAP);
        const ix = 40, iy = y + 20;           // 属性アイコンの中心
        const dmgY = y + 78;
        return `
    <g>
      <rect x="10" y="${y}" width="${W - 20}" height="${BLOCK_H}" rx="10" fill="${PAL.panel}"/>
      <!-- ローマ数字タグ (黒地にオレンジの数字) -->
      <rect x="16" y="${y + 9}" width="16" height="22" rx="3" fill="${PAL.tag}"/>
      <text x="24" y="${y + 24}" font-size="10" font-weight="800" text-anchor="middle" fill="${PAL.orange}">${escapeHtml(b.numeral)}</text>
      <!-- ① 属性アイコン (黒地の角丸に属性色のエンブレム。色で判定) -->
      <rect x="${ix - 10}" y="${iy - 10}" width="20" height="20" rx="5" fill="${PAL.tag}"/>
      <circle cx="${ix}" cy="${iy}" r="6" fill="${escapeHtml(b.color)}"/>
      <rect x="${ix - 14}" y="${iy - 14}" width="28" height="28" rx="7" fill="none" stroke="${PAL.orange}" stroke-width="2" stroke-dasharray="4 3"/>
      ${mark(ix - 14, iy - 15, '1')}
      <!-- ボス名 -->
      <text x="58" y="${y + 24}" font-size="11" font-weight="800" fill="${PAL.ink}">${escapeHtml(b.boss)}「${escapeHtml(b.code)}」</text>
      <!-- HARD (オレンジ) / Level — ② 行の目印 -->
      <rect x="${W - 76}" y="${y + 8}" width="48" height="14" rx="7" fill="${PAL.orange}"/>
      <text x="${W - 52}" y="${y + 18.5}" font-size="8.5" font-weight="900" text-anchor="middle" fill="#FFFFFF">HARD</text>
      <text x="${W - 30}" y="${y + 36}" font-size="9.5" font-weight="700" text-anchor="end" fill="${PAL.ink}">Level ${escapeHtml(String(b.level))}</text>
      <rect x="${W - 78}" y="${y + 26}" width="52" height="14" rx="4" fill="none" stroke="${PAL.orange}" stroke-width="2" stroke-dasharray="4 3"/>
      ${mark(W - 86, y + 33, '2')}
      <!-- キャラタイル 5枚 -->
      ${[0, 1, 2, 3, 4].map(k => tile(20 + k * 34, y + 44)).join('')}
      <!-- ③ ダメージ -->
      <text x="${W - 30}" y="${dmgY - 12}" font-size="8.5" text-anchor="end" fill="${PAL.sub}">ダメージ</text>
      <text x="${W - 30}" y="${dmgY + 6}" font-size="14" font-weight="900" text-anchor="end" fill="${PAL.ink}" style="font-variant-numeric:tabular-nums">${escapeHtml(b.damage)}</text>
      <rect x="${W - 150}" y="${dmgY - 8}" width="124" height="20" rx="5" fill="none" stroke="${PAL.orange}" stroke-width="2" stroke-dasharray="4 3"/>
      ${mark(W - 158, dmgY + 2, '3')}
    </g>`;
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}" font-family="'Poppins','Noto Sans JP',sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="${PAL.bg}"/>
  <text x="16" y="22" font-size="13" font-weight="900" fill="${PAL.ink}">PLAYER</text>
  <text x="${W - 16}" y="22" font-size="9.5" text-anchor="end" fill="${PAL.sub}">BlaBlaLINK › ユニオンレイド › 凸一覧</text>
  ${bs.map(block).join('')}
</svg>`;
}
