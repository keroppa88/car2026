"""富士スピードウェイ: つなぎ合わせた空撮 1 枚 + OSM から、地面の塗り分け図(1画素 = 1m、北が上)を作る → map/fuji-landcover.png
python3 tools/fuji/make_landcover_mosaic.py 空撮.png [確認用の出力フォルダ]
1. コースの線を空撮のアスファルトに合わせる(回転・縮尺・位置)。空撮の真っ白な所は「写っていない」= 前の塗り分けを使う。
2. 色で分ける: 舗装 / 草地 / 森 / 砂地。赤い大きなかたまり(ピット出入口の縞の三角)は赤白の縞。
3. OSM で上書き: 駐車場、建物、観客席、砂地。
色はあとで変えやすいよう原色(COL)。コースの路面は js が上に描く。空撮はリポジトリに入れない。
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from lxml import etree
from scipy import ndimage, optimize
ROOT = Path(__file__).resolve().parents[2]
F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text()); R = np.array([[p[0], p[2]] for p in d['route']])
I = cv2.imread(sys.argv[1]); DBG = Path(sys.argv[2]) if len(sys.argv) > 2 else None
ASPH_GB, ASPH_RB = 4, 8   # アスファルトとみなす色の幅(緑-青、赤-青)
COL = {  # BGR。アニメ調の基本色
    'paved': (140, 138, 137),   # 薄いグレー: アスファルト(コース以外)
    'grass': (120, 200, 150),   # 黄緑: 草地
    'forest': (60, 120, 60),    # 緑: 森
    'sand': (150, 196, 214),    # ベージュ: 砂地
    'parking': (124, 120, 118), # 少し濃いグレー: 駐車場
    'building': (108, 104, 102),# 建物の下
    'stand': (108, 104, 102),   # 観客席の下
}
KEYS = list(COL); ID = {k: i for i, k in enumerate(KEYS)}

# 1. 合わせる
def gray(J):
    J = cv2.medianBlur(J, 3).astype(int); lum = J.mean(2); sat = J.max(2) - J.min(2)
    return cv2.morphologyEx(((lum > 38) & (lum < 150) & (sat < 30)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
def dtof(f): return ndimage.distance_transform_edt(1 - gray(cv2.resize(I, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)))
dt = dtof(0.25); H, W = dt.shape; Rs = R[::8]; best = None
for th in np.radians(np.arange(-8, 8.1, 1)):
    c, sn = math.cos(th), math.sin(th); B = np.stack([Rs[:, 0] * c - Rs[:, 1] * sn, Rs[:, 0] * sn + Rs[:, 1] * c], 1)
    for s in np.geomspace(0.35, 0.8, 28):
        q = B * s; mn, mx = q.min(0), q.max(0)
        txs = np.arange(-mn[0], W - 1 - mx[0], 6); tys = np.arange(-mn[1], H - 1 - mx[1], 6)
        if not len(txs) or not len(tys): continue
        TX, TY = np.meshgrid(txs, tys)
        cst = np.minimum(dt[(q[:, 1] + TY[..., None]).round().astype(int), (q[:, 0] + TX[..., None]).round().astype(int)], 15).mean(2)
        k = np.unravel_index(cst.argmin(), cst.shape)
        if best is None or cst[k] < best[0]: best = (cst[k], [th, s * 2, TX[k] * 2, TY[k] * 2])
dt = dtof(0.5); H, W = dt.shape
def proj(p):
    th, s, tx, ty = p; c, sn = math.cos(th), math.sin(th)
    return np.stack([(R[:, 0] * c - R[:, 1] * sn) * s + tx, (R[:, 0] * sn + R[:, 1] * c) * s + ty], 1)
def cost(p):
    q = proj(p); return np.minimum(ndimage.map_coordinates(dt, [np.clip(q[:, 1], 0, H - 1), np.clip(q[:, 0], 0, W - 1)], order=1), 20).mean()
r = optimize.minimize(cost, best[1], method='Nelder-Mead', options={'maxiter': 8000, 'xatol': 1e-6, 'fatol': 1e-5})
th, s, tx, ty = r.x; c, sn = math.cos(th), math.sin(th)
T = np.array([[c * s * 2, -sn * s * 2, tx * 2], [sn * s * 2, c * s * 2, ty * 2], [0, 0, 1]])   # 地図 → 空撮の画素
print('合わせのずれ', round(r.fun, 3), 'px  1px =', round(0.5 / s, 3), 'm')

# 2. 地図の升目(1m)に直して色で分ける
G = d['ground']; x0, z0 = G['x0'], G['z0']; W = int((G['nx'] - 1) * G['cell']); H = int((G['nz'] - 1) * G['cell'])
Pinv = np.array([[1, 0, x0], [0, 1, z0], [0, 0, 1.0]])
img = cv2.warpPerspective(I, T @ Pinv, (W, H), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP, borderValue=(255, 255, 255))
blank = cv2.erode((I.min(2) < 250).astype(np.uint8), np.ones((9, 9), np.uint8))
have = cv2.warpPerspective(blank, T @ Pinv, (W, H), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP) > 0
A = cv2.GaussianBlur(img, (3, 3), 0).astype(np.float32); b, g, r_ = A[..., 0], A[..., 1], A[..., 2]; lum = A.mean(2)
mu = cv2.blur(lum, (9, 9)); sd = np.sqrt(np.maximum(cv2.blur(lum * lum, (9, 9)) - mu * mu, 0))
sand = (cv2.blur(r_ - g, (5, 5)) > 7) & (cv2.blur(r_ - b, (5, 5)) > 20) & (mu > 150)
veg = (cv2.blur(g - b, (5, 5)) > 12) & ~sand
# 舗装は「はっきりしたアスファルト」(青み〜無彩色のグレー)だけ。枯れ草・土など黄みのある微妙な所は草地にする。
# ホームストレートのまわり(130m 以内)は今まで通り
asph = (cv2.blur(g - b, (5, 5)) < ASPH_GB) & (cv2.blur(r_ - b, (5, 5)) < ASPH_RB)
hs = np.ones((H, W), np.uint8); st0 = d['start']; cv2.polylines(hs, [(R[np.arange(st0 - 110, st0 + 240) % len(R)] - [x0, z0]).astype(np.int32)], False, 0, 1)
nearHome = cv2.distanceTransform(hs, cv2.DIST_L2, 5) < 130
veg0 = veg.copy(); veg = veg | (~asph & ~sand & ~nearHome)
forest = veg0 & ((mu < 118) | (sd > 13))
lab = np.full((H, W), ID['paved'], np.uint8)
lab[veg] = ID['grass']; lab[forest] = ID['forest']
lab[sand] = ID['sand']
for k in (7, 7, 5): lab = cv2.medianBlur(lab, k)
# 森の中の影(暗い所)は森に: 森に囲まれた小さな舗装を埋める
fz = (lab == ID['forest']).astype(np.uint8)
lab[(cv2.morphologyEx(fz, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8)) > 0) & (lab == ID['paved']) & (mu < 75)] = ID['forest']
# 細い森(柵の影など)は草地に、小さい砂地(枯れ草のむら)も草地に
fz = (lab == ID['forest']).astype(np.uint8)
lab[(fz > 0) & (cv2.dilate(cv2.morphologyEx(fz, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))), np.ones((7, 7), np.uint8)) == 0)] = ID['grass']
n, cc, st, _ = cv2.connectedComponentsWithStats((lab == ID['sand']).astype(np.uint8))
lab[np.isin(cc, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] < 300])] = ID['grass']
# 赤い大きなかたまり = 縞の三角
red = ((r_ > 130) & (r_ > g + 40) & (r_ > b + 30)).astype(np.uint8)
red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)); n, cc, st, _ = cv2.connectedComponentsWithStats(red)
redmask = np.zeros((H, W), bool); chev = []
for i in range(1, n):
    ar = st[i, cv2.CC_STAT_AREA]
    if ar > 300 and min(st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]) > 5 and ar > 0.25 * st[i, cv2.CC_STAT_WIDTH] * st[i, cv2.CC_STAT_HEIGHT]:
        cen = np.array([st[i, 0] + st[i, 2] / 2 + x0, st[i, 1] + st[i, 3] / 2 + z0]); dr = np.hypot(*(R - cen).T)
        if dr.min() > 30: continue     # コースのそばだけ(赤い屋根や車を除く)
        print(' コースの点', int(dr.argmin()), end=' ')
        m1 = (cc == i).astype(np.uint8); redmask |= m1 > 0
        cn = max(cv2.findContours(m1, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0], key=cv2.contourArea)
        cn = cv2.approxPolyDP(cn, 1.5, True)[:, 0]
        chev.append([[round(float(x + x0), 1), round(float(y + z0), 1)] for x, y in cn]); print('赤白の縞', chev[-1][0], ar, 'm2')
# 写っていない所は前の塗り分け(舗装・芝・木)
old = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); 
if DBG and (DBG / 'landcover_old.png').exists(): old = cv2.imread(str(DBG / 'landcover_old.png'))
ol = np.full((H, W), ID['forest'], np.uint8)
if old is not None and old.shape[:2] == (H, W):
    og = old[..., 1].astype(int) - old[..., 0]
    ol = np.where(old[..., 1].astype(int) - old[..., 2] > 20, np.where(old[..., 1] > 140, ID['grass'], ID['forest']), ID['paved']).astype(np.uint8)
lab[~have] = ol[~have]; lab[redmask] = ID['paved']

# 3. OSM
lat0, lon0 = d['origin']; KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
N, polys, ways = {}, [], []
for _, e in etree.iterparse(str(ROOT / 'tools/fuji/fuji.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = ((float(e.get('lon')) - lon0) * KX - x0, -(float(e.get('lat')) - lat0) * KZ - z0)
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}; nd = [n.get('ref') for n in e.findall('nd')]
        k = ('stand' if t.get('building') == 'grandstand' or t.get('leisure') == 'bleachers' else 'building' if 'building' in t
             else 'parking' if t.get('amenity') in ('parking', 'motorcycle_parking') else 'sand' if t.get('natural') == 'sand' else None)
        if t.get('highway') in ('service', 'tertiary', 'residential', 'raceway', 'unclassified', 'track'): ways.append(np.array([N[q] for q in nd if q in N], np.int32))
        if k and len(nd) > 3 and nd[0] == nd[-1]: polys.append((k, np.array([N[q] for q in nd], np.int32)))
# せまい舗装(幅 8m 未満の切れ端、コースのふちの細いグレー)は草地にする。OSM にある道路・分かれ道のまわりは残す
course = np.zeros((H, W), np.uint8); cv2.polylines(course, [(R - [x0, z0]).astype(np.int32)], True, 1, 18)
keep = np.zeros((H, W), np.uint8)
for wy in ways: cv2.polylines(keep, [wy], False, 1, 8)
for b in d.get('branches', []): cv2.polylines(keep, [(np.array(b['pts']) - [x0, z0]).astype(np.int32)], False, 1, int(b['w']) + 4)
pv = ((lab == ID['paved']) & (course == 0)).astype(np.uint8)
wide = cv2.dilate(cv2.morphologyEx(pv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (8, 8))), np.ones((5, 5), np.uint8))
thin = (pv > 0) & (wide == 0) & (keep == 0) & have
lab[thin] = ID['grass']; print('せまい舗装 → 草地', int(thin.sum()), 'm2')
# コースのそばの小さな舗装のかたまり(800m2 未満、コースから 40m 以内)は草地。OSM の道路のまわりは残す
pv2 = ((lab == ID['paved']) & (course == 0)).astype(np.uint8)
ncc, cc2, st2, _ = cv2.connectedComponentsWithStats(pv2, connectivity=4)
rl = np.ones((H, W), np.uint8); cv2.polylines(rl, [(R - [x0, z0]).astype(np.int32)], True, 0, 1)
smallp = np.isin(cc2, [i for i in range(1, ncc) if st2[i, cv2.CC_STAT_AREA] < 800]) & (cv2.distanceTransform(rl, cv2.DIST_L2, 5) < 40) & (keep == 0) & have
lab[smallp] = ID['grass']; print('コースのそばの小さな舗装 → 草地', int(smallp.sum()), 'm2')
for want in ('sand', 'parking', 'building', 'stand'):
    for k, p in polys:
        if k == want: cv2.fillPoly(lab, [p], ID[k])
out = np.array([COL[k] for k in KEYS], np.uint8)[lab]
# 赤白の縞(V字)は js が板で描く。向き = ホームストレートの向き
st_i = d['start']; dx, dz = R[(st_i + 5) % len(R)] - R[st_i]; l = math.hypot(dx, dz)
# ピット入口の細い縞(空撮では薄くて自動で拾えない): コースの点 1436〜1445 の右 10〜13.5m
def side_pt(i, o):
    a, b = R[(i - 2) % len(R)], R[(i + 2) % len(R)]; ex, ez = b - a; ll = math.hypot(ex, ez); p = R[i % len(R)]
    return [round(float(p[0] + ez / ll * o), 1), round(float(p[1] - ex / ll * o), 1)]
chev.append([side_pt(1436, -10.3), side_pt(1445, -10.3), side_pt(1445, -13.5), side_pt(1436, -13.5)])
if 'chevrons' not in d: d['chevrons'] = [{'p': c, 'dir': [round(dx / l, 4), round(dz / l, 4)]} for c in chev]
# 絵で直した所(tools/fuji/apply_area_paint2.py)を重ねる
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'
if ovp.exists():
    ov = cv2.imread(str(ovp), 0)
    for k, c in {1: (75, 73, 71), 2: COL['grass'], 3: COL['paved'], 4: COL['parking'], 5: (206, 206, 204)}.items(): out[ov == k] = c
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), out)
d['landcover'] = {'x0': x0, 'z0': z0, 'px': 1.0, 'W': W, 'H': H}; F.write_text(json.dumps(d, separators=(',', ':')))
for k in KEYS: print(k, round(float((lab == ID[k]).mean()) * 100, 1), '%')
if DBG:
    Rp = (R - [x0, z0]).astype(np.int32)
    a = img.copy(); cv2.polylines(a, [Rp], True, (0, 255, 255), 1); o = out.copy(); cv2.polylines(o, [Rp], True, (40, 40, 40), 15)
    cv2.imwrite(str(DBG / 'lc_cmp.png'), np.hstack([a, o])); cv2.imwrite(str(DBG / 'mosaic_map.png'), img)
