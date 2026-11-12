"""富士スピードウェイ: ピットレーンを写真の通りにまっすぐにする(edit_pit_exit.py のあとに。何度実行してもよい)
ホームストレートはまっすぐなので、R[1200] を原点に、x = ストレートの向き(m)、v = 右へ(m)で決める。
- ピットレーン(幅 6m): 左の縁がストレートの始まり〜x 75 はコースの縁(7.5)に接し、x 75〜142 でまっすぐ外へ開いて 12.3 へ、その先はまっすぐ平行。出口はコースの点 1434
- 入口の赤白の縞(V字)は、コースとピットレーンの間のアスファルトの上(x 75〜142、終わりに V の切れ込み)
- コースとピットレーンの間(コースの点 1247〜1433): コースの縁から 2.5m のアスファルト、壁(10.0〜10.3、金網つき)、
  人のいるコンクリートの場所(10.3〜12.0)、ピット側の低い壁(12.0〜12.3)。始まりは V 字にとがる
→ map/fuji-course.json の branches(ピットレーン)、chevrons[0]、pitWall、pitExit.prof[0]、地面の塗り分けの上書き
"""
import json
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R); st = d['start']
u = R[st + 20] - R[st - 20]; u /= np.linalg.norm(u); v = np.array([-u[1], u[0]]); O = R[1200]
W = lambda x, vv: [round(float(c), 2) for c in O + u * x + v * vv]
xOf = lambda i: float((R[i] - O) @ u)
X0, XA, XB, XE = 60.0, 75.0, 142.0, xOf(1434)
EDGE0, EDGE1, PW = 7.5, 12.3, 6.0
edge = lambda x: EDGE0 if x <= XA else EDGE1 if x >= XB else EDGE0 + (EDGE1 - EDGE0) * (x - XA) / (XB - XA)
xs = [XE] + list(np.arange(np.floor(XE / 20) * 20, XB, -20)) + [XB, XA, X0]
pit = next(b for b in d['branches'] if b['w'] <= 9)
pit.update({'w': PW, 'from': 1434, 'to': int(round(1200 + X0 / 3)), 'pts': [W(x, edge(x) + PW / 2) for x in xs]})
d['chevrons'][0] = {'p': [W(XA, EDGE0 + 0.05), W(XB, EDGE0 + 0.05), W(XB - 6.5, 9.9), W(XB, EDGE1 - 0.05)], 'dir': [round(float(u[0]), 4), round(float(u[1]), 4)]}
d['pitWall'] = {'from': int(round(1200 + XB / 3)), 'to': 1433, 'side': -1, 'cw': 10.0, 'pw': 12.0, 'apex': 8}
d['pitExit']['prof'][0] = [1433, EDGE1, EDGE1 + PW]
d.pop('pitIsland', None)
# 地面: 縞の下と、ピットレーンのまわり(コースとの間)を路面の色に
L = d['landcover']; ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0)
px = lambda q: np.round(np.array(q) - [L['x0'], L['z0']]).astype(np.int32)
cv2.fillPoly(ov, [px([W(X0, 7.0), W(XB, 7.0), W(XB, EDGE1), W(XA, EDGE0)])], 1)
# ピットレーンの外(パドック側)は、まっすぐな縁で区切った明るい舗装(26m まで)。色の途切れ・しみを残さない
cv2.fillPoly(ov, [px([W(X0, EDGE0 + PW), W(XA, EDGE0 + PW), W(XB, EDGE1 + PW), W(XE, EDGE1 + PW), W(XE, 26), W(X0, 26)])], 3)
cv2.fillPoly(ov, [px([W(X0, EDGE0), W(XA, EDGE0), W(XB, EDGE1), W(XE, EDGE1), W(XE, EDGE1 + PW), W(XB, EDGE1 + PW), W(XA, EDGE0 + PW), W(X0, EDGE0 + PW)])], 1)
cv2.imwrite(str(ovp), ov)
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); paved = tuple(int(q) for q in src.split("'paved': (")[1].split(')')[0].split(','))
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); lc[ov == 1] = (75, 73, 71); lc[ov == 3] = paved; cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
F.write_text(json.dumps(d, separators=(',', ':')))
print('pit', pit['from'], pit['to'], len(pit['pts']), 'wall', d['pitWall'])
