"""赤城: PLATEAU 前橋市(2023)の地形 GML(543961_dem_6697_*_op.gml)を、緯度経度の升目(約 4m)に間引いて
tools/akagi/akagi_dem.npz にする。GML は大きいのでリポジトリには入れない。
python3 tools/akagi/make_dem.py GMLファイル...
"""
import re, sys
from pathlib import Path
import numpy as np
from scipy.interpolate import LinearNDInterpolator
OUT = Path(__file__).resolve().parent / 'akagi_dem.npz'
S, N, W, E = 36.515, 36.556, 139.138, 139.185      # 案内所〜姫百合駐車場のまわり
DLAT, DLON = 1 / 27000, 1 / 22000                   # 約 4.1m × 4.1m
pat = re.compile(rb'<gml:posList>([^<]*)</gml:posList>')
pts = []
for f in sys.argv[1:]:
    buf = b''
    with open(f, 'rb') as fh:
        while True:
            c = fh.read(1 << 26)
            if not c: break
            buf += c; k = buf.rfind(b'</gml:posList>')
            if k < 0: continue
            part, buf = buf[:k + 14], buf[k + 14:]
            a = np.array(b' '.join(m.group(1) for m in pat.finditer(part)).split(), dtype=np.float64).reshape(-1, 3)
            pts.append(np.unique(a[(a[:, 0] > S - 0.001) & (a[:, 0] < N + 0.001) & (a[:, 1] > W - 0.001) & (a[:, 1] < E + 0.001)], axis=0))
    print(f, sum(len(p) for p in pts), flush=True)
a = np.unique(np.concatenate(pts), axis=0)
la = np.arange(S, N, DLAT); lo = np.arange(W, E, DLON)
LA, LO = np.meshgrid(la, lo, indexing='ij')
h = LinearNDInterpolator(a[:, :2], a[:, 2])(LA, LO).astype(np.float32)
np.savez_compressed(OUT, h=h, lat_min=S, lon_min=W, dlat=DLAT, dlon=DLON)
print(h.shape, np.nanmin(h), np.nanmax(h), np.isnan(h).mean())
