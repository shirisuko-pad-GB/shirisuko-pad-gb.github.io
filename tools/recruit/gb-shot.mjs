// pages/*.html → PNG (ヘッドレス Chrome・CDP_PORT)
import { openPage } from './cdp.mjs'; import fs from 'node:fs'; import path from 'node:path';
const outDir = process.argv[2]; const pages = path.join(outDir, 'pages');
for (const f of fs.readdirSync(pages).filter(f => f.endsWith('.html'))) {
    const wide = f.startsWith('全属性');
    const p = await openPage({ width: wide ? 1600 : 1200, height: 900, mobile: false });
    await p.goto('file://' + path.join(pages, f), 1200);
    await p.shot(path.join(outDir, 'GB_募集基準_' + f.replace(/\.html$/, '.png')), true);
    if (p.errors.length) console.log(f, 'errors:', p.errors.join(' | ').slice(0, 200));
    await p.close().catch(() => {});
}
console.log('done');
