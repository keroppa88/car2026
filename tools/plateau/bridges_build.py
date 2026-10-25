# PLATEAU の橋梁モデルから首都高・東京高速道路(KK線)の高架を three.js 用の三角形にする
# → map/nihonbashi-bridges.json  ({bridges:[{top:[...], side:[...], fp:[[x,z]...]...}]})
# 線路の高架と重なる橋(OSM の線路で作る)と、川に架かる低い橋(道路の一部)は除く。
# 建物データ: 3D都市モデル(Project PLATEAU) 国土交通省
import json, math, pickle, sys
import numpy as np, mapbox_earcut as earcut
from shapely.geometry import LineString
from shapely.ops import unary_union
area = json.load(open('/home/claude/car2026/tools/tokyo-center-area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
GROUND = 3.0   # このあたりの地面の標高(m)。PLATEAU の高さは標高なので、これを引く
def xz(la, lo): return ((lo - lon0) * KX, -(la - lat0) * KZ)
B = pickle.load(open('/home/claude/plateau/bridges.pkl', 'rb'))
city = json.load(open('/home/claude/car2026/map/nihonbashi-city.json'))
rail = unary_union([LineString(r['pts']).buffer(6) for r in city['rails'] if len(r['pts']) > 1])

def tri(poly, out):
    ext, ints = poly
    P = []
    for r in [ext] + ints:
        r = r[:-1] if len(r) > 1 and r[0] == r[-1] else r
        P.append([(*xz(p[0], p[1]), p[2] - GROUND) for p in r])
    pts = np.array([q for r in P for q in r], dtype=float)
    if len(pts) < 3: return
    xyz = pts[:, [0, 2, 1]]
    n = np.zeros(3)
    for i in range(len(P[0])):
        a, b = xyz[i], xyz[(i + 1) % len(P[0])]
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    if np.linalg.norm(n) < 1e-9: return
    n /= np.linalg.norm(n)
    ax = [i for i in range(3) if i != int(np.argmax(np.abs(n)))]
    ends = np.cumsum([len(r) for r in P]).astype(np.uint32)
    try: idx = earcut.triangulate_float64(xyz[:, ax], ends)
    except Exception: return
    for t in range(0, len(idx), 3):
        a, b, c = xyz[idx[t]], xyz[idx[t + 1]], xyz[idx[t + 2]]
        if np.dot(np.cross(b - a, c - a), n) < 0: b, c = c, b
        for p in (a, b, c): out.extend(round(float(v), 1) for v in p)

from shapely.geometry import Polygon as _P, Point as _Pt
from shapely.strtree import STRtree
_w = [_P(w['o']).buffer(0) for w in city['water']] + [LineString(rv['pts']).buffer(rv['w'] / 2) for rv in city['rivers'] if len(rv['pts']) > 1]
_w = [g.buffer(8) for g in _w if not g.is_empty]   # 川・濠とそのまわり 8m
_tw = STRtree(_w)
def near_water(x, z):
    p = _Pt(x, z)
    return any(_w[j].contains(p) for j in _tw.query(p))
def drop_piers(arr, deck_bottom):
    # 川の上・近くで、桁より下にある三角形(橋脚)を外す
    out = []
    for k in range(0, len(arr), 9):
        xs, ys, zs = arr[k:k + 9:3], arr[k + 1:k + 9:3], arr[k + 2:k + 9:3]
        if max(ys) < deck_bottom and near_water(sum(xs) / 3, sum(zs) / 3): continue
        out += arr[k:k + 9]
    return out

res = []
dropped = 0
for b in B:
    fa = b['fp'].area or 1
    if b['kind'] == 'rail' or b['fp'].intersection(rail).area > 0.2 * fa: continue   # 線路の高架
    if b['zmax'] - GROUND < 6 or b['len'] < 40: continue               # 低い橋・小さいもの
    top, side = [], []
    for p in b['polys']['roof']: tri(p, top)
    for p in b['polys']['wall'] + b['polys']['ground'] + b['polys']['other']: tri(p, side)
    if top:
        ys = sorted(top[1::3]); deck_bottom = ys[len(ys) // 10] - 2.5
        n0 = len(side); side = drop_piers(side, deck_bottom); dropped += (n0 - len(side)) // 9
    gs = b['fp'].geoms if hasattr(b['fp'], 'geoms') else [b['fp']]
    res.append({'kind': b['kind'], 'top': top, 'side': side,
                'fp': [[[round(x, 1), round(z, 1)] for x, z in g.exterior.coords] for g in gs if g.area > 1]})
print('川の近くの橋脚の三角形を外す', dropped)
print('橋', len(res), '三角形', sum(len(r['top']) + len(r['side']) for r in res) // 9)
json.dump({'source': '3D都市モデル(Project PLATEAU) 国土交通省', 'bridges': res}, open(sys.argv[1], 'w'), separators=(',', ':'))
