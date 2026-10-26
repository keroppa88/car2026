# 築地大橋(PLATEAU の橋の形)を整える:
#  陸(跡地)の上の部分は消す / 西へ分かれる取り付け道路の水の上の部分はコンクリートのグレーの面に / 欄干・柵の壁は消す
import json, math
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
city = json.load(open('map/nihonbashi-city.json'))
f = 'map/nihonbashi-bridges.json'; B = json.load(open(f))
wet = unary_union([Polygon(w['o']).buffer(0) for w in city['water'] if len(w['o']) >= 3] + [LineString(r['pts']).buffer(r['w'] / 2) for r in city['rivers'] if len(r['pts']) > 1])
main = LineString([(-16, 1754), (150, 1940)])
idx = next(i for i, b in enumerate(B['bridges']) if b.get('kind') == 'other' and min(b['top'][0::3]) < -150 and max(b['top'][0::3]) > 150 and 1650 < min(b['top'][2::3]) < 1700)
b = B['bridges'][idx]
top, side, pier = [], [], []
t = b['top']
for k in range(0, len(t) - 8, 9):
    tri = t[k:k + 9]; cx = (tri[0] + tri[3] + tri[6]) / 3; cz = (tri[2] + tri[5] + tri[8]) / 3
    if not wet.contains(Point(cx, cz)): continue          # 陸の上は消す
    if main.distance(Point(cx, cz)) < 22: top += tri       # 本線の橋
    else: pier += [v if j % 3 != 1 else 0.3 for j, v in enumerate(tri)]   # 取り付け道路 → 水面すれすれのコンクリート
s = b['side']
for k in range(0, len(s) - 8, 9):
    tri = s[k:k + 9]; ys = tri[1::3]; cx = (tri[0] + tri[3] + tri[6]) / 3; cz = (tri[2] + tri[5] + tri[8]) / 3
    if max(ys) - min(ys) > 1.6: continue                    # 欄干・柵などの壁
    if not wet.contains(Point(cx, cz)) or main.distance(Point(cx, cz)) >= 22: continue
    side += tri
b['top'], b['side'] = top, side
B['bridges'] = [x for x in B['bridges'] if x.get('kind') != 'pier']
B['bridges'].append({'kind': 'pier', 'top': pier, 'side': [], 'fp': []})
json.dump(B, open(f, 'w'), separators=(',', ':'))
print('築地大橋', idx, len(top) // 9, len(side) // 9, '取り付け→コンクリート', len(pier) // 9)
