"""大磯 -9044,304 の指示の絵: 赤の所の道路・敷地・建物を消す(オレンジは本線の歩道。本線の外側の歩道はそのまま残る)。
絵の画素 → 地図の座標は照合で求めた射影変換 top/oiso2_Hw.npy(ずれ 0.3m 程度)。
"""
import sys, json
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape
TOP = Path(__file__).parent / 'paint/top'
A = cv2.imread(str(TOP / 'oiso2_base.png')).astype(int); B = cv2.imread(str(TOP / 'oiso2_paint.png')).astype(int)
Hw = np.load(TOP / 'oiso2_Hw.npy')
b, g, r = B[..., 0], B[..., 1], B[..., 2]
red = ((r > 190) & (g < 80) & (b < 80)).astype(np.uint8) * 255
red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
cs, hier = cv2.findContours(red, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
w = lambda c: [tuple(v) for v in cv2.perspectiveTransform(np.float32([[p[0][0] + .5, p[0][1] + .5] for p in c])[None], Hw)[0]]
ps = [Polygon(w(c)).buffer(0) for i, c in enumerate(cs) if hier[0][i][3] == -1 and len(c) >= 3]
RED = unary_union([p for p in ps if p.area > 4])
print('赤', round(RED.area), 'm²', [round(v) for v in RED.bounds])
d = json.loads(FILE.read_text()); M = Map(d)
b0 = len(d['roads'])
d['roads'] = [q for q in d['roads'] if LineString(q['pts']).intersection(RED).length < 0.5 * LineString(q['pts']).length]
print('消した道路', b0 - len(d['roads']))
b0 = len(d['buildings']); d['buildings'] = [q for q in d['buildings'] if not RED.contains(Polygon(q['p']).buffer(0).centroid)]; print('消した建物', b0 - len(d['buildings']))
M.put(RED, 'piers', keep_water=True, clear=False)   # まわりと同じ明るいグレー(コンクリート)で埋める
for k in ('medians', 'strips'):
    b0 = len(d[k]); d[k] = [m for m in d[k] if not RED.contains(Point(m[0], m[1])) and Point(m[0], m[1]).distance(Point(-9005.7, 322.4)) > 14]; print(k, b0 - len(d[k]))   # 消した支線の分かれ目の緑地も
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
