"""赤城山: ガードレールの直し(2 回目)。空撮に塗った 青 = ここは一続きのガードレール(途切れをつなぐ)、オレンジ = ここにもガードレール。
赤は前回のまま。絵のカメラは paint/cam_<名前>.json。今の railL / railR(map/akagi-course.json)に足す。
python3 tools/akagi/apply_rail_paint2.py rail2_a rail2_b rail2_c rail2_d
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); R = np.array(data['route']); n = len(R)
d = np.gradient(R[:, [0, 2]], axis=0); nn = np.stack([d[:, 1], -d[:, 0]], 1); nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-9
RAIL = 3.6 + 0.9 + 0.35; TOL = 3.5
def proj(M, X): q = np.c_[X, np.ones(len(X))] @ M.T; return q[:, :2] / q[:, 2:3]
add = np.zeros((2, n), bool)
for name in sys.argv[1:]:
    M = np.array(json.loads((P / f'cam_{name}.json').read_text())['M']); im = cv2.imread(str(P / f'{name}.png')).astype(int); Hh, Ww = im.shape[:2]
    b, g, r = im[..., 0], im[..., 1], im[..., 2]
    blue = (b > 150) & (r < 130) & (g > 100); orange = (r > 190) & (g > 110) & (g < 210) & (b < 90)
    dt = ndimage.distance_transform_edt(~(blue | orange))
    valid = cv2.erode(((im < 250).any(2)).astype(np.uint8), np.ones((5, 5), np.uint8))
    for si, side in enumerate((1, -1)):
        hit = np.zeros(n, bool)
        for off in (RAIL, RAIL + 2.0):
            X = np.c_[R[:, 0] + nn[:, 0] * side * off, R[:, 1] + 0.6, R[:, 2] + nn[:, 1] * side * off]
            uv = proj(M, X); u, v = uv[:, 0], uv[:, 1]
            ok = (u >= 2) & (u < Ww - 3) & (v >= 2) & (v < Hh - 3); ok[ok] &= valid[v[ok].astype(int), u[ok].astype(int)] > 0
            uv2 = proj(M, X + np.c_[nn[:, 0], np.zeros(n), nn[:, 1]]); ppm = np.linalg.norm(uv2 - uv, axis=1)
            dd = np.full(n, 1e9); dd[ok] = ndimage.map_coordinates(dt, [v[ok], u[ok]], order=1)
            hit |= ok & (dd <= TOL * ppm)
        add[si] |= hit
    print(name, '青・オレンジに当たった点 左', int(add[0].sum()), '右', int(add[1].sum()))
for si, key in enumerate(('railL', 'railR')):
    old = np.array(data[key]); f = old == 1
    a = add[si]
    # 青・オレンジの線は一続き: 線の上で 30m(10 点)以下の切れ目はつなぐ
    a = ndimage.binary_closing(a, np.ones(11))
    f = f | a
    # 支柱(偶数番)で区切る。続きの両端を偶数番に丸める
    g = np.zeros(n, bool); lab, k = ndimage.label(f)
    for j in range(1, k + 1):
        idx = np.nonzero(lab == j)[0]; s0, s1 = int(round(idx[0] / 2) * 2), int(round(idx[-1] / 2) * 2)
        if s1 > s0: g[s0:s1 + 1] = True
    new = np.where(g, 1, np.where(old == -1, -1, 0))
    print(key, '前', int((old == 1).sum()), '→', int(g.sum()), '点  足した', int((g & ~(old == 1)).sum()), ' 続きの数', ndimage.label(g)[1])
    data[key] = [int(v) for v in new]
(ROOT / 'map/akagi-course.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
