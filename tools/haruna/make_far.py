"""榛名山: 遠景の地形(map/haruna-course.json の far)。コースのまわり 東西 24km × 南北 24km を 80m 升目で。
国土地理院 DEM5A がある所はその高さ(升目の中の平均)。無い所は、近くの DEM の高さを、離れるほど地域のならした高さへ寄せ、
主な山(榛名富士・相馬山・掃部ヶ岳・赤城山・子持山・小野子山・浅間山・妙義山など)の高さと位置で、なだらかな山を足す(大まか)。
python3 tools/haruna/make_far.py DEM5A の xml ... [基本項目の Cntr(等高線)・ElevPt(標高点)・WA(水面)の xml ...]
DEM の無い所は、等高線と標高点があればそれを補間した高さ(10m おきの線なので大まか)。WA の大きな水面(榛名湖)は平らにして水の色
"""
import json, math, re, sys
from pathlib import Path
import numpy as np
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]
CJ = ROOT / 'map/haruna-course.json'; d = json.loads(CJ.read_text())
lat0, lon0 = d['origin']; BASE = d['base']; KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
CELL, HALF = 80.0, 12000.0
xs = np.arange(-HALF, HALF + 1, CELL) + 1000; zs = np.arange(-HALF, HALF + 1, CELL) - 1500   # コースの真ん中あたりを中心に
nx, nz = len(xs), len(zs)
LON = lon0 + xs / KX; LAT = lat0 - zs / KZ
acc = np.zeros((nz, nx)); cnt = np.zeros((nz, nx))
DEMS = [f for f in sys.argv[1:] if 'DEM' in f]; CN = [f for f in sys.argv[1:] if '-Cntr-' in f or '-ElevPt-' in f]; WAS = [f for f in sys.argv[1:] if '-WA-' in f]
for f in DEMS:
    s = open(f, encoding='utf-8').read()
    lo = list(map(float, re.search(r'<gml:lowerCorner>([^<]+)', s).group(1).split())); hi = list(map(float, re.search(r'<gml:upperCorner>([^<]+)', s).group(1).split()))
    gx, gy = [int(v) + 1 for v in re.search(r'<gml:high>([^<]+)', s).group(1).split()]; sx, sy = map(int, re.search(r'<gml:startPoint>([^<]+)', s).group(1).split())
    vals = np.array([float(t.split(',')[1]) for t in s[s.index('<gml:tupleList>') + 15:s.index('</gml:tupleList>')].split()])
    g = np.full(gx * gy, np.nan); st = sy * gx + sx; g[st:st + len(vals)] = vals; g = g.reshape(gy, gx); g[g < -9000] = np.nan
    la = hi[0] - (np.arange(gy) + 0.5) * (hi[0] - lo[0]) / gy; lo_ = lo[1] + (np.arange(gx) + 0.5) * (hi[1] - lo[1]) / gx
    LA, LO = np.meshgrid(la, lo_, indexing='ij'); ok = ~np.isnan(g)
    X = (LO[ok] - lon0) * KX; Z = -(LA[ok] - lat0) * KZ
    ix = np.round((X - xs[0]) / CELL).astype(int); iz = np.round((Z - zs[0]) / CELL).astype(int); m = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    np.add.at(acc, (iz[m], ix[m]), g[ok][m]); np.add.at(cnt, (iz[m], ix[m]), 1)
have = cnt > 0; h = np.where(have, acc / np.maximum(cnt, 1), np.nan)
# 等高線・標高点から(DEM の無い所)
XX, ZZ = np.meshgrid(xs, zs)
if CN:
    from scipy.interpolate import griddata
    P = []
    for f in CN:
        t = open(f, encoding='utf-8').read()
        for m in re.finditer(r'<gml:posList>([^<]*)</gml:posList>.*?<alti>([^<]+)</alti>', t, re.S):
            a = np.array(m.group(1).split(), float).reshape(-1, 2)[::3]; P.append(np.c_[a, np.full(len(a), float(m.group(2)))])
        for m in re.finditer(r'<gml:pos>([^<]*)</gml:pos>.*?<alti>([^<]+)</alti>', t, re.S):
            a = np.array(m.group(1).split(), float); P.append(np.array([[a[0], a[1], float(m.group(2))]]))
    P = np.concatenate(P); X = (P[:, 1] - lon0) * KX; Z = -(P[:, 0] - lat0) * KZ
    g = griddata(np.c_[X, Z], P[:, 2], (XX, ZZ), method='linear')
    use = ~have & ~np.isnan(g); h[use] = g[use]; have = have | use
    print('等高線の点', len(P))
