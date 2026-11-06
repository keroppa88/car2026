"""富士スピードウェイ: 空撮から地面の塗り分け図(1画素 = 1m、北が上)を作る → map/fuji-landcover.png
塗り分け: 舗装(駐車場・ランオフ・道路・建物の屋根など) = 薄いグレー、芝生 = 薄い黄緑、木々 = 深い緑。
コースの路面は js 側で濃いグレーの帯を上に描く。空撮が写っていない所は木々にする。

python3 tools/fuji/make_landcover.py 全体の空撮.png --zoom 拡大1.png 拡大2.png ...   (make_fuji.py のあとに)
空撮そのものはリポジトリに入れない(塗り分けた結果だけを残す)。
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]
src = (ROOT / 'tools/fuji/measure_runoff.py').read_text()
g = {'__file__': str(ROOT / 'tools/fuji/measure_runoff.py'), '__name__': 'lib'}
argv = sys.argv; sys.argv = ['x']
exec(compile(src[:src.index("Ts = [(p, fit_overview(p))")], 'measure_runoff', 'exec'), g)   # fit_overview などを借りる
sys.argv = argv
args = sys.argv[1:]
zoom = args[args.index('--zoom') + 1:] if '--zoom' in args else []
overview = args[:args.index('--zoom')] if '--zoom' in args else args

F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text()); G = d['ground']
PX = 1.0
x0, z0 = G['x0'], G['z0']; W = int((G['nx'] - 1) * G['cell'] / PX); H = int((G['nz'] - 1) * G['cell'] / PX)
Pinv = np.array([[PX, 0, x0], [0, PX, z0], [0, 0, 1.0]])   # 図の画素 → 地図
img = np.zeros((H, W, 3), np.uint8); have = np.zeros((H, W), bool)
sift = cv2.SIFT_create(12000)
refs = []
for p in overview:
    T = g['fit_overview'](p); I = cv2.imread(p)
    w = cv2.warpPerspective(I, T @ Pinv, (W, H), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP)
    mk = np.zeros(I.shape[:2], np.uint8); mk[45:-45, 45:-45] = 255
    wm = cv2.warpPerspective(mk, T @ Pinv, (W, H), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP) > 128
    put = wm & ~have; img[put] = w[put]; have |= wm
    refs.append((T, *sift.detectAndCompute(cv2.cvtColor(I, cv2.COLOR_BGR2GRAY), None)))
for zp in zoom:   # 拡大は細かいので上書き
    Z = cv2.imread(zp); k1, d1 = sift.detectAndCompute(cv2.cvtColor(Z, cv2.COLOR_BGR2GRAY), None); best = None
    for T, k2, d2 in refs:
        gg = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
        if len(gg) < 12: continue
        Hz, inl = cv2.findHomography(np.float32([k1[a.queryIdx].pt for a in gg]), np.float32([k2[a.trainIdx].pt for a in gg]), cv2.RANSAC, 3)
        if Hz is not None and (best is None or inl.sum() > best[0]): best = (inl.sum(), Hz, T)
    if not best or best[0] < 40: print(Path(zp).name, '照合できない'); continue
    M = np.linalg.inv(best[1]) @ best[2] @ Pinv
    w = cv2.warpPerspective(Z, M, (W, H), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP)
    mk = np.zeros(Z.shape[:2], np.uint8); mk[45:-45, 45:-45] = 255
    wm = cv2.warpPerspective(mk, M, (W, H), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP) > 128
    img[wm] = w[wm]; have |= wm
# 塗り分け: 0 舗装、1 芝生、2 木々。色(緑っぽさ)と、木々のざらざら(明るさのばらつき)で分ける
I = img.astype(np.float32); b, gr, r = I[..., 0], I[..., 1], I[..., 2]
lum = I.mean(2); sat = I.max(2) - I.min(2)
mu = cv2.blur(lum, (7, 7)); sd = np.sqrt(np.maximum(cv2.blur(lum * lum, (7, 7)) - mu * mu, 0))
gb = cv2.blur(gr - b, (5, 5)); sat5 = cv2.blur(sat, (5, 5))
veg = (gb > 11) | (sat5 > 34)
lab = np.where(veg, np.where((sd > 10) | (cv2.blur(lum, (5, 5)) < 92), 2, 1), 0).astype(np.uint8)
lab[~have] = 2
for k in (7, 7, 5): lab = cv2.medianBlur(lab, k)
lab[~have] = 2
COL = np.array([[152, 154, 155], [112, 186, 160], [40, 78, 44]], np.uint8)   # BGR: 薄いグレー、薄い黄緑、深い緑
out = COL[lab]
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), out)
d['landcover'] = {'x0': x0, 'z0': z0, 'px': PX, 'W': W, 'H': H}
F.write_text(json.dumps(d, separators=(',', ':')))
print(W, H, '舗装', round((lab == 0).mean() * 100), '% 芝生', round((lab == 1).mean() * 100), '% 木々', round((lab == 2).mean() * 100), '%')
