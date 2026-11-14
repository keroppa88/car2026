"""赤城山: ゲームの空撮(真上・北が上)に色を塗った絵を、コースの座標(x 東・z 南、m)に合わせる。
絵の中の道(灰色)と、コースの線(map/akagi-course.json)が重なるように、拡大・回転・平行移動と、カメラの高さを探す。
空撮は真上からの遠近(高い所ほど大きく写る)なので、高さ y の点は 1/(カメラの高さ - y) の倍率で写る。
python3 tools/akagi/register_topview.py 絵.png → 絵.json(画素 → 座標の変換)
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]
img = cv2.imread(sys.argv[1]).astype(int); Hh, Ww = img.shape[:2]
b, g, r = img[..., 0], img[..., 1], img[..., 2]
road = (abs(r - g) < 14) & (abs(g - b) < 14) & (g > 85) & (g < 190)
road = cv2.morphologyEx(road.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
dt = ndimage.distance_transform_edt(road == 0)
R3 = np.array(json.load(open(ROOT / 'map/akagi-course.json'))['route']); R = R3[:, [0, 2]]; Y = R3[:, 1]
ys, xs = np.nonzero(road)
# はじめの見当: 範囲をそろえる(北が上なので回転なし)
s0 = min((xs.max() - xs.min()) / np.ptp(R[:, 0]), (ys.max() - ys.min()) / np.ptp(R[:, 1]))
t0 = [xs.mean() - s0 * R[:, 0].mean(), ys.mean() - s0 * R[:, 1].mean()]
def uv(p, P=R, y=Y):
    # カメラの写し方そのもの(3x4 の行列、右下 = 1)。(x, y, z) → 画素。空撮の視点が少し斜めでも合う
    M = np.append(p, 1.0).reshape(3, 4); X = np.stack([P[:, 0], y, P[:, 1], np.ones(len(P))], 1) @ M.T
    return X[:, :2] / X[:, 2:3]
def cost(p):
    q = uv(p); u = np.clip(q[:, 0], 0, Ww - 1); v = np.clip(q[:, 1], 0, Hh - 1)
    return np.mean(np.minimum(ndimage.map_coordinates(dt, [v, u], order=1), 12) ** 2)
x0 = np.array([s0, 0, 0, t0[0], 0, 0, s0, t0[1], 0, 0, 0])   # はじめは真上から(高さは効かない)
best = optimize.minimize(cost, x0, method='Powell', options={'maxiter': 40000, 'xtol': 1e-7, 'ftol': 1e-8})
for _ in range(3):
    best = optimize.minimize(cost, best.x, method='Nelder-Mead', options={'maxiter': 40000, 'xatol': 1e-8, 'fatol': 1e-8, 'adaptive': True})
    best = optimize.minimize(cost, best.x, method='Powell', options={'maxiter': 40000, 'xtol': 1e-8, 'ftol': 1e-9})
p = best.x
q = uv(p); err = ndimage.map_coordinates(dt, [np.clip(q[:, 1], 0, Hh - 1), np.clip(q[:, 0], 0, Ww - 1)], order=1)
out = {'M': [float(v) for v in np.append(p, 1.0)], 'err_px_median': float(np.median(err)), 'err_px_90': float(np.percentile(err, 90))}
Path(sys.argv[1]).with_suffix('.json').write_text(json.dumps(out, indent=1))
print(out)
# 重ねた絵(確かめ用)
ov = cv2.imread(sys.argv[1]); cv2.polylines(ov, [np.round(q).astype(np.int32)], False, (255, 0, 255), 1)
cv2.imwrite(str(Path(sys.argv[1]).with_name(Path(sys.argv[1]).stem + '_check.png')), ov)
