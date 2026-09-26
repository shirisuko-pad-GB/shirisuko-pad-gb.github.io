// スクショ読み取りの Tips 用: BlaBlaLINK「凸一覧」画面を模した略図 (自作 SVG・純関数)。
//
// なぜ略図か: 実スクショは他の方の名前が写るので載せられず、ゲームの UI 画像も権利方針で
// 自作以外は使わない (CLAUDE.md 絶対ルール②)。形と「どこを読むか」だけ伝わればよいので、
// サイトのトークン色 (var(--…)) で描き、ライト/ダークに自動で追随させる。
//
// 読み取り箇所 ①属性アイコンの色 ②「Level」の位置 ③ダメージ を破線で囲って番号を振る
// (js/ocr.js が実際に見ている3点と一致させること — 図と実装がズレると案内が嘘になる)。
//
// 引数は全部呼び出し側から渡す (ATTR_INFO の色・raid.json のボス名)。ボス名は本家DB由来なので必ずエスケープ。

import { escapeHtml } from './shared.js';

const W = 360;
const BLOCK_H = 96, BLOCK_GAP = 8, TOP = 34;

/**
 * @param {{ blocks: {numeral: string, color: string, boss: string, code: string, level: number, damage: string}[], label?: string }} p
 *   blocks は 3件 (凸1〜3)。color は属性アイコンの色 (ATTR_INFO[bossAttr].color)、code は「H.S.T.A.」形式。
 *   label は読み上げ用の説明 (表示言語に合わせて呼び出し側が渡す — Codex指摘)
 * @returns {string} インライン SVG
 */
export function ocrTipsSvg({ blocks, label = 'BlaBlaLINK 凸一覧のイメージ図' }) {
    const bs = (Array.isArray(blocks) ? blocks : []).slice(0, 3);
    const H = TOP + bs.length * (BLOCK_H + BLOCK_GAP) + 6;
    const tile = (x, y) => `<rect x="${x}" y="${y}" width="30" height="30" rx="5" fill="var(--bg)" stroke="var(--line)"/>` +
        `<text x="${x + 15}" y="${y + 12}" font-size="7" text-anchor="middle" fill="var(--faint)">★★★</text>` +
        `<rect x="${x + 4}" y="${y + 18}" width="22" height="7" rx="2" fill="var(--line)"/>`;
    const block = (b, i) => {
        const y = TOP + i * (BLOCK_H + BLOCK_GAP);
        const cx = 40, cy = y + 20;           // 属性アイコンの中心
        const dmgY = y + 78;
        return `
    <g>
      <rect x="10" y="${y}" width="${W - 20}" height="${BLOCK_H}" rx="10" fill="var(--bg)" stroke="var(--line)"/>
      <!-- ローマ数字タグ -->
      <rect x="16" y="${y + 9}" width="16" height="22" rx="3" fill="var(--ink)"/>
      <text x="24" y="${y + 24}" font-size="10" font-weight="800" text-anchor="middle" fill="var(--onink)">${escapeHtml(b.numeral)}</text>
      <!-- ① 属性アイコン (色で判定) -->
      <circle cx="${cx}" cy="${cy}" r="8" fill="${escapeHtml(b.color)}"/>
      <rect x="${cx - 13}" y="${cy - 13}" width="26" height="26" rx="6" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${cx - 13}" y="${cy - 16}" font-size="9" font-weight="900" fill="var(--ink)">①</text>
      <!-- ボス名 -->
      <text x="56" y="${y + 24}" font-size="11" font-weight="800" fill="var(--ink)">${escapeHtml(b.boss)}「${escapeHtml(b.code)}」</text>
      <!-- HARD / Level (② 行の目印) -->
      <rect x="${W - 76}" y="${y + 8}" width="48" height="14" rx="7" fill="var(--ink)"/>
      <text x="${W - 52}" y="${y + 18.5}" font-size="8.5" font-weight="900" text-anchor="middle" fill="var(--onink)">HARD</text>
      <text x="${W - 30}" y="${y + 36}" font-size="9.5" font-weight="700" text-anchor="end" fill="var(--sub)">Level ${escapeHtml(String(b.level))}</text>
      <rect x="${W - 78}" y="${y + 26}" width="52" height="14" rx="4" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${W - 90}" y="${y + 37}" font-size="9" font-weight="900" fill="var(--ink)">②</text>
      <!-- キャラタイル 5枚 -->
      ${[0, 1, 2, 3, 4].map(k => tile(20 + k * 34, y + 44)).join('')}
      <!-- ③ ダメージ -->
      <text x="${W - 30}" y="${dmgY - 12}" font-size="8" text-anchor="end" fill="var(--faint)">ダメージ</text>
      <text x="${W - 30}" y="${dmgY + 6}" font-size="14" font-weight="900" text-anchor="end" fill="var(--ink)" style="font-variant-numeric:tabular-nums">${escapeHtml(b.damage)}</text>
      <rect x="${W - 150}" y="${dmgY - 8}" width="124" height="20" rx="5" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 3"/>
      <text x="${W - 162}" y="${dmgY + 6}" font-size="9" font-weight="900" fill="var(--ink)">③</text>
    </g>`;
    };
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}" font-family="'Poppins','Noto Sans JP',sans-serif">
  <rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="var(--card)"/>
  <text x="16" y="22" font-size="13" font-weight="900" fill="var(--ink)">PLAYER</text>
  <text x="${W - 16}" y="22" font-size="9" text-anchor="end" fill="var(--faint)">BlaBlaLINK › ユニオンレイド › 凸一覧</text>
  ${bs.map(block).join('')}
</svg>`;
}
