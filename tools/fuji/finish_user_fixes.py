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
# ホームストレートの左(観客席の側): コースの縁から 8.5m までは草地の帯(指示: 紫 = 草地)
gz = (ax > pe['xs'] - 15) & (ax < pe['xe'] + 10) & (sv < -7.3) & (sv > -16.0)
img[gz] = col('grass'); print('ホームストレート左の草地の帯', int(gz.sum()), 'm2')
Wp = lambda x, v: Op + uu * x + vv * v
poly = np.array([Wp(pe['xs'], 7.4), Wp(pe['xb'], pe['outer']), Wp(pe['xe'], pe['outer']), Wp(pe['xe'], 7.4)])
pm = np.zeros((H, W), np.uint8); cv2.fillPoly(pm, [np.round(poly * 8).astype(np.int32)], 1, shift=3)
img[pm > 0] = ROAD
img[lo == 2] = col('grass'); img[lo == 3] = col('paved'); lo[pm > 0] = 1   # ピット入口の形は細かい図でもくっきり
# ピット出口のあたり(指示: 紫 = 草地): 左は草地の帯の外の灰色の帯、右は出口の車線の外の灰色を草地に
Tn = np.roll(Rr, -2, 0) - np.roll(Rr, 2, 0); Tn /= np.linalg.norm(Tn, axis=1)[:, None]; NRr = np.stack([-Tn[:, 1], Tn[:, 0]], 1)
PR = d['pitExit']['prof']; outerAt = lambda i: float(np.interp(i, [p[0] for p in PR], [p[2] for p in PR]))
gm = np.zeros((H, W), np.uint8)
for i in range(1412, 1471):   # 左
    q = [Rr[i] - NRr[i] * 14.5, Rr[i + 1] - NRr[i + 1] * 14.5, Rr[i + 1] - NRr[i + 1] * 26, Rr[i] - NRr[i] * 26]
    cv2.fillPoly(gm, [np.round(np.array(q) * 8).astype(np.int32)], 1, shift=3)
for i in range(1428, 1513):   # 右(ピットの壁の終わりの角から)
    a1, a2 = outerAt(i) + 0.15, outerAt(i + 1) + 0.15
    q = [Rr[i] + NRr[i] * a1, Rr[i + 1] + NRr[i + 1] * a2, Rr[i + 1] + NRr[i + 1] * 30, Rr[i] + NRr[i] * 30]
    cv2.fillPoly(gm, [np.round(np.array(q) * 8).astype(np.int32)], 1, shift=3)
sel = (gm > 0) & ((img == np.array(col('paved'), np.uint8)).all(2) | (img == ROAD).all(2))   # 車線の白線の外の路面の色も
img[sel] = col('grass'); print('ピット出口のあたりの灰色 → 草地', int(sel.sum()), 'm2')
# 直線で区切った多角形の指示(apply_poly_paint.py)。あとのものほど上
PC = {2: col('grass'), 3: col('paved'), 6: col('sand')}
for pp in d.get('paintPolys', []):
    m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [np.round((np.array(pp['pts']) - [L['x0'], L['z0']]) * 8).astype(np.int32)], 1, shift=3)
    img[m > 0] = PC[pp['cls']]; lo[m > 0] = 0
# 説明できない破片を消す
# 1) 路面の色は 3D の路面(本コース・近道・ピットレーン・ピット入口・出口の車線・ピットの壁ぎわ)の下にだけ。そのすぐ外(3m)にはみ出した路面の色はとなりの色に
rm3 = np.zeros((H, W), np.uint8); px8 = lambda q: np.round(np.array(q) * 8).astype(np.int32)
for i in range(len(Rr)):
    j = (i + 1) % len(Rr); cv2.fillPoly(rm3, [px8([Rr[i] + NRr[i] * 7.6, Rr[j] + NRr[j] * 7.6, Rr[j] - NRr[j] * 7.6, Rr[i] - NRr[i] * 7.6])], 1, shift=3)
for b in d['branches']: cv2.polylines(rm3, [px8(np.array(b['pts']) - [L['x0'], L['z0']])], False, 1, int(round((b['w'] + 0.2) * 8)), shift=3)
cv2.fillPoly(rm3, [np.round(poly * 8).astype(np.int32)], 1, shift=3)
for i in range(int(PR[0][0]), min(int(PR[-1][0]), len(Rr) - 1)):
    a1, a2 = outerAt(i) + 0.1, outerAt(i + 1) + 0.1; cv2.fillPoly(rm3, [px8([Rr[i], Rr[i + 1], Rr[i + 1] + NRr[i + 1] * a2, Rr[i] + NRr[i] * a1])], 1, shift=3)
pw = d.get('pitWall')
if pw:
    for i in range(pw['from'], pw['to']): cv2.fillPoly(rm3, [px8([Rr[i], Rr[i + 1], Rr[i + 1] + NRr[i + 1] * 10.0, Rr[i] + NRr[i] * 10.0])], 1, shift=3)
isR = (img == ROAD).all(2); near3 = cv2.dilate(rm3, np.ones((7, 7), np.uint8)) > 0
sl = isR & near3   # 3D の路面のそばの路面の色は全部(下は 3D の路面が描く。ふちに濃い色を残さない)
_, (iy5, ix5) = ndimage.distance_transform_edt(isR, return_indices=True); img[sl] = img[iy5, ix5][sl]
lo[sl & (lo == 1)] = 0
print('路面の外にはみ出した路面の色', int(sl.sum()), 'm2')
# 2) 小さな破片(どの色も 60m2 未満)は、まわりでいちばん多い色に(塗ってもらった所は除く)
painted = lo > 0
for pp in d.get('paintPolys', []):
    m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [np.round((np.array(pp['pts']) - [L['x0'], L['z0']]) * 8).astype(np.int32)], 1, shift=3); painted |= m > 0
cols_, lab_ = np.unique(img.reshape(-1, 3), axis=0, return_inverse=True); lab_ = lab_.reshape(H, W); cnt = 0
for c in range(len(cols_)):
    nc, cc, st, _ = cv2.connectedComponentsWithStats((lab_ == c).astype(np.uint8), connectivity=4)
    for i in np.where(st[1:, cv2.CC_STAT_AREA] < 60)[0] + 1:
        x, y, w, h, a_ = st[i]; sl2 = (slice(max(0, y - 2), y + h + 2), slice(max(0, x - 2), x + w + 2)); msk = cc[sl2] == i
        if painted[sl2][msk].any() or rm3[sl2][msk].all(): continue
        ring = cv2.dilate(msk.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~msk; nb = lab_[sl2][ring]; nb = nb[nb != c]
        if len(nb): o = lab_[sl2]; o[msk] = np.bincount(nb).argmax(); lab_[sl2] = o; cnt += 1
img = cols_[lab_].astype(np.uint8); print('小さな破片', cnt, 'か所')
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), img)
cv2.imwrite(str(P / 'final_overrides.png'), lo)
print('あとの指示 草地', int((lo == 2).sum()), ' アスファルト', int((lo == 3).sum()), 'm2')
