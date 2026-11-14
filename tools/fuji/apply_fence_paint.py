"""富士スピードウェイ: 画面に描いた線で柵を直す。オレンジ (255,201,14) の線に沿った既存の柵をなくし、赤 (237,28,36) の線に沿って柵を立てる。
python3 tools/fuji/apply_fence_paint.py 絵.png 基準の描画.png カメラ.json
絵と基準の描画(同じ場所を真上から描いたもの)を特徴点で合わせ、線の画素を地図の座標に直す。
赤の線は、まっすぐな所はまっすぐになるよう折れ線にまとめる(誤差 1m)。建物にかかる所には柵を立てない。
→ map/fuji-course.json の fences
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
P = cv2.imread(sys.argv[1]); A = cv2.imread(sys.argv[2]); cam = json.loads(Path(sys.argv[3]).read_text())
J = P.astype(int); near = lambda rgb: (np.abs(J - np.array(rgb[::-1])).max(2) <= 30).astype(np.uint8)
red, org = near((237, 28, 36)), near((255, 201, 14))
def biggest(m, keep=1):   # 線のかたまりのうち大きいものだけ(画面の赤い車などを拾わない)
    n, cc, st, _ = cv2.connectedComponentsWithStats(cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)))
    ids = [i for i in np.argsort(-st[:, cv2.CC_STAT_AREA]) if i != 0][:keep]
    return np.isin(cc, [i for i in ids if st[i, cv2.CC_STAT_AREA] > 200]).astype(np.uint8)
red, org = biggest(red), biggest(org, 2)
mask = (cv2.dilate(red | org, np.ones((9, 9), np.uint8)) == 0).astype(np.uint8) * 255
sf = cv2.SIFT_create(20000); k1, d1 = sf.detectAndCompute(cv2.cvtColor(P, cv2.COLOR_BGR2GRAY), mask); k2, d2 = sf.detectAndCompute(cv2.cvtColor(A, cv2.COLOR_BGR2GRAY), None)
g = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
Hm, inl = cv2.findHomography(np.float32([k1[a.queryIdx].pt for a in g]), np.float32([k2[a.trainIdx].pt for a in g]), cv2.RANSAC, 4)
print('合わせ', len(g), '点 うち', int(inl.sum()))
Wp, Hp = cam['W'], cam['H']; pos = np.array(cam['pos'], float); U = np.array([cam['up'][0], cam['up'][2]], float); U /= np.linalg.norm(U); Rt = np.array([-U[1], U[0]])
f = Hp / 2 / math.tan(math.radians(cam.get('fov', 60) / 2)); R = np.array(d['route'])
def to_world(px):
    q = cv2.perspectiveTransform(np.float32(px).reshape(-1, 1, 2), Hm)[:, 0]; out = []
    for u, v in q:
        y = 0
        for _ in range(3):
            k = (pos[1] - y) / f; a, b = (u - Wp / 2) * k, -(v - Hp / 2) * k
            x, z = pos[0] + a * Rt[0] + b * U[0], pos[2] + a * Rt[1] + b * U[1]
            y = R[np.argmin((R[:, 0] - x) ** 2 + (R[:, 2] - z) ** 2), 1]
        out.append([x, z])
    return np.array(out)
def line_of(m):   # 太い線 → 中心の折れ線(線の向きに沿って並べる)
    ys, xs = np.nonzero(m); pts = np.stack([xs, ys], 1).astype(np.float64)
    c = pts.mean(0); _, _, vt = np.linalg.svd(pts - c); t = (pts - c) @ vt[0]
    order = np.argsort(t); pts, t = pts[order], t[order]
    bins = np.arange(t.min(), t.max() + 4, 4); out = []
    for a, b in zip(bins[:-1], bins[1:]):
        s = (t >= a) & (t < b)
        if s.any(): out.append(pts[s].mean(0))
    return np.array(out)
# オレンジ: その線から 4m 以内の柵の点をなくす(柵を切る)
og = unary_union([LineString(to_world(line_of(org * (cc_ == i)))).buffer(4.0) for cc_ in [cv2.connectedComponents(org)[1]] for i in range(1, org.max() and cv2.connectedComponents(org)[0])])
newf = []
for L in d['fences']:
    run = []
    for p in L:
        if og.contains(Point(p)):
            if len(run) >= 2: newf.append(run)
            run = []
        else: run.append(p)
    if len(run) >= 2: newf.append(run)
cut = sum(len(L) for L in d['fences']) - sum(len(L) for L in newf)
# 赤: 新しい柵。折れ線にまとめ、建物(と 1.5m の余白)にかかる所は切る
rp = to_world(line_of(red)); rl = LineString(rp).simplify(1.0)
bl = unary_union([Polygon(b['p']).buffer(1.5) for b in d['buildings'] if len(b['p']) >= 3])
free = rl.difference(bl)
parts = list(free.geoms) if hasattr(free, 'geoms') else [free]
added = 0
for g2 in parts:
    if g2.length < 3: continue
    pts = np.array(g2.segmentize(2.0).coords); newf.append([[round(float(x), 2), round(float(z), 2)] for x, z in pts]); added += g2.length
d['fences'] = newf; F.write_text(json.dumps(d, separators=(',', ':')))
print('なくした柵の点', cut, ' 新しい柵', round(added), 'm', len(parts), '本')
