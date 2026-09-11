// 検証用ローカルサーバの共通ガード (e2e.mjs / card-preview.mjs / recap-export.mjs が使う)。
//
// なぜ共通化したか: 3本とも「リポジトリ直下を静的配信する使い捨てサーバ」を各自で書いていて、
// 3本とも同じ2つの穴を持っていた (Codex監査 2026-09-11):
//   ① server.listen(PORT) はホスト未指定 = 全インターフェースで待ち受ける。
//      実行中は同一LANの誰でも http://<このPC>:<port>/supabase/seed.local.sql を取れてしまう。
//      このファイルには **公開厳禁の SLv補正テーブル** が入っている (CLAUDE.md 絶対ルール①)。
//   ② path.startsWith(ROOT) は封じ込めの判定として不十分。`%2e%2e` はデコード後に join されるため
//      `../shirisu-pad-global-backup/...` のような **兄弟ディレクトリ** が文字列前方一致を通る。
//      リポジトリ内のシンボリックリンクも readFile が追って外へ出られる。
//
// 方針: 待ち受けはループバック固定 + 実体パスで封じ込め + 秘匿ファイルは拡張子規則で拒否。
// 新しい秘匿ファイルを .gitignore に足したら、命名を `*.local` / `*.local.*` に合わせること
// (そうすればこのガードが自動で効く)。

import { realpath } from 'node:fs/promises';
import { resolve, sep, basename } from 'node:path';

/** 使い捨てサーバの待ち受けホスト。外から触れないようループバック固定 */
export const LOCAL_HOST = '127.0.0.1';

// 配信してはいけないもの。
//  - `*.local` / `*.local.*` … gitignore 済みのローカル秘匿ファイルの命名規則
//  - slv-ratio.json … SLv補正テーブルそのもの (公開厳禁)
const SECRET_NAME = /(^|\.)local$|\.local\./i;
const SECRET_FILES = new Set(['slv-ratio.json']);
// ページ側が読む必要がないので丸ごと閉じる (秘匿SQLの置き場でもある)
const DENY_DIRS = new Set(['.git', 'supabase', 'node_modules']);

/**
 * URL のパス部分を、root 配下の「配信してよい実ファイル」へ解決する。
 * 配信不可なら null を返す (呼び出し側が 403/404 を返す)。
 * @param {string} root リポジトリのルート (絶対パス)
 * @param {string} urlPath リクエストURLのパス部分 (クエリ除去済みでなくてもよい)
 * @param {string} [indexFile] '/' のときに返すファイル名
 */
export async function resolveServable(root, urlPath, indexFile = 'index.html') {
    let rel;
    try {
        rel = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]);
    } catch { return null; }                      // 壊れた %エンコード
    if (rel.includes('\0')) return null;
    if (rel === '/' || rel === '') rel = `/${indexFile}`;
    // Windows の区切りも潰しておく (デコード後の `\` は向こうでは区切り)
    rel = rel.replace(/\\/g, '/').replace(/^\/+/, '');

    const rootReal = await realpath(root).catch(() => resolve(root));
    const target = resolve(rootReal, rel);

    // ① 文字列ではなく「セパレータ境界つき」で封じ込める (兄弟ディレクトリを弾く)
    if (target !== rootReal && !target.startsWith(rootReal + sep)) return null;

    // ② 実体を解決してから再確認する (リポジトリ内のシンボリックリンク経由の脱出を塞ぐ)
    const real = await realpath(target).catch(() => null);
    if (!real) return null;                       // 存在しない / 読めない
    if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;

    // ③ 秘匿ファイル・閉じているディレクトリを拒否
    const parts = real.slice(rootReal.length + 1).split(sep);
    if (parts.some(p => DENY_DIRS.has(p))) return null;
    const name = basename(real);
    if (SECRET_FILES.has(name) || SECRET_NAME.test(name)) return null;

    return real;
}

/** ループバックで待ち受ける (Promise 版) */
export function listenLocal(server, port) {
    return new Promise((res, rej) => {
        server.once('error', rej);
        server.listen(port, LOCAL_HOST, () => res(server));
    });
}
