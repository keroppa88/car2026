"""富士スピードウェイ: 真上からの空撮から、コースの両側のアスファルトの幅を測る。
空撮と地図の合わせ(回転・縮尺・位置)は、本コースの線を空撮のアスファルトに合わせて自動で求める。
空撮の画像はリポジトリに入れない(地図サービスの画像なので)。測った幅だけを残す。複数の空撮を渡すと平均する。
コースの点ごとに、縁石の外から外へ 0.5m ずつ見て、アスファルト(灰色)が続く所まで(3.5m までの切れ目は越える)。
→ map/fuji-course.json の runL / runR(左・右。進む向きの左が L)
python3 tools/fuji/measure_runoff.py 空撮1.png [空撮2.png ...]   (make_fuji.py のあとに)
"""
import json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'
import sys
from scipy import optimize
d = json.loads(F.read_text()); R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R)
HALF = 7.5 + 1.2
def measure(path):
    I = cv2.medianBlur(cv2.imread(path), 3).astype(int)
    lum, sat = I.mean(2), I.max(2) - I.min(2)
    raw = ((lum > 38) & (lum < 130) & (sat < 28)).astype(np.uint8)
    m = cv2.GaussianBlur(raw.astype(np.float32), (5, 5), 0); H, W = m.shape
    dt = ndimage.distance_transform_edt(1 - cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)))
    def proj(p):
        th, s, tx, ty = p; c, sn = math.cos(th), math.sin(th)
        return np.stack([(R[:, 0] * c - R[:, 1] * sn) * s + tx, (R[:, 0] * sn + R[:, 1] * c) * s + ty], 1)
    def cost(p):
        q = proj(p); pen = ((q[:, 0] < 0) | (q[:, 0] > W - 1) | (q[:, 1] < 0) | (q[:, 1] > H - 1)).mean() * 50
        return ndimage.map_coordinates(dt, [np.clip(q[:, 1], 0, H - 1), np.clip(q[:, 0], 0, W - 1)], order=1).mean() + pen
    best = None
    for th in np.radians(np.arange(0, 360, 3)):
        for s in np.geomspace(0.3, 3, 30):
            q = proj([th, s, 0, 0]); p = [th, s, W / 2 - q[:, 0].mean(), H / 2 - q[:, 1].mean()]
            if (q.max(0) - q.min(0) > [W, H]).any(): continue
            for ox in range(-150, 151, 30):
                for oy in range(-90, 91, 30):
                    pp = [p[0], p[1], p[2] + ox, p[3] + oy]; c = cost(pp)
                    if best is None or c < best[0]: best = (c, pp)
    r = optimize.minimize(cost, best[1], method='Nelder-Mead', options={'maxiter': 5000, 'xatol': 1e-5, 'fatol': 1e-4})
    th, s, tx, ty = r.x; c, sn = math.cos(th), math.sin(th)
    print(path, '合わせのずれ', round(r.fun, 2), 'px  1px =', round(1 / s, 2), 'm')
    def at(x, z):
        u, v = (x * c - z * sn) * s + tx, (x * sn + z * c) * s + ty
        if u < 0 or v < 0 or u > W - 1 or v > H - 1: return 0
        return ndimage.map_coordinates(m, [[v], [u]], order=1)[0]
    out = {'L': np.zeros(n), 'R': np.zeros(n)}
    for i in range(n):
        a, b = R[(i - 2) % n], R[(i + 2) % n]; dx, dz = b - a; l = math.hypot(dx, dz); nx, nz = dz / l, -dx / l
        for side, sg in (('L', 1), ('R', -1)):
            last, gap, dd = HALF, 0, HALF
            while dd < 90:
                dd += 0.5
                if at(R[i, 0] + sg * nx * dd, R[i, 1] + sg * nz * dd) > 0.5: last, gap = dd, 0
                else:
                    gap += 0.5
                    if gap > 3.5: break
            out[side][i] = last - HALF
    return out
res = [measure(p) for p in sys.argv[1:]]
out = {k: np.mean([r[k] for r in res], 0) for k in ('L', 'R')}
for k in out:
    w = ndimage.uniform_filter1d(ndimage.median_filter(out[k], size=9, mode='wrap'), 7, mode='wrap')
    d['run' + k] = np.clip(w, 1.5, 80).round(1).tolist()
F.write_text(json.dumps(d, separators=(',', ':')))
print('左', np.percentile(d['runL'], [5, 50, 95]), '右', np.percentile(d['runR'], [5, 50, 95]))
