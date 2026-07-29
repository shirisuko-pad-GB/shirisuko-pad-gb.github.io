// 複数モジュール (app.js / stats.js / backend.js / tests) 共通のユーティリティ。
// ※ ATTR_INFO や属性色の完全統合は将来課題。今は安全系の共有関数としきい値を置く。

// PT属性の表示情報 (色・和名・絵文字・相手ボス)。app.js/stats.js/sharecard.js で共用。
// enemyJp/enemyEmoji = そのPTで殴る相手ボスの属性。
// ※ アイコンは絵文字 (自作フォント描画)。ゲーム内の属性アイコン画像は使わない (権利方針)。
export const ATTR_INFO = {
    FIRE:     { jp: '灼熱', color: '#FF3D44', emoji: '🔥', enemyJp: '風圧', enemyEmoji: '🍃' },
    WATER:    { jp: '水冷', color: '#2E8BFF', emoji: '💧', enemyJp: '灼熱', enemyEmoji: '🔥' },
    ELECTRIC: { jp: '電撃', color: '#9B4DFF', emoji: '⚡', enemyJp: '水冷', enemyEmoji: '💧' },
    IRON:     { jp: '鉄甲', color: '#FF8A2B', emoji: '🛡️', enemyJp: '電撃', enemyEmoji: '⚡' },
    WIND:     { jp: '風圧', color: '#18C26B', emoji: '🍃', enemyJp: '鉄甲', enemyEmoji: '🛡️' },
};

export const SITE_URL = 'https://shirisuko-pad-gb.github.io/';

// 分布・集計の解禁しきい値 (表示用)。シーズンごとに 0 から積む前提の値。
// ⚠ 実際のゲート判定はサーバー (05_seasons.sql) が強制する。ここは進捗表示・説明文用で、
//    ゲート表示はサーバーが返す need を優先する (ここがズレても実害は説明文の数字のみ)。
//    SQL 側の閾値 (get_distribution=50/15, get_comp_insights=10) を変えたら合わせて更新。
export const THRESHOLDS = { dist: 50, comp: 15, insights: 10 };

// HTML エスケープ: 文字列を innerHTML テンプレートに埋める前に必ず通す。
// DB由来・ユーザー入力由来の文字列を DOM に入れる箇所は全てこれを使う (XSS対策)。
export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// キャラIDの形式 (32桁hex + .webp)。画像を使っていた時代のファイル名形式を
// IDとして継承している (過去データ互換 + サーバー側 CHECK 制約と同一パターン)。
// クライアントでも送信前に検証してゴミを送らない。
export const CHAR_IMG_RE = /^[0-9a-f]{32}\.webp$/;

// 編成 (キャラ画像名の配列) が「ちょうど5要素・全て正規の画像名」かを検証。
// 満たさなければ null を返す (= 編成なし扱い)。
export function sanitizeCharacters(chars) {
    if (!Array.isArray(chars) || chars.length !== 5) return null;
    if (!chars.every(c => typeof c === 'string' && CHAR_IMG_RE.test(c))) return null;
    return chars;
}
