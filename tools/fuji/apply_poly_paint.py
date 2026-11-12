"""富士スピードウェイ: 画面に塗った絵を、色ごとの「直線で区切った多角形」にして地図に残す → map/fuji-course.json の paintPolys
python3 tools/fuji/apply_poly_paint.py 絵.png 基準の描画.png カメラ.json 色=種類 ...   (例: 赤=舗装 紫=草地 水色=砂地)
絵と基準の描画(真上から描いた同じ場所)を特徴点で合わせ、色のかたまりの輪郭を直線の多角形(誤差 3 画素)にまとめ、地図の座標に直す。
あとから足した絵ほど上に重なる。種類: 舗装 3 / 草地 2 / 砂地 6
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
P = cv2.imread(sys.argv[1]); A = cv2.imread(sys.argv[2]); cam = json.loads(Path(sys.argv[3]).read_text())
COLS = {'赤': (237, 28, 36), '紫': (163, 73, 164), '水色': (153, 217, 234), '青': (63, 72, 204), '黄': (255, 242, 0), '橙': (255, 127, 39)}
KIND = {'舗装': 3, '草地': 2, '砂地': 6}
jobs = [(COLS[a.split('=')[0]], KIND[a.split('=')[1]]) for a in sys.argv[4:]]
J = P.astype(int); near = lambda rgb: (np.abs(J - np.array(rgb[::-1])).max(2) <= 22).astype(np.uint8)
painted = np.zeros(P.shape[:2], np.uint8)
for rgb, _ in jobs: painted |= near(rgb)
mask = (cv2.dilate(painted, np.ones((9, 9), np.uint8)) == 0).astype(np.uint8) * 255
sf = cv2.SIFT_create(20000); k1, d1 = sf.detectAndCompute(cv2.cvtColor(P, cv2.COLOR_BGR2GRAY), mask); k2, d2 = sf.detectAndCompute(cv2.cvtColor(A, cv2.COLOR_BGR2GRAY), None)
g = [a for a, b in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * b.distance]
Hm, inl = cv2.findHomography(np.float32([k1[a.queryIdx].pt for a in g]), np.float32([k2[a.trainIdx].pt for a in g]), cv2.RANSAC, 4)
print('合わせ', len(g), '点 うち', int(inl.sum()))
Wp, Hp = cam['W'], cam['H']; pos = np.array(cam['pos'], float); U = np.array([cam['up'][0], cam['up'][2]], float); U /= np.linalg.norm(U); Rt = np.array([-U[1], U[0]])
f = Hp / 2 / math.tan(math.radians(cam.get('fov', 60) / 2)); R = np.array(d['route'])
def to_world(px):
    q = cv2.perspectiveTransform(np.float32(px).reshape(-1, 1, 2), Hm)[:, 0]
    out = []
    for u, v in q:
        y = 0
        for _ in range(3):
            k = (pos[1] - y) / f; a, b = (u - Wp / 2) * k, -(v - Hp / 2) * k
            x, z = pos[0] + a * Rt[0] + b * U[0], pos[2] + a * Rt[1] + b * U[1]
            y = R[np.argmin((R[:, 0] - x) ** 2 + (R[:, 2] - z) ** 2), 1]
        out.append([round(float(x), 2), round(float(z), 2)])
    return out
polys = d.get('paintPolys', [])
for rgb, kind in jobs:
    m = cv2.morphologyEx(near(rgb), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]:
        if cv2.contourArea(c) < 40: continue
        q = cv2.approxPolyDP(c, 3.0, True)[:, 0]
        polys.append({'cls': kind, 'pts': to_world(q)}); print('種類', kind, '角', len(q))
d['paintPolys'] = polys; F.write_text(json.dumps(d, separators=(',', ':')))
