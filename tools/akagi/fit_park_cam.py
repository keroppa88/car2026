"""駐車場の絵(ゲームの斜めの画面に色を塗ったもの)のカメラを求める。
絵の中の灰色(駐車場・道)の形に、駐車場の外形(map/akagi-course.json の parkings)と道の中心線が重なるように、
カメラの位置・向き・画角を総当たりで探し、そのあと 3x4 行列(11 個)で細かく合わせる。→ paint/cam_<絵>.json
python3 tools/akagi/fit_park_cam.py park_paint
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
name = sys.argv[1]
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); R = np.array(data['route'])
pk = np.array(data['parkings'][0]); cxp, czp = pk.mean(0)
i0 = np.argmin(np.hypot(R[:, 0] - cxp, R[:, 2] - czp)); PY = R[i0, 1] - 0.25   # 駐車場の高さ(道より 25cm 下)
im = cv2.imread(str(P / f'{name}.png')).astype(int); Hh, Ww = im.shape[:2]; b, g, r = im[..., 0], im[..., 1], im[..., 2]
grey = (abs(r - g) < 12) & (abs(g - b) < 12) & (g > 55) & (g < 140)
pink = (r > 200) & (g > 120) & (g < 200) & (b > 150) & (r - g > 25); orange = (r > 200) & (g > 120) & (g < 190) & (b < 80)
yellow = (r > 180) & (g > 150) & (b < 100); red = (r > 150) & (g < 110) & (b < 110); cyan = (b > 180) & (r < 200) & (g > 170)
grey = grey | pink | orange | red | cyan            # 線は駐車場のふちに引いてある
# 外形: 黄色(森にする所。駐車場の西側にもかかる)の上でもよい。道: 灰色だけ。外側の輪: 灰色の上はだめ(黄色はよい)
dt_edge = ndimage.distance_transform_edt(~(grey | yellow)); dt_road = ndimage.distance_transform_edt(~grey); dt_in = ndimage.distance_transform_edt(grey)
# 世界の点: 駐車場の外形(1m おき)、道の中心線(駐車場から 160m 以内)、外側の輪(外形から 5m 外。道から 12m 以上離れた所)
def dense(poly, step=1.0):
    out = []
    for a, bq in zip(poly, np.roll(poly, -1, 0)):
        L = np.hypot(*(bq - a)); k = max(1, int(L / step))
        for t in range(k): out.append(a + (bq - a) * t / k)
    return np.array(out)
edge = dense(pk); E3 = np.c_[edge[:, 0], np.full(len(edge), PY), edge[:, 1]]
near = np.hypot(R[:, 0] - cxp, R[:, 2] - czp) < 160; C3 = R[near]
cen = pk.mean(0); outer = cen + (edge - cen) * (1 + 5 / np.maximum(1e-6, np.linalg.norm(edge - cen, axis=1)))[:, None]
far_from_road = np.array([np.min(np.hypot(R[:, 0] - q[0], R[:, 2] - q[1])) > 12 for q in outer]); O3 = np.c_[outer[:, 0], np.full(len(outer), PY), outer[:, 1]][far_from_road]
def proj(M, X): q = np.c_[X, np.ones(len(X))] @ M.T; w = q[:, 2:3]; return np.where(w > 1e-6, q[:, :2] / np.where(w > 1e-6, w, 1), np.nan)
def samp(dt, uv):
    out = np.full(len(uv), np.nan); ok = ~np.isnan(uv[:, 0])
    u = uv[ok, 0]; v = uv[ok, 1]; ins = (u >= 0) & (u < Ww - 1) & (v >= 0) & (v < Hh - 1)
    val = np.full(ok.sum(), np.nan); val[ins] = ndimage.map_coordinates(dt, [v[ins], u[ins]], order=1)
    out[ok] = val; return out
def cost(M, cap=8.0):
    a = samp(dt_edge, proj(M, E3)); c = samp(dt_road, proj(M, C3)); o = samp(dt_in, proj(M, O3))
    e = np.r_[np.minimum(np.nan_to_num(a, nan=cap), cap) ** 2, 0.5 * np.minimum(np.nan_to_num(c, nan=cap), cap) ** 2, 0.7 * np.minimum(np.nan_to_num(o, nan=0), cap) ** 2]
    return float(np.mean(e))
def cam(az, el, dist, fov, tx=cxp, tz=czp, ty=PY, roll=0.0):
    e = math.radians(el); pos = np.array([tx + math.cos(az) * dist * math.cos(e), ty + dist * math.sin(e), tz + math.sin(az) * dist * math.cos(e)])
    f = (Hh / 2) / math.tan(math.radians(fov) / 2)
    fwd = np.array([tx, ty, tz]) - pos; fwd /= np.linalg.norm(fwd); up0 = np.array([0, 1, 0.0])
    right = np.cross(fwd, up0); right /= np.linalg.norm(right); up = np.cross(right, fwd)
    if roll: cr, sr = math.cos(roll), math.sin(roll); right, up = right * cr + up * sr, up * cr - right * sr
    Rm = np.stack([right, -up, fwd])            # 画素: u 右、v 下
    K = np.array([[f, 0, Ww / 2], [0, f, Hh / 2], [0, 0, 1]])
    M = K @ np.c_[Rm, -Rm @ pos]; return M / M[2, 3]
best = None
for az in np.radians(np.arange(0, 360, 10)):
    for el in (20, 30, 40, 50, 60, 70):
        for dist in (90, 130, 180, 250, 340):
            for fov in (45, 60, 75):
                M = cam(az, el, dist, fov); c = cost(M)
                if best is None or c < best[0]: best = (c, az, el, dist, fov)
print('総当たり', round(best[0], 2), '方角', round(math.degrees(best[1])), '仰角', best[2], '距離', best[3], '画角', best[4])
# 7 個(方角・仰角・距離・画角・注視点 x,z・ロール)で細かく
def c7(p): return cost(cam(p[0], p[1], p[2], p[3], p[4], p[5], PY, p[6]))
p = np.array([best[1], best[2], best[3], best[4], cxp, czp, 0.0])
for _ in range(2):
    p = optimize.minimize(c7, p, method='Powell', options={'maxiter': 20000, 'xtol': 1e-6, 'ftol': 1e-8}).x
    p = optimize.minimize(c7, p, method='Nelder-Mead', options={'maxiter': 20000, 'xatol': 1e-7, 'fatol': 1e-8, 'adaptive': True}).x
print('7個', round(c7(p), 3))
M = cam(*p[:4], p[4], p[5], PY, p[6]); q = M.reshape(-1)[:11]
c11 = lambda v: cost(np.append(v, 1.0).reshape(3, 4))
for _ in range(2):
    q = optimize.minimize(c11, q, method='Powell', options={'maxiter': 40000, 'xtol': 1e-8, 'ftol': 1e-10}).x
    q = optimize.minimize(c11, q, method='Nelder-Mead', options={'maxiter': 40000, 'xatol': 1e-9, 'fatol': 1e-10, 'adaptive': True}).x
M = np.append(q, 1.0).reshape(3, 4); print('11個', round(c11(q), 3))
a = samp(dt_edge, proj(M, E3)); print('外形のずれ px 中央値', round(float(np.nanmedian(a)), 2), '90%', round(float(np.nanpercentile(a, 90)), 2))
(P / f'cam_{name}.json').write_text(json.dumps({'M': M.tolist(), 'PY': float(PY)}))
# 確かめ: 外形(紫)と道(緑)を絵に重ねる
ov = cv2.imread(str(P / f'{name}.png'))
for X, col in ((E3, (255, 0, 255)), (C3, (0, 255, 0))):
    uv = proj(M, X)
    for k in range(len(uv) - 1):
        if np.isnan(uv[k]).any() or np.isnan(uv[k + 1]).any(): continue
        cv2.line(ov, tuple(np.round(uv[k]).astype(int)), tuple(np.round(uv[k + 1]).astype(int)), col, 1)
cv2.imwrite(str(P / f'{name}_check.png'), ov)
