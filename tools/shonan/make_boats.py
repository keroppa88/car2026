"""湘南: 船を置く → city.json の boats = [{x, z, a(向き: 船首の向きの角度 atan2(dx,dz)), L(長さ), k: 'fish' | 'yacht'}]
漁港(大磯港・平塚漁港・須賀港): 小型漁船をまばらに。船は幹線道路と同じ向き(波に対して垂直)、船尾を岸壁につける。
  → 幹線道路の向きに直角に走る岸壁(船の向きと直角)だけを使う。
ヨット: 海に白いヨットを全体で 5 隻、幹線道路から見える所(岸から 70〜130m 沖)にまばらに。
python3 tools/shonan/make_boats.py
"""
import json, math, random
from pathlib import Path
from shapely.geometry import Polygon, Point, LineString, box
from shapely.ops import unary_union
import shapely
ROOT = Path(__file__).resolve().parents[2]; FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
LAND = ('beaches', 'piers', 'rocks', 'parks', 'woods', 'lots', 'parking', 'lawns')
land = unary_union([shape(q) for k in LAND for q in d.get(k, [])])
water = unary_union([shape(q) for q in d['water']])
water = shapely.set_precision(water, 0.01).difference(shapely.set_precision(land, 0.01))   # 見えている水面
trunk = [LineString(r['pts']) for r in d['roads'] if r.get('name') == '国道134号']
def road_dir(x, z):
    L = min(trunk, key=lambda l: l.distance(Point(x, z))); s = L.project(Point(x, z))
    a, b = L.interpolate(max(0, s - 10)), L.interpolate(min(L.length, s + 10))
    l = math.hypot(b.x - a.x, b.y - a.y) or 1; return ((b.x - a.x) / l, (b.y - a.y) / l)
rnd = random.Random(2026)
boats = []
def hull(x, z, tx, tz, L, W):   # 船の形(長方形)
    return Polygon([(x + tx * L / 2 + tz * W / 2, z + tz * L / 2 - tx * W / 2), (x + tx * L / 2 - tz * W / 2, z + tz * L / 2 + tx * W / 2),
                    (x - tx * L / 2 - tz * W / 2, z - tz * L / 2 + tx * W / 2), (x - tx * L / 2 + tz * W / 2, z - tz * L / 2 - tx * W / 2)])
PORTS = [('大磯港', -8895, 447, 260), ('平塚漁港', -4600, -500, 260), ('須賀港', -4531, -1049, 150)]
for name, px, pz, rad in PORTS:
    zone = Point(px, pz).buffer(rad)
    sea = water.intersection(zone); inner = sea.buffer(-0.4)
    outline = sea.simplify(1.5)   # 細かい折れをまとめて、岸壁を長い1本の線にする
    rx, rz = road_dir(px, pz)
    placed = []
    edges = []
    for poly in getattr(outline, 'geoms', [outline]):
        if poly.geom_type != 'Polygon': continue
        for ring in [poly.exterior] + list(poly.interiors):
            c = list(ring.coords)
            for a, b in zip(c[:-1], c[1:]):
                L = math.dist(a, b)
                if L < 6: continue
                ex, ez = (b[0] - a[0]) / L, (b[1] - a[1]) / L
                if abs(ex * rx + ez * rz) > 0.35: continue          # 岸壁が道路と直角(船が道路と同じ向きで船尾をつけられる)
                mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
                if zone.exterior.distance(Point(mx, mz)) < 3: continue   # 範囲の切れ目は岸壁でない
                edges.append((a, b, L, ex, ez))
    rnd.shuffle(edges)                                               # 港の中に散らばるように
    for a, b, L, ex, ez in edges:
        nx, nz = -ez, ex                                             # 水の側へ
        m = Point((a[0] + b[0]) / 2 + nx * 2, (a[1] + b[1]) / 2 + nz * 2)
        if not sea.contains(m): nx, nz = -nx, -nz
        sgn = 1 if nx * rx + nz * rz > 0 else -1                     # 船首の向き = 道路の向き(岸壁から離れる側)
        tx, tz = rx * sgn, rz * sgn
        t = 3.0 + rnd.random() * 4
        while t < L - 3:
            if rnd.random() < 0.35 and len(placed) < 12:             # まばらに(1つの港で 12 隻まで)
                bl = 7 + rnd.random() * 3; bw = 2.3
                wx, wz = a[0] + ex * t, a[1] + ez * t
                cx, cz = wx + tx * (bl / 2 + 0.7), wz + tz * (bl / 2 + 0.7)
                h = hull(cx, cz, tx, tz, bl, bw)
                if inner.contains(h) and all(math.dist((cx, cz), q) > 9 for q in placed):
                    placed.append((cx, cz)); boats.append({'x': round(cx, 2), 'z': round(cz, 2), 'a': round(math.atan2(tx, tz), 3), 'L': round(bl, 1), 'k': 'fish'})
            t += 4.5 + rnd.random() * 6
    print(name, '漁船', len(placed), '岸壁', len(edges))
# ヨット 5 隻: 岸(海の縁)から 120〜260m 沖。道路に沿ってまばらに
sea = unary_union([shape(q) for q in d['water'] if q.get('sea')]).difference(land)
for x in (-6900, -2600, 1200, 4300, 8600):
    vl = LineString([(x, -1600), (x, 1600)])
    zs = [g.y for l in trunk for g in getattr(l.intersection(vl), 'geoms', [l.intersection(vl)]) if not g.is_empty and g.geom_type == 'Point']
    z0 = max(zs)                                                     # 海に近い方の車線
    rx, rz = road_dir(x, z0)
    # 道路から海の方(南 +z)へ進んで岸を探す
    s = 0
    while s < 1500 and not sea.contains(Point(x, z0 + s)): s += 5
    if s >= 1500: print('海が見つからない', x); continue
    off = 70 + rnd.random() * 60
    cx, cz = x, z0 + s + off
    if not sea.buffer(-15).contains(Point(cx, cz)): print('沖に海がない', x); continue
    ang = math.atan2(rx, rz) + (rnd.random() - 0.5) * 1.0 + (math.pi if rnd.random() < 0.5 else 0)
    boats.append({'x': round(cx, 1), 'z': round(cz, 1), 'a': round(ang, 3), 'L': round(8 + rnd.random() * 3, 1), 'k': 'yacht'})
    print('ヨット', round(cx), round(cz))
d['boats'] = boats
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('船', len(boats))
