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
# 長い橋(80m 以上)の真ん中: 左右に腕を出して両側の車線を照らす街灯。30m おき
bridges = [r for r in d['roads'] if r.get('bridge') and LineString(r['pts']).length >= 80]
for r in d['roads']:   # 道路にまとめた中の長い橋の区間(江の島への橋)
    if r.get('longBridge'):
        i, j = r['longBridge']; bridges.append({**r, 'pts': r['pts'][i:j + 1]})
blamps, used = [], set()
for i, r in enumerate(bridges):
    if i in used: continue
    A = LineString(r['pts'])
    partner = None
    if r.get('oneway'):   # 上下線が別の橋: となりの橋とのあいだ
        for j, q in enumerate(bridges):
            if j == i or j in used or not q.get('oneway'): continue
            B = LineString(q['pts'])
            if A.hausdorff_distance(B) < 40: partner = (j, B); break
        if partner: used.add(partner[0])
    used.add(i)
    for k in range(int((A.length - 30) // 30) + 1):
        p = A.interpolate(15 + k * 30)
        if partner:
            B = partner[1]; q = B.interpolate(B.project(p))
            mx, mz = (p.x + q.x) / 2, (p.y + q.y) / 2
            ang = math.atan2(q.x - p.x, q.y - p.y); arm = max(1.5, min(3.5, p.distance(q) / 2 - 1.0))
        else:
            a = A.interpolate(max(0, 15 + k * 30 - 2)); b = A.interpolate(min(A.length, 15 + k * 30 + 2))
            mx, mz = p.x, p.y; ang = math.atan2(-(b.y - a.y), b.x - a.x); arm = 2.5   # 道路と直角
        blamps.append([round(mx, 2), round(mz, 2), round(ang, 3), round(arm, 2)])
# 指示でつなぐ電線(交差点で途切れている所): 両端に近い電柱をつなぐ。近くに無ければ電柱を立てる
EXTRA = [((-3740, -1076), (-3681, -1097))]
for a, b in EXTRA:
    ends = []
    for x, z in (a, b):
        best = min(range(len(poles)), key=lambda i: math.hypot(poles[i][0] - x, poles[i][1] - z)) if poles else None
        if best is not None and math.hypot(poles[best][0] - x, poles[best][1] - z) < 12: ends.append(best)
        else:
            ang = math.atan2(b[1] - a[1], -(b[0] - a[0]))   # 腕木は電線と直角
            poles.append([x, z, round(ang, 3), -1]); ends.append(len(poles) - 1)
    wires.append(ends)
(ROOT / 'map/shonan-lamps.json').write_text(json.dumps({'lamps': lamps, 'poles': [p[:3] for p in poles], 'wires': wires, 'bridgeLamps': blamps}, separators=(',', ':')))
print('橋の街灯', len(blamps), '本(長い橋', len(bridges), '本)')
print('街灯', len(lamps), '電柱', len(poles), '電線の区間', len(wires), 'ルート', round(route.length), 'm')
