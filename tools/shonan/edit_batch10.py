"""湘南: 座標の指示(2026-10-29 23時)。
・-1386,-966 の道路の出っ張りを消す / -4907,-690 の飛び出した道路を消す / -4890,-690 の道路を西の交差点へつなぐ
・-4854,-725 の国道134号(西行き)が4車線になっていたのを片側2車線に
・-4063,-1066 の水路を緑地に / -3831,-961 の細いグレーを緑地に
・-7499,-457 / -7541,-441 の小さな砂浜・海の突起を消す(川の水に)
・花水川橋(-7480,-461): 上下線を1本の橋にまとめ、歩道(欄干)はいちばん外側だけに
・橋の上・たもと(12m)には中央分離帯の緑地を置かない
"""
import sys, json, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape, encode
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union
d = json.loads(FILE.read_text()); M = Map(d); R = d['roads']
near = lambda p, q, e=0.6: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
def find(a, b=None):
    for r in R:
        if near(r['pts'][0], a) and (b is None or near(r['pts'][-1], b)): return r
    raise SystemExit(f'道路が見つからない {a} {b}')
r = find((-1479.6, -1048.8), (-1382.6, -954.0)); r['pts'] = r['pts'][:4]; r['junctions'] = [j for j in r['junctions'] if j < 4] + ([3] if 3 not in r['junctions'] else [])
d['roads'] = [x for x in R if not (near(x['pts'][0], (-4938.2, -680.9)) and near(x['pts'][-1], (-4898.4, -689.6)))]; R = d['roads']
r = find((-4891.0, -692.4)); r['pts'].insert(0, [-4898.8, -706.8]); r['junctions'] = sorted({0} | {j + 1 for j in r['junctions']})
r = find((-4815.0, -740.8), (-4898.8, -706.8)); r['lanes'] = 2
# 水路 → 緑地
for q in list(d['water']):
    g = shape(q)
    if not q.get('sea') and g.buffer(0.5).contains(Point(-4063, -1066)): d['water'].remove(q); M.put(g, 'parks', keep_water=True, clear=False); print('水路を緑地に', round(g.area))
# 細いグレー → 緑地
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
z = Point(-3831, -961).buffer(70)
kinds = ('lots', 'parks', 'woods', 'beaches', 'piers', 'parking', 'water', 'rocks')
cov = unary_union([shape(q) for k in kinds for q in d[k] if shape(q).intersects(z)] + [LineString(r['pts']).buffer(W(r) / 2 + 4.5) for r in R if LineString(r['pts']).distance(z) < 30])
gap = z.difference(cov); gap = unary_union([p for p in getattr(gap, 'geoms', [gap]) if p.geom_type == 'Polygon' and p.buffer(-4).is_empty])
M.put(gap.buffer(0.2), 'parks', keep_water=True, clear=False); print('細いグレーを緑地に', round(gap.area))
# 小さな突起
for pt in [(-7499, -457), (-7541, -441)]:
    P = Point(pt)
    for k in ('beaches', 'water'):
        for q in list(d[k]):
            g = shape(q)
            if g.area < 1000 and g.buffer(0.5).contains(P):
                d[k].remove(q); big = max((w for w in d['water'] if not w.get('sea') and shape(w).distance(g) < 2), key=lambda w: shape(w).area, default=None)
                if big: i = d['water'].index(big); d['water'][i:i + 1] = encode(shape(big).union(g.buffer(0.3)), **{a: b for a, b in big.items() if a not in ('o', 'h')})
                print('突起を消した', k, round(g.area))
# 花水川橋: 2本を1本の橋に
a = find((-7428.7, -475.5), (-7551.4, -429.4)); b = find((-7564.0, -446.3), (-7439.1, -494.3))
for r, o in ((a, b), (b, a)):
    ln = LineString(r['pts']); m = ln.interpolate(0.5, normalized=True); lo = LineString(o['pts']); q = lo.interpolate(lo.project(m))
    p0, p1 = r['pts'][0], r['pts'][-1]; L = math.dist(p0, p1); tx, tz = (p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L
    side = 1 if (tz * (q.x - m.x) - tx * (q.y - m.y)) > 0 else -1
    r['pair'] = {'side': side, 'gap': round(lo.distance(m), 2), 'wall': 1 if r is a else 0}
print('花水川橋をまとめた', a['pair'], b['pair'])
BR = unary_union([LineString(r['pts']) for r in R if r.get('bridge')])
b0 = len(d['medians']); d['medians'] = [m for m in d['medians'] if BR.distance(Point(m[0], m[1])) > 12]; print('橋の上の中央分離帯', b0 - len(d['medians']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
