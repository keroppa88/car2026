"""富士スピードウェイ: 書き込み用の高精細な真上図(北が上)を作る → tools/fuji/paint/fuji_base.png
1画素 = 0.5m。左上の角の地図座標と縮尺は fuji_base.json(書き込んだ絵を地図へ戻すときに使う)。
描くもの: 路面・白線・縁石、今のランオフ(薄いグレー)、建物(白)、等高線(2m ごと、10m ごとに太く)、100m ごとの方眼と座標。
python3 tools/fuji/make_paint_base.py
"""
import json, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; OUT = ROOT / 'tools/fuji/paint'; OUT.mkdir(parents=True, exist_ok=True)
d = json.loads((ROOT / 'map/fuji-course.json').read_text())
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R)
PX = 0.5; M = 80
x0, z0 = R[:, 0].min() - M, R[:, 1].min() - M; x1, z1 = R[:, 0].max() + M, R[:, 1].max() + M
W, H = int((x1 - x0) / PX), int((z1 - z0) / PX)
P = lambda x, z: (int(round((x - x0) / PX)), int(round((z - z0) / PX)))
img = np.full((H, W, 3), (120, 170, 128), np.uint8)   # 芝(BGR)
# 地面の高さ → 等高線
G = d['ground']; gh = np.array(G['h'], float).reshape(G['nz'], G['nx']) / 10
gx = (np.arange(W) * PX + x0 - G['x0']) / G['cell']; gz = (np.arange(H) * PX + z0 - G['z0']) / G['cell']
from scipy import ndimage
hh = ndimage.map_coordinates(gh, np.meshgrid(gz, gx, indexing='ij'), order=1, mode='nearest')
for step, col, th in ((2, (105, 150, 112), 1), (10, (80, 120, 88), 2)):
    q = np.floor(hh / step); edge = (np.diff(q, axis=0, prepend=q[:1]) != 0) | (np.diff(q, axis=1, prepend=q[:, :1]) != 0)
    if th > 1: edge = cv2.dilate(edge.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0
    img[edge] = col
def normals(i):
    a, b = R[(i - 2) % n], R[(i + 2) % n]; dx, dz = b - a; l = math.hypot(dx, dz); return dz / l, -dx / l
def band(off0, off1, col, side_runs=None):
    for i in range(n):
        j = (i + 1) % n; poly = []
        for k, sgn in ((i, 1), (j, 1), (j, -1), (i, -1)):
            nx, nz = normals(k)
            o = (off1 if sgn > 0 else off0) if side_runs is None else side_runs(k, sgn)
            poly.append(P(R[k, 0] + nx * o, R[k, 1] + nz * o))
        cv2.fillConvexPoly(img, np.array(poly, np.int32), col, lineType=cv2.LINE_AA)
HALF = 7.5
band(None, None, (150, 150, 148), lambda k, s: (HALF + 1.2 + d['runL'][k]) if s > 0 else (HALF + 1.2))   # 今のランオフ(左)
band(None, None, (150, 150, 148), lambda k, s: -(HALF + 1.2) if s > 0 else -(HALF + 1.2 + d['runR'][k]))  # 右
for i in range(n):   # 縁石(赤白)
    col = (60, 60, 200) if (i // 1) % 2 else (235, 235, 235)
    for s in (1, -1):
        j = (i + 1) % n; a, b = normals(i), normals(j)
        poly = [P(R[i, 0] + a[0] * s * HALF, R[i, 1] + a[1] * s * HALF), P(R[j, 0] + b[0] * s * HALF, R[j, 1] + b[1] * s * HALF),
                P(R[j, 0] + b[0] * s * (HALF + 1.2), R[j, 1] + b[1] * s * (HALF + 1.2)), P(R[i, 0] + a[0] * s * (HALF + 1.2), R[i, 1] + a[1] * s * (HALF + 1.2))]
        cv2.fillConvexPoly(img, np.array(poly, np.int32), col, lineType=cv2.LINE_AA)
band(-HALF, HALF, (72, 70, 68))   # 路面
pts = np.array([P(*q) for q in R], np.int32)
for s in (1, -1):
    e = np.array([P(R[i, 0] + normals(i)[0] * s * (HALF - 0.45), R[i, 1] + normals(i)[1] * s * (HALF - 0.45)) for i in range(n)], np.int32)
    cv2.polylines(img, [e], True, (235, 235, 235), 1, cv2.LINE_AA)
for b in d['buildings']:
    cv2.fillPoly(img, [np.array([P(*q) for q in b['p']], np.int32)], (245, 245, 245), cv2.LINE_AA)
    cv2.polylines(img, [np.array([P(*q) for q in b['p']], np.int32)], True, (150, 150, 150), 1, cv2.LINE_AA)
# 方眼(100m)と座標
for x in range(int(math.ceil(x0 / 100)) * 100, int(x1), 100):
    u = P(x, 0)[0]; cv2.line(img, (u, 0), (u, H), (210, 210, 210), 1); cv2.putText(img, str(x), (u + 4, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 40), 2, cv2.LINE_AA)
for z in range(int(math.ceil(z0 / 100)) * 100, int(z1), 100):
    v = P(0, z)[1]; cv2.line(img, (0, v), (W, v), (210, 210, 210), 1); cv2.putText(img, str(z), (6, v - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 40, 40), 2, cv2.LINE_AA)
st = R[d['start']]; cv2.putText(img, 'START', (P(*st)[0] + 20, P(*st)[1] - 20), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 220), 3, cv2.LINE_AA)
cv2.putText(img, 'N', (W - 60, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 0), 3, cv2.LINE_AA); cv2.arrowedLine(img, (W - 48, 140), (W - 48, 75), (0, 0, 0), 3)
cv2.imwrite(str(OUT / 'fuji_base.png'), img)
(OUT / 'fuji_base.json').write_text(json.dumps({'x0': x0, 'z0': z0, 'px': PX, 'W': W, 'H': H}))
print(W, H, 'px  1px =', PX, 'm')
