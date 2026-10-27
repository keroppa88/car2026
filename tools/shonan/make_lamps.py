"""湘南: 国道134号の街灯・電柱・電線の位置(map/shonan-lamps.json)。
街灯は車道の外側に、海側と陸側へ交互に 30m おき(片側では 60m おき)。電柱と電線は陸側だけ 30m おき。
寸法は街並みマップ(js/nihon-town.js)と同じ。脇道の入口・砂浜や水の上には立てない。
python3 tools/shonan/make_lamps.py
"""
from pathlib import Path
import json, math
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[2]
LANE = 3.25
d = json.loads((ROOT / 'map/shonan-city.json').read_text())
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
width = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * LANE
R134 = [r for r in d['roads'] if r.get('name') == '国道134号']
others = [r for r in d['roads'] if r.get('name') != '国道134号']
carriage = unary_union([LineString(r['pts']).buffer(width(r) / 2, cap_style=2) for r in R134])
closed = carriage.buffer(10).buffer(-10)                 # 上下線と中央分離帯をひとまとめ
pc = prep(closed)
side_roads = prep(unary_union([LineString(r['pts']).buffer(width(r) / 2 + 2.0) for r in others]))
low = unary_union([shape(q) for q in d['beaches'] + d['water']])
pl = prep(low.buffer(0.5))
sea = unary_union([shape(q) for q in d['water'] if q.get('sea')])
route = LineString(json.loads((ROOT / 'map/shonan-routes.json').read_text())['west'])

def edge(c, n):                                          # 中心から n 方向へ、車道の外の縁までの距離
    t = 0.0
    while t < 40 and pc.contains(Point(c[0] + n[0] * t, c[1] + n[1] * t)): t += 0.25
    return t if t < 40 else None

def frame(s):
    c = route.interpolate(s); a = route.interpolate(max(0, s - 3)); b = route.interpolate(min(route.length, s + 3))
    tx, tz = b.x - a.x, b.y - a.y; L = math.hypot(tx, tz) or 1
    n = (-tz / L, tx / L)
    # 海側の向き: 遠くの海に近い方
    p1, p2 = Point(c.x + n[0] * 80, c.y + n[1] * 80), Point(c.x - n[0] * 80, c.y - n[1] * 80)
    if sea.distance(p1) > sea.distance(p2): n = (-n[0], -n[1])
    return (c.x, c.y), n                                  # n は海側

lamps, poles = [], []
k = 0
s = 0.0
while s < route.length:
    c, nsea = frame(s)
    if pc.contains(Point(c)):
        sea_side = (k % 2 == 0)
        n = nsea if sea_side else (-nsea[0], -nsea[1])
        t = edge(c, n)
        if t is not None:
            for off in (0.8, 0.4):
                p = (c[0] + n[0] * (t + off), c[1] + n[1] * (t + off))
                if not pl.contains(Point(p)) and not side_roads.contains(Point(p)):
                    lamps.append([round(p[0], 2), round(p[1], 2), round(math.atan2(-n[0], -n[1]), 3)])   # 腕は道路の方へ
                    break
        # 電柱(陸側、街灯の間)
        c2, nsea2 = frame(s + 15)
        n2 = (-nsea2[0], -nsea2[1])
        if pc.contains(Point(c2)):
            t2 = edge(c2, n2)
            if t2 is not None:
                p = (c2[0] + n2[0] * (t2 + 1.6), c2[1] + n2[1] * (t2 + 1.6))
                if not pl.contains(Point(p)) and not side_roads.contains(Point(p)) and low.distance(Point(p)) > 3:
                    poles.append([round(p[0], 2), round(p[1], 2), round(math.atan2(-n2[0], -n2[1]), 3), round(s + 15, 1)])
    k += 1; s += 30.0
wires = [[i, i + 1] for i in range(len(poles) - 1)
         if poles[i + 1][3] - poles[i][3] <= 31 and math.hypot(poles[i + 1][0] - poles[i][0], poles[i + 1][1] - poles[i][1]) < 40]
(ROOT / 'map/shonan-lamps.json').write_text(json.dumps({'lamps': lamps, 'poles': [p[:3] for p in poles], 'wires': wires}, separators=(',', ':')))
print('街灯', len(lamps), '電柱', len(poles), '電線の区間', len(wires), 'ルート', round(route.length), 'm')
