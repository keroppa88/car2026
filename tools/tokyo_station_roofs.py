"""TOKYO(日本橋コース): 東京駅のホームの屋根(白・薄い水色・グレー)と、有楽町駅の白い屋根を作る。
OSM(tools/tokyo-center.osm)の building=roof(東京駅のホームの上)と railway=platform(有楽町)の形を使う。
→ map/nihonbashi-city.json の stationRoofs = [{o: [[x,z],...], y: 高さ, c: '#rrggbb'}]
python3 tools/tokyo_station_roofs.py
"""
import json, math, random
from pathlib import Path
from lxml import etree
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[1]; FILE = ROOT / 'map/nihonbashi-city.json'
LL = json.load(open(ROOT / 'tools/tokyo-center-area.json'))['lonlat']
lat0 = (min(p[1] for p in LL) + max(p[1] for p in LL)) / 2; lon0 = (min(p[0] for p in LL) + max(p[0] for p in LL)) / 2
KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
xy = lambda lat, lon: [round((lon - lon0) * KX, 2), round(-(lat - lat0) * KZ, 2)]
d = json.loads(FILE.read_text())
via = [(Polygon([p[:2] for p in v['rings'][0]], [[p[:2] for p in h] for h in v['rings'][1:]]).buffer(0), v['rings'][0][0][2]) for v in d['viaducts'] if not v.get('ceil')]
N, roofs, plats = {}, [], []
for _, e in etree.iterparse(str(ROOT / 'tools/tokyo-center.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = xy(float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}; refs = [n.get('ref') for n in e.findall('nd')]
        if refs[0] == refs[-1] and len(refs) >= 4 and not t.get('layer', '0').startswith('-') and not t.get('level', '0').startswith('-'):
            pts = [N[r] for r in refs[:-1] if r in N]
            if t.get('building') == 'roof': roofs.append(pts)
            elif t.get('railway') == 'platform': plats.append(pts)
        e.clear()
def on_via(g, k=0.6):   # 線路の高架の上にあるか(面積の k 以上)。高さも返す
    for v, h in via:
        if v.intersects(g) and v.intersection(g).area > k * g.area: return h
    return None
rnd = random.Random(1914)
COLS = ['#eeeeea', '#eeeeea', '#a9cdc6', '#a9cdc6', '#c3c6c8']   # 白・薄い水色・グレー
out = []
# 東京駅: 高架の上の細長い屋根(八重洲のグランルーフは別に描いているので除く)
for pts in roofs:
    g = Polygon(pts).buffer(0)
    if g.area < 150: continue
    mrr = g.minimum_rotated_rectangle; c = list(mrr.exterior.coords); a, b = math.dist(c[0], c[1]), math.dist(c[1], c[2])
    if max(a, b) / max(1e-6, min(a, b)) < 4: continue          # ホームの屋根は細長い
    h = on_via(g, 0.95)   # 全部が高架の上(八重洲のグランルーフは外れる)
    if h is None: continue
    out.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(g.exterior.coords)[:-1]], 'y': round(h + 5.5, 2), 'c': rnd.choice(COLS)})
print('東京駅の屋根', len(out), '(OSM の屋根', len(roofs), 'ホーム', len(plats), ')')
# 有楽町駅: 高架の上のホームを少し広げて白い屋根に
yk = [Polygon(p).buffer(0) for p in plats if -700 < sum(q[0] for q in p) / len(p) < -450 and -50 < sum(q[1] for q in p) / len(p) < 250]
yk = [g for g in yk if on_via(g) is not None]
if yk:
    u = unary_union([g.buffer(2.5, join_style=2) for g in yk])
    h = on_via(yk[0])
    for g in getattr(u, 'geoms', [u]):
        out.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(g.exterior.coords)[:-1]], 'y': round(h + 5.5, 2), 'c': '#f2f2ee'})
    print('有楽町駅の屋根', len(getattr(u, 'geoms', [u])))
# 屋根を支える柱: 屋根の長い向きの真ん中の線に 15m ごと
for r in out:
    g = Polygon(r['o']); c = list(g.minimum_rotated_rectangle.exterior.coords)
    a, b = (c[0], c[1]) if math.dist(c[0], c[1]) < math.dist(c[1], c[2]) else (c[1], c[2])
    m0 = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); o = (c[2], c[3]) if (a, b) == (c[0], c[1]) else (c[3], c[0])
    m1 = ((o[0][0] + o[1][0]) / 2, (o[0][1] + o[1][1]) / 2); L = math.dist(m0, m1); n = max(2, int(L // 15))
    r['posts'] = [[round(m0[0] + (m1[0] - m0[0]) * (k + 0.5) / n, 2), round(m0[1] + (m1[1] - m0[1]) * (k + 0.5) / n, 2)] for k in range(n)
                  if g.buffer(-0.5).contains(Point(m0[0] + (m1[0] - m0[0]) * (k + 0.5) / n, m0[1] + (m1[1] - m0[1]) * (k + 0.5) / n))]
d['stationRoofs'] = out
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
