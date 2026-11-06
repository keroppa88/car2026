"""富士スピードウェイ: 指示の絵(tools/fuji/paint/kerb_paint.png)を反映する。
絵は真上からの描画(カメラ 高さ 1500m・(0, 30) の真上・画角 60°、1400x1000)に塗ったもの。
  ピンク = 縁石のある所(それ以外の縁は白線だけ)
  濃いグレー(コースの外に描いた道) = 分かれ道(ピットレーン、ダンロップの近道)
→ map/fuji-course.json の kerbL / kerbR(1 = 縁石あり)、branches = [{pts: [[x, z], ...], w}]
python3 tools/fuji/apply_kerb_paint.py   (make_fuji.py のあとに)
"""
import json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
from skimage.morphology import skeletonize
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'
d = json.loads(F.read_text()); route = d['route']; n = len(route)
I = cv2.imread(str(ROOT / 'tools/fuji/paint/kerb_paint.png')).astype(int); b, g, r = I[..., 0], I[..., 1], I[..., 2]
H, W = I.shape[:2]; f = (H / 2) / math.tan(math.radians(30)); CAM = (0.0, 1500.0, 30.0)
px = lambda x, y, z: (W / 2 + f * (x - CAM[0]) / (CAM[1] - y), H / 2 + f * (z - CAM[2]) / (CAM[1] - y))
R = np.array([[p[0], p[2]] for p in route]); Y = np.array([p[1] for p in route])
NRM = []
for i in range(n):
    a, c = R[(i - 2) % n], R[(i + 2) % n]; dx, dz = c - a; l = math.hypot(dx, dz); NRM.append((dz / l, -dx / l))
# 縁石
pink = ((r > 200) & (b > 170) & (g < 200) & (r - g > 40)).astype(np.uint8)
# コースを横切る線(-15〜+15m)の上のピンクを数え、どちら側に寄っているかで縁石の側を決める(線が太くて両方の縁にかかるので)
pl, pr = np.zeros(n), np.zeros(n)
for i in range(n):
    for o in np.arange(-15, 15.01, 0.5):
        if abs(o) < 2: continue
        u, w = px(R[i, 0] + NRM[i][0] * o, Y[i], R[i, 1] + NRM[i][1] * o); u, w = int(round(u)), int(round(w))
        if 0 <= u < W and 0 <= w < H and pink[w, u]:
            if o > 0: pl[i] += 1
            else: pr[i] += 1
pl, pr = ndimage.uniform_filter1d(pl, 5, mode='wrap'), ndimage.uniform_filter1d(pr, 5, mode='wrap')
tot = pl + pr
for side, a_, b_ in (('L', pl, pr), ('R', pr, pl)):
    m = (tot > 2.5) & (a_ > 0.6 * tot)   # はっきりこちら側に寄っている所だけ
    m = ndimage.binary_opening(ndimage.binary_closing(m, np.ones(5)), np.ones(3))
    d['kerb' + side] = m.astype(int).tolist(); print('縁石', side, int(m.sum()), '/', n)
# 分かれ道
dark = ((abs(r - 72) < 14) & (abs(g - 72) < 14) & (abs(b - 74) < 14)).astype(np.uint8)
road = np.zeros_like(dark); pts = np.array([px(p[0], p[1], p[2]) for p in route], np.int32)
cv2.polylines(road, [pts], True, 1, int(2 * 11 / 1.73))
far = cv2.morphologyEx(dark & (1 - road), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
nl, lab, st, _ = cv2.connectedComponentsWithStats(far)
def to_world(u, v):
    y = 40.0
    for _ in range(3):
        x = CAM[0] + (u - W / 2) * (CAM[1] - y) / f; z = CAM[2] + (v - H / 2) * (CAM[1] - y) / f
        y = Y[np.argmin(((R - [x, z]) ** 2).sum(1))]
    return x, z
d['branches'] = []
for k in range(1, nl):
    if st[k, 4] < 100: continue
    mk = lab == k
    sk = skeletonize(cv2.morphologyEx(mk.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)).astype(bool)); ys, xs = np.nonzero(sk); P = list(zip(xs.tolist(), ys.tolist())); Sset = set(P)
    nb = lambda p: [(p[0] + a, p[1] + c) for a in (-1, 0, 1) for c in (-1, 0, 1) if (a or c) and (p[0] + a, p[1] + c) in Sset]
    def bfs(s):
        prev = {s: None}; q = [s]
        for p in q:
            for m in nb(p):
                if m not in prev: prev[m] = p; q.append(m)
        return q[-1], prev
    ends = [p for p in P if len(nb(p)) == 1] or P[:1]
    a, _ = bfs(ends[0]); z_, prev = bfs(a); path = []; p = z_
    while p: path.append(p); p = prev[p]
    wpts = [to_world(u + 0.5, v + 0.5) for u, v in path[::3]]
    # 本コースから離れている部分だけ残し、両端は本コースの点につなぐ
    dist = [np.sqrt(((R - q) ** 2).sum(1)).min() for q in wpts]
    line = wpts
    j0 = int(np.argmin(((R - line[0]) ** 2).sum(1))); j1 = int(np.argmin(((R - line[-1]) ** 2).sum(1)))
    line = [tuple(R[j0])] + line + [tuple(R[j1])]   # 両端は本コースの点につなぐ
    from shapely.geometry import LineString
    L = LineString(line).simplify(1.0)
    wdt = float(np.median(ndimage.distance_transform_edt(mk)[sk & mk])) * 2 * 1.73 if (sk & mk).any() else 8
    wdt = float(np.clip(wdt, 8, 12))
    d['branches'].append({'pts': [[round(x, 2), round(z, 2)] for x, z in L.coords], 'w': round(wdt, 1), 'from': j0, 'to': j1})
    print('分かれ道', round(L.length), 'm 幅', round(wdt, 1), 'm  本コースの点', j0, '→', j1)
F.write_text(json.dumps(d, separators=(',', ':')))
