"""湘南: 道路の削除(指示の絵)。
-320,-847: 小さな道路を消し、まわりの岸壁と同じコンクリートにする。
1900,-1429: 北へ行き止まりになる道(曲がり角から先)と、湘南新道の北東の端(-1358 より先)を消す。歩道の帯の切れ端も消す。
"""
import json
from pathlib import Path
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
RW = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
# -320,-847
r605 = next(r for r in R if near(r['pts'][0], (-319, -861), 1.5) and near(r['pts'][-1], (-312, -837), 1.5))
foot = LineString(r605['pts']).buffer(RW(r605) / 2 + 4.6)
others = unary_union([Polygon(q['o'], q.get('h', [])).buffer(0) for k in ('lots', 'parks', 'woods') for q in d[k] if Polygon(q['o']).buffer(0).intersects(foot)])
fill = foot.difference(others)
for g in getattr(fill, 'geoms', [fill]):
    if g.geom_type == 'Polygon' and g.area > 1: d['piers'].append({'o': [[round(x, 2), round(z, 2)] for x, z in list(g.exterior.coords)[:-1]]})
R.remove(r605)
# 1900,-1429: 北への行き止まり
r198 = next(r for r in R if near(r['pts'][0], (1867, -1257), 1.5) and near(r['pts'][-1], (1898, -1435), 1.5))
k = next(i for i, p in enumerate(r198['pts']) if near(p, (1925, -1375), 1.5))
r198['pts'] = r198['pts'][:k + 1]; r198['junctions'] = [j for j in r198['junctions'] if j <= k]
# 湘南新道の北東の端
rs = next(r for r in R if near(r['pts'][0], (1884, -1422), 1.5) and near(r['pts'][-1], (1572, -1080), 1.5))
k2 = next(i for i, p in enumerate(rs['pts']) if near(p, (1772, -1358), 1.5))
rs['pts'] = rs['pts'][k2:]; rs['junctions'] = [j - k2 for j in rs['junctions'] if j >= k2]
# どの道路の歩道にもかからなくなった歩道の帯・街路樹を消す(この2か所の近くだけ)
zones = [box(-360, -900, -280, -800), box(1740, -1480, 1980, -1330)]
side = unary_union([LineString(r['pts']).buffer(RW(r) / 2 + 4.6) for r in R])
stale = lambda x, z: any(b.contains(Point(x, z)) for b in zones) and not side.contains(Point(x, z))
n0 = len(d['strips']); d['strips'] = [t for t in d['strips'] if not stale(t[0], t[1])]
d['trees'] = [t for t in d['trees'] if not stale(t[0], t[1])]
print('歩道の帯', n0 - len(d['strips']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
