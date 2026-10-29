"""湘南: 江ノ電(単線)の線路を作る。OSM の江ノ島電鉄の線路をつないだ1本の線(地図の範囲内)。
・道路のすぐ脇(すき間 6m 未満)を通る所は、道路に隣接するよう寄せる。道路と重なる所はそのまま
・線路(砂利の路盤)は道路より 2m 高い。道路の車道を横切る所(踏切)は道路の高さで、前後 15m は坂
・路盤(幅 4m)にかかる建物は消す。林・緑地は路盤の所だけ外す
出力: city.json の enoden = {pts: [[x,z,h],...]}(2m ごと)
python3 tools/shonan/make_enoden.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from lxml import etree
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, unary_union
from shapely.strtree import STRtree
import sys
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, shape
ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); M = Map(d)
area = json.load(open(ROOT / 'tools/shonan/area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
xy = lambda lat, lon: ((lon - lon0) * KX, -(lat - lat0) * KZ)
N, ways = {}, []
for _, e in etree.iterparse(str(ROOT / 'tools/shonan.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = xy(float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}
        if t.get('railway') == 'light_rail' and not t.get('service'):
            ways.append(LineString([N[r] for r in (n.get('ref') for n in e.findall('nd')) if r in N]))
        e.clear()
X0, Z0, X1, Z1 = d['bounds']
# 線路のグラフ(点を 0.5m でまとめる)をたどって、江ノ島駅(6591,-39)から地図の東の端までの最短の道
import heapq
key = lambda c: (round(c[0] * 2), round(c[1] * 2))
G = {}
for w in ways:
    c = list(w.coords)
    for a, b in zip(c, c[1:]):
        ka, kb = key(a), key(b); dd = math.dist(a, b)
        G.setdefault(ka, {})[kb] = (dd, b); G.setdefault(kb, {})[ka] = (dd, a)
P = {k: v[1] for k in G for v in G[k].values()}
for k in G:
    for kb, (dd, b) in G[k].items(): P[kb] = b
start = min(G, key=lambda k: math.dist(P[k], (6591, -39)))
end = min((k for k in G if P[k][0] < X1 - 5), key=lambda k: -P[k][0])
dist, prev, q = {start: 0}, {}, [(0, start)]
while q:
    dd, u = heapq.heappop(q)
    if u == end: break
    if dd > dist[u]: continue
    for v, (w_, _) in G[u].items():
        if dd + w_ < dist.get(v, 1e18): dist[v] = dd + w_; prev[v] = u; heapq.heappush(q, (dd + w_, v))
path, u = [], end
while u != start: path.append(P[u]); u = prev[u]
path.append(P[start]); path = path[::-1]
line = LineString(path).intersection(box(X0 + 5, -300, X1 - 5, Z1))
line = max(getattr(line, 'geoms', [line]), key=lambda l: l.length)
if line.coords[0][0] > line.coords[-1][0]: line = LineString(line.coords[::-1])   # 西→東
print('江ノ電', round(line.length), 'm', [round(v) for v in line.coords[0]], '→', [round(v) for v in line.coords[-1]])
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
SW = d.get('sidewalk', 4.5)
R = d['roads']
outer = [LineString(r['pts']).buffer(W(r) / 2 + (0 if r.get('bridge') else SW), cap_style=2, join_style=2) for r in R]   # 歩道まで
carr = [LineString(r['pts']).buffer(W(r) / 2, cap_style=2, join_style=2) for r in R]
to, tc = STRtree(outer), STRtree(carr)
HALF = 2.0   # 路盤の半幅
n = int(line.length // 2) + 1
pts = []
for k in range(n):
    s = min(line.length, k * 2.0); p = line.interpolate(s)
    a = line.interpolate(max(0, s - 3)); b = line.interpolate(min(line.length, s + 3))
    tx, tz = b.x - a.x, b.y - a.y; l = math.hypot(tx, tz) or 1; nx, nz = tz / l, -tx / l
    shift = 0.0
    if not any(carr[j].contains(p) for j in tc.query(p)):
        # 左右それぞれ、路盤の縁から道路(歩道の外側)までのすき間
        for sd in (1, -1):
            for dd in [x * 0.25 for x in range(0, 33)]:
                q = Point(p.x + nx * sd * (HALF + dd), p.y + nz * sd * (HALF + dd))
                if any(outer[j].contains(q) for j in to.query(q)):
                    if 0.25 < dd < 6 and abs(shift) < 1e-9: shift = sd * (dd - 0.1)
                    break
    pts.append([p.x + nx * shift, p.y + nz * shift])
# 寄せ量をなめらかに(急に曲がらないよう 7 点の平均)
sm = []
for i in range(len(pts)):
    xs = pts[max(0, i - 3): i + 4]
    sm.append([sum(q[0] for q in xs) / len(xs), sum(q[1] for q in xs) / len(xs)])
sm[0], sm[-1] = pts[0], pts[-1]
# 高さ: 車道の上は 0(踏切)、ほかは 2m。坂は 15m で 2m
cross = [any(carr[j].buffer(1.0).contains(Point(q)) for j in tc.query(Point(q))) for q in sm]
dist = [0.0]
for i in range(1, len(sm)): dist.append(dist[-1] + math.dist(sm[i - 1], sm[i]))
cs = [dist[i] for i, c in enumerate(cross) if c]
import bisect
def h(s):
    if not cs: return 2.0
    i = bisect.bisect_left(cs, s); dmin = min(abs(s - cs[j]) for j in (i - 1, i) if 0 <= j < len(cs))
    return round(min(2.0, dmin / 15 * 2.0), 2)
out = [[round(q[0], 2), round(q[1], 2), h(dist[i])] for i, q in enumerate(sm)]
d['enoden'] = {'pts': out}
bed = LineString([q[:2] for q in out]).buffer(HALF + 0.3, cap_style=2)
b0 = len(d['buildings']); d['buildings'] = [b for b in d['buildings'] if not Polygon(b['p']).buffer(0).intersects(bed)]
M.cut(bed, ['woods', 'parks'])
d['trees'] = [t for t in d.get('trees', []) if not bed.contains(Point(t[0], t[1]))]
print('点', len(out), ' 踏切', sum(1 for q in out if q[2] == 0), '点  消した建物', b0 - len(d['buildings']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
