#!/usr/bin/env python3
# 募集バナー (assets/recruit-banner.jpg) から「推しりをすこれ部」タイトルを切り出して
# 背景透過した assets/union-logo.png を再生成する (シェアカード右上のロゴ)。
#   実行:  python3 scripts/extract-union-logo.py
#   依存:  pillow + numpy (作成時: pillow 11.3.0 / numpy 2.0.2。PNG エンコードは
#          ライブラリ版に依存するためバイト一致は保証しない — コミット済み PNG が正)
#
# ⚠ バナー画像を差し替えたときは以下すべてが元画像固有なので見直すこと:
#   CROP・各ゾーン座標・明色/青/赤の閾値・成分サイズ閾値。
#   座標の出典: 元画像に 50px グリッドを重ねた確認画像を目視計測して決めた
#   (再計測は PIL で crop に ImageDraw の格子+座標ラベルを描いて行う)。
import numpy as np
from PIL import Image, ImageFilter
from collections import deque
import colorsys

import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'assets', 'recruit-banner.jpg')
OUT = os.path.join(ROOT, 'assets', 'union-logo.png')
CROP = (50, 2, 862, 196)   # タイトル行 (ID含む — 後でID成分を除去)

im = Image.open(SRC).convert('RGB').crop(CROP)
W, H = im.size
rgb = np.asarray(im, dtype=np.float32)
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
mx = rgb.max(axis=2); mn = rgb.min(axis=2)
V = mx / 255.0
S = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
# Hue (度)
hue = np.zeros((H, W), dtype=np.float32)
delta = mx - mn
nz = delta > 0
rr, gg, bb = r, g, b
# 同率最大チャネルの画素で候補が二重加算されないよう、優先順位つきで択一する
hue = np.select(
    [(mx == rr) & nz, (mx == gg) & nz, (mx == bb) & nz],
    [(60 * ((gg - bb) / np.maximum(delta, 1e-6)) + 360) % 360,
     60 * ((bb - rr) / np.maximum(delta, 1e-6)) + 120,
     60 * ((rr - gg) / np.maximum(delta, 1e-6)) + 240],
    default=0).astype(np.float32)

light = (V >= 0.80) & (S <= 0.50)                                  # 空・雲・白フチ
vivid = (S >= 0.60) & (V >= 0.50) & (hue >= 190) & (hue <= 228)    # 七宝柄・キーライン青

