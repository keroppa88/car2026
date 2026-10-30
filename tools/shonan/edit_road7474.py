"""湘南 7474,12: 指示の絵(paint/top/road7474_target.png)のとおり、北の何もない所へ伸びる道路を消す。
絵 → 描画の画素(road7474_H.npy)→ 地図の座標(road7474_Hw.npy)。絵で地面(明るいグレー)になっている所の道路を切る。"""
import json, math
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import LineString
ROOT = Path(__file__).resolve().parents[2]; TOP = ROOT / 'tools/shonan/paint/top'; FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
T = cv2.imread(str(TOP / 'road7474_target.png')); base = cv2.imread(str(TOP / 'road7474_base.png'))
H = np.load(TOP / 'road7474_H.npy'); Hw = np.load(TOP / 'road7474_Hw.npy'); Hinv = np.linalg.inv(Hw)
Wt = cv2.warpPerspective(T, H, (base.shape[1], base.shape[0])); valid = cv2.warpPerspective(np.full(T.shape[:2], 255, np.uint8), H, (base.shape[1], base.shape[0])) > 200
valid = cv2.erode(valid.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
g = Wt.astype(int); lum = g.mean(2); sat = g.max(2) - g.min(2)
ground = (lum > 140) & (sat < 18)           # 何もない地面(明るいグレー)
ground = cv2.erode(ground.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
def px(x, z):
    p = cv2.perspectiveTransform(np.float32([[[x, z]]]), Hinv)[0, 0]; return int(round(p[0])), int(round(p[1]))
key = lambda q: (round(q[0], 2), round(q[1], 2))
cnt = {}
for r in R:
    for q in r['pts']: cnt[key(q)] = cnt.get(key(q), 0) + 1
out, changed = [], 0
for r in R:
    L = LineString(r['pts'])
    n = max(2, int(L.length) + 1); kill = []
    for k in range(n):
        p = L.interpolate(k / (n - 1), normalized=True); u, v = px(p.x, p.y)
        kill.append(0 <= u < base.shape[1] and 0 <= v < base.shape[0] and valid[v, u] and ground[v, u])
    if not any(kill): out.append(r); continue
    changed += 1
    # 残す区間(1m ごと)。区間ごとに元の頂点 + 切れ目の点で道路を作り直す
    runs, cur = [], None
    for k, kk in enumerate(kill):
        if not kk and cur is None: cur = [k, k]
        elif not kk: cur[1] = k
        elif cur is not None: runs.append(cur); cur = None
    if cur is not None: runs.append(cur)
    s = [0.0]
    for a, b in zip(r['pts'][:-1], r['pts'][1:]): s.append(s[-1] + math.dist(a, b))
    for a, b in runs:
        s0, s1 = a / (n - 1) * L.length, b / (n - 1) * L.length
        if s1 - s0 < 6: continue
        pts, jn = [], []
        p0 = L.interpolate(s0); pts.append([round(p0.x, 2), round(p0.y, 2)])
        for i, q in enumerate(r['pts']):
            if s0 + 0.3 < s[i] < s1 - 0.3: pts.append(q)
        p1 = L.interpolate(s1); pts.append([round(p1.x, 2), round(p1.y, 2)])
        if s[0] >= s0 - 0.3: pts[0] = r['pts'][0]
        if s[-1] <= s1 + 0.3: pts[-1] = r['pts'][-1]
        jn = [i for i, q in enumerate(pts) if cnt.get(key(q), 0) > 1]
        out.append({**r, 'pts': pts, 'junctions': jn})
print('切った道路', changed, '本', '道路の数', len(R), '→', len(out))
d['roads'] = out
# この辺で、どの道路の歩道にもかからなくなった歩道の帯・街路樹を消す
from shapely.geometry import Point, box
from shapely.ops import unary_union
RW = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
c = [cv2.perspectiveTransform(np.float32([[[u, v]]]), Hw)[0, 0] for u, v in ((0, 0), (base.shape[1], 0), (0, base.shape[0]), (base.shape[1], base.shape[0]))]
zone = box(min(p[0] for p in c), min(p[1] for p in c), max(p[0] for p in c), max(p[1] for p in c))
side = unary_union([LineString(r['pts']).buffer(RW(r) / 2 + 4.6) for r in out if LineString(r['pts']).intersects(zone.buffer(60))])
stale = lambda x, z: zone.contains(Point(x, z)) and not side.contains(Point(x, z))
n0 = len(d['strips']); d['strips'] = [t for t in d['strips'] if not stale(t[0], t[1])]; d['trees'] = [t for t in d['trees'] if not stale(t[0], t[1])]
print('歩道の帯', n0 - len(d['strips']))
# 消した道路に沿って残った細い敷地(幅 3m 未満)も消す
from shapely.geometry import Polygon
thin = lambda q: (lambda g: g.area > 0 and 2 * g.area / g.length < 1.5)(Polygon(q['o']).buffer(0))
n1 = len(d['lots']); d['lots'] = [q for q in d['lots'] if not (zone.contains(Polygon(q['o']).buffer(0).centroid) and thin(q))]
print('細い敷地', n1 - len(d['lots']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
