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
lines_ = [LineString(r['pts']) for r in R]
def road_dir(j, p):
    L = lines_[j]; s0 = L.project(p); a = L.interpolate(max(0, s0 - 2)); b = L.interpolate(min(L.length, s0 + 2))
    l = math.hypot(b.x - a.x, b.y - a.y) or 1; return (b.x - a.x) / l, (b.y - a.y) / l
n = int(line.length // 2) + 1
base_pts, cross, offs = [], [], []
for k in range(n):
    s = min(line.length, k * 2.0); p = line.interpolate(s)
    a = line.interpolate(max(0, s - 3)); b = line.interpolate(min(line.length, s + 3))
    tx, tz = b.x - a.x, b.y - a.y; l = math.hypot(tx, tz) or 1; tx, tz = tx / l, tz / l; nx, nz = tz, -tx
    base_pts.append((p, nx, nz))
    near = [j for j in to.query(p.buffer(HALF)) if outer[j].distance(p) < HALF]
    crossing = [j for j in near if abs(sum(u * v for u, v in zip(road_dir(j, p), (tx, tz)))) < 0.7]   # 45度より直角に近い = 踏切
    parallel = [j for j in near if j not in crossing]
    cross.append(any(carr[j].buffer(1.0).contains(p) for j in crossing))
    off = 0.0
    if parallel and not cross[-1]:
        # 並行な道路(歩道まで)と重ならない、いちばん近い位置へずらす
        cands = []
        for sd in (1, -1):
            for dd in [x * 0.5 for x in range(1, 61)]:
                q = Point(p.x + nx * sd * dd, p.y + nz * sd * dd)
                if not any(outer[j].distance(q) < HALF + 0.1 for j in to.query(q.buffer(HALF + 0.1)) if j not in crossing): cands.append(sd * dd); break
        if cands: off = min(cands, key=abs)
    offs.append(off)
# ずらし量をなめらかに(急に曲がらないよう)。重なりが残らないよう、まわりの大きい方を使ってからならす
def smooth(o):
    m = [max(o[max(0, i - 10): i + 11], key=abs) if any(o[max(0, i - 10): i + 11]) else 0 for i in range(n)]
    return [sum(m[max(0, i - 9): i + 10]) / len(m[max(0, i - 9): i + 10]) for i in range(n)]
def overlaps(i, o):
    p, nx, nz = base_pts[i]; q = Point(p.x + nx * o, p.y + nz * o)
    return not cross[i] and any(outer[j].distance(q) < HALF and abs(sum(u * v for u, v in zip(road_dir(j, q), (-nz, nx)))) >= 0.7 for j in to.query(q.buffer(HALF)))
sm_off = smooth(offs)
for it in range(4):   # ならしたせいで重なりが残った所は、もう一度ずらし直す
    bad = 0
    for i in range(n):
        if not overlaps(i, sm_off[i]): continue
        bad += 1; p, nx, nz = base_pts[i]; sd = 1 if sm_off[i] >= 0 else -1
        for dd in [x * 0.5 for x in range(1, 41)]:
            o = sm_off[i] + sd * dd
            if not overlaps(i, o): offs[i] = o if abs(o) > abs(offs[i]) else offs[i]; break
    if not bad: break
    sm_off = smooth(offs)
sm = [[p.x + nx * o, p.y + nz * o] for (p, nx, nz), o in zip(base_pts, sm_off)]
print('並行で重なる所をずらした', sum(1 for o in offs if o), '点  踏切', sum(cross), '点')
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
wide = LineString([q[:2] for q in out]).buffer(HALF + 1.5, cap_style=2)
for k in ('medians', 'strips'): d[k] = [m for m in d[k] if not wide.contains(Point(m[0], m[1]))]
d['buildings'] = [b for b in d['buildings'] if not Polygon(b['p']).buffer(0).intersects(wide)]
d['trees'] = [t for t in d.get('trees', []) if not bed.contains(Point(t[0], t[1]))]
print('点', len(out), ' 踏切', sum(1 for q in out if q[2] == 0), '点  消した建物', b0 - len(d['buildings']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
