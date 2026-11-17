"""絵のカメラ(3x4 行列)を、対応点(match_*.json の画素 ↔ picked_*.json の 3D 座標)から DLT + RANSAC で解く。
python3 tools/akagi/solve_rail_cam.py 絵の名前...   → paint/cam_<名前>.json
"""
import json, sys
from pathlib import Path
import numpy as np
P = Path(__file__).resolve().parent / 'paint'
def dlt(X, uv, ii):
    A = []
    for i in ii:
        x, y, z = X[i]; u, v = uv[i]
        A.append([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z, -u]); A.append([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z, -v])
    _, _, Vt = np.linalg.svd(np.array(A)); M = Vt[-1].reshape(3, 4); return M / M[2, 3]
def proj(M, Xs): q = np.c_[Xs, np.ones(len(Xs))] @ M.T; return q[:, :2] / np.where(abs(q[:, 2:3]) < 1e-9, 1e-9, q[:, 2:3])
for name in sys.argv[1:]:
    st = Path(name).stem; uv, xyz = [], []
    for mm in json.loads((P / f'match_{st}.json').read_text()):
        f = P / f'picked_{st}_{Path(mm["tile"]).stem}.json'
        if not f.exists(): continue
        for (a, q), w in zip(mm['pairs'], json.loads(f.read_text())):
            if w and w[1] < 700: uv.append(a); xyz.append(w[:3])
    uv = np.array(uv, float); X = np.array(xyz, float); N = len(uv)
    rng = np.random.default_rng(0); best, bi = None, []
    for _ in range(5000):
        ii = rng.choice(N, 6, replace=False)
        try: M = dlt(X, uv, ii)
        except Exception: continue
        inl = np.nonzero(np.linalg.norm(proj(M, X) - uv, axis=1) < 3.0)[0]
        if len(inl) > len(bi): best, bi = M, inl
    M = dlt(X, uv, bi); bi = np.nonzero(np.linalg.norm(proj(M, X) - uv, axis=1) < 2.5)[0]; M = dlt(X, uv, bi)
    e = np.linalg.norm(proj(M, X[bi]) - uv[bi], axis=1)
    print(st, '対応', N, '使った', len(bi), '誤差 px 中央値', round(float(np.median(e)), 2), '最大', round(float(e.max()), 2))
    (P / f'cam_{st}.json').write_text(json.dumps({'M': M.tolist(), 'n': int(len(bi)), 'err_med': float(np.median(e))}))
