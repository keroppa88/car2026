"""駐車場の絵(ゲームの斜めの画面に色を塗ったもの)を、駐車場の平面(高さ = 駐車場の高さ)に合わせる: 平面の射影変換 H(8 個)。
絵の中の駐車場(灰色のかたまり)の輪郭と中身に、駐車場の外形(map/akagi-course.json の parkings)が重なるように、
回転・倍率・縦のつぶれ・位置を総当たりで探し、そのあと H の 8 個を細かく合わせる。→ paint/homog_<絵>.json
python3 tools/akagi/fit_park_homog.py park_paint
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
name = sys.argv[1]
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); pk = np.array(data['parkings'][0]); cen = pk.mean(0)
im = cv2.imread(str(P / f'{name}.png')).astype(int); Hh, Ww = im.shape[:2]; b, g, r = im[..., 0], im[..., 1], im[..., 2]
grey = (abs(r - g) < 12) & (abs(g - b) < 12) & (g > 60) & (g < 120)
pink = (r > 200) & (g > 120) & (g < 200) & (b > 150) & (r - g > 25); orange = (r > 200) & (g > 120) & (g < 190) & (b < 80)
yellow = (r > 180) & (g > 150) & (b < 100); red = (r > 150) & (g < 110) & (b < 110); cyan = (b > 180) & (r < 200) & (g > 170)
lot = (grey | pink | orange | red | cyan).astype(np.uint8)
lot = cv2.morphologyEx(lot, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
nl, lab, st, _ = cv2.connectedComponentsWithStats(lot); k = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]); lot = (lab == k).astype(np.uint8)
ff = np.pad(lot, 1); fl = ff.copy(); cv2.floodFill(fl, None, (0, 0), 2); lot = (fl[1:-1, 1:-1] != 2).astype(np.uint8)   # 穴(車など)を埋める
ydil = cv2.dilate(yellow.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
roadm = cv2.dilate(((grey | ((abs(r - g) < 12) & (abs(g - b) < 12) & (g >= 120) & (g < 200))) & (lot == 0)).astype(np.uint8), np.ones((5, 5), np.uint8))   # 道(灰色と白線)。駐車場のかたまりの外
dt_road = ndimage.distance_transform_edt(roadm == 0)
R = np.array(data['route']); i0 = np.argmin(np.hypot(R[:, 0] - cen[0], R[:, 2] - cen[1])); PY = R[i0, 1]
near = (np.hypot(R[:, 0] - cen[0], R[:, 2] - cen[1]) < 90) & (abs(R[:, 1] - PY) < 8); C2 = R[near][:, [0, 2]]   # 駐車場のそばの道の中心線(ほぼ同じ高さの所)
outline = (lot - cv2.erode(lot, np.ones((3, 3), np.uint8))) > 0
dt_outline = ndimage.distance_transform_edt(~(outline | ydil))     # 外形の点 → 絵の輪郭(黄色の下はどこでもよい)
dt_inside = ndimage.distance_transform_edt(~((lot > 0) | ydil))    # 中の点 → 駐車場の中(黄色の下でもよい)
def dense(poly, step=1.0):
    out = []
    for a, bq in zip(poly, np.roll(poly, -1, 0)):
        L = np.hypot(*(bq - a)); kk = max(1, int(L / step))
        for t in range(kk): out.append(a + (bq - a) * t / kk)
    return np.array(out)
E = dense(pk)
xs, zs = np.meshgrid(np.arange(pk[:, 0].min(), pk[:, 0].max(), 3.0), np.arange(pk[:, 1].min(), pk[:, 1].max(), 3.0))
I = np.c_[xs.ravel(), zs.ravel()]
def inpoly(q):
    c = np.zeros(len(q), bool)
    for i in range(len(pk)):
        a, bq = pk[i], pk[(i + 1) % len(pk)]
        cond = (a[1] > q[:, 1]) != (bq[1] > q[:, 1])
        xcross = (bq[0] - a[0]) * (q[:, 1] - a[1]) / np.where(bq[1] - a[1] == 0, 1e-9, bq[1] - a[1]) + a[0]
        c ^= cond & (q[:, 0] < xcross)
    return c
I = I[inpoly(I)]
def apply(Hm, q): w = np.c_[q, np.ones(len(q))] @ Hm.T; return w[:, :2] / np.where(abs(w[:, 2:3]) < 1e-9, 1e-9, w[:, 2:3])
CAP = 10.0
def samp(dt, uv):
    u, v = uv[:, 0], uv[:, 1]; ok = (u >= 0) & (u < Ww - 1) & (v >= 0) & (v < Hh - 1)
    out = np.full(len(uv), CAP); out[ok] = np.minimum(ndimage.map_coordinates(dt, [v[ok], u[ok]], order=1), CAP); return out
from scipy.spatial import cKDTree
lys, lxs = np.nonzero(lot[::4, ::4]); LOTPX = np.c_[lxs * 4, lys * 4].astype(float)   # 絵の駐車場の画素(4px おき)
def cost(Hm):
    uvI = apply(Hm, I)
    # 絵の駐車場の画素は、写した中の点のどれかの近くにあるはず(つぶれない)
    dd, _ = cKDTree(uvI).query(LOTPX); cover = float(np.mean(np.minimum(dd, CAP) ** 2))
    return float(np.mean(samp(dt_outline, apply(Hm, E)) ** 2)) + 0.5 * float(np.mean(samp(dt_inside, uvI) ** 2)) + 0.5 * cover + 0.7 * float(np.mean(samp(dt_road, apply(Hm, C2)) ** 2))
def cost_fast(Hm):   # 総当たり用(つぶれの罰なし)
    return float(np.mean(samp(dt_outline, apply(Hm, E)) ** 2)) + 0.5 * float(np.mean(samp(dt_inside, apply(Hm, I)) ** 2)) + 0.7 * float(np.mean(samp(dt_road, apply(Hm, C2)) ** 2))
area_px = lot.sum(); area_m2 = 0.5 * abs(np.sum(pk[:, 0] * np.roll(pk[:, 1], -1) - np.roll(pk[:, 0], -1) * pk[:, 1]))
ys, xs2 = np.nonzero(lot); pu, pv = xs2.mean(), ys.mean()
# 手がかり: 北の辺のくぼみの角(世界: 外形の中で北の辺が南へ出っぱる所)は、絵では赤い線が折れる所
ANCHOR_W = pk[np.argmax([(q[1] if abs(q[1] - pk[:, 1].min()) < 12 else -1e9) for q in pk])]   # 北の辺(z が小さい側)の中で、いちばん南の角
ANCHOR_I = np.array([float(v) for v in sys.argv[2].split(',')]) if len(sys.argv) > 2 else np.array([pu, pv])
print('手がかりの角', ANCHOR_W, '→', ANCHOR_I)
def affine(th, s, kf, du, dv):   # 回転 th、倍率 s、縦のつぶれ kf(斜めから見ているぶん)、位置(手がかりの角を合わせる)
    c, sn = math.cos(th), math.sin(th)
    A = np.array([[s * c, -s * sn, 0], [kf * s * sn, kf * s * c, 0], [0, 0, 1.0]])
    t = ANCHOR_I + [du, dv] - (A @ np.array([ANCHOR_W[0], ANCHOR_W[1], 1]))[:2]; A[0, 2], A[1, 2] = t; return A
best = None
for th in np.radians(np.arange(0, 360, 4)):
    for kf in (0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1.0):
        for s in (2.0, 2.5, 3.0, 3.6, 4.3, 5.2, 6.2, 7.5):
            for du in (-12, 0, 12):
                for dv in (-12, 0, 12):
                    Hm = affine(th, s, kf, du, dv); c = cost_fast(Hm)
                    if best is None or c < best[0]: best = (c, th, s, kf, du, dv)
print('総当たり cost', round(best[0], 2), '回転', round(math.degrees(best[1])), '倍率', round(best[2], 2), 'つぶれ', best[3], 'ずれ', best[4], best[5])
Hm = affine(*best[1:])
c5 = lambda p: cost(affine(*p))
p = optimize.minimize(c5, np.array(best[1:]), method='Powell', options={'maxiter': 20000, 'xtol': 1e-6, 'ftol': 1e-9}).x
Hm = affine(*p); print('5個', round(cost(Hm), 3))
q = Hm.reshape(-1)[:8]; c8 = lambda v: cost(np.append(v, 1.0).reshape(3, 3))
for _ in range(3):
    q = optimize.minimize(c8, q, method='Powell', options={'maxiter': 40000, 'xtol': 1e-8, 'ftol': 1e-10}).x
    q = optimize.minimize(c8, q, method='Nelder-Mead', options={'maxiter': 40000, 'xatol': 1e-9, 'fatol': 1e-10, 'adaptive': True}).x
Hm = np.append(q, 1.0).reshape(3, 3); print('8個', round(c8(q), 3))
a = samp(dt_outline, apply(Hm, E)); print('外形のずれ px 中央値', round(float(np.median(a)), 2), '90%', round(float(np.percentile(a, 90)), 2))
(P / f'homog_{name}.json').write_text(json.dumps({'H': Hm.tolist()}))
ov = cv2.imread(str(P / f'{name}.png')); uv = apply(Hm, dense(pk, 0.5))
for k2 in range(len(uv)): cv2.circle(ov, (int(round(uv[k2, 0])), int(round(uv[k2, 1]))), 1, (255, 0, 255), -1)
cv2.imwrite(str(P / f'{name}_check.png'), ov)
