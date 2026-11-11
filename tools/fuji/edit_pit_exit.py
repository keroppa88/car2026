"""富士スピードウェイ: ピット出口 → ホームストレートの合流を、空撮の通りにする。
空撮で測った形(コースの点の番号, コースの右への距離 m):
  ピットの壁は 1433 で終わり。そこから赤白の縞(1435〜1452 で細くなる三角)をはさんで出口の車線が本コースへ寄り、
  1452 から本コースの右に幅 約4.3m の車線として並び(境は 1466 まで実線、その先は破線)、1511 で終わる(横線)。1517 までにすぼまる。
→ map/fuji-course.json の pitExit(js が路面と白線を描く)、ピットレーンの分かれ道の端、chevrons の2つ目、地面の塗り分け
python3 tools/fuji/edit_pit_exit.py   (branches を作り直したあとは、これも実行する。何度実行してもよい)
"""
import json
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R)
T = np.roll(R, -2, 0) - np.roll(R, 2, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NR = np.stack([-T[:, 1], T[:, 0]], 1)   # 右
def pt(fi, o):
    i = int(np.floor(fi)); f = fi - i; a, b = R[i % n], R[(i + 1) % n]; na, nb = NR[i % n], NR[(i + 1) % n]
    return (a + (b - a) * f + (na + (nb - na) * f) * o).tolist()
PROF = [[1433, 12.3, 18.3], [1452, 7.5, 12.5], [1463, 7.5, 11.75], [1511, 7.5, 11.75], [1517, 7.5, 7.5]]   # [点, 車線の内側, 外側]
d['pitExit'] = {'side': -1, 'prof': PROF, 'tip': 1452, 'dash': 1466, 'to': 1511, 'wallEnd': 1433}
pit = next(b for b in d['branches'] if b['w'] <= 9)
idx = [int(np.hypot(*(R - p).T).argmin()) for p in pit['pts']]
keep = [p for p, i in zip(pit['pts'], idx) if not (1428 <= i <= 1500)]
end = [round(v, 2) for v in pt(1434, 15.3)]
pit['pts'] = ([end] + keep) if idx[0] > 1300 else (keep + [end]); pit['from' if idx[0] > 1300 else 'to'] = 1434
ch = [[round(v, 1) for v in pt(*q)] for q in ((1435, 7.75), (1451.3, 7.75), (1435, 11.8))]
d['chevrons'] = d['chevrons'][:1] + [{'p': ch, 'dir': d['chevrons'][0]['dir']}]
# 地面: 車線と縞の所を路面の色に
L = d['landcover']; ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0)
fi = np.arange(1433, 1517.01, 0.5); outer = np.interp(fi, [p[0] for p in PROF], [p[2] for p in PROF])
poly = [pt(a, 7.0) for a in fi] + [pt(a, o + 0.3) for a, o in zip(fi[::-1], outer[::-1])]
cv2.fillPoly(ov, [np.round(np.array(poly) - [L['x0'], L['z0']]).astype(np.int32)], 1); cv2.imwrite(str(ovp), ov)
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); lc[ov == 1] = (75, 73, 71); cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
F.write_text(json.dumps(d, separators=(',', ':'))); print('pit', pit['pts'][:2], pit['from'], pit['to'])
