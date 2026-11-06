"""富士スピードウェイ: 空撮(U)の画面に塗った指示の絵を反映する(場所ごと)。
python3 tools/fuji/apply_area_paint.py 名前
  tools/fuji/paint/名前_paint.png   … 塗った絵
  tools/fuji/paint/名前_H.npy       … 絵の画素 → 照合した描画の画素
  tools/fuji/paint/名前_Hw.npy      … 描画の画素 → 地図 (x, z)
色:
  白(大きな塊)  = 観客席(グランドスタンド)  → buildings(stand)
  白(道路の上の細いもの) = 白線(破線)        → markings
  黄緑(明るい)  = 芝生                        → paintAreas k='lawn'
  水色          = アスファルト(コースではない) → paintAreas k='paved'
  黄色          = 砂地                        → paintAreas k='sand'
  赤の線        = 白い棒の柵                  → fences
  赤白のしま    = 地面の描画(赤白のシェブロン) → decals
→ map/fuji-course.json(src=名前 のものは置き換え)
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from skimage.morphology import skeletonize
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/fuji/paint'; F = ROOT / 'map/fuji-course.json'
name = sys.argv[1]
I = cv2.imread(str(P / f'{name}_paint.png')).astype(int); H = np.load(P / f'{name}_H.npy'); Hw = np.load(P / f'{name}_Hw.npy')
M = Hw @ H
b, g, r = I[..., 0], I[..., 1], I[..., 2]
W = lambda pts: cv2.perspectiveTransform(np.float32(pts).reshape(-1, 1, 2), M).reshape(-1, 2)
near = lambda c, t=18: (abs(r - c[0]) < t) & (abs(g - c[1]) < t) & (abs(b - c[2]) < t)
white = (r > 238) & (g > 238) & (b > 238)
red = (r > 200) & (g < 70) & (b < 80)
lime = near((178, 226, 28), 22)
blue = near((154, 218, 234), 16)
yellow = (r > 230) & (g > 220) & (b < 50)
dark = near((80, 80, 80), 12)
d = json.loads(F.read_text())
for k in ('paintAreas', 'fences', 'decals', 'markings'):
    d[k] = [q for q in d.get(k, []) if q.get('src') != name]
d['buildings'] = [q for q in d['buildings'] if q.get('src') != name]
ring = lambda p: [[round(float(x), 2), round(float(z), 2)] for x, z in list(p.exterior.coords)[:-1]]
def polys(mask, min_px=40, close=3):
    m = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cs:
        if cv2.contourArea(c) < min_px: continue
        p = Polygon(W(c.reshape(-1, 2) + 0.5)).buffer(0)
        for q in getattr(p, 'geoms', [p]):
            if q.geom_type == 'Polygon' and q.area > 2: out.append(q.simplify(0.25))
    return out
# 赤白のしま: 赤と白が細かく混ざった所
light = (r > 195) & (g > 195) & (b > 195)
mix = cv2.dilate(red.astype(np.uint8), np.ones((5, 5), np.uint8)) & cv2.dilate(light.astype(np.uint8), np.ones((5, 5), np.uint8))
mix = cv2.morphologyEx(mix, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
nl, lab, st, _ = cv2.connectedComponentsWithStats(mix)
chev = np.zeros_like(mix)
for k in range(1, nl):
    if st[k, 4] > 60: chev |= (lab == k).astype(np.uint8)
chev_d = cv2.dilate(chev, np.ones((5, 5), np.uint8)).astype(bool)
for p in polys(chev.astype(bool), 60, 5):
    # 向き: 長い方向。しまの矢じりはコースの進む向き(絵の左向き)
    mrr = p.minimum_rotated_rectangle; c = list(mrr.exterior.coords)
    e = max([(c[i], c[i + 1]) for i in range(4)], key=lambda s: math.dist(*s))
    d['decals'].append({'o': ring(p), 'k': 'chevron', 'axis': [round(e[1][0] - e[0][0], 3), round(e[1][1] - e[0][1], 3)], 'src': name})
# 観客席: 大きな白い塊
nl, lab, st, _ = cv2.connectedComponentsWithStats((white & ~chev_d).astype(np.uint8))
for k in range(1, nl):
    mk = lab == k
    if st[k, 4] > 1500:
        for p in polys(mk, 1500):
            d['buildings'].append({'p': ring(p.minimum_rotated_rectangle), 'h': 14, 'y': None, 'roof': False, 'stand': True, 'name': '観客席', 'src': name})
# 白線(破線): 路面(濃いグレー)の上の細長い白。破線の切れ目をまたいで一本の線にする
wl = (r > 205) & (g > 205) & (b > 205) & ~chev_d
nl2, lab2, st2, cen2 = cv2.connectedComponentsWithStats(wl.astype(np.uint8))
dash = []
for k in range(1, nl2):
    x_, y_, w_, h_, a_ = st2[k]
    if a_ < 4 or a_ > 400 or max(w_, h_) < 3 * min(w_, h_) or max(w_, h_) < 6: continue
    ring_ = cv2.dilate((lab2 == k).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & ~(lab2 == k)
    if dark[ring_].mean() < 0.3: continue
    dash.append(cen2[k])
if len(dash) >= 3:
    q = W(np.float32(dash)); c0 = q.mean(0); _, _, vt = np.linalg.svd(q - c0); t = (q - c0) @ vt[0]
    order = np.argsort(t); q = q[order]
    L = LineString(q).simplify(0.5); ends = list(L.coords)
    d['markings'].append({'pts': [[round(x, 2), round(z, 2)] for x, z in ends], 'w': 0.15, 'dash': [3, 3], 'src': name})
# 芝生・アスファルト・砂地
for mask, kind in ((blue, 'paved'), (lime, 'lawn'), (yellow, 'sand')):
    for p in polys(mask & ~chev_d, 40, 3):
        d['paintAreas'].append({'o': ring(p), 'k': kind, 'src': name})
# 白い棒の柵: 赤の線(しまの所は除く)を細線にして折れ線に
fm = (red & ~chev_d).astype(np.uint8)
fm = cv2.morphologyEx(fm, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
nl, lab, st, _ = cv2.connectedComponentsWithStats(fm)
for k in range(1, nl):
    if st[k, 4] < 20: continue
    sk = skeletonize(lab == k); ys, xs = np.nonzero(sk); S = set(zip(xs.tolist(), ys.tolist()))
    nb = lambda p: [(p[0] + a, p[1] + c) for a in (-1, 0, 1) for c in (-1, 0, 1) if (a or c) and (p[0] + a, p[1] + c) in S]
    def bfs(s):
        prev = {s: None}; q = [s]
        for p in q:
            for m in nb(p):
                if m not in prev: prev[m] = p; q.append(m)
        return q[-1], prev
    ends = [p for p in S if len(nb(p)) == 1] or list(S)[:1]
    a, _ = bfs(ends[0]); z, prev = bfs(a); path = []; p = z
    while p: path.append(p); p = prev[p]
    L = LineString(W(np.float32(path) + 0.5)).simplify(0.4)
    if L.length > 12: d['fences'].append({'pts': [[round(x, 2), round(zz, 2)] for x, zz in L.coords], 'src': name})
F.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
cnt = lambda k: len([q for q in d[k] if q.get('src') == name])
print('芝生/アスファルト/砂地', cnt('paintAreas'), ' 柵', cnt('fences'), round(sum(LineString(q['pts']).length for q in d['fences'] if q.get('src') == name)), 'm',
      ' しま', cnt('decals'), ' 白線', cnt('markings'), ' 観客席', len([q for q in d['buildings'] if q.get('src') == name]))
