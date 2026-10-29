"""湘南: 座標の指示(2026-10-29 23:06〜)。
・-8826,31 から -9004,272 へ向かう道路を消す
・-3083,-652 の孤立した道路を消す
・-3315,-931 / -3273,-899 のグレーの地面を、となりと同じ緑地に
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
d = json.loads(FILE.read_text()); M = Map(d)
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
b = len(d['roads'])
d['roads'] = [r for r in d['roads'] if not (r['kind'] == 'tertiary' and near(r['pts'][0], (-8815, 9))) and not (r['kind'] == 'service' and near(r['pts'][0], (-3048.4, -660.4)))]
print('消した道路', b - len(d['roads']))
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
z = Point(-3294, -915).buffer(150)
kinds = ('lots', 'parks', 'woods', 'beaches', 'piers', 'parking', 'water', 'rocks')
cov = unary_union([shape(q) for k in kinds for q in d[k] if shape(q).intersects(z)] + [LineString(r['pts']).buffer(W(r) / 2 + 4.5) for r in d['roads'] if LineString(r['pts']).distance(z) < 30])
gap = z.difference(cov)
parts = [p for p in getattr(gap, 'geoms', [gap]) if p.geom_type == 'Polygon' and (p.buffer(1).contains(Point(-3315, -931)) or p.buffer(1).contains(Point(-3273, -899)))]
g = unary_union(parts)
M.put(g.buffer(0.3), 'parks', keep_water=True, clear=False); print('グレーを緑地に', round(g.area), 'm²')
# 国道の外側に沿うグレーの細い道(-3351,-937〜-3163,-804)も消して緑地に
sv = [r for r in d['roads'] if r['kind'] == 'service' and near(r['pts'][0], (-3351, -937), 1.5) and near(r['pts'][-1], (-3163, -804), 1.5)]
for r in sv:
    d['roads'].remove(r)
    keep = unary_union([LineString(q['pts']).buffer(W(q) / 2 + 4.5) for q in d['roads'] if LineString(q['pts']).distance(LineString(r['pts'])) < 30])
    M.put(LineString(r['pts']).buffer(W(r) / 2 + 4.5, cap_style=2).difference(keep), 'parks', keep_water=True, clear=False)
print('外側の細い道を緑地に', len(sv))
# 江の島の対岸 6055,275 の海のすき間 → コンクリート / 5945,861 の建物を消す
zz = Point(6055, 275).buffer(35)
sea = M.water(sea_only=True).intersection(zz.buffer(20))
thin = sea.difference(sea.buffer(-14, join_style=2).buffer(14, join_style=2)).intersection(zz)
thin = unary_union([p for p in getattr(thin, 'geoms', [thin]) if p.geom_type == 'Polygon' and p.distance(Point(6055, 275)) < 25])
M.put(thin.buffer(0.3), 'piers', clear=False); print('海のすき間をコンクリートに', round(thin.area))
from shapely.geometry import Polygon
b0 = len(d['buildings']); d['buildings'] = [b for b in d['buildings'] if not Polygon(b['p']).buffer(2).contains(Point(5945, 861))]; print('建物', b0 - len(d['buildings']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
