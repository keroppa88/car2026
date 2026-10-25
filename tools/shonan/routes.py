# 湘南: 国道134号の走行ルート(左側通行の一番左の車線)とスタート地点を作る
#  → map/shonan-routes.json {west:[[x,z]...] (稲村ヶ崎→大磯), east:[...] (大磯→稲村ヶ崎), starts:{...}}
# 座標は osm_to_city.py と同じ(範囲 area.json の外枠の中心が原点、x=東、z=南)
import json, math, heapq, sys
from lxml import etree
area = json.load(open('tools/shonan/area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xy(lat, lon): return ((lon - lon0) * KX, -(lat - lat0) * KZ)
N, W = {}, []
for _, e in etree.iterparse('tools/shonan.osm', events=('end',)):
    if e.tag == 'node': N[e.get('id')] = xy(float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}
        if t.get('highway') in ('trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'tertiary'):
            W.append(([n.get('ref') for n in e.findall('nd')], t))
        e.clear()
def lanes_of(t):
    v = (t.get('lanes') or '').split(';')[0]
    oneway = t.get('oneway') in ('yes', '1')
    if v.isdigit(): return int(v), oneway
    return (2 if oneway else 4), oneway
# 有向グラフ: 辺ごとに「左の車線へずらす量」を持つ
G = {}
for refs, t in W:
    refs = [r for r in refs if r in N]
    n, ow = lanes_of(t)
    width = 4.5 if n == 1 and not ow else n * 3.25
    off = width / 2 - 1.625
    for a, b in zip(refs, refs[1:]):
        d = math.dist(N[a], N[b]) * (1 if t.get('ref') == '134' else 4)   # 134号を優先
        G.setdefault(a, []).append((b, d, off))
        if not ow: G.setdefault(b, []).append((a, d, off))
nodes134 = set(r for refs, t in W if t.get('ref') == '134' for r in refs)
nodes = [r for r in G if r in nodes134]
def dijkstra(src):
    dist, prev = {src: 0}, {}
    q = [(0, src)]
    while q:
        d, u = heapq.heappop(q)
        if d > dist[u]: continue
        for v, w, off in G.get(u, []):
            if d + w < dist.get(v, 1e18): dist[v] = d + w; prev[v] = (u, off); heapq.heappush(q, (d + w, v))
    return dist, prev
def best_path(src_side, dst_side):
    # 端の近く(200m)の点から、反対の端に一番近づける経路
    xs = sorted(N[r][0] for r in nodes)
    lo, hi = xs[0], xs[-1]
    srcs = [r for r in nodes if (N[r][0] > hi - 300 if src_side == 'E' else N[r][0] < lo + 300)]
    best = None
    for s in srcs:
        dist, prev = dijkstra(s)
        reach = [r for r in dist if r != s]
        if not reach: continue
        d = min(reach, key=lambda r: N[r][0]) if dst_side == 'W' else max(reach, key=lambda r: N[r][0])
        span = abs(N[d][0] - N[s][0])
        if best is None or span > best[0]: best = (span, s, d, prev)
    _, s, d, prev = best
    out, u = [], d
    while u != s:
        p, off = prev[u]; out.append((p, u, off)); u = p
    return out[::-1]
def lane_line(segs):
    pts = []
    for a, b, off in segs:
        (ax, az), (bx, bz) = N[a], N[b]; L = math.hypot(bx - ax, bz - az) or 1
        ox, oz = (bz - az) / L * off, -(bx - ax) / L * off   # 進む向きの左
        k = max(1, int(L // 6))
        for i in range(k):
            pts.append([round(ax + (bx - ax) * i / k + ox, 2), round(az + (bz - az) * i / k + oz, 2)])
    a, b, off = segs[-1]; (ax, az), (bx, bz) = N[a], N[b]; L = math.hypot(bx - ax, bz - az) or 1
    pts.append([round(bx + (bz - az) / L * off, 2), round(bz - (bx - ax) / L * off, 2)])
    return pts
from shapely.geometry import Polygon as _P, Point as _Pt
_A = _P([xy(p[1], p[0]) for p in area]).buffer(-15)
def trim(r):   # 範囲の外へ出る先は切る
    i0 = 0
    while i0 < len(r) and not _A.contains(_Pt(r[i0])): i0 += 1
    i1 = len(r) - 1
    while i1 > i0 and not _A.contains(_Pt(r[i1])): i1 -= 1
    out = r[i0:i1 + 1]
    # 途中で範囲の外へ出たら、そこまで
    for k, p in enumerate(out):
        if not _A.contains(_Pt(p)): return out[:k]
    return out
west = trim(lane_line(best_path('E', 'W')))   # 稲村ヶ崎 → 大磯
east = trim(lane_line(best_path('W', 'E')))   # 大磯 → 稲村ヶ崎
def start_at(route, k):
    a, b = route[k], route[min(k + 3, len(route) - 1)]
    return {'x': a[0], 'z': a[1], 'heading': round(math.atan2(b[0] - a[0], b[1] - a[1]), 3)}
# 湘南大橋(相模川)
sx, sz = xy(35.31964, 139.37360)   # 湘南大橋の東の端
kb = min(range(len(west)), key=lambda i: math.dist(west[i], (sx, sz)))
starts = {'inamuragasaki': start_at(west, 4), 'shonanohashi': start_at(west, max(0, kb - 25)), 'oiso': start_at(east, 4)}
json.dump({'west': west, 'east': east, 'starts': starts}, open('map/shonan-routes.json', 'w'), separators=(',', ':'))
print('西行き', len(west), '点', round(sum(math.dist(west[i], west[i + 1]) for i in range(len(west) - 1))), 'm / 東行き', len(east), '点', starts)
