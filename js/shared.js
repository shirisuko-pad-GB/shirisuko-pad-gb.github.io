// 複数モジュール (app.js / stats.js / backend.js / tests) 共通のユーティリティ。
// ※ ATTR_INFO や属性色の完全統合は将来課題。今は安全系の共有関数としきい値を置く。

// PT属性の表示情報 (色・和名・相手ボス)。app.js/stats.js/sharecard.js で共用。
// enemy = そのPTで殴る相手ボスの属性キー (色は ATTR_INFO[enemy].color で引く)。
// ※ 属性は「色 + 漢字」で表現する。絵文字・ゲーム内アイコン画像は使わない
//    (絵文字は端末で見た目が揺れるため全廃 — 2026-07-30 運営判断)。
export const ATTR_INFO = {
    FIRE:     { jp: '灼熱', color: '#FF3D44', enemy: 'WIND' },
    WATER:    { jp: '水冷', color: '#2E8BFF', enemy: 'FIRE' },
    ELECTRIC: { jp: '電撃', color: '#9B4DFF', enemy: 'WATER' },
    IRON:     { jp: '鉄甲', color: '#FF8A2B', enemy: 'ELECTRIC' },
    WIND:     { jp: '風圧', color: '#18C26B', enemy: 'IRON' },
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

// 引っぱって更新 (Pull to Refresh)。ホーム画面から起動した PWA (standalone) には
// ブラウザの再読み込みボタンが無く、iOS Safari の standalone は既定のPTRも効かないため自前で用意する。
// 発動条件: ページ最上部 (scrollY<=0) から下方向に 70px 以上引く + 縦方向の動き優先。
// 送信中 (オーバーレイ表示中) は誤発動させない
export function enablePullToRefresh() {
    const el = document.getElementById('ptr');
    if (!el) return;
    let startY = null, startX = 0, pulling = false, dy = 0;
    const MAX = 96, TRIGGER = 70;
    const reset = () => { el.style.transform = ''; el.classList.remove('ready', 'on'); pulling = false; startY = null; dy = 0; };

    document.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        if (document.getElementById('loadingOverlay')?.style.display === 'flex') return;   // 送信中は無効
        if (window.scrollY > 0) return;
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (startY == null) return;
        const t = e.touches[0];
        const d = t.clientY - startY;
        // 横スワイプ (画像の横送り等) と取り違えない
        if (!pulling && Math.abs(t.clientX - startX) > Math.abs(d)) { startY = null; return; }
        if (d <= 0 || window.scrollY > 0) { if (pulling) reset(); return; }
        pulling = true;
        dy = Math.min(MAX, d * 0.5);   // 引く量は減衰させる (ゴムの手触り)
        el.classList.add('on');
        el.style.transform = `translateY(${dy}px)`;
        el.classList.toggle('ready', dy >= TRIGGER * 0.5);
    }, { passive: true });

    document.addEventListener('touchend', () => {
        if (!pulling) { startY = null; return; }
        const fire = dy >= TRIGGER * 0.5;
        if (fire) {
            el.classList.add('ready');
            el.textContent = '更新中…';
            location.reload();
            return;   // reload するので状態は戻さない
        }
        reset();
    }, { passive: true });
}
