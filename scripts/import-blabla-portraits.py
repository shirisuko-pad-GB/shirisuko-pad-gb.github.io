#!/usr/bin/env python3
# BlaBlaLINK のキャラ一覧 (ブックマークレットで書き出した list.json) の立ち絵から、
# 図鑑アイコンと同じ見た目の顔アイコン (透過 128px WebP) を作って assets/blabla-icons に置き、
# data/blabla-map.json に「キー → 日本語名」を足す。そのあと build-characters.mjs で反映する。
#
#   実行:  python3 scripts/import-blabla-portraits.py <list.json>            # 確かめるだけ (何も書かない)
#          python3 scripts/import-blabla-portraits.py <list.json> --apply    # 書き込む
#          ... --also "ラプンツェル：サンクチュアリ"   # 本家DBにまだ無いキャラも先に置く (登録されたら build で反映)
#   依存:  pillow (scripts/extract-union-logo.py と同じ)。立ち絵は CDN から取る (--cache <dir> で再利用)
#
# 対象は「GB のマスタにいて画像が無いキャラ」(+ --also) だけ。既に画像があるキャラ (図鑑アイコン・本家の
# アイコン) は置き換えない — 図鑑アイコンが第一優先なので、ここで足すと本家のアイコンより勝ってしまうため。
#
# 切り抜き位置 CROP は 2026-11-01 に実測した: 立ち絵 (256×512) と既存の図鑑アイコン (128×128) 約 170 組で
# 一致する正方形を探すと、中央値が 一辺 248・左 4・上 78 (p10〜p90 = 一辺 236〜252・左 0〜12・上 64〜90)。
# 目視でもほぼ全キャラで見分けがつかない (違うのは立ち絵とアイコンが別衣装のキャラだけ)。
# ⚠ BlaBlaLINK が立ち絵の寸法や構図を変えたら測り直すこと (寸法が違う画像は止めて知らせる)。
#
# キーは "cdn-<CDN のファイル名の先頭 8 桁>" — 図鑑アイコン (resource_id) とは別系統だと分かるように。
import argparse, io, json, os, re, sys, tempfile, time, urllib.parse, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
CROP = (4, 78, 252, 326)          # 立ち絵 (256×512) の中の顔の正方形
PORTRAIT = (256, 512)
OUT_PX = 128
# ブックマークレットの名前の揺れ → GB マスタの名前 (本家DBの正式名)
ALIAS = {
    'ジル': 'ジル・バレンタイン', 'エイダ': 'エイダ・ウォン', '千束': '錦木千束', 'たきな': '井ノ上たきな',
    'アスカ': '式波・アスカ・ラングレー', 'アスカ:WILLE': '式波・アスカ・ラングレー:WILLE',
    'レイ(仮称)': 'アヤナミレイ(仮称)', '雪子': '天城雪子', 'クイーン(真)': 'クイーン(新島真)', 'レイ': '綾波レイ',
    'ソルジャーF.A.': 'ソルジャーFA', 'ソルジャーE.G.': 'ソルジャーEG', 'ソルジャーO.W.': 'ソルジャーOW',
    'I-DOLL・フラワー': 'フラワー', 'I-DOLL・サン': 'サン', 'I-DOLL・オーシャン': 'オーシャン',
}
JUNK = {'完了'}   # キャラ一覧の外 (ゲーム連携の画面) を拾った行
norm = lambda s: re.sub(r'\s+', '', str(s).replace('：', ':').replace('（', '(').replace('）', ')'))


def list_name(e):
    """ブックマークレットは一部のキャラで名前に 'LV.' を拾う (texts の残りが名前)"""
    n = str(e.get('name') or '')
    if n == 'LV.':
        rest = [t for t in (e.get('texts') or []) if t not in ('LV.', 'MAX')]
        n = rest[0] if rest else ''
    return n


CDN_HOST = 'sg-tools-cdn.blablalink.com'
MAX_BYTES = 2 * 1024 * 1024   # 立ち絵は 1 枚 30KB 前後。大きすぎる応答は読まない


def cdn_hash(url):
    """BlaBlaLINK の CDN の立ち絵の URL なら 32 桁のファイル名、違えば None (list.json は外から来るので形を厳しく見る)"""
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.netloc != CDN_HOST or u.query or u.fragment:
        return None
    m = re.fullmatch(r'(?:/[a-z0-9-]{1,16}){0,4}/([0-9a-f]{32})\.webp', u.path)
    return m.group(1) if m else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('CDN が転送 (リダイレクト) を返しました — 取りに行きません')


_opener = urllib.request.build_opener(_NoRedirect)


