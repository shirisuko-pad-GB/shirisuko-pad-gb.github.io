#!/usr/bin/env python3
# 募集バナー (assets/recruit-banner.jpg) から「推しりをすこれ部」タイトルを切り出して
# 背景透過した assets/union-logo.png を再生成する (シェアカード右上のロゴ)。
#   実行:  python3 scripts/extract-union-logo.py   (要 pillow + numpy)
# バナー画像を差し替えたときはゾーン座標 (グリッド実測値) の見直しが必要。
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
h_r = np.where((mx == rr) & nz, (60 * ((gg - bb) / np.maximum(delta, 1e-6)) + 360) % 360, 0)
h_g = np.where((mx == gg) & nz, 60 * ((bb - rr) / np.maximum(delta, 1e-6)) + 120, 0)
h_b = np.where((mx == bb) & nz, 60 * ((rr - gg) / np.maximum(delta, 1e-6)) + 240, 0)
hue = h_r + h_g + h_b

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
keep &= ~((xs >= 206) & (xs <= 692) & (ys < 83))
# 2) 左端の波しぶき装飾
keep &= ~(xs < 30)
# 3) り上部に食い込む青い飾りの尻尾 (青系のみ消す — 消えたキーラインは後段の再生成が補う)
blueish = ((hue >= 185) & (hue <= 235)) & (S >= 0.25)
keep &= ~((xs >= 265) & (xs <= 350) & (ys >= 83) & (ys <= 99) & blueish)
# 4) 下端の画鋲: 最下帯は全消去 + 赤系文字が無いx帯の赤を広めに消去
keep &= ~(ys >= 186)
reddish = (((hue <= 30) | (hue >= 330)) & (S >= 0.35) & (V >= 0.35))
keep &= ~(reddish & (ys >= 162) & (((xs <= 282)) | ((xs >= 398) & (xs <= 585)) | ((xs >= 660) & (xs <= 697))))
# 5) 右上のはみ出し (部の上の切れ端): 部の上端 y18 より十分上を消去
keep &= ~((xs >= 580) & (ys <= 14))
# 6) 画鋲上端の淡いピンクの弧 (彩度が低く reddish に掛からない) — 下帯のピンクを追加消去
pinkish = (((hue <= 40) | (hue >= 320)) & (S >= 0.16) & (V >= 0.5))
keep &= ~(pinkish & (ys >= 168) & (((xs <= 282)) | ((xs >= 398) & (xs <= 585)) | ((xs >= 660) & (xs <= 697))))
# 7b) 部の下の画鋲ドーム (橙赤 hue≈7。部の紅 hue≈346 とは色相で区別できる)
orange = (((hue >= 3) & (hue <= 45)) | (hue >= 330)) & (S >= 0.15) & (S <= 0.65) & (V >= 0.4)
keep &= ~(orange & (ys >= 168) & (xs >= 665) & (xs <= 765))
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

# マスク仕上げ: 白フチ再生成 (6px白ストローク + 2px青キーライン) → 端をぼかす
mask = Image.fromarray((keep * 255).astype(np.uint8), 'L')
white_stroke = mask.filter(ImageFilter.MaxFilter(13))    # +6px
blue_key = mask.filter(ImageFilter.MaxFilter(17))        # +8px
# 余白を足したキャンバスに合成: 青キーライン → 白ストローク → 元画像(keep部)
PAD = 12
cw, ch = W + PAD * 2, H + PAD * 2
out = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
key_layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
key_layer.paste(Image.new('RGBA', (W, H), (63, 134, 214, 255)), (PAD, PAD), blue_key)
white_layer = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
white_layer.paste(Image.new('RGBA', (W, H), (255, 255, 255, 255)), (PAD, PAD), white_stroke)
body = Image.new('RGBA', (cw, ch), (0, 0, 0, 0))
body.paste(im.convert('RGBA'), (PAD, PAD), mask)
out = Image.alpha_composite(Image.alpha_composite(key_layer, white_layer), body)
# エッジを1px弱ぼかしたアルファに (ジャギ低減)
a = out.getchannel('A').filter(ImageFilter.GaussianBlur(0.8))
out.putalpha(a)
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
