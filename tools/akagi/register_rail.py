"""赤城山: 空撮(ゲームの U の画面)に塗った絵を、12 枚の自前の空撮(tiles_job.json、真上からの決まったカメラ)と
特徴点(SIFT)で突き合わせ、絵のカメラ(3x4 行列)を求める。
1 回目: 突き合わせて、自前の空撮の画素の一覧(pick 用)を書く → render.mjs で 3D 座標を取る → 2 回目: カメラを解く。
python3 tools/akagi/register_rail.py pick 絵.png ...      → paint/pick_<絵>.json(画素一覧)を書く
python3 tools/akagi/register_rail.py solve 絵.png ...     → paint/cam_<絵>.json(3x4 行列)を書く
"""
import json, sys
from pathlib import Path
import numpy as np, cv2
P = Path(__file__).resolve().parent / 'paint'
job = json.loads((P / 'tiles_job.json').read_text())
tiles = [c['out'] for c in job['cams']]
sift = cv2.SIFT_create(12000)
def feats(path):
    im = cv2.imread(str(path)); g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    k, d = sift.detectAndCompute(g, None); return im, k, d
mode, names = sys.argv[1], sys.argv[2:]
if mode == 'pick':
    tf = {t: feats(t)[1:] for t in tiles}
    for name in names:
        im, ka, da = feats(P / name)
        # 塗った色(赤・ピンク・黄・水色・オレンジ)の上の特徴点は使わない
        b, g, r = [im[..., c].astype(int) for c in range(3)]
        painted = ((r > 150) & (g < 110)) | ((r > 180) & (g > 150) & (b < 100)) | ((b > 180) & (r < 180) & (g > 170))
        painted = cv2.dilate(painted.astype(np.uint8), np.ones((9, 9), np.uint8))
        allm = []
        for t, (kb, db) in tf.items():
            if db is None or len(db) < 2 or da is None: continue
            m = cv2.BFMatcher().knnMatch(da, db, k=2); good = [x[0] for x in m if len(x) == 2 and x[0].distance < 0.75 * x[1].distance]
            good = [x for x in good if not painted[int(ka[x.queryIdx].pt[1]), int(ka[x.queryIdx].pt[0])]]
            if len(good) < 12: continue
            pa = np.float32([ka[x.queryIdx].pt for x in good]); pb = np.float32([kb[x.trainIdx].pt for x in good])
            Hm, mask = cv2.findHomography(pa, pb, cv2.RANSAC, 4.0)
            if Hm is None: continue
            inl = [(pa[i].tolist(), pb[i].tolist()) for i in range(len(good)) if mask[i]]
            print(name, Path(t).name, len(good), len(inl))
            if len(inl) >= 12: allm.append({'tile': t, 'pairs': inl})
        (P / f'match_{Path(name).stem}.json').write_text(json.dumps(allm))
    # pick 用の仕事: タイルごとに、必要な画素の一覧
    need = {}
    for name in names:
        for mm in json.loads((P / f'match_{Path(name).stem}.json').read_text()):
            need.setdefault(mm['tile'], []).extend([q for _, q in mm['pairs']])
    cams = []
    for c in job['cams']:
        if c['out'] not in need: continue
        pk = P / ('pick_' + Path(c['out']).stem + '.json'); pk.write_text(json.dumps(need[c['out']]))
        cams.append({**c, 'out': None, 'pick': str(pk), 'pickOut': str(P / ('picked_' + Path(c['out']).stem + '.json'))})
    (P / 'pick_job.json').write_text(json.dumps({'W': job['W'], 'H': job['H'], 'cams': cams}))
    print('pick', sum(len(v) for v in need.values()), '点', len(cams), 'タイル')
else:
    for name in names:
        uv, xyz = [], []
        for mm in json.loads((P / f'match_{Path(name).stem}.json').read_text()):
            picked = json.loads((P / ('picked_' + Path(mm['tile']).stem + '.json')).read_text())
            want = json.loads((P / ('pick_' + Path(mm['tile']).stem + '.json')).read_text())
            idx = {tuple(q): i for i, q in enumerate(want)}
            for a, q in mm['pairs']:
                w = picked[idx[tuple(q)]]
                if w and w[1] < 600: uv.append(a); xyz.append(w[:3])
        uv = np.array(uv, float); X = np.array(xyz, float); N = len(uv)
        # DLT + RANSAC(6 点から 3x4 を解く)、最後に全体の当てはめ
        def dlt(ii):
            A = []
            for i in ii:
                x, y, z = X[i]; u, v = uv[i]
                A.append([x, y, z, 1, 0, 0, 0, 0, -u * x, -u * y, -u * z, -u]); A.append([0, 0, 0, 0, x, y, z, 1, -v * x, -v * y, -v * z, -v])
            _, _, Vt = np.linalg.svd(np.array(A)); M = Vt[-1].reshape(3, 4); return M / M[2, 3]
        def proj(M, Xs): q = np.c_[Xs, np.ones(len(Xs))] @ M.T; return q[:, :2] / q[:, 2:3]
        rng = np.random.default_rng(0); best, bi = None, []
        for _ in range(3000):
            ii = rng.choice(N, 6, replace=False)
            try: M = dlt(ii)
            except Exception: continue
            e = np.linalg.norm(proj(M, X) - uv, axis=1); inl = np.nonzero(e < 3.0)[0]
            if len(inl) > len(bi): best, bi = M, inl
        M = dlt(bi); e = np.linalg.norm(proj(M, X) - uv, axis=1); bi = np.nonzero(e < 2.5)[0]; M = dlt(bi)
        e = np.linalg.norm(proj(M, X[bi]) - uv[bi], axis=1)
        print(name, '対応', N, '使った', len(bi), '誤差 px 中央値', round(float(np.median(e)), 2), '最大', round(float(e.max()), 2))
        (P / f'cam_{Path(name).stem}.json').write_text(json.dumps({'M': M.tolist(), 'n': int(len(bi)), 'err_med': float(np.median(e))}))
