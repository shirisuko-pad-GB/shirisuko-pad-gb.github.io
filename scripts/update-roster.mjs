#!/usr/bin/env node
// 新キャラ・新データの取り込みを1コマンドに: presets/画像 → characters を順に再生成する。
//
// 使い方:  node scripts/update-roster.mjs [shirisu-padのパス]   (省略時 ../shirisu-pad)
//
// 流れ: PADの月次JSONが更新されたら実行 → 警告が出たら
//   ・バースト未分類  → data/burst-map.json に追記 (出典: game8)
//   ・名前なし画像    → python -m http.server で tools/annotate.html を開いて注釈 →
//                       出力を name-overrides.json / burst-map.json に貼る
// → もう一度このコマンド → 警告が消えたら commit & push
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const padDir = process.argv[2] || join(ROOT, '..', 'shirisu-pad');
if (!existsSync(join(padDir, 'data'))) {
    console.error(`shirisu-pad が見つかりません: ${padDir}`);
    process.exit(1);
}

console.log('--- 1/2 presets.json + キャラ画像 (build-data) ---');
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-data.mjs'), padDir], { stdio: 'inherit' });
console.log('--- 2/2 characters.json (build-characters) ---');
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-characters.mjs'), padDir], { stdio: 'inherit' });
console.log('--- 完了。警告が出ていなければ commit & push で反映されます ---');