# 無い所: いちばん近い DEM の高さを、離れるほど地域の高さへ(西は榛名の外輪 900m、東は平野 250m)
dist, (iz_, ix_) = ndimage.distance_transform_edt(~have, return_indices=True); near = h[iz_, ix_]
region = np.interp(XX, [-6000, 6000], [900, 250])
k = np.clip(dist * CELL / 3000, 0, 1); fill = near * (1 - k) + region * k
# 主な山: [名前, 緯度, 経度, 標高 m, 裾の広さ m]
PEAKS = [['榛名富士', 36.4767, 138.8578, 1391, 700], ['相馬山', 36.4967, 138.8506, 1411, 600], ['掃部ヶ岳', 36.4686, 138.8403, 1449, 900],
         ['二ツ岳', 36.4975, 138.8711, 1343, 500], ['鷹ノ巣山', 36.4560, 138.8660, 1185, 600], ['烏帽子ヶ岳', 36.4620, 138.8530, 1363, 500],
         ['子持山', 36.5806, 138.9622, 1296, 1800], ['小野子山', 36.6028, 138.9314, 1208, 1800],
         ['赤城山 黒檜山', 36.5600, 139.1933, 1828, 6000], ['浅間山', 36.4064, 138.5231, 2568, 6000], ['妙義山', 36.2950, 138.7480, 1104, 2500],
         ['谷川岳', 36.8372, 138.9300, 1977, 6000], ['武尊山', 36.8044, 139.1328, 2158, 6000], ['草津白根山', 36.6175, 138.5281, 2160, 6000]]
for name, la, lo, el, w in PEAKS:
    px, pz = (lo - lon0) * KX, -(la - lat0) * KZ
    bump = np.exp(-((XX - px) ** 2 + (ZZ - pz) ** 2) / (2 * w * w))
    fill = np.maximum(fill, fill + (el - fill) * bump * 0.95) if True else fill
h = np.where(have, h, fill)
h = ndimage.gaussian_filter(h, 0.6)
# 水面(WA): 1 km² ほどより大きいものだけ(榛名湖)。中を平らに(ふちの高さのいちばん低い所)
water = []
if WAS:
    from matplotlib.path import Path as MPath
    for f in WAS:
        t = open(f, encoding='utf-8').read()
        for m in re.finditer(r'<gml:exterior>.*?<gml:posList>([^<]*)</gml:posList>', t, re.S):
            a = np.array(m.group(1).split(), float).reshape(-1, 2); X = (a[:, 1] - lon0) * KX; Z = -(a[:, 0] - lat0) * KZ
            area = 0.5 * abs(np.dot(X, np.roll(Z, 1)) - np.dot(Z, np.roll(X, 1)))
            if area < 300000: continue
            inside = MPath(np.c_[X, Z]).contains_points(np.c_[XX.ravel(), ZZ.ravel()]).reshape(XX.shape)
            if not inside.any(): continue
            ring = ndimage.binary_dilation(inside) & ~inside; lvl = float(np.percentile(h[ring], 10)); h[inside] = lvl - 2
            water.append({'pts': [[round(float(x), 1), round(float(z), 1)] for x, z in zip(X[::2], Z[::2])], 'y': round(lvl - BASE, 1)})
    print('水面', len(water), [round(w['y'] + BASE) for w in water])
d['far'] = {'x0': float(xs[0]), 'z0': float(zs[0]), 'cell': CELL, 'nx': nx, 'nz': nz, 'h': [round(float(v - BASE), 1) for v in h.ravel()],
            'water': water, 'peaks': [[n, round((lo - lon0) * KX), round(-(la - lat0) * KZ), round(el - BASE)] for n, la, lo, el, _ in PEAKS]}
CJ.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print(nx, nz, 'DEM の所', round(float(have.mean()) * 100), '%', '高さ', round(float(h.min())), '〜', round(float(h.max())))
