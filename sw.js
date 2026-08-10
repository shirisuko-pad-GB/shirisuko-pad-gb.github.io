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
// 【2026-08-10】キャラ画像の掲載停止 (権利方針・README参照) に伴い character-images を
// キャッシュ対象から外し、版数を v2 に上げた。版数を上げると activate 時に旧キャッシュ
// (spg-assets-v1) ごと削除されるので、**既に画像を持っている端末からも消える**。
// 掲載を再開する場合はここを戻すこと
const CACHE = 'spg-assets-v2';
const CACHEABLE = /\/assets\/[^/]+\.(png|webp|gif|jpg)$/;

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
