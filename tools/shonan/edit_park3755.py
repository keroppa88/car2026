"""湘南 -3755,-799 付近(公園)の指示の絵(paint/top/park3755_*)を反映する。
赤 = グレーのすき間をなくし、となりの緑地(parks)とつなげる
紫 = 2D の茂み(bushes h=2)
黄緑 = 少し色の違う平らな緑地(lawns)
オレンジ = 白い中層(3〜5階)の建物、窓なし(buildings plain)
"""
import json
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, LineString, box
from shapely.ops import unary_union
from skimage.morphology import skeletonize
ROOT = Path(__file__).resolve().parents[2]; TOP = ROOT / 'tools/shonan/paint/top'; FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
B = cv2.imread(str(TOP / 'park3755_paint.png')).astype(int); Hw = np.load(TOP / 'park3755_Hw.npy')
b, g, r = B[..., 0], B[..., 1], B[..., 2]
W = lambda q: cv2.perspectiveTransform(np.float32(q).reshape(-1, 1, 2), Hw).reshape(-1, 2)
RW = lambda rd: 4.5 if rd.get('lanes') == 1 and not rd.get('oneway') else rd.get('lanes', 2) * 3.25
roads = unary_union([LineString(rd['pts']).buffer(RW(rd) / 2 + 2.0) for rd in d['roads']])   # 車道 + 少し
def comps(mask, min_px=30):
    m = cv2.morphologyEx(mask.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    return [(lab == i) for i in range(1, n) if st[i, 4] >= min_px]
def poly(mk):
    cs, _ = cv2.findContours(mk.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    c = max(cs, key=cv2.contourArea)
    return Polygon(W(c.reshape(-1, 2) + 0.5)).buffer(0)
ring = lambda p: [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]
pieces = lambda g: [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon']

# 赤: その近くのグレー(どの面にも入っていない所)を緑地に
parks = unary_union([Polygon(q['o'], q.get('h', [])).buffer(0) for q in d['parks']])
for mk in comps((r > 200) & (g < 60) & (b < 60)):
    red = poly(mk)   # 赤い線がかかっているグレーだけ
    gap = red.buffer(25).difference(parks).difference(roads)
    for p in pieces(gap):
        if p.area > 50 and p.intersects(red.buffer(3)): d['parks'].append({'o': ring(p.buffer(0.5).simplify(0.2))}); print('赤 → 緑地', round(p.area), 'm²')

# 黄緑: 少し色の違う平らな緑地
d['lawns'] = d.get('lawns', [])
for mk in comps((r > 150) & (r < 200) & (g > 210) & (b < 60)):
    p = poly(mk).minimum_rotated_rectangle.difference(roads)
    for q in pieces(p):
        if q.area > 50: d['lawns'].append({'o': ring(q)}); print('黄緑 → 緑地(色違い)', round(q.area), 'm²')

# オレンジ: 白い中層の建物(窓なし)。高さ 3〜5階
rng = np.random.default_rng(3755)
for mk in comps((r > 230) & (g > 150) & (g < 215) & (b < 40)):
    p = poly(mk).minimum_rotated_rectangle.difference(roads)
    q = max(pieces(p), key=lambda q: q.area)
    h = round(float(rng.choice([10.5, 14.0, 17.5])), 1)
    d['buildings'].append({'p': ring(q.simplify(0.3)), 'h': h, 'holes': [], 'plain': 1}); print('オレンジ → 建物', round(q.area), 'm²', h, 'm')

# 紫: 線(細線化してつなぐ) → 2D の茂み
d['bushes'] = [x for x in d.get('bushes', []) if x.get('src') != 'park3755']
for mk in comps((r > 130) & (r < 200) & (g < 110) & (b > 130)):
    sk = skeletonize(mk); ys, xs = np.nonzero(sk)
    pts = list(zip(xs.tolist(), ys.tolist())); S = set(pts)
    nb = lambda p: [(p[0] + dx, p[1] + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if (dx or dy) and (p[0] + dx, p[1] + dy) in S]
    ends = [p for p in pts if len(nb(p)) == 1] or pts[:1]
    # 一番長い道: 端から BFS で最遠 → そこから BFS で最遠
    def bfs(s):
        prev = {s: None}; q = [s]
        for p in q:
            for n in nb(p):
                if n not in prev: prev[n] = p; q.append(n)
        return q[-1], prev
    a, _ = bfs(ends[0]); z, prev = bfs(a)
    path = []; p = z
    while p: path.append(p); p = prev[p]
    L = LineString(W(np.float32(path) + 0.5)).simplify(1.0)
    for part in getattr(L.difference(roads), 'geoms', [L.difference(roads)]):
        if part.geom_type == 'LineString' and part.length > 3:
            d['bushes'].append({'pts': [[round(x, 2), round(z, 2)] for x, z in part.coords], 'h': 2, 'src': 'park3755'}); print('紫 → 茂み', round(part.length), 'm')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
