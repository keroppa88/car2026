"""榛名山(県道33号 渋川松井田線): 国土地理院 基盤地図情報 数値標高モデル 5m(DEM5A)の GML を、緯度経度の升目にまとめて
tools/haruna/haruna_dem.npz にする。GML は大きいのでリポジトリには入れない。
python3 tools/haruna/make_dem.py FG-GML-5438-57-*-DEM5A-*.xml FG-GML-5438-67-*-DEM5A-*.xml ...
升目は 3 次メッシュと同じ: 1 区画 = 緯度 30 秒 × 経度 45 秒 を 150 × 225(約 5.5m × 5.6m)。北が上で並んでいる(+x-y)
"""
import re, sys
from pathlib import Path
import numpy as np
OUT = Path(__file__).resolve().parent / 'haruna_dem.npz'
S, N, W, E = 36.462, 36.515, 138.870, 138.935          # コースのまわり
DLAT, DLON = 30 / 3600 / 150, 45 / 3600 / 225
ny, nx = round((N - S) / DLAT), round((E - W) / DLON)
h = np.full((ny, nx), np.nan, np.float32)
for f in sys.argv[1:]:
    s = open(f, encoding='utf-8').read()
    lo = list(map(float, re.search(r'<gml:lowerCorner>([^<]+)', s).group(1).split()))
    hi = list(map(float, re.search(r'<gml:upperCorner>([^<]+)', s).group(1).split()))
    gx, gy = [int(v) + 1 for v in re.search(r'<gml:high>([^<]+)', s).group(1).split()]
    sx, sy = map(int, re.search(r'<gml:startPoint>([^<]+)', s).group(1).split())
    vals = np.array([float(t.split(',')[1]) for t in s[s.index('<gml:tupleList>') + 15:s.index('</gml:tupleList>')].split()], np.float32)
    g = np.full(gx * gy, np.nan, np.float32); st = sy * gx + sx; g[st:st + len(vals)] = vals
    g = g.reshape(gy, gx)[::-1]               # 南が先(行 0 = 南)
    g[g < -9000] = np.nan
    r0, c0 = round((lo[0] - S) / DLAT), round((lo[1] - W) / DLON)
    rs, cs = max(0, r0), max(0, c0); re_, ce = min(ny, r0 + gy), min(nx, c0 + gx)
    if rs < re_ and cs < ce: h[rs:re_, cs:ce] = g[rs - r0:re_ - r0, cs - c0:ce - c0]
# 升目の中心の緯度経度にそろえる(半升ずらす)
np.savez_compressed(OUT, h=h, lat_min=S + DLAT / 2, lon_min=W + DLON / 2, dlat=DLAT, dlon=DLON)
print(h.shape, np.nanmin(h), np.nanmax(h), 'なし', round(float(np.isnan(h).mean()), 4))
