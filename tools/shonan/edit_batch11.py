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
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
