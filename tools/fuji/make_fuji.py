"""富士スピードウェイ: 本コースの線(OSM)・地形(PLATEAU を間引いた fuji_dem.npz)・建物(OSM)から
map/fuji-course.json を作る。js/fuji-map.js がこれを読んでコースを組み立てる。

座標: 本コースの外枠の中心が原点。x = 東、z = 南(m)。y = 標高 - 基準(コースの一番低い所)。
python3 tools/fuji/make_fuji.py
"""
import json, math
from pathlib import Path
import numpy as np
from lxml import etree
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
OSM, DEM, OUT = ROOT / 'tools/fuji/fuji.osm', ROOT / 'tools/fuji/fuji_dem.npz', ROOT / 'map/fuji-course.json'
MAIN_WAY = '148622740'   # 本コース(name=Fuji Speedway)
STEP = 3.0               # コースの点の間隔(m)
CELL = 6.0               # 地面の升目(m)
PAD = 400.0              # 地形データの外側にのばす幅(m)

N, W = {}, {}
for _, e in etree.iterparse(str(OSM), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way':
        W[e.get('id')] = ([n.get('ref') for n in e.findall('nd')], {x.get('k'): x.get('v') for x in e.findall('tag')}); e.clear()
refs, _ = W[MAIN_WAY]
ll = [N[r] for r in refs]
lat0 = (min(p[0] for p in ll) + max(p[0] for p in ll)) / 2
lon0 = (min(p[1] for p in ll) + max(p[1] for p in ll)) / 2
KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
xz = lambda lat, lon: ((lon - lon0) * KX, -(lat - lat0) * KZ)

# 地形(緯度経度の升目)
z = np.load(DEM)
H = z['h'].astype(np.float64); la_min, lo_min, dla, dlo = float(z['lat_min']), float(z['lon_min']), float(z['dlat']), float(z['dlon'])
idx = ndimage.distance_transform_edt(np.isnan(H), return_distances=False, return_indices=True)
Hf = H[tuple(idx)]   # 穴(データの外)は一番近い高さで埋める
def dem_at(lat, lon):
    fy = np.clip((lat - la_min) / dla, 0, Hf.shape[0] - 1.001); fx = np.clip((lon - lo_min) / dlo, 0, Hf.shape[1] - 1.001)
    iy, ix = int(fy), int(fx); ty, tx = fy - iy, fx - ix
    a, b, c, d = Hf[iy, ix], Hf[iy, ix + 1], Hf[iy + 1, ix], Hf[iy + 1, ix + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty

# コース: 3m ごとに置き直す(閉じた輪)
P = np.array([xz(*p) for p in ll])
if np.allclose(P[0], P[-1]): P = P[:-1]
# 時計回り(上から見て。x 東・z 南の座標では面積が正)にそろえる = レースの向き
area = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
if area < 0: P = P[::-1]
seg = np.linalg.norm(np.roll(P, -1, 0) - P, axis=1); cum = np.concatenate([[0], np.cumsum(seg)]); L = cum[-1]
n = int(round(L / STEP)); ds = np.arange(n) * L / n
Q = np.stack([np.interp(ds, cum, np.append(P[:, k], P[0, k])) for k in (0, 1)], 1)
# 高さ: 地形から読み、前後 ±15m でならす
lat_of = lambda zz: lat0 - zz / KZ; lon_of = lambda xx: lon0 + xx / KX
y = np.array([dem_at(lat_of(q[1]), lon_of(q[0])) for q in Q])
k = 5; y = np.array([np.mean(np.take(y, range(i - k, i + k + 1), mode='wrap')) for i in range(n)])
BASE = float(np.floor(y.min()))
# メインストレート(いちばん長くまっすぐな所)とスタートの位置
dirs = np.arctan2(np.roll(Q[:, 0], -1) - Q[:, 0], np.roll(Q[:, 1], -1) - Q[:, 1])
best, cur, s0, bs = 0, 0, 0, 0
for i in range(2 * n):
    a, b = dirs[i % n], dirs[(i - 1) % n]
    if abs((a - b + math.pi) % (2 * math.pi) - math.pi) < 0.01: cur += 1
    else: cur, s0 = 0, i
    if cur > best: best, bs = cur, s0
st_i = (bs + int(best * 0.55)) % n   # ストレートの中ほど(コントロールライン付近)
print('長さ', round(L), 'm  点', n, ' 高さ', round(y.min(), 1), '〜', round(y.max(), 1), ' ストレート', round(best * L / n), 'm',
      ' 向き(度, 北=0 東=90)', round(math.degrees(math.atan2(math.sin(dirs[st_i]), -math.cos(dirs[st_i]))) % 360))

# 地面: 地形を 4m 升目にして、まわりへ PAD のばす
x_min, x_max = P[:, 0].min() - PAD, P[:, 0].max() + PAD
z_min, z_max = P[:, 1].min() - PAD, P[:, 1].max() + PAD
nx, nz = int((x_max - x_min) / CELL) + 1, int((z_max - z_min) / CELL) + 1
gx = x_min + np.arange(nx) * CELL; gz = z_min + np.arange(nz) * CELL
GX, GZ = np.meshgrid(gx, gz)
fy = (lat_of(GZ) - la_min) / dla; fx = (lon_of(GX) - lo_min) / dlo
G = ndimage.map_coordinates(Hf, [np.clip(fy, 0, Hf.shape[0] - 1), np.clip(fx, 0, Hf.shape[1] - 1)], order=1, mode='nearest')
# データの外は、遠くほど端の高さのまま少しずつならす
out = (fy < 0) | (fy > Hf.shape[0] - 1) | (fx < 0) | (fx > Hf.shape[1] - 1) | np.isnan(H[np.clip(fy.astype(int), 0, H.shape[0] - 1), np.clip(fx.astype(int), 0, H.shape[1] - 1)])
G = np.where(out, ndimage.gaussian_filter(G, 6), G)

# 建物
bld = []
HT = {'grandstand': 14, 'commercial': 14, 'roof': 6}
NAMED = {'ピットビルA': 12, 'ピットビルB': 12, 'コントロールセンター': 18, 'サービスガレージ': 7, 'レストランOrizuru': 8}
# ホームストレートの両わき(ストレートの線から 120m 以内、ストレートの両端の間)の建物だけ残す
sa, sb = Q[bs % n], Q[(bs + best) % n]; sd = (sb - sa) / np.linalg.norm(sb - sa); sL = np.linalg.norm(sb - sa)
def by_straight(pts):
    c = np.mean(pts, 0) - sa; t = c @ sd; off = abs(c[0] * sd[1] - c[1] * sd[0])
    return -20 < t < sL + 20 and off < 120
for wid, (r, t) in W.items():
    if 'building' not in t or r[0] != r[-1] or len(r) < 4: continue
    pts = [xz(*N[q]) for q in r[:-1] if q in N]
    if not by_straight(pts): continue
    h = NAMED.get(t.get('name'), HT.get(t['building'], 7))
    if t.get('building:levels'): h = float(t['building:levels']) * 3.5
    gy = min(dem_at(lat_of(p[1]), lon_of(p[0])) for p in pts) - BASE
    bld.append({'p': [[round(a, 2), round(b, 2)] for a, b in pts], 'h': h, 'y': round(gy, 2), 'roof': t['building'] == 'roof', 'name': t.get('name', '')})

data = {
    'origin': [lat0, lon0], 'base': BASE,
    'route': [[round(q[0], 2), round(yy - BASE, 3), round(q[1], 2)] for q, yy in zip(Q, y)],
    'start': st_i,
    'ground': {'x0': round(x_min, 2), 'z0': round(z_min, 2), 'cell': CELL, 'nx': nx, 'nz': nz,
               'h': np.round((G - BASE) * 10).astype(int).ravel().tolist()},   # 0.1m 単位
    'buildings': bld,
}
OUT.write_text(json.dumps(data, separators=(',', ':')))
print('建物', len(bld), ' 地面', nx, 'x', nz, ' ->', OUT, round(OUT.stat().st_size / 1e6, 1), 'MB')
