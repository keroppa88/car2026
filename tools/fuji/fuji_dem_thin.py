"""富士スピードウェイ: PLATEAU 地形(dem LOD3)の GML 8 ファイルを間引いて、2m 間隔の高さの表にする。

使い方(Windows のコマンドプロンプト / PowerShell):
  1. numpy を入れる(初回だけ):   pip install numpy
  2. この .py を、8つの GML と同じフォルダに置く
  3. そのフォルダで実行:           python fuji_dem_thin.py
  → 同じフォルダに fuji_dem.npz ができる(数MB)。これを送る。

読むファイル(このフォルダにあるものだけ読む):
  533807334 533807343 533807432 533807441 533807442 533807443 533807444 533807542 (_dem_6697_op.gml)
"""
import glob
import math
import os
import sys
import time
import xml.etree.ElementTree as ET

import numpy as np

CODES = ['533807334', '533807343', '533807432', '533807441', '533807442', '533807443', '533807444', '533807542']

# 範囲: 本コースのまわり + 100m の余白(緯度・経度)
LAT_MIN, LAT_MAX = 35.36381, 35.37725
LON_MIN, LON_MAX = 138.91889, 138.93493
STEP = 2.0   # 何 m ごとの升目にするか

KX = math.cos(math.radians((LAT_MIN + LAT_MAX) / 2)) * 111320.0   # 経度 1度 = 何 m
KZ = 110574.0                                                    # 緯度 1度 = 何 m
DLAT, DLON = STEP / KZ, STEP / KX
NY = int(math.ceil((LAT_MAX - LAT_MIN) / DLAT)) + 1
NX = int(math.ceil((LON_MAX - LON_MIN) / DLON)) + 1
total = np.zeros(NY * NX, dtype=np.float64)
count = np.zeros(NY * NX, dtype=np.int32)


def add_points(a):
    """a: (n, 3) の [緯度, 経度, 高さ]。範囲の中の点を升目に足す"""
    lat, lon, h = a[:, 0], a[:, 1], a[:, 2]
    ok = (lat >= LAT_MIN) & (lat <= LAT_MAX) & (lon >= LON_MIN) & (lon <= LON_MAX)
    if not ok.any():
        return 0
    iy = np.round((lat[ok] - LAT_MIN) / DLAT).astype(np.int64)
    ix = np.round((lon[ok] - LON_MIN) / DLON).astype(np.int64)
    k = iy * NX + ix
    np.add.at(total, k, h[ok])
    np.add.at(count, k, 1)
    return int(ok.sum())


here = os.path.dirname(os.path.abspath(__file__))
files = []
for c in CODES:
    f = glob.glob(os.path.join(here, c + '_dem_*.gml'))
    if f:
        files.append(f[0])
    else:
        print('見つからない:', c)
if not files:
    sys.exit('GML ファイルがありません。この .py を GML と同じフォルダに置いてください。')

for n, f in enumerate(files, 1):
    t0 = time.time()
    used = 0
    buf = []
    for _, el in ET.iterparse(f, events=('end',)):
        if el.tag.endswith('posList') or el.tag.endswith('}pos'):
            if el.text:
                buf.append(el.text)
                if len(buf) >= 20000:
                    a = np.array(' '.join(buf).split(), dtype=np.float64).reshape(-1, 3)
                    used += add_points(a)
                    buf = []
        el.clear()
    if buf:
        a = np.array(' '.join(buf).split(), dtype=np.float64).reshape(-1, 3)
        used += add_points(a)
    print(f'[{n}/{len(files)}] {os.path.basename(f)}  使った点 {used:,}  {time.time() - t0:.0f} 秒')

h = np.full(NY * NX, np.nan, dtype=np.float32)
has = count > 0
h[has] = (total[has] / count[has]).astype(np.float32)
h = h.reshape(NY, NX)
print(f'升目 {NX} x {NY}(横 x 縦)  高さのある升目 {has.mean() * 100:.1f}%  高さ {np.nanmin(h):.1f}〜{np.nanmax(h):.1f} m')

out = os.path.join(here, 'fuji_dem.npz')
np.savez_compressed(out, h=h, lat_min=LAT_MIN, lon_min=LON_MIN, dlat=DLAT, dlon=DLON, step=STEP)
print('できた:', out, f'{os.path.getsize(out) / 1e6:.1f} MB')
