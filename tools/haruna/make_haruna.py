"""榛名山(県道33号 渋川松井田線、上の端(OSM の範囲の南西の端) → 伊香保)のコースデータを作る。
道の線は OpenStreetMap(tools/haruna/haruna.osm)、起伏は国土地理院 DEM5A(tools/haruna/haruna_dem.npz、make_dem.py)。
→ map/haruna-course.json(赤城山と同じ形。js/akagi-map.js で組み立てる)
道の向き: 上の端がスタート、伊香保(北東の端)がゴール。赤城山と同じく route はくだりの向き。
座標: スタートが原点。x = 東、z = 南(m)。y = 標高 - 基準(コースの一番低い所)。
python3 tools/haruna/make_haruna.py
"""
import json, math
from pathlib import Path
import numpy as np
from lxml import etree
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]
OSM, DEM, OUT = ROOT / 'tools/haruna/haruna.osm', ROOT / 'tools/haruna/haruna_dem.npz', ROOT / 'map/haruna-course.json'
STEP, CELL, PAD = 3.0, 6.0, 600.0
EXT = 60.0          # スタート(上の端)の手前にまっすぐのばす長さ(m)。ゴールの先は js/akagi-map.js が 250m のばす
# 県道33号(伊香保 → 上)。ヘアピンもそのまま 1 本の線につながっている
WAYS = ['691869699', '691869698', '1574747383', '691869704', '1574747384', '1574747381', '1576969852', '1576969851', '1574747382', '691869703', '405586760', '405586761', '197294653']
MIN_LAT = 36.47917   # OSM の範囲の南の端(絵のピンクの終わり)。その先は切る
N, W = {}, {}
for _, e in etree.iterparse(str(OSM), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way': W[e.get('id')] = [n.get('ref') for n in e.findall('nd')]; e.clear()
refs = []
for w in WAYS: refs += W[w] if not refs else W[w][1:]
refs = [r for r in refs if N[r][0] >= MIN_LAT]
refs = refs[::-1]                                   # 上の端 → 伊香保
ll = np.array([N[r] for r in refs])
lat0, lon0 = ll[0]
KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
P = np.stack([(ll[:, 1] - lon0) * KX, -(ll[:, 0] - lat0) * KZ], 1)
t = P[0] - P[min(5, len(P) - 1)]; t /= np.linalg.norm(t)
P = np.vstack([P[0] + t * EXT, P])                  # スタートの手前へ、はじめの向きのまま まっすぐ
z = np.load(DEM); H = z['h'].astype(np.float64)
la_min, lo_min, dla, dlo = float(z['lat_min']), float(z['lon_min']), float(z['dlat']), float(z['dlon'])
Hf = H[tuple(ndimage.distance_transform_edt(np.isnan(H), return_distances=False, return_indices=True))]
def dem_at(lat, lon):
    fy = np.clip((lat - la_min) / dla, 0, Hf.shape[0] - 1.001); fx = np.clip((lon - lo_min) / dlo, 0, Hf.shape[1] - 1.001)
    iy, ix = fy.astype(int), fx.astype(int); ty, tx = fy - iy, fx - ix
    return (Hf[iy, ix] * (1 - tx) + Hf[iy, ix + 1] * tx) * (1 - ty) + (Hf[iy + 1, ix] * (1 - tx) + Hf[iy + 1, ix + 1] * tx) * ty
lat_of = lambda zz: lat0 - zz / KZ; lon_of = lambda xx: lon0 + xx / KX
seg = np.linalg.norm(np.diff(P, axis=0), axis=1); cum = np.concatenate([[0], np.cumsum(seg)]); L = cum[-1]
n = int(round(L / STEP)) + 1; ds = np.linspace(0, L, n)
Q = np.stack([np.interp(ds, cum, P[:, k]) for k in (0, 1)], 1)
for _ in range(3): Q[1:-1] = (Q[:-2] + 2 * Q[1:-1] + Q[2:]) / 4    # 角をならす
y = dem_at(lat_of(Q[:, 1]), lon_of(Q[:, 0]))
k = 15; y = np.array([y[max(0, i - k):i + k + 1].mean() for i in range(n)])   # 前後 ±45m でならす
BASE = float(np.floor(y.min()))
x0, x1 = Q[:, 0].min() - PAD, Q[:, 0].max() + PAD; z0, z1 = Q[:, 1].min() - PAD, Q[:, 1].max() + PAD
nx, nz = int((x1 - x0) / CELL) + 1, int((z1 - z0) / CELL) + 1
GX, GZ = np.meshgrid(x0 + np.arange(nx) * CELL, z0 + np.arange(nz) * CELL)
gh = dem_at(lat_of(GZ), lon_of(GX)) - BASE
data = {'origin': [float(lat0), float(lon0)], 'base': BASE, 'start': int(round(EXT / L * (n - 1))), 'goal': n - 1,
        'route': [[round(float(q[0]), 2), round(float(y[i] - BASE), 3), round(float(q[1]), 2)] for i, q in enumerate(Q)],
        'ground': {'x0': round(float(x0), 2), 'z0': round(float(z0), 2), 'cell': CELL, 'nx': nx, 'nz': nz,
                   'h': [round(float(v), 1) for v in gh.ravel()]}}
if OUT.exists():   # あとで塗って決めた場所(草原・ガードレールなど)は残す
    old = json.loads(OUT.read_text())
    for key in ('meadows', 'bushes', 'parkings', 'toilets', 'railL', 'railR', 'aprons', 'woods', 'parkGuides', 'signs', 'sands', 'extraRails', 'decks'):
        if key in old: data[key] = old[key]
OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
print('スタート', data['start'], 'ゴール', data['goal'], ' 長さ', round(L), 'm  点', n, ' 高さ', round(y[0]), '→', round(y[-1]), ' 基準', BASE, ' 地面', nx, 'x', nz, OUT.stat().st_size // 1024, 'KB')
