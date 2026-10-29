"""湘南: 座標の指示(2026-10-29 夕方 その2)。
・-3580,-1104 〜 -4821,-739 の国道134号(上下線・相模川の橋)を消し、同じルートを片側2車線の道路1本(両側に歩道、緑地帯なし)でつなぐ。
  自動運転のルート(map/shonan-routes.json)も、この区間は新しい道路の左の車線に置き換える
・-3515,-1075: 国道134号の南の緑地を消し、南から来る細い道を国道までつなぐ
・1556,-1093 の煩雑な交差点: 取り付け道路をまとめて、湘南新道を国道134号へまっすぐつなぐ。中の島(緑地)はグレーの地面に
python3 tools/shonan/edit_batch6.py → make_lamps.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point, box
from shapely.ops import substring, unary_union
ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'; RFILE = ROOT / 'map/shonan-routes.json'
d = json.loads(FILE.read_text()); R = d['roads']; routes = json.loads(RFILE.read_text())
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
def find(a, b=None):
    for r in R:
        if near(r['pts'][0], a) and (b is None or near(r['pts'][-1], b)): return r
    raise SystemExit(f'道路が見つからない {a} {b}')
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25

# ---- 1) 相模川の区間 ----
west_chain = [find((-3567.6, -1093.8)), find((-3713.7, -1069.2)), find((-3854, -1020), (-4514, -795)), find((-4514, -795), (-4813, -735))]
east_chain = [find((-4513, -806), (-3855, -1029)), find((-3855, -1029), (-3712, -1081))]
r597 = find((-3712.2, -1081.2), (-3082.4, -787.4)); r1063 = find((-5630, -648), (-4513, -806))
Lw = LineString([p for r in west_chain for p in r['pts']])   # 西行き(東→西)
Le = LineString([p for r in east_chain for p in r['pts']])   # 東行き(西→東)
# 中心線: 西行きの線にそって 6m ごとに、東行きの線との真ん中
cl = []
for k in range(int(Lw.length // 6) + 1):
    p = Lw.interpolate(k * 6); q = Le.interpolate(Le.project(p)) if p.x < -3712 else r597_line.interpolate(0) if False else None
    if p.x > -3712: q = LineString(r597['pts']).interpolate(LineString(r597['pts']).project(p))
    else: q = Le.interpolate(Le.project(p))
    if p.distance(q) < 40: cl.append(((p.x + q.x) / 2, (p.y + q.y) / 2))
cl = LineString(cl).simplify(0.6)
# 東の端: x = -3575 の所で切る。西の端: -4813 の交差点(1030 の始まり)まで
def cut_x(line, x):   # line 上で x 座標が x になる所までの長さ
    lo, hi = 0, line.length
    for _ in range(60):
        m = (lo + hi) / 2
        if line.interpolate(m).x > x: lo = m
        else: hi = m
    return lo
cl = substring(cl, cut_x(cl, -3575), cl.length)
E = [round(c, 2) for c in cl.coords[0]]
wj = find((-4813, -735), (-4899, -707))['pts'][0]
# 西端は 1030 の始まりと、そのあたりの 1063 の点の真ん中
L1063 = LineString(r1063['pts']); q1063 = L1063.interpolate(L1063.project(Point(wj)))
Wn = [round((wj[0] + q1063.x) / 2, 2), round((wj[1] + q1063.y) / 2, 2)]
pts = [E] + [[round(x, 2), round(z, 2)] for x, z in cl.coords[1:] if x > Wn[0] + 6] + [Wn]
new = {'pts': pts, 'lanes': 4, 'oneway': False, 'kind': 'trunk', 'name': '国道134号', 'junctions': [0, len(pts) - 1]}
gone = west_chain + east_chain
# 残す道路の端を新しい道路の端へ
r810 = next(r for r in R if near(r['pts'][-1], (-3567.6, -1093.8)) and r not in gone)
r810['pts'].append(E); r810['junctions'] = sorted(set(r810['junctions']) | {len(r810['pts']) - 1})   # 元の点は残して、短くつなぐ
L597 = LineString(r597['pts']); s0 = L597.project(Point(E))
r597['pts'] = [E] + [[round(L597.interpolate(s0 + 8).x, 2), round(L597.interpolate(s0 + 8).y, 2)]] + [p for p in r597['pts'] if L597.project(Point(p)) > s0 + 8]
r597['junctions'] = [0] + [j for j in range(1, len(r597['pts']))][-1:]
r1030 = find((-4813, -735), (-4899, -707)); r1030['pts'].insert(0, Wn); r1030['junctions'] = sorted({0} | {j + 1 for j in r1030['junctions']})
s1 = L1063.project(Point(Wn))
r1063['pts'] = [p for p in r1063['pts'] if L1063.project(Point(p)) < s1 - 8] + [[round(L1063.interpolate(s1 - 8).x, 2), round(L1063.interpolate(s1 - 8).y, 2)], Wn]
r1063['junctions'] = [0, len(r1063['pts']) - 1]
d['roads'] = [r for r in R if not any(r is g for g in gone)] + [new]; R = d['roads']
zone = LineString(pts).buffer(25)
for k in ('medians', 'strips'):
    b = len(d[k]); d[k] = [m for m in d[k] if not zone.contains(Point(m[0], m[1]))]; print(k, '消した', b - len(d[k]))
print('新しい道路', len(pts), '点', round(LineString(pts).length), 'm')
# 自動運転のルート: この区間は新しい道路の左の車線(中心から 4.875m)
NL = LineString(pts)
for key, west in (('west', True), ('east', False)):
    rt = routes[key]; out = []
    for x, z in rt:
        P = Point(x, z)
        if -4821 < x < -3575 and NL.distance(P) < 30:
            s = NL.project(P); a = NL.interpolate(max(0, s - 2)); b = NL.interpolate(min(NL.length, s + 2)); c = NL.interpolate(s)
            tx, tz = b.x - a.x, b.y - a.y; l = math.hypot(tx, tz) or 1; tx, tz = tx / l, tz / l
            if not west: tx, tz = -tx, -tz   # NL は東→西。東行きは逆向き
            out.append([round(c.x + tz * 4.875, 2), round(c.y - tx * 4.875, 2)])   # 進む向きの左
        else: out.append([x, z])
    routes[key] = out

# ---- 2) -3515,-1075 ----
zz = Point(-3515, -1068).buffer(45)
for k in ('medians', 'strips'):
    b = len(d[k]); d[k] = [m for m in d[k] if not (zz.contains(Point(m[0], m[1])) and m[1] > -1080)]; print('-3515 の', k, b - len(d[k]))
r839 = find((-3504.4, -1062.1))
r810 = next(r for r in R if near(r['pts'][-1], E) and r.get('name') == '国道134号' and r is not new)
L810 = LineString(r810['pts']); q = L810.interpolate(L810.project(Point(r839['pts'][0])))
qq = [round(q.x, 2), round(q.y, 2)]
i = max(range(len(r810['pts']) - 1), key=lambda i: -LineString(r810['pts'][i:i + 2]).distance(q))
r810['pts'].insert(i + 1, qq); r810['junctions'] = sorted({(j + 1 if j > i else j) for j in r810['junctions']} | {i + 1})
r839['pts'].insert(0, qq); r839['junctions'] = sorted({0} | {j + 1 for j in r839['junctions']})
print('細い道を国道へ', qq)

# ---- 3) 1556,-1093 の交差点 ----
links = [find((1480.7, -1084.5), (1558.5, -1109.2)), find((1588.6, -1135.5), (1544.9, -1078.2)), find((1677.6, -1088.8), (1558.5, -1109.2)),
         find((1558.5, -1109.2), (1582.1, -1141.3)), find((1588.6, -1135.5), (1598.6, -1093.4))]
d['roads'] = [r for r in R if not any(r is g for g in links)]; R = d['roads']
a = [1585.35, -1138.4]   # 湘南新道の上下線の端の真ん中
L161 = LineString(find((3083.5, -1007.8))['pts']); L265 = LineString(find((1480.7, -1084.5), (3086.9, -1024.5))['pts'])
p1 = L161.interpolate(L161.project(Point(1570, -1080))); p2 = L265.interpolate(L265.project(Point(1570, -1091)))
b = [round((p1.x + p2.x) / 2, 2), round((p1.y + p2.y) / 2, 2)]
R.append({'pts': [a, b], 'lanes': 4, 'oneway': False, 'kind': 'primary', 'name': '戸塚茅ヶ崎線（湘南新道）', 'junctions': [0, 1]})
for r in R:
    if r.get('name') == '戸塚茅ヶ崎線（湘南新道）':
        if near(r['pts'][-1], (1588.6, -1135.5), 0.5): r['pts'][-1] = a
        if near(r['pts'][0], (1582.1, -1141.3), 0.5): r['pts'][0] = a
iz = Point(1565, -1105).buffer(40)
for k in ('medians', 'strips'):
    b2 = len(d[k]); d[k] = [m for m in d[k] if not iz.contains(Point(m[0], m[1]))]; print('交差点の', k, b2 - len(d[k]))
import sys; sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map
Map(d).cut(Point(1568, -1105).buffer(28), ['parks', 'woods'])   # 中の島の緑地 → 地面(グレー)

FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
RFILE.write_text(json.dumps(routes, separators=(',', ':')))
print('ok')
