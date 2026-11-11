"""富士スピードウェイ: ゲームの真上ビュー(U キー)の画面に塗った絵から、地面の塗り分けを直す。
python3 tools/fuji/apply_area_paint2.py 絵.png 確認用の出力フォルダ [--add] [--pink-paved]
1枚目: area_paint2.png(オプションなし)。2枚目: area_paint3.png --add --pink-paved(--add = 前の直しに重ねる)
色(ペイントの原色そのまま): ピンク (255,174,201) = コース(濃いグレー) / 赤 (237,28,36) = 芝生 / 水色 (153,217,234) = コンクリート / 黄 (255,242,0) = 駐車場
合わせ方: 真下を向いたカメラ(位置・高さ・向き・画角)を、コースの線(高さつき)が絵の濃いグレーに重なるように求める。
→ tools/fuji/paint/area_overrides.png(地図の升目 1m。0 = なし、1 コース、2 芝生、3 コンクリート、4 駐車場)と map/fuji-landcover.png
make_landcover_mosaic.py は最後に area_overrides.png を重ねるので、作り直しても消えない。
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]; d = json.loads((ROOT / 'map/fuji-course.json').read_text())
src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tools/fuji/paint/area_paint2.png'; DBG = Path(sys.argv[2]) if len(sys.argv) > 2 else None
I = cv2.imread(str(src)); Hh, Ww = I.shape[:2]; J = I.astype(int)
near = lambda rgb, tol=6: (np.abs(J - np.array(rgb[::-1])).max(2) <= tol)
PAINT = {1: (255, 174, 201), 2: (237, 28, 36), 3: (153, 217, 234), 4: (255, 242, 0)}
if '--pink-paved' in sys.argv: PAINT = {3: (255, 174, 201), 2: (237, 28, 36)}   # ピンク = アスファルト(コース以外)、赤 = 芝生 だけの絵
R3 = np.array(d['route']); n = len(R3)
# コースの濃いグレー(塗った所も「不明」として距離 0 にしない)
dark = ((J.max(2) - J.min(2) < 14) & (J.mean(2) > 70) & (J.mean(2) < 96)).astype(np.uint8)
dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
dt = np.minimum(ndimage.distance_transform_edt(1 - dark), 25)
def proj(p, X):   # p: カメラ x, z, 高さ, 向き, 焦点(画素)。X: (N,3) x,y,z
    cx, cz, h, th, f = p; c, s = math.cos(th), math.sin(th); dx, dz = X[:, 0] - cx, X[:, 2] - cz; k = f / (h - X[:, 1])
    return Ww / 2 + (dx * c - dz * s) * k, Hh / 2 + (dx * s + dz * c) * k
def cost(p):
    u, v = proj(p, R3); out = ((u < 0) | (u > Ww - 1) | (v < 0) | (v > Hh - 1))
    return ndimage.map_coordinates(dt, [np.clip(v, 0, Hh - 1), np.clip(u, 0, Ww - 1)], order=1).mean() + out.mean() * 25
best = None; f0 = Hh / 2 / math.tan(math.radians(30))
for th in np.radians(np.arange(0, 360, 4)):
    for h in np.geomspace(400, 2500, 24):
        for cx in range(-300, 301, 100):
            for cz in range(-300, 301, 100):
                c = cost([cx, cz, h, th, f0])
                if best is None or c < best[0]: best = (c, [cx, cz, h, th, f0])
r = optimize.minimize(cost, best[1], method='Nelder-Mead', options={'maxiter': 20000, 'xatol': 1e-4, 'fatol': 1e-6})
r = optimize.minimize(cost, r.x, method='Nelder-Mead', options={'maxiter': 20000, 'xatol': 1e-4, 'fatol': 1e-6}); p = r.x
print('合わせのずれ', round(r.fun, 2), 'px  カメラ', np.round(p, 2))
# 地図の升目(1m)ごとに、地面の高さつきで絵の画素を引く
L = d['landcover']; W, H = L['W'], L['H']; G = d['ground']
gh = cv2.resize((np.array(G['h'], np.float32) / 10).reshape(G['nz'], G['nx']), (W + 1, H + 1), interpolation=cv2.INTER_LINEAR)[:H, :W]
xs, zs = np.meshgrid(np.arange(W) + L['x0'] + 0.5, np.arange(H) + L['z0'] + 0.5)
# コースの近くは路面の高さ(js と同じ考え方)
road = np.ones((H, W), np.uint8); Rp = np.round(R3[:, [0, 2]] - [L['x0'], L['z0']]).astype(int); road[np.clip(Rp[:, 1], 0, H - 1), np.clip(Rp[:, 0], 0, W - 1)] = 0
dist, idx = ndimage.distance_transform_edt(road, return_indices=True)
ry = np.zeros((H, W), np.float32); ry[Rp[:, 1].clip(0, H - 1), Rp[:, 0].clip(0, W - 1)] = R3[:, 1]; ry = ry[idx[0], idx[1]]
wide = np.zeros((H, W), np.float32); wide[Rp[:, 1].clip(0, H - 1), Rp[:, 0].clip(0, W - 1)] = 8.7 + np.maximum(d['runL'], d['runR']); wide = wide[idx[0], idx[1]]
t = np.clip((dist - wide - 12) / 30, 0, 1); t = t * t * (3 - 2 * t); y = ry * (1 - t) + gh * t
u, v = proj(p, np.stack([xs.ravel(), y.ravel(), zs.ravel()], 1)); u = u.reshape(H, W).astype(np.float32); v = v.reshape(H, W).astype(np.float32)
ov = np.zeros((H, W), np.uint8)
for k, rgb in PAINT.items():
    m = near(rgb).astype(np.uint8)
    m = cv2.dilate(m, np.ones((3, 3), np.uint8))   # 塗りのふちのにじみ
    ov[cv2.remap(m * 255, u, v, cv2.INTER_LINEAR, borderValue=0) > 127] = k
old = ROOT / 'tools/fuji/paint/area_overrides.png'
if old.exists() and '--add' in sys.argv: prev = cv2.imread(str(old), 0); ov = np.where(ov > 0, ov, prev)
cv2.imwrite(str(old), ov)
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png'))
msrc = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda key: tuple(int(q) for q in msrc.split(f"'{key}': (")[1].split(')')[0].split(','))
COL = {1: (75, 73, 71), 2: col('grass'), 3: col('paved'), 4: col('parking')}
for k, c in COL.items(): lc[ov == k] = c; print(k, int((ov == k).sum()), 'm2')
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
# コースにした所がコースのすぐ横なら、縁石のない帯(グレー)も路面の色にする → roadL / roadR
T = np.roll(R3[:, [0, 2]], -2, 0) - np.roll(R3[:, [0, 2]], 2, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NR = np.stack([T[:, 1], -T[:, 0]], 1)
for sg, key in ((1, 'roadL'), (-1, 'roadR')):
    q = np.round(R3[:, [0, 2]] + sg * NR * 10.5 - [L['x0'], L['z0']]).astype(int)
    d[key] = (ov[q[:, 1].clip(0, H - 1), q[:, 0].clip(0, W - 1)] == 1).astype(int).tolist()
(ROOT / 'map/fuji-course.json').write_text(json.dumps(d, separators=(',', ':')))
if DBG:
    a = I.copy(); uu, vv = proj(p, R3); cv2.polylines(a, [np.stack([uu, vv], 1).astype(np.int32)], True, (0, 255, 255), 1); cv2.imwrite(str(DBG / 'ap_fit.png'), a)
    cv2.imwrite(str(DBG / 'ap_back.png'), cv2.remap(I, u, v, cv2.INTER_LINEAR))
