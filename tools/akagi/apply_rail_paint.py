"""赤城山: 空撮に赤で塗ったガードレールを、コースの点ごと・左右ごとの印(railL / railR: 1 = ある、0 = なし、-1 = 絵に写っていない)にして
map/akagi-course.json に入れる。絵のカメラは paint/cam_<絵>.json(register_rail.py → refine_rail_cam.py)。
- 赤がある所 = 今のまま、赤がない所 = 取り外し(絵に写っている範囲だけ)
- 途切れ・つなぎは支柱(3m おきの偶数の点)の所でそろえる。12m 以下のすき間は埋め、6m 以下の切れ端は消す
python3 tools/akagi/apply_rail_paint.py rail_a rail_b rail_c rail_d
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); R = np.array(data['route']); n = len(R)
d = np.gradient(R[:, [0, 2]], axis=0); nn = np.stack([d[:, 1], -d[:, 0]], 1); nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-9   # 進む向きの左
RAIL = 3.6 + 0.9 + 0.35
red = {1: np.zeros(n, bool), -1: np.zeros(n, bool)}; seen = {1: np.zeros(n, bool), -1: np.zeros(n, bool)}
for name in sys.argv[1:]:
    M = np.array(json.load(open(P / f'cam_{name}.json'))['M']); im = cv2.imread(str(P / f'{name}.png')); Hh, Ww = im.shape[:2]
    b, g, r = [im[..., c].astype(int) for c in range(3)]
    isred = ((r > 150) & (g < 100) & (b < 100)).astype(np.uint8)
    white = (im == 255).all(2)
    proj = lambda X: (lambda q: q[:, :2] / q[:, 2:3])(np.c_[X, np.ones(len(X))] @ M.T)
    for side in (1, -1):
        X = np.c_[R[:, 0] + nn[:, 0] * side * RAIL, R[:, 1] + 0.6, R[:, 2] + nn[:, 1] * side * RAIL]
        uv = proj(X); uv2 = proj(X + [nn[:, 0] * side * 2, 0, nn[:, 1] * side * 2] if False else np.c_[X[:, 0] + nn[:, 0] * side * 2, X[:, 1], X[:, 2] + nn[:, 1] * side * 2])
        scale = np.linalg.norm(uv2 - uv, axis=1) / 2   # px / m(その場所で)
        for i in range(n):
            u, v = uv[i]; rad = max(3, int(round(scale[i] * 2.5)))
            if not (rad <= u < Ww - rad and rad <= v < Hh - rad): continue
            if white[int(v), int(u)]: continue
            seen[side][i] = True
            win = isred[int(v) - rad:int(v) + rad + 1, int(u) - rad:int(u) + rad + 1]
            yy, xx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
            if (win[(xx * xx + yy * yy) <= rad * rad]).any(): red[side][i] = True
    print(name, '写っている点 左', int(seen[1].sum()), '右', int(seen[-1].sum()))
out = {}
for side, key in ((1, 'railL'), (-1, 'railR')):
    f = red[side].copy()
    # 12m 以下のすき間(写っている範囲の中)を埋める
    i = 0
    while i < n:
        if not f[i] and seen[side][i]:
            j = i
            while j < n and not f[j] and seen[side][j]: j += 1
            if 0 < i and j < n and f[i - 1] and f[j] and j - i <= 4: f[i:j] = True
            i = j
        else: i += 1
    # 6m 以下の切れ端を消す
    i = 0
    while i < n:
        if f[i]:
            j = i
            while j < n and f[j]: j += 1
            if j - i <= 2: f[i:j] = False
            i = j
        else: i += 1
    # 支柱(偶数の点)でそろえる: 始まりは手前の偶数、終わりは先の偶数へ(のばす)
    g2 = f.copy(); i = 0
    while i < n:
        if f[i]:
            j = i
            while j < n and f[j]: j += 1
            a, bq = i - (i % 2), min(n - 1, j - 1 + ((j - 1) % 2)); g2[a:bq + 1] = True; i = j
        else: i += 1
    flags = np.where(seen[side], g2.astype(int), -1)
    out[key] = flags.tolist()
    runs = []; i = 0
    while i < n:
        if flags[i] == 1:
            j = i
            while j < n and flags[j] == 1: j += 1
            runs.append((i, j - 1)); i = j
        else: i += 1
    print(key, '写っている点', int((flags >= 0).sum()), '/', n, ' ガードレール', int((flags == 1).sum()), '点', len(runs), '本', ' 写っていない点', int((flags < 0).sum()))
data.update(out); (ROOT / 'map/akagi-course.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
