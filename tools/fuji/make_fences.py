"""富士スピードウェイ: コースの両側の柵(白いガードレール + 金網)の線を作る → map/fuji-course.json の fences
位置: ランオフ(runL / runR)の外 3m。その先に砂地が続いていれば砂地の外 2m。前後でならす。
置かない所: ピットレーンなど分かれ道のある側、グランドスタンドの前(別に柵がある)、コースの別の所に近い所。
python3 tools/fuji/make_fences.py   (make_landcover_mosaic.py のあとに)
"""
import json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R); HALF = 7.5
L = d['landcover']; img = cv2.imread(str(ROOT / 'map/fuji-landcover.png')).astype(int)
sand = (img[..., 2] - img[..., 0] > 40) & (img[..., 2] > 180)      # ベージュ
T = np.roll(R, -2, 0) - np.roll(R, 2, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NRM = np.stack([T[:, 1], -T[:, 0]], 1)   # 左(+)
def is_sand(x, z):
    u, v = int(x - L['x0']), int(z - L['z0']); return 0 <= u < L['W'] and 0 <= v < L['H'] and sand[v, u]
def seg_dist(P, x, z):
    P = np.asarray(P, float); a, b = P[:-1], P[1:]; ab = b - a; t = np.clip(((np.array([x, z]) - a) * ab).sum(1) / np.maximum((ab * ab).sum(1), 1e-9), 0, 1)
    return np.hypot(*(a + ab * t[:, None] - [x, z]).T).min()
stand = [b['p'] + [b['p'][0]] for b in d['buildings'] if b.get('name') == 'グランドスタンド']
out = []
for sg, key in ((1, 'runL'), (-1, 'runR')):
    off = np.zeros(n)
    for i in range(n):
        o = HALF + 1.2 + max(d[key][i], 3) + 3; q = o
        while q < o + 14:                      # 砂地が続くなら、その外まで
            q += 1
            if is_sand(*(R[i] + sg * NRM[i] * q)): o = q + 2
        off[i] = min(o, 75)
    off = ndimage.uniform_filter1d(ndimage.maximum_filter1d(off, 9, mode='wrap'), 15, mode='wrap')
    ok = np.ones(n, bool); P = R + sg * NRM * off[:, None]
    for i in range(n):
        x, z = P[i]
        dd = np.hypot(*(R - P[i]).T); far = np.abs((np.arange(n) - i + n // 2) % n - n // 2) > 25
        if dd.min() < off[i] - 1.5 or dd[far].min() < HALF + 6: ok[i] = False               # コースの別の所に近い
        for b in d.get('branches', []):
            if seg_dist(b['pts'], *R[i]) < off[i] + b['w'] and seg_dist(b['pts'], x, z) < seg_dist(b['pts'], *(R[i] - sg * NRM[i] * 5)): ok[i] = False   # 分かれ道のある側
        for s in stand:
            if seg_dist(s, x, z) < 25: ok[i] = False
    ok = ndimage.binary_opening(ok, np.ones(7), origin=0) if ok.any() else ok
    i = 0; start = next((k for k in range(n) if not ok[k]), 0)
    run = []
    for k in range(start, start + n + 1):
        j = k % n
        if ok[j] and k < start + n: run.append([round(float(P[j, 0]), 1), round(float(P[j, 1]), 1)])
        else:
            if len(run) >= 8: out.append(run)
            run = []
d['fences'] = out; F.write_text(json.dumps(d, separators=(',', ':')))
print('柵', len(out), '本  合計', round(sum(sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(r, r[1:])) for r in out)), 'm')
