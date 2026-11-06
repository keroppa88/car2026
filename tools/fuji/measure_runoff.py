"""富士スピードウェイ: 空撮から、コースの両側のアスファルトの幅と縁石のある所を測る。

python3 tools/fuji/measure_runoff.py 全体の空撮.png [全体2.png ...] --zoom 拡大1.png 拡大2.png ...   (make_fuji.py のあとに)

1. 全体の空撮(真上・コース全体が入ったもの): 本コースの線を空撮のアスファルトに合わせて、地図→空撮の対応を自動で求める。
2. 拡大した空撮: 全体の空撮と特徴点で照合して位置を求める(地図→全体→拡大)。拡大は 1画素 約0.5m と細かいので、
   写っている所は拡大の測り方を使う(何枚かに写っていれば中央値)。写っていない所は全体の空撮の平均。
3. 測り方: コースの点(3m ごと)で、縁石の外から外へ少しずつ見て、灰色(アスファルト)が続く所まで(3.5m までの切れ目は越える)。
   縁石: コースの縁から 0〜1.5m に赤い画素が多ければ「縁石あり」(拡大の空撮で見えた所だけ)。
→ map/fuji-course.json の runL / runR(進む向きの左 L・右 R の幅 m)、kerbL / kerbR(1 = 縁石あり)

空撮の画像は地図サービスのものなので、リポジトリには入れない。測った数字だけを残す。
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'
args = sys.argv[1:]
zoom = args[args.index('--zoom') + 1:] if '--zoom' in args else []
overview = args[:args.index('--zoom')] if '--zoom' in args else args
d = json.loads(F.read_text()); R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R)
HALF = 7.5          # 路面の半分
KERB = 1.2          # 縁石の幅
NRM = []
for i in range(n):
    a, b = R[(i - 2) % n], R[(i + 2) % n]; dx, dz = b - a; l = math.hypot(dx, dz); NRM.append((dz / l, -dx / l))
NRM = np.array(NRM)


def gray_mask(I):
    I = cv2.medianBlur(I, 3).astype(int)
    lum, sat = I.mean(2), I.max(2) - I.min(2)
    return ((lum > 38) & (lum < 135) & (sat < 28)).astype(np.uint8)


def red_mask(I):
    b, g, r = [I[..., k].astype(int) for k in range(3)]
    return ((r > 120) & (r > g + 45) & (r > b + 45)).astype(np.float32)


def fit_overview(path):
    """地図 (x, z) → 空撮の画素 (u, v) の 3x3 行列"""
    raw = gray_mask(cv2.imread(path)); H, W = raw.shape
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
            q = proj([th, s, 0, 0])
            if (q.max(0) - q.min(0) > [W, H]).any(): continue
            p = [th, s, W / 2 - q[:, 0].mean(), H / 2 - q[:, 1].mean()]
            for ox in range(-150, 151, 30):
                for oy in range(-90, 91, 30):
                    pp = [p[0], p[1], p[2] + ox, p[3] + oy]; c = cost(pp)
                    if best is None or c < best[0]: best = (c, pp)
    r = optimize.minimize(cost, best[1], method='Nelder-Mead', options={'maxiter': 5000, 'xatol': 1e-5, 'fatol': 1e-4})
    th, s, tx, ty = r.x; c, sn = math.cos(th), math.sin(th)
    print(Path(path).name, '合わせのずれ', round(r.fun, 2), 'px  1px =', round(1 / s, 2), 'm')
    return np.array([[c * s, -sn * s, tx], [sn * s, c * s, ty], [0, 0, 1]])


def measure(path, T, step=0.5, margin=0, want_kerb=False):
    """T: 地図→画像。返す: 幅 L/R(写っていない点は nan)、縁石 L/R(nan/0/1)"""
    I = cv2.imread(path); Hh, Ww = I.shape[:2]
    m = cv2.GaussianBlur(gray_mask(I).astype(np.float32), (5, 5), 0)
    red = cv2.GaussianBlur(red_mask(I), (3, 3), 0) if want_kerb else None
    def uv(x, z):
        p = T @ np.array([x, z, 1.0]); return p[0] / p[2], p[1] / p[2]
    def inside(u, v): return margin <= u <= Ww - 1 - margin and margin <= v <= Hh - 1 - margin
    def at(img, x, z):
        u, v = uv(x, z)
        if not inside(u, v): return None
        return ndimage.map_coordinates(img, [[v], [u]], order=1)[0]
    out = {k: np.full(n, np.nan) for k in ('L', 'R', 'kL', 'kR')}
    for i in range(n):
        nx, nz = NRM[i]
        for side, sg in (('L', 1), ('R', -1)):
            if not inside(*uv(R[i, 0] + sg * nx * (HALF + 60), R[i, 1] + sg * nz * (HALF + 60))) and not inside(*uv(R[i, 0] + sg * nx * (HALF + 20), R[i, 1] + sg * nz * (HALF + 20))):
                continue
            if at(m, R[i, 0], R[i, 1]) is None: continue
            last, gap, dd, ok = HALF + KERB, 0, HALF + KERB, True
            while dd < HALF + KERB + 80:
                dd += step
                q = at(m, R[i, 0] + sg * nx * dd, R[i, 1] + sg * nz * dd)
                if q is None: ok = False; break     # 画像の外に出た: 測れない
                if q > 0.5: last, gap = dd, 0
                else:
                    gap += step
                    if gap > 3.5: break
            if ok: out[side][i] = last - HALF - KERB
            if want_kerb:
                vals = [at(red, R[i, 0] + sg * nx * o, R[i, 1] + sg * nz * o) for o in np.arange(HALF - 0.3, HALF + 1.6, 0.25)]
                vals = [v for v in vals if v is not None]
                if vals: out['k' + side][i] = float(np.mean(vals))
    return out


Ts = [(p, fit_overview(p)) for p in overview]
base = [measure(p, T) for p, T in Ts]
runs = {k: np.nanmean([b[k] for b in base], 0) for k in ('L', 'R')}
# 拡大の空撮: 全体の空撮と照合
sift = cv2.SIFT_create(12000)
ref = [(p, T, *sift.detectAndCompute(cv2.imread(p, 0), None)) for p, T in Ts]
zl = {k: [] for k in ('L', 'R', 'kL', 'kR')}
for zp in zoom:
    k1, d1 = sift.detectAndCompute(cv2.imread(zp, 0), None); best = None
    for p, T, k2, d2 in ref:
        g = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
        if len(g) < 12: continue
        Hz, inl = cv2.findHomography(np.float32([k1[a.queryIdx].pt for a in g]), np.float32([k2[a.trainIdx].pt for a in g]), cv2.RANSAC, 3)
        if Hz is not None and (best is None or inl.sum() > best[0]): best = (int(inl.sum()), Hz, T)
    if not best or best[0] < 40:
        print(Path(zp).name, '照合できない'); continue
    Tz = np.linalg.inv(best[1]) @ best[2]     # 地図 → 全体 → 拡大
    r = measure(zp, Tz, step=0.25, margin=40, want_kerb=True)
    print(Path(zp).name, '照合', best[0], '点  測れた所', int(np.isfinite(r['L']).sum() + np.isfinite(r['R']).sum()))
    for k in zl: zl[k].append(r[k])
for side in ('L', 'R'):
    if zl[side]:
        z = np.nanmedian(np.array(zl[side]), 0)
        runs[side] = np.where(np.isfinite(z), z, runs[side])
    w = ndimage.uniform_filter1d(ndimage.median_filter(np.nan_to_num(runs[side], nan=8.0), size=7, mode='wrap'), 5, mode='wrap')
    d['run' + side] = np.clip(w, 1.0, 80).round(1).tolist()
    if zl['k' + side]:
        kv = np.nanmax(np.array(zl['k' + side]), 0)
        seen = np.isfinite(kv)
        kb = np.where(seen, kv > 0.12, True)       # 見えない所は縁石あり(今まで通り)
        kb = ndimage.binary_closing(ndimage.binary_opening(kb, np.ones(3)), np.ones(5))   # 細かい切れ・点を整える
        d['kerb' + side] = kb.astype(int).tolist()
        print(side, '縁石あり', int(kb.sum()), '/', n, ' 拡大で見えた点', int(seen.sum()))
F.write_text(json.dumps(d, separators=(',', ':')))
print('左', np.percentile(d['runL'], [5, 50, 95]), '右', np.percentile(d['runR'], [5, 50, 95]))
