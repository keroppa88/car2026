# 選んだ PLATEAU の建物を three.js 用の三角形にする → map/nihonbashi-landmarks.json
# 座標は街のデータ(osm_to_city.py)と同じ: 範囲の中心が原点、x=東、z=南、y=高さ(m)
# 建物データ: 3D都市モデル(Project PLATEAU) 国土交通省
import json, math, pickle, sys
import numpy as np, mapbox_earcut as earcut
from shapely.geometry import Polygon
from shapely.ops import unary_union
area = json.load(open('/home/claude/car2026/tools/tokyo-center-area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xz(la, lo): return ((lo - lon0) * KX, -(la - lat0) * KZ)
# PLATEAU が完成前の古い姿・位置が不確かなものは OSM の建物のままにする
SKIP = {'日本橋野村ビルディング', 'TOFROM YAESU', '東京ミッドタウン日本橋', 'Ginza Sony Park'}
SEL = pickle.load(open('/home/claude/plateau/selected.pkl', 'rb'))

def tri(poly, y0, out, uv=None):  # uv は使わない(窓の模様は JS 側で面の向きから計算)
    ext, ints = poly
    rings = [ext] + ints
    P = []
    for r in rings:
        r = r[:-1] if len(r) > 1 and r[0] == r[-1] else r
        P.append([(*xz(p[0], p[1]), p[2] - y0) for p in r])
    pts = np.array([q for r in P for q in r], dtype=float)
    if len(pts) < 3: return
    xyz = pts[:, [0, 2, 1]]   # (x, y=高さ, z)
    # 面の向き(Newell)
    n = np.zeros(3)
    for i in range(len(P[0])):
        a, b = np.array(xyz[i]), np.array(xyz[(i + 1) % len(P[0])])
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    if np.linalg.norm(n) < 1e-9: return
    n /= np.linalg.norm(n)
    k = int(np.argmax(np.abs(n)))
    ax = [i for i in range(3) if i != k]
    v2 = xyz[:, ax]
    ends = np.cumsum([len(r) for r in P]).astype(np.uint32)
    try: idx = earcut.triangulate_float64(v2, ends)
    except Exception: return
    for t in range(0, len(idx), 3):
        a, b, c = xyz[idx[t]], xyz[idx[t + 1]], xyz[idx[t + 2]]
        # 法線の向きにそろえる
        if np.dot(np.cross(b - a, c - a), n) < 0: b, c = c, b
        for p in (a, b, c):
            out.extend(round(float(v), 1) for v in p)

res = []
for s in SEL:
    if not s['parts'] or s['label'] in SKIP: continue
    y0 = min(min(p[2] for p in b['fp']) for b in s['parts'])
    zs = [p[2] for b in s['parts'] for w in b['walls'] for p in w[0]]
    if zs: y0 = min(zs)
    walls, uv, roofs = [], [], []
    for b in s['parts']:
        for w in b['walls'] + b['inst']: tri(w, y0, walls)
        for r in b['roofs']: tri(r, y0, roofs)
    fp = unary_union([Polygon([xz(p[0], p[1]) for p in b['fp']]).buffer(0) for b in s['parts']])
    fps = [list(g.exterior.coords) for g in (fp.geoms if hasattr(fp, 'geoms') else [fp]) if g.area > 1]
    if not walls:   # LOD2 が無い建物は外す(普通の建物のまま)
        print('LOD2なし', s['label']); continue
    res.append({'label': s['label'], 'walls': walls, 'roofs': roofs,
                'fp': [[[round(x, 2), round(z, 2)] for x, z in r] for r in fps]})
    print(s['label'], '壁', len(walls) // 9, '屋根', len(roofs) // 9)
json.dump({'source': '3D都市モデル(Project PLATEAU) 国土交通省', 'landmarks': res},
          open(sys.argv[1], 'w'), ensure_ascii=False, separators=(',', ':'))
