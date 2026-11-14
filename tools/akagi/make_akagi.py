"""赤城(県道4号 前橋赤城線、赤城山総合観光案内所の前 → 姫百合駐車場の前)のコースデータを作る。
道の線は OpenStreetMap(tools/akagi/akagi.osm)、起伏は PLATEAU 前橋市の地形(tools/akagi/akagi_dem.npz)。
→ map/akagi-course.json
座標: スタートが原点。x = 東、z = 南(m)。y = 標高 - 基準(コースの一番低い所)。
python3 tools/akagi/make_akagi.py
"""
import json, math, heapq
from pathlib import Path
import numpy as np
from lxml import etree
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]
OSM, DEM, OUT = ROOT / 'tools/akagi/akagi.osm', ROOT / 'tools/akagi/akagi_dem.npz', ROOT / 'map/akagi-course.json'
STEP, CELL, PAD = 3.0, 6.0, 600.0
N, W = {}, {}
for _, e in etree.iterparse(str(OSM), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way':
        W[e.get('id')] = ([n.get('ref') for n in e.findall('nd')], {x.get('k'): x.get('v') for x in e.findall('tag')}); e.clear()
cen = lambda name: np.mean([N[r] for refs, t in W.values() if t.get('name') == name for r in refs], 0)
# 県道4号だけでつないだ道の網
G = {}
for refs, t in W.values():
    if t.get('highway') and t.get('ref') == '4':
        for a, b in zip(refs, refs[1:]):
            d = math.dist((N[a][0] * 111000, N[a][1] * 89500), (N[b][0] * 111000, N[b][1] * 89500))
            G.setdefault(a, []).append((b, d)); G.setdefault(b, []).append((a, d))
near = lambda p: min(G, key=lambda i: (N[i][0] - p[0]) ** 2 + ((N[i][1] - p[1]) * 0.806) ** 2)
A, B = near(cen('赤城山総合観光案内所')), near(cen('姫百合駐車場'))
dist, prev, pq = {A: 0}, {}, [(0, A)]
while pq:
    d, u = heapq.heappop(pq)
    if u == B: break
    if d > dist[u]: continue
    for v, w in G[u]:
        if d + w < dist.get(v, 1e18): dist[v] = d + w; prev[v] = u; heapq.heappush(pq, (d + w, v))
path = [B]
while path[-1] != A: path.append(prev[path[-1]])
ll = np.array([N[i] for i in path[::-1]])
lat0, lon0 = ll[0]
KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
P = np.stack([(ll[:, 1] - lon0) * KX, -(ll[:, 0] - lat0) * KZ], 1)
# 地形
z = np.load(DEM); H = z['h'].astype(np.float64)
la_min, lo_min, dla, dlo = float(z['lat_min']), float(z['lon_min']), float(z['dlat']), float(z['dlon'])
Hf = H[tuple(ndimage.distance_transform_edt(np.isnan(H), return_distances=False, return_indices=True))]
def dem_at(lat, lon):
    fy = np.clip((lat - la_min) / dla, 0, Hf.shape[0] - 1.001); fx = np.clip((lon - lo_min) / dlo, 0, Hf.shape[1] - 1.001)
    iy, ix = fy.astype(int), fx.astype(int); ty, tx = fy - iy, fx - ix
    return (Hf[iy, ix] * (1 - tx) + Hf[iy, ix + 1] * tx) * (1 - ty) + (Hf[iy + 1, ix] * (1 - tx) + Hf[iy + 1, ix + 1] * tx) * ty
lat_of = lambda zz: lat0 - zz / KZ; lon_of = lambda xx: lon0 + xx / KX
# コース: 3m ごとに置き直す(はじめと終わりがある1本道)
seg = np.linalg.norm(np.diff(P, axis=0), axis=1); cum = np.concatenate([[0], np.cumsum(seg)]); L = cum[-1]
n = int(round(L / STEP)) + 1; ds = np.linspace(0, L, n)
Q = np.stack([np.interp(ds, cum, P[:, k]) for k in (0, 1)], 1)
# 角をならす(OSM の折れ線の角を丸める)
for _ in range(3): Q[1:-1] = (Q[:-2] + 2 * Q[1:-1] + Q[2:]) / 4
y = dem_at(lat_of(Q[:, 1]), lon_of(Q[:, 0]))
k = 15; y = np.array([y[max(0, i - k):i + k + 1].mean() for i in range(n)])   # 前後 ±45m でならす(地形の升目は道の切り土・盛り土でがたつく)
BASE = float(np.floor(y.min()))
# 地面の升目(コースのまわり PAD m)
x0, x1 = Q[:, 0].min() - PAD, Q[:, 0].max() + PAD; z0, z1 = Q[:, 1].min() - PAD, Q[:, 1].max() + PAD
nx, nz = int((x1 - x0) / CELL) + 1, int((z1 - z0) / CELL) + 1
GX, GZ = np.meshgrid(x0 + np.arange(nx) * CELL, z0 + np.arange(nz) * CELL)
gh = dem_at(lat_of(GZ), lon_of(GX)) - BASE
data = {'origin': [float(lat0), float(lon0)], 'base': BASE,
        'route': [[round(float(q[0]), 2), round(float(y[i] - BASE), 3), round(float(q[1]), 2)] for i, q in enumerate(Q)],
        'ground': {'x0': round(float(x0), 2), 'z0': round(float(z0), 2), 'cell': CELL, 'nx': nx, 'nz': nz,
                   'h': [round(float(v), 1) for v in gh.ravel()]}}
OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
print('長さ', round(L), 'm  点', n, ' 高さ', round(y[0]), '→', round(y[-1]), ' 基準', BASE, ' 地面', nx, 'x', nz, OUT.stat().st_size // 1024, 'KB')
