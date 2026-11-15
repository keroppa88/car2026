"""絵のカメラ(3x4)を、絵の中の道の形(灰色)にコースの線が重なるように細かく直す。
cost = コースの中心線は道の中 + 道の外(路肩の外 3m)は道の外。python3 tools/akagi/refine_rail_cam.py 絵の名前...  [--init-parking]
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); R = np.array(data['route']); n = len(R)
d = np.gradient(R[:, [0, 2]], axis=0); nn = np.stack([d[:, 1], -d[:, 0]], 1); nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-9
EDGE = 3.6 + 0.9
def pts3(off): return np.c_[R[:, 0] + nn[:, 0] * off, R[:, 1], R[:, 2] + nn[:, 1] * off]
C, L, Rr = pts3(0), pts3(EDGE + 3), pts3(-(EDGE + 3))
def proj(M, X): q = np.c_[X, np.ones(len(X))] @ M.T; return q[:, :2] / q[:, 2:3]
for name in [a for a in sys.argv[1:] if not a.startswith('--')]:
    im = cv2.imread(str(P / f'{name}.png')).astype(int); Hh, Ww = im.shape[:2]
    b, g, r = im[..., 0], im[..., 1], im[..., 2]
    road = ((abs(r - g) < 16) & (abs(g - b) < 16) & (g > 70) & (g < 235)).astype(np.uint8)   # 道(灰)とガードレール(白っぽい)
    road = cv2.morphologyEx(road, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    # 道ではない灰色のかたまり(駐車場・文字の箱)は外す: 面積が大きくて丸っこいもの
    nl, lab, st, _ = cv2.connectedComponentsWithStats(road)
    for k in range(1, nl):
        ar, w, h = st[k, cv2.CC_STAT_AREA], st[k, cv2.CC_STAT_WIDTH], st[k, cv2.CC_STAT_HEIGHT]
        if ar > 400 and ar / (w * h) > 0.45: road[lab == k] = 0
    dt_out = ndimage.distance_transform_edt(road == 0); dt_in = ndimage.distance_transform_edt(road == 1)
    def samp(dt, uv):
        u = uv[:, 0]; v = uv[:, 1]; ok = (u >= 0) & (u < Ww - 1) & (v >= 0) & (v < Hh - 1)
        out = np.full(len(uv), np.nan); out[ok] = ndimage.map_coordinates(dt, [v[ok], u[ok]], order=1); return out
    sub = None   # 初期値で画面に入っていた点だけで合わせる(画面の外へ逃げない)
    def cost(p, cap=6.0):
        M = np.append(p, 1.0).reshape(3, 4)
        a = samp(dt_out, proj(M, C[sub])); e = np.minimum(np.nan_to_num(a, nan=cap), cap) ** 2
        for X in (L, Rr):
            bq = samp(dt_in, proj(M, X[sub])); e = np.r_[e, np.minimum(np.nan_to_num(bq, nan=0), cap) ** 2 * 0.5]
        return float(np.mean(e))
    camf = P / f'cam_{name}.json'
    if '--init-end' in sys.argv:   # 初期値: 真上から(回転・倍率・平行移動を総当たり)。コースの終わりの方(ゴール前 380 点)が写っている絵
        Cq = C[n - 380:]; cx, cz = Cq[:, 0].mean(), Cq[:, 2].mean(); best = None
        for th in np.radians(np.arange(-30, 31, 5)):
            co, si = np.cos(th), np.sin(th)
            for s in np.arange(0.7, 1.5, 0.05):
                u0 = ((Cq[:, 0] - cx) * co - (Cq[:, 2] - cz) * si) * s; v0 = ((Cq[:, 0] - cx) * si + (Cq[:, 2] - cz) * co) * s
                for pu in range(0, Ww, 8):
                    for pv in range(0, Hh, 8):
                        u = u0 + pu; v = v0 + pv; ok = (u >= 0) & (u < Ww - 1) & (v >= 0) & (v < Hh - 1)
                        if ok.mean() < 0.6: continue
                        e = ndimage.map_coordinates(dt_out, [v[ok], u[ok]], order=0); cst = np.mean(np.minimum(e, 8) ** 2) + 20 * (1 - ok.mean())
                        if best is None or cst < best[0]: best = (cst, th, s, pu, pv)
        cst, th, s, pu, pv = best; co, si = np.cos(th), np.sin(th)
        # u = s*(co*x - si*z) + (pu - s*(co*cx - si*cz)) など
        p = np.array([s * co, 0, -s * si, pu - s * (co * cx - si * cz), s * si, 0, s * co, pv - s * (si * cx + co * cz), 0, 0, 0])
        print(name, '初期値 回転', round(np.degrees(th)), '倍率', round(s, 2), 'cost', round(cst, 2))
    else:
        p = np.array(json.loads(camf.read_text())['M']).reshape(-1)[:11]
    M0 = np.append(p, 1.0).reshape(3, 4); uv0 = proj(M0, C); sub = np.nonzero((uv0[:, 0] >= 0) & (uv0[:, 0] < Ww) & (uv0[:, 1] >= 0) & (uv0[:, 1] < Hh))[0]
    c0 = cost(p)
    for _ in range(3):
        res = optimize.minimize(cost, p, method='Powell', options={'maxiter': 30000, 'xtol': 1e-7, 'ftol': 1e-9}); p = res.x
        res = optimize.minimize(cost, p, method='Nelder-Mead', options={'maxiter': 30000, 'xatol': 1e-8, 'fatol': 1e-9, 'adaptive': True}); p = res.x
    M = np.append(p, 1.0).reshape(3, 4)
    a = samp(dt_out, proj(M, C)); ok = ~np.isnan(a)
    print(name, 'cost', round(c0, 3), '→', round(cost(p), 3), ' 中心線のずれ px 中央値', round(float(np.median(a[ok])), 2), '90%', round(float(np.percentile(a[ok], 90)), 2), '画面内', int(ok.sum()))
    camf.write_text(json.dumps({'M': M.tolist(), 'refined': True}))
