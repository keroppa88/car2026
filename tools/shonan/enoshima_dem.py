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
# 道路の所は横方向に水平にする: 道の中心線の高さ(道に沿ってならした値)を、道幅の升目へそのまま入れる
city = json.load(open('map/shonan-city.json'))
def road_w(r): return 4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25
def hat(x, z):
    fi, fj = (x - x0) / C, (z - z0) / C
    if fi < 0 or fj < 0 or fi >= W - 1 or fj >= H - 1: return 0.0
    i, j = int(fi), int(fj); u, v = fi - i, fj - j
    return (h[j, i] * (1 - u) + h[j, i + 1] * u) * (1 - v) + (h[j + 1, i] * (1 - u) + h[j + 1, i + 1] * u) * v
best = np.full((H, W), np.inf); newh = h.copy(); nroad = 0
for r in city['roads']:
    p = r['pts']
    if not any(x0 <= x <= x1 and z0 <= z <= z1 for x, z in p): continue
    # 2m ごとの中心線と高さ
    pts = []
    for (ax, az), (bx, bz) in zip(p, p[1:]):
        k = max(1, int(math.hypot(bx - ax, bz - az) // 2))
        pts += [(ax + (bx - ax) * q / k, az + (bz - az) * q / k) for q in range(k)]
    pts.append(tuple(p[-1]))
    hs = np.array([hat(x, z) for x, z in pts])
    if hs.max() <= 0: continue
    nroad += 1
    if len(hs) >= 5: hs = np.convolve(np.pad(hs, 3, mode='edge'), np.ones(7) / 7, mode='valid')   # 道に沿ってならす
    half = road_w(r) / 2 + 1.5
    for (x, z), hv in zip(pts, hs):
        i0, i1 = max(0, int((x - half - x0) / C)), min(W - 1, int((x + half - x0) / C) + 1)
        j0, j1 = max(0, int((z - half - z0) / C)), min(H - 1, int((z + half - z0) / C) + 1)
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                d = math.hypot(x0 + i * C - x, z0 + j * C - z)
                if d <= half and d < best[j, i] and h[j, i] > 0:
                    best[j, i] = d; newh[j, i] = hv
h = newh
print('水平にした道路', nroad)
print('三角形', n, '升目', W, 'x', H, '最高', round(float(h.max()), 1), 'm')
json.dump({'x0': round(x0, 2), 'z0': round(z0, 2), 'c': C, 'w': W, 'h': H, 'd': [int(round(v * 10)) for v in h.flatten()]},
          open('map/shonan-terrain.json', 'w'), separators=(',', ':'))
