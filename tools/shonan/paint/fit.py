"""ユーザーのスクショと同じカメラを求める(描いた画面とスクショを特徴点で照合 → 3D点 → PnP)。
python3 tools/shonan/paint/fit.py 画像.png 'x,y,z' 'tx,ty,tz' 作業フォルダ [回数]
結果: 作業フォルダ/cam.json と、同じ角度の描画 render.png、重ね合わせ overlay.png
"""
import sys, json, subprocess, math
from pathlib import Path
import numpy as np, cv2

ROOT = Path(__file__).resolve().parents[3]
img_path, pos, tgt, work = sys.argv[1], [float(v) for v in sys.argv[2].split(',')], [float(v) for v in sys.argv[3].split(',')], Path(sys.argv[4])
iters = int(sys.argv[5]) if len(sys.argv) > 5 else 3
work.mkdir(parents=True, exist_ok=True)
U = cv2.imread(img_path); H, W = U.shape[:2]

def paint_mask(img):
    b, g, r = [img[..., i].astype(int) for i in range(3)]
    red = (r > 200) & (g < 60) & (b < 60)
    yel = (r > 230) & (g > 200) & (b < 40)
    org = (r > 230) & (g > 150) & (g < 215) & (b < 40)
    ygr = (r > 150) & (r < 200) & (g > 210) & (b < 60)
    return red | yel | org | ygr

def node(job):
    jp = work / 'job.json'; jp.write_text(json.dumps(job))
    subprocess.run(['node', str(ROOT / 'tools/shonan/paint/render.mjs'), str(jp)], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)

sift = cv2.SIFT_create(8000)
gu = cv2.cvtColor(U, cv2.COLOR_BGR2GRAY)
mu = (~paint_mask(U)).astype(np.uint8) * 255
mu = cv2.erode(mu, np.ones((7, 7), np.uint8))
ku, du = sift.detectAndCompute(gu, mu)
f = (H / 2) / math.tan(math.radians(30))
K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], float)
cam = {'pos': pos, 'target': tgt}
for it in range(iters):
    rp = str(work / f'render{it}.png')
    node({'W': W, 'H': H, 'cams': [{**cam, 'out': rp}]})
    R = cv2.imread(rp); gr = cv2.cvtColor(R, cv2.COLOR_BGR2GRAY)
    kr, dr = sift.detectAndCompute(gr, None)
    m = cv2.BFMatcher().knnMatch(du, dr, k=2)
    good = [a for a, b in m if a.distance < 0.75 * b.distance]
    pu = np.float32([ku[a.queryIdx].pt for a in good]); pr = np.float32([kr[a.trainIdx].pt for a in good])
    Hm, inl = cv2.findHomography(pu, pr, cv2.RANSAC, 25)
    sel = inl.ravel() > 0 if inl is not None else np.ones(len(pu), bool)
    pu, pr = pu[sel], pr[sel]
    (work / 'pick.json').write_text(json.dumps(pr.tolist()))
    node({'W': W, 'H': H, 'cams': [{**cam, 'pick': str(work / 'pick.json'), 'pickOut': str(work / 'pts.json')}]})
    P3 = json.loads((work / 'pts.json').read_text())
    ok = [i for i, p in enumerate(P3) if p is not None]
    obj = np.float32([P3[i][:3] for i in ok]); imgp = pu[ok]
    succ, rv, tv, inl2 = cv2.solvePnPRansac(obj, imgp, K, None, reprojectionError=6, iterationsCount=2000)
    Rm = cv2.Rodrigues(rv)[0]; C = (-Rm.T @ tv).ravel(); fwd = Rm.T @ np.array([0, 0, 1.]); up = Rm.T @ np.array([0, -1, 0.])
    proj, _ = cv2.projectPoints(obj[inl2.ravel()], rv, tv, K, None)
    err = np.linalg.norm(proj.reshape(-1, 2) - imgp[inl2.ravel()], axis=1)
    print(f'iter {it}: matches {len(good)} → {len(ok)} 点, 内点 {len(inl2)}, 誤差 中央 {np.median(err):.1f}px 最大 {err.max():.1f}px, roll {math.degrees(math.atan2(up[0]*fwd[2]-up[2]*fwd[0], up[1])):.2f}°', flush=True)
    cam = {'pos': C.tolist(), 'target': (C + fwd * 500).tolist()}
(work / 'cam.json').write_text(json.dumps({**cam, 'W': W, 'H': H}))
node({'W': W, 'H': H, 'cams': [{**cam, 'out': str(work / 'render.png')}]})
R = cv2.imread(str(work / 'render.png'))
cv2.imwrite(str(work / 'overlay.png'), cv2.addWeighted(U, 0.5, R, 0.5, 0))
print('cam', json.dumps(cam))
