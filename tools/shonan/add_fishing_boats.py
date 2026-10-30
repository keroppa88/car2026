"""湘南: 指示の絵で船の形を塗った所(赤 または 白)に小型漁船を置く → city.json boats (k='fish')。
絵: paint/top/boatsNN_paint.png、絵→描画の画素 boatsNN_H.npy、描画の画素→地図 boatsNN_Hw.npy。
船の向きは塗った形の長い方向、船尾は岸壁(陸)に近い方の端。長さは塗った形の長さ(7〜12m)。
python3 tools/shonan/add_fishing_boats.py 69 62 16 46 88
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; TOP = ROOT / 'tools/shonan/paint/top'; FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
water = unary_union([shape(q) for q in d['water']])
land = unary_union([shape(q) for k in ('beaches', 'piers', 'rocks', 'parks', 'woods', 'lots', 'parking', 'lawns') for q in d.get(k, [])])
sea = water.difference(land)
boats = [b for b in d.get('boats', []) if not (b['k'] == 'fish' and b.get('src') in sys.argv[1:])]
for name in sys.argv[1:]:
    T = cv2.imread(str(TOP / f'boats{name}_paint.png')); H = np.load(TOP / f'boats{name}_H.npy'); Hw = np.load(TOP / f'boats{name}_Hw.npy')
    b, g, r = [T[..., i].astype(int) for i in range(3)]
    mask = (((r > 200) & (g < 60) & (b < 60)) | ((r > 248) & (g > 248) & (b > 248))).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
    k = 0
    for i in range(1, n):
        if st[i, 4] < 25: continue
        ys, xs = np.nonzero(lab == i)
        p = cv2.perspectiveTransform(cv2.perspectiveTransform(np.float32(np.stack([xs + .5, ys + .5], 1))[None], H), Hw)[0]
        c = p.mean(0)
        if not sea.buffer(-0.5).contains(Point(*c)): continue          # 水の上に塗った所だけ(白い建物などは除く)
        _, _, vt = np.linalg.svd(p - c); ax = vt[0]; t = (p - c) @ ax
        L = float(np.clip(t.max() - t.min(), 7, 12))
        e1, e2 = c + ax * t.max(), c + ax * t.min()
        stern, bow = (e1, e2) if land.distance(Point(*e1)) < land.distance(Point(*e2)) else (e2, e1)
        tx, tz = bow - stern; l = math.hypot(tx, tz); tx, tz = tx / l, tz / l
        boats.append({'x': round(float(c[0]), 2), 'z': round(float(c[1]), 2), 'a': round(math.atan2(tx, tz), 3), 'L': round(L, 1), 'k': 'fish', 'src': name}); k += 1
    print(name, '漁船', k)
d['boats'] = boats
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
