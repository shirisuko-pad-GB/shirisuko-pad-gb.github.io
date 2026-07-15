// 複数モジュール (app.js / stats.js / backend.js / tests) 共通のユーティリティ。
// ※ ATTR_INFO や属性色の完全統合は将来課題。今は安全系の共有関数としきい値を置く。

// 分布・集計の解禁しきい値 (表示用)。
// ⚠ 実際のゲート判定はサーバー (04_hardening.sql) が強制する。ここは進捗表示・説明文用で、
//    ゲート表示はサーバーが返す need を優先する (ここがズレても実害は説明文の数字のみ)。
//    SQL 側の閾値を変えたら合わせて更新すること。
export const THRESHOLDS = { dist: 100, comp: 30, insights: 10 };

// HTML エスケープ: 文字列を innerHTML テンプレートに埋める前に必ず通す。
// DB由来・ユーザー入力由来の文字列を DOM に入れる箇所は全てこれを使う (XSS対策)。
export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// キャラ画像ファイル名の形式 (character-images/ の実体は全て 32桁hex + .webp)。
// サーバー側 CHECK 制約と同じパターン — クライアントでも送信前に検証してゴミを送らない。
export const CHAR_IMG_RE = /^[0-9a-f]{32}\.webp$/;

// 編成 (キャラ画像名の配列) が「ちょうど5要素・全て正規の画像名」かを検証。
// 満たさなければ null を返す (= 編成なし扱い)。
export function sanitizeCharacters(chars) {
    if (!Array.isArray(chars) || chars.length !== 5) return null;
    if (!chars.every(c => typeof c === 'string' && CHAR_IMG_RE.test(c))) return null;
    return chars;
}
