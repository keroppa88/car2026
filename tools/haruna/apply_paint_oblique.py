"""榛名山: 斜めから見た画面に塗った絵を入れる(2026-11-20 19:17 の絵: くだりのスタート近くの拡張)。
画面と地面(x, z)の対応は、駐車の列の両端・看板・拡張の角で当てて、白線に合わせて直した射影(tools/haruna/paint/homog_oblique1.json)。
  赤線   = その所のガードレールを外す               → railL / railR を 0
  黄緑線 = 緑地の補充(道と拡張の間を芝生の帯にする)   → meadows に帯を足す(路肩の外 〜 線の外側 1m)
  オレンジ線 = アスファルトと緑の境目を砂でぼかす    → sandEdges(拡張の外まわりの辺 [x1, z1, x2, z2])
python3 tools/haruna/apply_paint_oblique.py 絵 射影.json
(黄緑の帯は足していくので、やり直すときは map/haruna-course.json を前の状態に戻してから)
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]
paint, hjson = sys.argv[1:3]
CJ = ROOT / 'map/haruna-course.json'; data = json.loads(CJ.read_text())
Hm = np.array(json.load(open(hjson))['H'])
im = cv2.imread(paint).astype(int); B, G, Rr = im[..., 0], im[..., 1], im[..., 2]
def big(m, area=100):
    k, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8)); keep = np.zeros_like(m)
    for j in range(1, k):
        if st[j, cv2.CC_STAT_AREA] >= area: keep |= lab == j
    return cv2.dilate(keep.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
red = big((Rr > 200) & (G < 60) & (B < 70)); lime = big((Rr > 150) & (Rr < 215) & (G > 200) & (B < 80)); orange = big((Rr > 220) & (G > 140) & (G < 215) & (B < 60))
P = lambda X: (lambda q: q[:, :2] / q[:, 2:3])(np.c_[np.asarray(X, float), np.ones(len(X))] @ Hm.T)
hit = lambda m, uv: [bool(0 <= int(u) < m.shape[1] and 0 <= int(v) < m.shape[0] and m[int(v), int(u)]) for u, v in uv]
R = np.array(data['route']); n = len(R); EDGE = 3.6 + 0.9
out = {'rail0': [0, 0], 'meadow': 0, 'sand': 0}
strips = {1: [], -1: []}
for i in range(n):
    a, b = R[max(0, i - 1)], R[min(n - 1, i + 1)]; dx, dz = b[0] - a[0], b[2] - a[2]; l = math.hypot(dx, dz) or 1; nx, nz = dz / l, -dx / l
    for side in (1, -1):
        offs = np.arange(2.5, 7.6, 0.3); pts = [[R[i, 0] + nx * side * o, R[i, 2] + nz * side * o] for o in offs]
        if any(hit(red, P(pts))): data['railL' if side > 0 else 'railR'][i] = 0; out['rail0'][0 if side > 0 else 1] += 1
        offs = np.arange(3.0, 10.0, 0.3); pts = [[R[i, 0] + nx * side * o, R[i, 2] + nz * side * o] for o in offs]
        h = [o for o, f in zip(offs, hit(lime, P(pts))) if f]
        if h: strips[side].append((i, max(h)))
# 黄緑: 続いている点ごとに 1 本の帯(路肩の外 EDGE 〜 線の外側 +1m)
for side, lst in strips.items():
    runs = []
    for i, o in lst:
        if runs and i - runs[-1][-1][0] <= 2: runs[-1].append((i, o))
        else: runs.append([(i, o)])
    for run in runs:
        if len(run) < 3: continue
        w = max(EDGE + 1.5, float(np.median([o for _, o in run])) + 1.0)
        inner, outer = [], []
        for i, _ in run:
            a, b = R[max(0, i - 1)], R[min(n - 1, i + 1)]; dx, dz = b[0] - a[0], b[2] - a[2]; l = math.hypot(dx, dz) or 1; nx, nz = dz / l, -dx / l
            inner.append([round(R[i, 0] + nx * side * (EDGE - 0.1), 2), round(R[i, 2] + nz * side * (EDGE - 0.1), 2)])
            outer.append([round(R[i, 0] + nx * side * w, 2), round(R[i, 2] + nz * side * w, 2)])
        data.setdefault('meadows', []).append(inner + outer[::-1]); out['meadow'] += 1
# オレンジ: 拡張の外まわりの辺のうち、線が近くを通るもの
sand = []
for A in data.get('aprons', []):
    for k in range(len(A)):
        p, q = A[k], A[(k + 1) % len(A)]
        mids = [[p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] for t in (0.25, 0.5, 0.75)]
        uv = P(mids); near = 0
        for u, v in uv:
            u, v = int(u), int(v)
            if 0 <= u < orange.shape[1] and 0 <= v < orange.shape[0] and orange[max(0, v - 9):v + 10, max(0, u - 9):u + 10].any(): near += 1
        m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
        if near >= 2 and np.hypot(R[:, 0] - m[0], R[:, 2] - m[1]).min() > EDGE + 2: sand.append([p[0], p[1], q[0], q[1]])   # 道ぎわの辺は除く
data['sandEdges'] = sand; out['sand'] = len(sand)
CJ.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
print(out)
