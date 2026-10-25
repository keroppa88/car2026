# 江の島だけ高低差を付ける: PLATEAU の地形(dem, TIN)から 2m の升目の高さを作る → map/shonan-terrain.json
# 高さ = 標高 - BASE(海沿いの道の標高)。島の外は 0。
import sys, json, math
import numpy as np
from lxml import etree
BASE = 3.0
LAT0, LAT1, LON0, LON1 = 35.2955, 35.3035, 139.4720, 139.4890   # 江の島のまわり
area = json.load(open('tools/shonan/area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xz(la, lo): return ((lo - lon0) * KX, -(la - lat0) * KZ)
x0, z1 = xz(LAT0, LON0); x1, z0 = xz(LAT1, LON1)
C = 2.0
W, H = int((x1 - x0) / C) + 1, int((z1 - z0) / C) + 1
grid = np.full((H, W), np.nan)
G = '{http://www.opengis.net/gml}'
n = 0
for _, e in etree.iterparse(sys.argv[1], tag=G + 'Triangle', huge_tree=True):
    v = [float(t) for t in e.find(f'.//{G}posList').text.split()]
    e.clear()
    lats, lons = v[0:9:3], v[1:9:3]
    if max(lats) < LAT0 or min(lats) > LAT1 or max(lons) < LON0 or min(lons) > LON1: continue
    P = [xz(v[i], v[i + 1]) + (v[i + 2],) for i in (0, 3, 6)]
    (ax, az, ah), (bx, bz, bh), (cx, cz, ch) = P
    i0, i1 = max(0, int((min(ax, bx, cx) - x0) / C)), min(W - 1, int((max(ax, bx, cx) - x0) / C) + 1)
    j0, j1 = max(0, int((min(az, bz, cz) - z0) / C)), min(H - 1, int((max(az, bz, cz) - z0) / C) + 1)
    d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if abs(d) < 1e-9: continue
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            px, pz = x0 + i * C, z0 + j * C
            l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / d
            l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / d
            l3 = 1 - l1 - l2
            if l1 >= -1e-6 and l2 >= -1e-6 and l3 >= -1e-6: grid[j, i] = l1 * ah + l2 * bh + l3 * ch
    n += 1
h = np.nan_to_num(grid, nan=0.0) - BASE
h[h < 0] = 0
# 本土側(島の北の砂浜・橋のたもと)は平らに: 江の島弁天橋の北端より北は 0
north_cut = xz(35.3010, LON0)[1]
for j in range(H):
    if z0 + j * C < north_cut: h[j, :] = 0
print('三角形', n, '升目', W, 'x', H, '最高', round(float(h.max()), 1), 'm')
json.dump({'x0': round(x0, 2), 'z0': round(z0, 2), 'c': C, 'w': W, 'h': H, 'd': [int(round(v * 10)) for v in h.flatten()]},
          open('map/shonan-terrain.json', 'w'), separators=(',', ':'))
