"""赤城山: ガードレールの直し(3 回目)。中盤〜後半(絵 c とその左下の枠 d。1 画素 = 約 1.4m で、道幅が 7 画素ほどしかない)は、
点ごとに「近い側」で決めると線が左右に飛んで切れる。塗った線(赤・青・オレンジをまとめて 1 本)ごとに、道の中心線からの横のずれを
前後 60m でならして側を決める(1 本の線は、はっきり反対側へ移らないかぎり同じ側)。両側に塗ってある所(幅が広い)は両側。
python3 tools/akagi/apply_rail_paint3.py FROM 絵,絵 [TO]  (FROM 番から TO 番の手前までの点だけ置きかえる)
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
from scipy.spatial import cKDTree
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi/paint'
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); R = np.array(data['route']); n = len(R)
FROM = int(sys.argv[1])
def proj(M, X): q = np.c_[X, np.ones(len(X))] @ M.T; return q[:, :2] / q[:, 2:3]
want = np.zeros((2, n), bool); seen = np.zeros(n, bool)   # 0: 左(進む向きの左)、1: 右
for name in sys.argv[2].split(','):
    M = np.array(json.loads((P / f'cam_{name}.json').read_text())['M']); im = cv2.imread(str(P / f'{name}.png')).astype(int); Hh, Ww = im.shape[:2]
    b, g, r = im[..., 0], im[..., 1], im[..., 2]
    paint = ((b > 150) & (r < 130) & (g > 100)) | ((r > 190) & (g > 110) & (g < 210) & (b < 90)) | ((r > 150) & (g < 100) & (b < 100))
    uv = proj(M, R); ok = (uv[:, 0] >= 0) & (uv[:, 0] < Ww) & (uv[:, 1] >= 0) & (uv[:, 1] < Hh)
    ok &= (im[np.clip(uv[:, 1].astype(int), 0, Hh - 1), np.clip(uv[:, 0].astype(int), 0, Ww - 1)] < 250).any(1)
    idx = np.nonzero(ok)[0]; seen[idx] = True
    t = np.gradient(uv, axis=0); t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-9
    ppm = np.linalg.norm(np.gradient(uv, axis=0), axis=1) / 3.0   # 1m が何画素か(点の間隔は 3m)
    tree = cKDTree(uv[idx])
    ys, xs = np.nonzero(paint); dd, k = tree.query(np.c_[xs, ys]); i = idx[k]
    keep = dd < 12 * ppm[i]; xs, ys, i = xs[keep], ys[keep], i[keep]
    # 横のずれ(m)。画面は y が下向きなので、進む向きの左 = (t.y, -t.x)
    off = ((xs - uv[i, 0]) * t[i, 1] - (ys - uv[i, 1]) * t[i, 0]) / ppm[i]
    lo = np.full(n, np.nan); hi = np.full(n, np.nan); mean = np.full(n, np.nan)
    for j in np.unique(i):
        o = off[i == j]; lo[j], hi[j], mean[j] = o.min(), o.max(), o.mean()
    has = ~np.isnan(mean)
    both = has & (hi - lo > 11.0)                 # 両側に塗ってある(線 1 本の幅は 5 画素 ≒ 7m まで)
    # 片側の所: 平均のずれを前後 60m(±20 点)の中央値でならして側を決める
    m2 = np.where(has & ~both, mean, np.nan); sm = np.full(n, np.nan)
    for j in np.nonzero(has & ~both)[0]:
        w = m2[max(0, j - 20):j + 21]; w = w[~np.isnan(w)]; sm[j] = np.median(w)
    want[0] |= both | (sm > 0); want[1] |= both | (sm < 0)
    print(name, '写った点', len(idx), ' 塗りのある点', int(has.sum()), ' 両側', int(both.sum()), ' 左だけ', int((sm > 0).sum()), ' 右だけ', int((sm < 0).sum()))
for si, key in enumerate(('railL', 'railR')):
    old = np.array(data[key]); f = want[si].copy()
    f = ndimage.binary_closing(f, np.ones(9))               # 24m 以下の切れ目はつなぐ
    lab, k = ndimage.label(f)
    for j in range(1, k + 1):
        q = np.nonzero(lab == j)[0]
        if len(q) < 3: f[q] = False                           # 6m 以下の切れ端は消す
    g2 = np.zeros(n, bool); lab, k = ndimage.label(f)         # 支柱(偶数番)で区切る
    for j in range(1, k + 1):
        q = np.nonzero(lab == j)[0]; s0, s1 = int(round(q[0] / 2) * 2), int(round(q[-1] / 2) * 2)
        if s1 > s0: g2[s0:s1 + 1] = True
    TO = int(sys.argv[3]) if len(sys.argv) > 3 else n; rep = seen & (np.arange(n) >= FROM) & (np.arange(n) < TO)
    new = np.where(rep, g2.astype(int), old)
    lab, k = ndimage.label(new[FROM:] != 1)
    print(key, FROM, '番から先: ある', int((new[FROM:] == 1).sum()), '点(前', int((old[FROM:] == 1).sum()), ') 切れ目', k)
    data[key] = [int(v) for v in new]
(ROOT / 'map/akagi-course.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
