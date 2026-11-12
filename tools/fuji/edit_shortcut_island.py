"""富士スピードウェイ: 二股(近道)と本コースに囲まれた島を芝生にする。あわせて、塗り直した所(area_overrides.png)が
コースのすぐ横なら、縁石のない帯の色も合わせる(roadL/R = 路面の色、lawnL/R = 芝生の色)。
python3 tools/fuji/edit_shortcut_island.py   (apply_area_paint2.py を --add なしで実行したあとは、これも実行する)
"""
import json
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
L = d['landcover']; W, H = L['W'], L['H']; R = np.array([[p[0], p[2]] for p in d['route']])
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0) if ovp.exists() else np.zeros((H, W), np.uint8)
for b in d['branches']:
    if b['w'] > 9:
        a, c = sorted((b['from'], b['to']))
        cv2.fillPoly(ov, [np.round(R[a:c + 1] - [L['x0'], L['z0']]).astype(np.int32)], 2)
# 近道の口: 近道を両端で 12m のばした帯のうち、本コースの縁(縁石の帯のあたり)にかかる所は路面の色に
road = np.ones((H, W), np.uint8); cv2.polylines(road, [np.round(R - [L['x0'], L['z0']]).astype(np.int32)], True, 0, 1); dist = cv2.distanceTransform(road, cv2.DIST_L2, 5)
for b in d['branches']:
    if b['w'] > 9:
        A, B = np.array(b['pts'][0]), np.array(b['pts'][-1]); u = (B - A) / np.linalg.norm(B - A); n = np.array([u[1], -u[0]]) * b['w'] / 2
        m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [np.round(np.array([A - u * 12 + n, B + u * 12 + n, B + u * 12 - n, A - u * 12 - n]) - [L['x0'], L['z0']]).astype(np.int32)], 1)
        pass   # (やめた: 口の所を路面の色にすると、コースの色が白線の外へはみ出す)
cv2.imwrite(str(ovp), ov)
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda k: tuple(int(v) for v in src.split(f"'{k}': (")[1].split(')')[0].split(','))
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); lc[ov == 2] = col('grass'); lc[ov == 1] = (75, 73, 71); cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
T = np.roll(R, -2, 0) - np.roll(R, 2, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NR = np.stack([T[:, 1], -T[:, 0]], 1)
for sg, s in ((1, 'L'), (-1, 'R')):
    q = np.round(R + sg * NR * 10.5 - [L['x0'], L['z0']]).astype(int)
    d['road' + s] = (ov[q[:, 1].clip(0, H - 1), q[:, 0].clip(0, W - 1)] == 1).astype(int).tolist()
    q = np.round(R + sg * NR * 9.6 - [L['x0'], L['z0']]).astype(int)     # 帯のすぐ外が草地の色なら、帯も草地の色
    d['lawn' + s] = (lc[q[:, 1].clip(0, H - 1), q[:, 0].clip(0, W - 1)] == np.array(col('grass'), np.uint8)).all(1).astype(int).tolist()
F.write_text(json.dumps(d, separators=(',', ':')))
print('lawn', sum(d['lawnL']), sum(d['lawnR']), 'road', sum(d['roadL']), sum(d['roadR']))