def fetch(url, cache):
    h = cdn_hash(url)   # キャッシュを見る前に確かめる (キャッシュ名も 32 桁だけ)
    if not h:
        raise ValueError(f'BlaBlaLINK の CDN の立ち絵の URL ではありません: {url}')
    fn = os.path.join(cache, f'{h}.webp')
    if not os.path.exists(fn) or os.path.getsize(fn) == 0:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with _opener.open(req, timeout=20) as r:
            data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError(f'立ち絵が大きすぎます ({url})')
        open(fn, 'wb').write(data)
        time.sleep(0.15)
    return fn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('list_json')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--also', action='append', default=[], help='本家DBにまだ無いが先に置くキャラ名 (list.json の名前)')
    ap.add_argument('--cache', default=os.path.join(tempfile.gettempdir(), 'blabla-portraits'))
    a = ap.parse_args()
    from PIL import Image   # 確かめるだけでも寸法を見るので必要

    os.makedirs(a.cache, exist_ok=True)
    chars = json.load(open(os.path.join(ROOT, 'data', 'characters.json'), encoding='utf-8'))['chars']
    bm_path = os.path.join(ROOT, 'data', 'blabla-map.json')
    bm = json.load(open(bm_path, encoding='utf-8'))
    have_icon = set()
    for e in bm['icons'].values():
        for j in (e['jp'] if isinstance(e['jp'], list) else [e['jp']]):
            have_icon.add(norm(j))
    master = {norm(c['name']): c for c in chars.values()}
    also = {norm(x) for x in a.also}

    plan, skipped = [], []
    for e in json.load(open(a.list_json, encoding='utf-8')):
        raw = list_name(e)
        if not raw or raw in JUNK:
            continue
        name = ALIAS.get(norm(raw), raw)
        if norm(name) in have_icon:
            continue   # 対応表に置き済み (マスタ未登録で先に置いたキャラの再実行も含む) — 置き換えない
        c = master.get(norm(name))
        if c is None and norm(raw) not in also:
            skipped.append(f'{raw} (GB のマスタに居ない)')
            continue
        if c is not None and c.get('hasImg'):
            continue   # 画像あり (本家のアイコン) — 置き換えない
        gb_name = c['name'] if c else raw
        url = str(e.get('url') or '')
        h = cdn_hash(url)
        if not h:
            skipped.append(f'{raw} (BlaBlaLINK の CDN の URL でない)')
            continue
        plan.append((gb_name, url, 'cdn-' + h[:8]))

    # キーが既存の行や同じ回の別キャラと重なったら止める (重なると既存の対応を黙って付け替えてしまう: Codex 指摘)
    keys = [k for _, _, k in plan]
    clash = sorted({k for k in keys if keys.count(k) > 1} | {k for k in keys if k in bm['icons']})
    if clash:
        sys.exit(f'⚠ キーが重なりました: {", ".join(clash)} — 既存の対応を壊さないよう止めます (キーの桁を増やすか、重なった行を手で確かめる)')

    print(f'対象 {len(plan)} 体:')
    out_dir = os.path.join(ROOT, 'assets', 'blabla-icons')
    made = []   # 全部作れてから書く (途中で止まると、画像だけ置かれて対応表が古いまま残る: Codex 指摘)
    for gb_name, url, key in plan:
        im = Image.open(fetch(url, a.cache)).convert('RGBA')
        if im.size != PORTRAIT:
            sys.exit(f'⚠ {gb_name}: 立ち絵の寸法が {im.size} (想定 {PORTRAIT}) — CROP を測り直すまで止めます (何も書いていません)')
        icon = im.crop(CROP).resize((OUT_PX, OUT_PX), Image.LANCZOS)
        buf = io.BytesIO()
        icon.save(buf, 'WEBP', quality=85, method=6)
        made.append((gb_name, key, buf.getvalue()))
        print(f'  {gb_name:<28} → assets/blabla-icons/{key}.webp ({len(buf.getvalue())} bytes)')
    if skipped:
        print('飛ばした: ' + ' / '.join(skipped))
    if a.apply and made:
        for gb_name, key, data in made:
            open(os.path.join(out_dir, f'{key}.webp'), 'wb').write(data)
            bm['icons'][key] = {'jp': gb_name, 'src': 'portrait'}
        with open(bm_path, 'w', encoding='utf-8') as f:
            json.dump(bm, f, ensure_ascii=False, indent=1)   # 元の書き方 (1 字下げ・末尾の改行なし) のまま — 差分を足した行だけにする
        print('→ node scripts/build-characters.mjs ../しりすこPAD で反映してください')
    elif not a.apply:
        print('(確かめただけ。書き込むときは --apply)')


if __name__ == '__main__':
    main()
