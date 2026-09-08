// 複数モジュール (app.js / stats.js / backend.js / tests) 共通のユーティリティ。
import { t } from './i18n.js';

// ※ ATTR_INFO や属性色の完全統合は将来課題。今は安全系の共有関数としきい値を置く。

// PT属性の表示情報 (色・和名・相手ボス)。app.js/stats.js/sharecard.js で共用。
// enemy = そのPTで殴る相手ボスの属性キー (色は ATTR_INFO[enemy].color で引く)。
// ※ 属性は「色 + 漢字」で表現する。絵文字・ゲーム内アイコン画像は使わない
//    (絵文字は端末で見た目が揺れるため全廃 — 2026-07-30 運営判断)。
//
// **表示名は attrName() を使うこと**。`.jp` は日本語の固定値なので、英語表示では嘘になる
// (英語版の属性名は NIKKE 公式の Code 表記 = Fire / Water / Electric / Iron / Wind)。
// `.jp` 自体は辞書 (messages.js の attr.*) と対で残してある。
export const ATTR_INFO = {
    FIRE:     { jp: '灼熱', color: '#FF3D44', enemy: 'WIND' },
    WATER:    { jp: '水冷', color: '#2E8BFF', enemy: 'FIRE' },
    ELECTRIC: { jp: '電撃', color: '#9B4DFF', enemy: 'WATER' },
    IRON:     { jp: '鉄甲', color: '#FF8A2B', enemy: 'ELECTRIC' },
    WIND:     { jp: '風圧', color: '#18C26B', enemy: 'IRON' },
};

/** 属性の表示名 (今の言語で)。知らないキーは「属性？」相当に落とす。 */
export const attrName = (key) => (ATTR_INFO[key] ? t(`attr.${key}`) : t('attr.unknown'));

export const SITE_URL = 'https://shirisuko-pad-gb.github.io/';

// CanvasRenderingContext2D.roundRect のポリフィル (iOS Safari 16.3以前・古いAndroid WebView)。
// シェアカードは全面 roundRect で描いているため、これが無い端末では TypeError で
// 「プレビューが一切出ない」= 実際に寄せられた「画像が表示されない」の一因になる。
// ⚠ import しただけで入るよう副作用として実行する (sharecard.js / tiles.js は shared.js を
//   経由するので、描画側が個別に呼ぶ必要をなくす — 呼び忘れを構造的に防ぐため)。
// 対応する引数形: 数値1つ / [tl,tr,br,bl] の配列 (sharecard.js のミニ分布が配列形を使う)。
export function installRoundRectPolyfill(g = (typeof globalThis !== 'undefined' ? globalThis : null)) {
    const C = g && g.CanvasRenderingContext2D;
    if (!C || typeof C.prototype.roundRect === 'function') return false;
    C.prototype.roundRect = function (x, y, w, h, radii = 0) {
        // 仕様どおり 1〜4個を tl,tr,br,bl に展開 (数値単体も配列も受ける)
        const a = Array.isArray(radii) ? radii : [radii];
        const n = a.map(v => Math.max(0, Number(v) || 0));
        const c4 = n.length === 1 ? [n[0], n[0], n[0], n[0]]
            : n.length === 2 ? [n[0], n[1], n[0], n[1]]
            : n.length === 3 ? [n[0], n[1], n[2], n[1]]
            : [n[0], n[1], n[2], n[3]];
        // 負の幅・高さは辺を反転させて描く (仕様準拠。呼び出し側は使っていないが黙って壊さない)。
        // 反転時は角丸も入れ替える — 左右反転で tl↔tr / bl↔br、上下反転で tl↔bl / tr↔br
        let [tl, tr, br, bl] = c4;
        if (w < 0) { [tl, tr] = [tr, tl]; [bl, br] = [br, bl]; }
        if (h < 0) { [tl, bl] = [bl, tl]; [tr, br] = [br, tr]; }
        const x0 = w < 0 ? x + w : x, y0 = h < 0 ? y + h : y;
        const aw = Math.abs(w), ah = Math.abs(h);
        // 半径の合計が辺を超える場合は一律に縮める (仕様のスケーリング)
        const k = Math.min(1, aw / Math.max(1e-9, tl + tr), aw / Math.max(1e-9, bl + br),
            ah / Math.max(1e-9, tl + bl), ah / Math.max(1e-9, tr + br));
        const [a1, a2, a3, a4] = [tl * k, tr * k, br * k, bl * k];
        this.moveTo(x0 + a1, y0);
        this.lineTo(x0 + aw - a2, y0);
        this.arcTo(x0 + aw, y0, x0 + aw, y0 + a2, a2);
        this.lineTo(x0 + aw, y0 + ah - a3);
        this.arcTo(x0 + aw, y0 + ah, x0 + aw - a3, y0 + ah, a3);
        this.lineTo(x0 + a4, y0 + ah);
        this.arcTo(x0, y0 + ah, x0, y0 + ah - a4, a4);
        this.lineTo(x0, y0 + a1);
        this.arcTo(x0, y0, x0 + a1, y0, a1);
        this.closePath();
    };
    return true;
}
installRoundRectPolyfill();

