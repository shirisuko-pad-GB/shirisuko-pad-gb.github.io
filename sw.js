// PWA 用の最小 Service Worker。
// 目的は「ホーム画面に置けるようにする」ことと、オフライン時に白画面にしないこと。
//
// ⚠ 方針: HTML / JS / data は **キャッシュしない** (公開サイトなので更新が即座に届くのが最優先。
// シーズン切替・基準更新・撤去レバーが古いキャッシュで残ると事故になる)。
// キャッシュするのは実質不変のアセット (アイコン・キャラ画像・ローディングGIF) だけ。
// ⚠ アイコン等を「同じファイル名のまま差し替える」ときは、この版数を上げること
// (cache-first なので名前が同じだと古い画像が residents に残る)。
// キャラ画像・ロゴはファイル名がハッシュ/内容に紐づくため通常は据え置きでよい
//
// 【2026-08-31】キャラ画像を takedown 方式で再掲載 (README「権利方針」) — character-images を
// キャッシュ対象に戻し、版数を v3 に上げた。撤去時は CACHEABLE から外して版数を上げること
// (版数を上げると activate 時に旧キャッシュごと削除されるので、**既に画像を持っている端末からも消える**)
// 【2026-09-24】スクショ読み取り (js/ocr.js) の Tesseract アセット (vendor/tesseract-<ver>/ 約9.6MB) を
// cache-first に追加し、版数を v4 に上げた。パスに版数が入るので差し替え時はパスが変わる = 据え置きで安全。
// GitHub Pages の max-age は10分なので、これが無いと再訪のたびに数MBを取り直す
const CACHE = 'spg-assets-v4';
const CACHEABLE = /\/(assets|character-images)\/[^/]+\.(png|webp|gif|jpg)$|\/vendor\/tesseract-[\d.]+\/[^/]+\.(js|gz)$/;

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        // 旧世代のキャッシュを掃除してから制御を引き継ぐ
        for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || !CACHEABLE.test(url.pathname)) return;   // それ以外は素通し (常に最新)

    // 画像だけ cache-first (不変前提。差し替え時はファイル名が変わる)
    e.respondWith((async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
    })());
});
