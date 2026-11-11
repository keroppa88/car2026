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
cv2.imwrite(str(ovp), ov)
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda k: tuple(int(v) for v in src.split(f"'{k}': (")[1].split(')')[0].split(','))
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); lc[ov == 2] = col('grass'); cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
T = np.roll(R, -2, 0) - np.roll(R, 2, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NR = np.stack([T[:, 1], -T[:, 0]], 1)
for sg, s in ((1, 'L'), (-1, 'R')):
    for key, cls, off in (('road', 1, 10.5), ('lawn', 2, 9.3)):
        q = np.round(R + sg * NR * off - [L['x0'], L['z0']]).astype(int)
        d[key + s] = (ov[q[:, 1].clip(0, H - 1), q[:, 0].clip(0, W - 1)] == cls).astype(int).tolist()
F.write_text(json.dumps(d, separators=(',', ':')))
print('lawn', sum(d['lawnL']), sum(d['lawnR']), 'road', sum(d['roadL']), sum(d['roadR']))