def bfs(passable):
    seen = np.zeros((H, W), dtype=bool)
    dq = deque()
    for x in range(W):
        for y in (0, H - 1):
            if passable[y, x] and not seen[y, x]: seen[y, x] = True; dq.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if passable[y, x] and not seen[y, x]: seen[y, x] = True; dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and passable[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; dq.append((ny, nx))
    return seen

removed = bfs(light) | bfs(vivid)
keep = ~removed

# 文字の中の閉じた空ポケット (青みの明色) を除去。白フチ (ほぼ無彩色) は残す
sky_pocket = (V >= 0.80) & (S >= 0.07) & (S <= 0.50) & ((b - r) >= 14) & keep
keep &= ~sky_pocket

# ---- 文字以外のゾーン消去 (グリッド実測に基づく) ----
xs = np.arange(W)[None, :].repeat(H, 0)
ys = np.arange(H)[:, None].repeat(W, 1)
# 1) 中段 (し〜れ x206-692) の文字上端 y≈85 より上: 魚リボン・雲の筆致・ID残り
keep &= ~((xs >= 206) & (xs <= 654) & (ys < 83))   # 右端654: 部の白フチ左端(x658〜)を削らない
# 2) 左端の波しぶき装飾
keep &= ~(xs < 30)
# 3) り上部に食い込む青い飾りの尻尾 (青系のみ消す — 消えたキーラインは後段の再生成が補う)
blueish = ((hue >= 185) & (hue <= 235)) & (S >= 0.25)
keep &= ~((xs >= 265) & (xs <= 350) & (ys >= 83) & (ys <= 99) & blueish)
# 4) 下端の画鋲: 最下帯は全消去 + 赤系文字が無いx帯の赤を広めに消去
keep &= ~(ys >= 186)
# 赤系文字が無い帯 (推し/をす) は赤全般、部の隣 (x660-697) は橙のみ (部の紅 hue≈346 を守る)
reddish = (((hue <= 30) | (hue >= 330)) & (S >= 0.35) & (V >= 0.35))
keep &= ~(reddish & (ys >= 162) & (((xs <= 282)) | ((xs >= 398) & (xs <= 585))))
orange_strong = (hue <= 45) & (S >= 0.35) & (V >= 0.35)   # hue下限なし (画鋲の深い赤 hue≈0-3 も拾う)
keep &= ~(orange_strong & (ys >= 162) & (xs >= 660) & (xs <= 697))
# 4b) ID「99」の下端の食み出し (れのフチに接触して成分除去を逃れる) — れ上端 y≈102 より上の青系のみ
keep &= ~((xs >= 620) & (xs <= 655) & (ys >= 84) & (ys <= 99) & blueish)
# 5) 右上のはみ出し (部の上の切れ端): 部の上端 y18 より十分上を消去
keep &= ~((xs >= 580) & (ys <= 14))
# 6) 画鋲上端の淡いピンクの弧 (彩度が低く reddish に掛からない) — 下帯のピンクを追加消去
pinkish = (((hue <= 40) | (hue >= 320)) & (S >= 0.16) & (V >= 0.5))
keep &= ~(pinkish & (ys >= 168) & (((xs <= 282)) | ((xs >= 398) & (xs <= 585))))
orange_pale = (hue <= 45) & (S >= 0.16) & (S <= 0.7) & (V >= 0.5)
keep &= ~(orange_pale & (ys >= 168) & (xs >= 660) & (xs <= 697))
# 7b) 部の下の画鋲ドーム (橙〜深赤 hue<=45)。部の紅 (hue≈345-358) は色相範囲外なので無傷
orange = (hue <= 45) & (S >= 0.15) & (S <= 0.7) & (V >= 0.4)   # 橙〜深赤 (hue下限なし)。部の紅 hue≈346 は範囲外
keep &= ~(orange & (ys >= 166) & (xs >= 665) & (xs <= 765))
keep &= ~((hue >= 3) & (hue <= 45) & (S >= 0.5) & (V >= 0.4) & (ys >= 170) & (xs >= 665) & (xs <= 765))
# 7) オープニング (1〜2px のヘアライン・孤立点を除去。文字は太いので無傷)
_m = Image.fromarray((keep * 255).astype(np.uint8))
_m = _m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
keep = np.asarray(_m) > 127

# 連結成分ラベリング (小ゴミ除去 + ID文字の除去)
labels = np.zeros((H, W), dtype=np.int32)
comp_info = []   # (label, size, minx, miny, maxx, maxy)
cur = 0
for y0 in range(H):
    for x0 in range(W):
        if keep[y0, x0] and labels[y0, x0] == 0:
            cur += 1
            dq = deque([(y0, x0)]); labels[y0, x0] = cur
            size = 0; mnx = mny = 10**9; mxx = mxy = -1
            while dq:
                y, x = dq.popleft(); size += 1
                mnx = min(mnx, x); mxx = max(mxx, x); mny = min(mny, y); mxy = max(mxy, y)
                for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and keep[ny, nx] and labels[ny, nx] == 0:
                        labels[ny, nx] = cur; dq.append((ny, nx))
            comp_info.append((cur, size, mnx, mny, mxx, mxy))

# 除去: ゴミ (<120px) / ID テキスト (x 400〜660, y 30〜100 に収まる成分) /
#        下端に接する成分 (掲示板の板・画鋲が写り込む)
drop = set()
for lab, size, mnx, mny, mxx, mxy in comp_info:
    if size < 120: drop.add(lab)
    elif mnx >= 395 and mxx <= 665 and mny >= 25 and mxy <= 105: drop.add(lab)
    elif mny >= H - 14: drop.add(lab)   # 下端帯に完全に収まる成分 (板・画鋲) のみ除去
for lab in drop: keep[labels == lab] = False

# マスク仕上げ: 2倍解像度で 白フチ+キーライン を再生成して合成し、LANCZOS で等倍へ縮小
# (旧実装のアルファぼかしは輪郭が甘くなるため廃止 — 縮小の自然なアンチエイリアスで滑らかさを得る)
mask = Image.fromarray((keep * 255).astype(np.uint8))
W2, H2 = W * 2, H * 2
im2 = im.resize((W2, H2), Image.LANCZOS)
mask2 = mask.resize((W2, H2), Image.LANCZOS).point(lambda v: 255 if v >= 128 else 0)
white_stroke = mask2.filter(ImageFilter.MaxFilter(25))   # +6px相当 (2x)
blue_key = mask2.filter(ImageFilter.MaxFilter(33))       # +8px相当 (2x)
PAD = 24
cw, ch = W2 + PAD * 2, H2 + PAD * 2
key_layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
key_layer.paste(Image.new('RGBA', (W2, H2), (63, 134, 214, 255)), (PAD, PAD), blue_key)
white_layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
white_layer.paste(Image.new('RGBA', (W2, H2), (255, 255, 255, 255)), (PAD, PAD), white_stroke)
body = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
body.paste(im2.convert('RGBA'), (PAD, PAD), mask2)
out = Image.alpha_composite(Image.alpha_composite(key_layer, white_layer), body)
out = out.resize((cw // 2, ch // 2), Image.LANCZOS)
# 最終スイープ: 文字クラスタに属さない小さな孤立成分 (150px未満) を色を問わず除去
oa = np.array(out)
vis = oa[..., 3] > 10
lab2 = np.zeros(vis.shape, dtype=np.int32)
n2 = 0
for yy in range(vis.shape[0]):
    for xx in range(vis.shape[1]):
        if vis[yy, xx] and lab2[yy, xx] == 0:
            n2 += 1
            q = deque([(yy, xx)]); lab2[yy, xx] = n2; px = []
            while q:
                cy, cx = q.popleft(); px.append((cy, cx))
                for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                    ny2, nx2 = cy + dy, cx + dx
                    if 0 <= ny2 < vis.shape[0] and 0 <= nx2 < vis.shape[1] and vis[ny2, nx2] and lab2[ny2, nx2] == 0:
                        lab2[ny2, nx2] = n2; q.append((ny2, nx2))
            if len(px) < 150:
                for cy, cx in px: oa[cy, cx, 3] = 0
out = Image.fromarray(oa)

# 使用領域でトリム
bbox = out.getbbox()
out = out.crop(bbox)
out.save(OUT)
print('saved', out.size, 'components:', len(comp_info), 'dropped:', len(drop))
