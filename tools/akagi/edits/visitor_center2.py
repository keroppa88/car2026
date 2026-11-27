"""赤城山: 2 回目の指示(2026-11-27 16:58)。道・駐車場・脇道・建物の台地の高さを同じに。
赤 = 道との境目(アスファルト。駐車場・脇道に足す)。駐車場(1)と脇道(24)は、いちばん近い道の高さ(road: true)。白の敷地は、駐車場とつながる所の道の高さで水平。
黄緑 = アスファルトをやめて緑地(駐車場から外す)。
python3 tools/akagi/edits/visitor_center2.py
"""
import json, math
from pathlib import Path
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = [[(-56.75,59.75),(-54,61.5),(-47.25,55.25),(-49.25,52.5),(-53,52.75)],
       [(-83.25,85.75),(-81.25,88),(-91,96.75),(-92.75,94)],
       [(-70,58),(-78.5,67),(-76,68.75),(-66,60.25)],
       [(-64,82.5),(-59.25,77.75),(-55,81.75),(-61.5,84.5)],
       [(-199.25,212),(-190.75,203.5),(-186.75,204.5),(-194.75,212.5)]]
GREEN = [(-184.25,201.5),(-186,200.25),(-189.25,203.25),(-186,203.5)]
d = json.loads(FILE.read_text()); R = d['route']
road = LineString([(p[0], p[2]) for p in R]).buffer(3.6 + 0.9)
def ring(g):
    g = g.buffer(0)
    if g.geom_type != 'Polygon': g = max(g.geoms, key=lambda q: q.area)
    return [[round(x, 2), round(z, 2)] for x, z in list(g.exterior.coords)[:-1]]
def road_y(x, z):
    best = (1e9, 0)
    for a, b in zip(R[:-1], R[1:]):
        dx, dz = b[0] - a[0], b[2] - a[2]; t = max(0, min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / (dx * dx + dz * dz or 1)))
        dd = math.hypot(a[0] + dx * t - x, a[2] + dz * t - z)
        if dd < best[0]: best = (dd, a[1] + (b[1] - a[1]) * t)
    return best[1]
L = d['lots']
lot1, lot24, pad = Polygon(L[-3]['pts']), Polygon(L[-2]['pts']), Polygon(L[-1]['pts'])
green = Polygon(GREEN)
lot1 = unary_union([lot1] + [Polygon(RED[i]) for i in (0, 1, 2)]).difference(road).difference(green)
lot24 = unary_union([lot24] + [Polygon(RED[i]) for i in (3, 4)]).difference(road).difference(green)
pad = pad.difference(lot1)
y = round(road_y(-68.8, 58.7) - 0.04, 3)
L[-3] = {'pts': ring(lot1), 'road': True, 'cliff': True}
L[-2] = {'pts': ring(lot24), 'road': True, 'cliff': True}
L[-1] = {'pts': ring(pad), 'plane': [0, 0, y], 'cliff': True, 'surface': 'grass'}
d['grassAreas'].append({'pts': [list(p) for p in GREEN], 'fade': 1.0, 'inner': 1})
print('台地の高さ', y)
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
