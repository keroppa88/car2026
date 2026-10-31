"""湘南 3080〜3107,-1015: 国道134号の上下線が短い橋で道をまたぐ所。
緑地帯の切れ目のグレーをなくす: 緑地帯は橋のたもとまでまっすぐのばして、そこで途切れさせる。
橋の上の上下線のあいだはアスファルト。あいだに入り込んでいた林のかけらは消す。"""
import json, math, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union
d = json.loads(FILE.read_text()); R = d['roads']
X0, X1 = 3060.0, 3140.0
north = [r for r in R if r.get('name') == '国道134号' and LineString(r['pts']).intersects(box(X0, -1012, X1, -990))]
south = [r for r in R if r.get('name') == '国道134号' and LineString(r['pts']).intersects(box(X0, -1035, X1, -1013))]
car = unary_union([LineString(r['pts']).buffer(r['lanes'] * 3.25 / 2, cap_style=2) for r in north + south])
# 上下線のあいだ: 縦の線ごとに、北の車道の南の縁 〜 南の車道の北の縁
top, bot = [], []
for x in [X0 + 0.5 * k for k in range(int((X1 - X0) / 0.5) + 1)]:
    v = LineString([(x, -1040), (x, -985)]).difference(car)
    segs = [g for g in getattr(v, 'geoms', [v]) if g.geom_type == 'LineString' and g.length > 0.5]
    mid = [g for g in segs if -1035 < min(c[1] for c in g.coords) and max(c[1] for c in g.coords) < -990]
    if not mid: continue
    g = max(mid, key=lambda g: g.length); zs = sorted(c[1] for c in g.coords)
    top.append((x, zs[0])); bot.append((x, zs[-1]))
G = Polygon(top + bot[::-1]).buffer(0)
bridge = [r for r in R if r.get('bridge') and r.get('name') == '国道134号' and LineString(r['pts']).intersects(box(X0, -1040, X1, -990))]
bx0 = min(p[0] for r in bridge for p in r['pts']); bx1 = max(p[0] for r in bridge for p in r['pts'])
# 緑地帯の長方形(2m ごと)の切れ目が残らないよう、橋の上のアスファルトを両側へ少し広げて、緑地帯の端にそろえる
bx0 = X0 + 1 + 2 * math.floor((bx0 - X0 - 1) / 2) + 1.0; bx1 = X0 + 1 + 2 * math.ceil((bx1 - X0 - 1) / 2) - 1.0
span = G.intersection(box(bx0, -1040, bx1, -985))
ends = G.difference(box(bx0, -1040, bx1, -985))
M = Map(d)
M.cut(G, ['woods', 'parks', 'lots', 'piers', 'lawns'])
d['parking'].append({'o': [[round(x, 2), round(z, 2)] for x, z in list(span.exterior.coords)[:-1]], 'h': []})
# 両側の端: 緑地帯の短い長方形を 2m ごとに(すでにある所は残す)
have = [m for m in d['medians'] if G.contains(Point(m[0], m[1]))]
for e in getattr(ends, 'geoms', [ends]):
    x0, _, x1, _ = e.bounds; x = X0 + 1 + 2 * math.ceil((x0 - X0 - 1) / 2)
    while x < x1 - 0.5:
        if not any(abs(m[0] - x) < 1.0 for m in have):
            v = LineString([(x, -1040), (x, -985)]).intersection(e)
            if not v.is_empty and v.geom_type == 'LineString':
                zs = sorted(c[1] for c in v.coords)
                p0 = min(top, key=lambda t: abs(t[0] - (x - 1))); p1 = min(top, key=lambda t: abs(t[0] - (x + 1)))
                ang = math.atan2(p1[0] - p0[0], p1[1] - p0[1])
                d['medians'].append([round(x, 2), round((zs[0] + zs[-1]) / 2, 2), round(ang, 3), 2.1, round(zs[-1] - zs[0] - 0.3, 2), 1])
        x += 2.0
# 長方形のすき間(斜めの角)が残らないよう、両側の端は形そのものも緑地帯の色で塗る
d['medianPolys'] = [q for q in d.get('medianPolys', []) if q.get('src') != '3093'] + [
    {'o': [[round(x, 2), round(z, 2)] for x, z in list(e.exterior.coords)[:-1]], 'src': '3093'} for e in getattr(ends, 'geoms', [ends]) if e.geom_type == 'Polygon']
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('あいだ', round(G.area), '橋の上', round(span.area), '橋', round(bx0), round(bx1))