// アプリ内ブラウザ (X / LINE / Facebook / Instagram の WebView) か。
// ⚠ UA判定なので当てにしすぎない。用途は「保存の導線を切り替える / 案内を1行足す」だけに限り、
//   機能をブロックしたり数値を変えたりしない (誤検出しても案内が余分に出るだけ、が上限)。
// なぜ必要か: これらの WebView は <a download> を黙って無視し、blob: 画像の
//   「写真に追加」も出さないため、通常のダウンロード導線が無反応になる。
// 判定はモバイルUAであることを前提にする (デスクトップの通常DLを壊さないため)。
export function isInAppBrowser(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
    const s = String(ua);
    if (!/iPhone|iPad|iPod|Android/i.test(s)) return false;   // モバイル以外は対象外
    // 各アプリが名乗る印
    if (/\bFBAN\/|\bFBAV\/|Instagram|\bLine\/|TwitterAndroid|Twitter for iPhone/i.test(s)) return true;
    if (/;\s*wv\)/i.test(s)) return true;                     // Android WebView の標準的な印
    // iOS の WKWebView は Safari を名乗らない (アプリ内ブラウザの強いシグナル)。
    // Chrome(CriOS)・Firefox(FxiOS)・Edge(EdgiOS) は別ブラウザなので除外する
    if (/iPhone|iPad|iPod/i.test(s) && !/Safari\//i.test(s) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(s)) return true;
    return false;
}

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
// 発動条件: ページ最上部 (scrollY<=0) から下方向に引く + 縦方向の動きが優勢なこと。
// 送信中 (オーバーレイ表示中) は誤発動させない。
// ⚠ ブラウザ既定のPTRとの二重発動を避けるため、body に overscroll-behavior-y:contain を敷く前提
// (index/stats の CSS で指定済み)。
let ptrBound = false;
export function enablePullToRefresh() {
    const el = document.getElementById('ptr');
    if (!el || ptrBound) return;   // 多重登録の防止
    ptrBound = true;
    let startY = null, startX = 0, pulling = false, dy = 0, firing = false;
    const MAX = 96, TRIGGER = 35;
    const reset = () => {
        el.style.transform = ''; el.classList.remove('ready', 'on');
        pulling = false; startY = null; dy = 0;
    };

    document.addEventListener('touchstart', (e) => {
        if (firing) return;
        // 2本目以降 (ピンチ等) に移行したら PTR は取りやめる
        if (e.touches.length !== 1) { reset(); startY = null; return; }
        if (document.getElementById('loadingOverlay')?.style.display === 'flex') return;   // 送信中は無効
        if (window.scrollY > 0) return;
        startY = e.touches[0].clientY;
        startX = e.touches[0].clientX;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (startY == null || firing) return;
        if (e.touches.length !== 1) { reset(); return; }   // ピンチに移行したら中止
        const t = e.touches[0];
        const d = t.clientY - startY;
        const dx = Math.abs(t.clientX - startX);
        // 斜め・横方向の動きが優勢になったら (途中からでも) 中止する
        if (dx > Math.abs(d)) { reset(); startY = null; return; }
        if (d <= 0 || window.scrollY > 0) { if (pulling) reset(); return; }
        pulling = true;
        dy = Math.min(MAX, d * 0.5);   // 引く量は減衰させる (ゴムの手触り)
        el.classList.add('on');
        el.style.transform = `translateY(${dy}px)`;
        el.classList.toggle('ready', dy >= TRIGGER);
    }, { passive: true });

    const end = (cancelled) => {
        if (!pulling) { startY = null; return; }
        if (!cancelled && dy >= TRIGGER) {
            firing = true;
            el.classList.add('ready');
            el.setAttribute('aria-hidden', 'false');   // 更新中だけ読み上げ対象に
            el.textContent = t('common.refreshing');
            location.reload();
            return;   // reload するので状態は戻さない
        }
        reset();   // 中断・しきい値未満は元に戻す
    };
    document.addEventListener('touchend', () => end(false), { passive: true });
    document.addEventListener('touchcancel', () => end(true), { passive: true });   // OSジェスチャ等での中断
}
