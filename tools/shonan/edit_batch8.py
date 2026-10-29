"""湘南: 大磯(西の終点)まで、-8618,-48 の形(片側2車線・真ん中に緑の分離帯・両側に歩道)のまま続ける。
西湘バイパスの -8621,-39 から西の終点までの上下線(橋・ランプを含む)を消し、同じルートに上下線を引き直す(橋ではなくふつうの道路)。
-8690,-26 の分かれた道(国道134号)は、間の緑地帯を消して片側1車線のままバイパスにつなぐ。
自動運転のルートも引き直す(大磯のスタートはバイパスの西の端)。
python3 tools/shonan/edit_batch8.py → make_lamps.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point, box
ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'; RFILE = ROOT / 'map/shonan-routes.json'
d = json.loads(FILE.read_text()); R = d['roads']; routes = json.loads(RFILE.read_text())
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
def find(a, b):
    for r in R:
        if near(r['pts'][0], a) and near(r['pts'][-1], b): return r
    raise SystemExit(f'道路が見つからない {a} {b}')
west = [find((-8621, -39), (-9108, 416)), find((-9108, 416), (-9169, 447)), find((-9169, 447), (-9507, 436)), find((-9507, 436), (-9750, 469))]
east = [find((-9756, 462), (-9549, 427)), find((-9549, 427), (-9506, 429)), find((-9506, 429), (-9172, 439)), find((-9172, 439), (-9113, 409)), find((-9113, 409), (-8624, -47))]
Lw = LineString([p for r in west for p in r['pts']]); Le = LineString([p for r in east for p in r['pts']])
cl = []
for k in range(int(Lw.length // 5) + 1):
    p = Lw.interpolate(k * 5); q = Le.interpolate(Le.project(p))
    if p.distance(q) < 25: cl.append(((p.x + q.x) / 2, (p.y + q.y) / 2))
J = ((-8621.28 + -8624.19) / 2, (-39.28 + -46.85) / 2)   # 東の上下線が分かれる所の真ん中
cl = LineString([J] + cl[1:]).simplify(0.4)   # 東→西
OFF = 4.5   # 上下線の中心の間 9m(分離帯 2.5m)
def side(line, off):   # 進む向きの左へ off ずらした線
    c = list(line.coords); out = []
    for i, (x, z) in enumerate(c):
        a, b = c[max(i - 1, 0)], c[min(i + 1, len(c) - 1)]
        dx, dz = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dz) or 1
        out.append([round(x + dz / l * off, 2), round(z - dx / l * off, 2)])
    return out
wpts = side(cl, OFF)                                   # 西行き: 東→西の向きの左
epts = side(LineString(cl.coords[::-1]), OFF)          # 東行き: 西→東の向きの左
# 東の端は今の上下線の端にぴったり
wpts[0] = [-8621.28, -39.28]; epts[-1] = [-8624.19, -46.85]
nw = {'pts': wpts, 'lanes': 2, 'oneway': True, 'kind': 'trunk', 'name': '西湘バイパス', 'junctions': [0]}
ne = {'pts': epts, 'lanes': 2, 'oneway': True, 'kind': 'trunk', 'name': '西湘バイパス', 'junctions': [len(epts) - 1]}
gone = west + east
zone = cl.buffer(30)
links = [r for r in R if r['kind'] == 'trunk_link' and zone.intersects(LineString(r['pts'])) and r not in gone]
gone += links
old = [LineString(r['pts']) for r in west + east]
d['roads'] = [r for r in R if not any(r is g for g in gone)]
# 残った道路で、消した上下線につながっていた端は、新しい上下線のいちばん近い所へつなぐ
NW, NE = LineString(wpts), LineString(epts)
for r in d['roads']:
    for end in (0, -1):
        q = Point(r['pts'][end])
        if q.x > -8640 or min(o.distance(q) for o in old) > 1.5: continue
        tgt = min((NW, NE), key=lambda L: L.distance(q)); t = tgt.interpolate(tgt.project(q))
        if end == 0: r['pts'].insert(0, [round(t.x, 2), round(t.y, 2)]); r['junctions'] = sorted({0} | {j + 1 for j in r['junctions']})
        else: r['pts'].append([round(t.x, 2), round(t.y, 2)]); r['junctions'] = sorted(set(r['junctions']) | {len(r['pts']) - 1})
d['roads'] += [nw, ne]
print('消した道路', len(gone), '(ランプ', len(links), ')  新しい上下線', len(wpts), '点', round(NW.length), 'm')
# 中央分離帯: この区間は作り直し(上下線のすき間 2.5m)。-8690,-26 の緑地帯も消す
gz = zone.union(Point(-8690, -26).buffer(60))
d['medians'] = [m for m in d['medians'] if not gz.contains(Point(m[0], m[1]))]
d['strips'] = [m for m in d['strips'] if not gz.contains(Point(m[0], m[1]))]
for k in range(int(cl.length // 2)):
    s = k * 2 + 1; p = cl.interpolate(s); a = cl.interpolate(max(0, s - 1)); b = cl.interpolate(min(cl.length, s + 1))
    if Point(p).distance(Point(J)) < 25: continue   # 分かれる所は空ける
    d['medians'].append([round(p.x, 2), round(p.y, 2), round(math.atan2(b.x - a.x, b.y - a.y), 4), 2.05, 2.2, 1])
# 自動運転のルート: 左の車線(上下線の中心から 1.625m 左)
def lane(pts):   # 6m ごとの点に
    L = LineString(side(LineString(pts), 1.625)); n = max(2, int(L.length // 6) + 1)
    return [[round(L.interpolate(L.length * k / (n - 1)).x, 2), round(L.interpolate(L.length * k / (n - 1)).y, 2)] for k in range(n)]
wl = lane(wpts); el = lane(epts)
w = routes['west']; i = next(i for i, p in enumerate(w) if p[0] < -8630)
routes['west'] = w[:i] + [p for p in wl if p[0] < -8632]
e = routes['east']; j = next(i for i, p in enumerate(e) if p[0] > -8615)
routes['east'] = [p for p in el if p[0] < -8632] + e[j:]
s0, s1 = routes['east'][0], routes['east'][1]
routes['starts']['oiso'] = {'x': s0[0], 'z': s0[1], 'heading': round(math.atan2(s1[0] - s0[0], s1[1] - s0[1]), 3)}
d['noCrosswalks'] = d.get('noCrosswalks', []) + [[-8615, -45]]   # 分かれる所には横断歩道を置かない
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
RFILE.write_text(json.dumps(routes, separators=(',', ':')))
print('ok', routes['starts']['oiso'])
