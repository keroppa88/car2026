"""base_landcover_1357.png に、そのあとの絵の指示(later_overrides.png: 2 草地、3 アスファルト)を重ねて map/fuji-landcover.png にする。
二股の近道のわきにはみ出していた路面の色(白線の外)は、となりの色にする(指示: コースの色のはみ出しをなくす)。"""
import json
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/fuji/paint'
d = json.loads((ROOT / 'map/fuji-course.json').read_text()); L = d['landcover']
img = cv2.imread(str(P / 'base_landcover_1357.png')); H, W = img.shape[:2]
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda k: tuple(int(q) for q in src.split(f"'{k}': (")[1].split(')')[0].split(','))
ROAD = np.array((75, 73, 71), np.uint8)
road = (img == ROAD).all(2)
br = np.zeros((H, W), np.uint8)
for b in d['branches']:
    if b['w'] > 9: cv2.polylines(br, [np.round(np.array(b['pts']) - [L['x0'], L['z0']]).astype(np.int32)], False, 1, 1)
db = cv2.distanceTransform(1 - br, cv2.DIST_L2, 5)
Rr = np.array([[p[0] - L['x0'], p[2] - L['z0']] for p in d['route']])
mk = np.ones((H, W), np.uint8); cv2.polylines(mk, [np.round(Rr).astype(np.int32)], True, 0, 1); dm = cv2.distanceTransform(mk, cv2.DIST_L2, 5)
mk2 = np.ones((H, W), np.uint8); cv2.polylines(mk2, [np.round(Rr[685:790]).astype(np.int32)], False, 0, 1); dz = cv2.distanceTransform(mk2, cv2.DIST_L2, 5)
spill = road & (((db < 25) & (db > 6.3)) | (dz < 45)) & (dm > 7.4) & (db > 6.3)   # 近道・二股のまわりで、路面(本コース 7.5m・近道 6.5m)の外にある路面の色
_, (iy, ix) = ndimage.distance_transform_edt(road, return_indices=True); img[spill] = img[iy, ix][spill]
print('近道わきの路面の色のはみ出し', int(spill.sum()), 'm2')
# 二股: 近道の外側(島と反対側)の、近道のふちから 9m までは、すき間なくアスファルト(指示: ピンクの3か所をコンクリで埋める)
bb = next(b for b in d['branches'] if b['w'] > 9); A = np.array(bb['pts'][0]) - [L['x0'], L['z0']]; B = np.array(bb['pts'][-1]) - [L['x0'], L['z0']]
u = (B - A) / np.linalg.norm(B - A); nv = np.array([-u[1], u[0]]); Lb = np.linalg.norm(B - A)
i0_, i1_ = sorted((bb['from'], bb['to'])); isl = Rr[i0_:i1_ + 1].mean(0); sgn = -np.sign((isl - A) @ nv)
yy, xx = np.mgrid[0:H, 0:W]; tt = (xx - A[0]) * u[0] + (yy - A[1]) * u[1]; ss = ((xx - A[0]) * nv[0] + (yy - A[1]) * nv[1]) * sgn
fill = (ss > bb['w'] / 2 - 0.5) & (ss < bb['w'] / 2 + 9) & (tt > -45) & (tt < Lb + 45) & (dm > 7.0)
img[fill] = col('paved'); print('近道の外側をアスファルトで埋める', int(fill.sum()), 'm2')
lo = cv2.imread(str(P / 'later_overrides.png'), 0)
# ピット入口: ホームストレートの右の路面の色は、まっすぐな形(コースの縁 → 外へまっすぐ開く線 → ピットレーンの外の縁)だけにする
pe = d['pitEntry']; Op = np.array(pe['O']) - [L['x0'], L['z0']]; uu = np.array(pe['u']); vv = np.array([-uu[1], uu[0]])
yy2, xx2 = np.mgrid[0:H, 0:W]; ax = (xx2 - Op[0]) * uu[0] + (yy2 - Op[1]) * uu[1]; sv = (xx2 - Op[0]) * vv[0] + (yy2 - Op[1]) * vv[1]
zone = (ax > pe['xs'] - 15) & (ax < pe['xe']) & (sv > 7.3) & (sv < 45)
img[zone & (img == ROAD).all(2)] = col('paved')
Wp = lambda x, v: Op + uu * x + vv * v
poly = np.array([Wp(pe['xs'], 7.4), Wp(pe['xb'], pe['outer']), Wp(pe['xe'], pe['outer']), Wp(pe['xe'], 7.4)])
pm = np.zeros((H, W), np.uint8); cv2.fillPoly(pm, [np.round(poly * 8).astype(np.int32)], 1, shift=3)
img[pm > 0] = ROAD
img[lo == 2] = col('grass'); img[lo == 3] = col('paved'); lo[pm > 0] = 1   # ピット入口の形は細かい図でもくっきり
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), img)
cv2.imwrite(str(P / 'final_overrides.png'), lo)
print('あとの指示 草地', int((lo == 2).sum()), ' アスファルト', int((lo == 3).sum()), 'm2')
