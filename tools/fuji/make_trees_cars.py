"""富士スピードウェイ: 塗り分け図(map/fuji-landcover.png)から、木と駐車場の車の位置を作る → map/fuji-course.json の trees / cars
木: 森の画素に。コースから 130m 以内は 9m おきに1本ずつ(大きさ 9〜13m)、その奥は 20m おきに大きな木の塊(20〜28m)。
車: 駐車場のかたまりごとに向きを決め、2列ずつ向かい合わせ + 通路で並べる。7割ほど埋める。
python3 tools/fuji/make_trees_cars.py   (make_landcover_mosaic.py のあとに)
"""
import json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
L = d['landcover']; img = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); H, W = img.shape[:2]
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text()
col = lambda k: tuple(int(v) for v in src.split(f"'{k}': (")[1].split(')')[0].split(','))
is_ = lambda k: (img == np.array(col(k), np.uint8)).all(2)
rng = np.random.default_rng(7)
# コース・分かれ道からの距離
road = np.ones((H, W), np.uint8)
P = lambda pts: np.array([[p[0] - L['x0'], p[-1] - L['z0']] for p in pts], np.int32)
cv2.polylines(road, [P(d['route'])], True, 0, 1)
for b in d.get('branches', []): cv2.polylines(road, [P(b['pts'])], False, 0, 1)
dist = cv2.distanceTransform(road, cv2.DIST_L2, 5)
forest = cv2.erode(is_('forest').astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
trees = []
def scatter(mask, step, s0, s1):
    for z in np.arange(step / 2, H, step):
        for x in np.arange(step / 2, W, step):
            u, v = int(x + rng.uniform(-0.4, 0.4) * step), int(z + rng.uniform(-0.4, 0.4) * step)
            if 0 <= u < W and 0 <= v < H and mask[v, u]: trees.append([u + L['x0'], v + L['z0'], round(float(rng.uniform(s0, s1)), 1)])
scatter(forest & (dist > 16) & (dist <= 130), 9, 9, 13)
near = len(trees)
scatter(forest & (dist > 130), 20, 20, 28)
d['trees'] = [[round(x), round(z), s] for x, z, s in trees]
# 車
park = cv2.erode(is_('parking').astype(np.uint8), np.ones((3, 3), np.uint8))
n, cc, st, _ = cv2.connectedComponentsWithStats(park); cars = []
CL, CW, PITCH = 4.4, 1.8, 2.7
for i in range(1, n):
    if st[i, cv2.CC_STAT_AREA] < 150: continue
    m = (cc == i).astype(np.uint8); cnt = max(cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
    (cx, cy), (w, h), ang = cv2.minAreaRect(cnt); a = math.radians(ang if w >= h else ang + 90)   # 長い辺の向き
    ex, ez = math.cos(a), math.sin(a); fx, fz = -ez, ex; half = math.hypot(w, h) / 2
    fill = rng.uniform(0.5, 0.85); r = -half; k = 0
    while r < half:
        for s in np.arange(-half, half, PITCH):
            if rng.random() > fill: continue
            x, y = cx + ex * s + fx * r, cy + ey if False else cy + ez * s + fz * r
            ok = True
            for da, db in ((0, 0), (CW / 2, CL / 2), (-CW / 2, CL / 2), (CW / 2, -CL / 2), (-CW / 2, -CL / 2)):
                u, v = int(round(x + ex * da + fx * db)), int(round(y + ez * da + fz * db))
                if not (0 <= u < W and 0 <= v < H and m[v, u]): ok = False; break
            if ok: cars.append([round(float(x + L['x0']), 1), round(float(y + L['z0']), 1), round(math.degrees(math.atan2(fx, fz)) + (180 if k % 2 else 0))])
        r += 5.0 if k % 2 == 0 else 11.5; k += 1     # 向かい合わせの2列、通路 6.5m
d['cars'] = cars
F.write_text(json.dumps(d, separators=(',', ':')))
print('木', near, '+ 塊', len(trees) - near, ' 車', len(cars))
