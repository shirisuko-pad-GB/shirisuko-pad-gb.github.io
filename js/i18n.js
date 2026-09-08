// 表示言語の切り替え (日本語 / English)。
//
// 英語圏プレイヤーからの要望で追加 (2026-09-08)。X で拡散されるサイトなので、
// **英語で開いたリンクがそのまま英語のカードになる**ことを最優先に設計している。
//
// 決め方の優先順位 (上が強い):
//   1. URL の ?lang=en / ?lang=ja  … 共有リンクがそのまま相手の言語で開く
//   2. localStorage の保存値        … 一度選んだら次回も同じ
//   3. 端末の言語 (navigator.language) … 日本語圏だけ ja、それ以外は en
//   4. ja
//
// ⚠ t() が返すのは **ただの文字列**。DOM へ入れるときの escapeHtml は
//    呼ぶ側の責任 (CLAUDE.md 絶対ルール4)。params にキャラ名などDB由来の値を
//    渡す場合、innerHTML 経路なら必ず呼ぶ側で escape すること。
import { MESSAGES } from './messages.js';

export const LANGS = ['ja', 'en'];
export const STORE_KEY = 'spg_lang';
export const DEFAULT_LANG = 'ja';

/**
 * 表示言語を決める。**純関数** — 環境は全部引数で受ける (テストのため)。
 * @param {string} search   location.search ('?lang=en' など)
 * @param {string|null} saved localStorage の保存値
 * @param {string} navLang  navigator.language ('ja-JP' / 'en-US' など)
 */
export function detectLang(search = '', saved = null, navLang = '') {
    let fromUrl = null;
    try {
        fromUrl = new URLSearchParams(search).get('lang');
    } catch {
        fromUrl = null;   // 壊れたクエリでも落とさない
    }
    if (LANGS.includes(fromUrl)) return fromUrl;
    if (LANGS.includes(saved)) return saved;
    // 日本語圏だけ ja。それ以外は英語 (英語話者でなくても、日本語よりは読める前提)
    if (typeof navLang === 'string' && navLang.toLowerCase().startsWith('ja')) return 'ja';
    if (navLang) return 'en';
    return DEFAULT_LANG;
}

let current = DEFAULT_LANG;

/** 起動時に一度だけ呼ぶ。決まった言語を返し、<html lang> も合わせる。 */
export function initLang(doc = (typeof document !== 'undefined' ? document : null)) {
    let saved = null;
    try {
        saved = localStorage.getItem(STORE_KEY);
    } catch {
        saved = null;   // プライベートモード等で読めなくても既定で動く
    }
    current = detectLang(
        typeof location !== 'undefined' ? location.search : '',
        saved,
        typeof navigator !== 'undefined' ? navigator.language : '',
    );
    // URL で指定された言語は覚える (次回から同じ言語で開く)
    try {
        const fromUrl = new URLSearchParams(location.search).get('lang');
        if (LANGS.includes(fromUrl)) localStorage.setItem(STORE_KEY, fromUrl);
    } catch { /* 保存できなくても表示は成立する */ }
    if (doc?.documentElement) doc.documentElement.lang = current;
    return current;
}

export const currentLang = () => current;

/** 言語を切り替えて再読み込み。URL にも残すので、その状態を共有できる。 */
export function setLang(lang) {
    if (!LANGS.includes(lang)) return;
    try {
        localStorage.setItem(STORE_KEY, lang);
    } catch { /* 保存できなくても URL で反映される */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    location.href = url.toString();
}

/** テスト用。実行時は initLang / setLang を使う。 */
export function _setLangForTest(lang) {
    current = LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

/**
 * 訳文を引く。
 *
 * - 見つからない鍵は **ja へ落ちる** (英訳が途中でも画面が壊れない)
 * - `{n}` などのプレースホルダを params で差し替える
 * - 値が `{one, other}` なら params.n の単複で選ぶ (英語の「1 user / 5 users」)
 */
export function t(key, params = null, lang = current) {
    const table = MESSAGES[lang] ?? MESSAGES[DEFAULT_LANG];
    let value = table?.[key];
    if (value === undefined) value = MESSAGES[DEFAULT_LANG]?.[key];
    if (value === undefined) return key;   // 鍵そのものを返す (未訳が画面で目立つ)
    if (value && typeof value === 'object') {
        const n = Number(params?.n);
        value = (n === 1 ? value.one : value.other) ?? value.other ?? '';
    }
    if (!params) return value;
    return String(value).replace(/\{(\w+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
    ));
}
