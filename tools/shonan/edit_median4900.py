"""湘南 -4844,-732 〜 -4940,-699: 国道129号との交差点のため上下線が離れて中央分離帯が広くなっていた所を直す。
-4787,-747 と同じ片側2車線(分離帯なし)の道路を、交差点を過ぎるまで(-4945 付近)のばし、
そこから -5174,-660 の上下線が分かれた形へなめらかに移る(分かれ目からの分離帯は緑地帯)。
自動運転のルートもこの区間だけ新しい車線に合わせる。
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point
ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'; RFILE = ROOT / 'map/shonan-routes.json'
d = json.loads(FILE.read_text()); R = d['roads']; routes = json.loads(RFILE.read_text())
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
def find(a, b):
    for r in R:
        if near(r['pts'][0], a) and near(r['pts'][-1], b): return r
    raise SystemExit(f'道路が見つからない {a} {b}')
four = find((-3575, -1099), (-4815, -741))          # 片側2車線(分離帯なし)
eb = find((-5630, -648), (-4815, -741))             # 上り(東行き)
wb0 = find((-4815, -741), (-4899, -707))            # 下り(西行き)の東の短い所
wb = find((-4899, -707), (-5629, -638))             # 下り(西行き)
x129 = find((-4899, -707), (-4906, -743))           # 国道129号(交差する所)
E = four['pts'][-1]
X_SPLIT, X_JOIN = -4945.0, -5113.0                  # 分かれ始める所 / 元の上下線に合流する所
Le = LineString(eb['pts'][::-1])                    # 東→西
Lw = LineString(wb0['pts'] + wb['pts'][1:])         # 東→西
def mid_at(x):   # 上下線の真ん中(x の所)
    import numpy as np
    def zat(L):
        best = None
        for (ax, az), (bx, bz) in zip(L.coords[:-1], L.coords[1:]):
            if min(ax, bx) - 1e-6 <= x <= max(ax, bx) + 1e-6 and ax != bx:
                best = az + (bz - az) * (x - ax) / (bx - ax); break
        return best
    return (zat(Le) + zat(Lw)) / 2, zat(Le), zat(Lw)
# 真ん中の線(E → 分かれ目)。交差点は国道129号の線との交点
cl = [E] + [[x, mid_at(x)[0]] for x in [E[0] - 10 - 10 * k for k in range(int((E[0] - X_SPLIT) // 10))] if x > X_SPLIT] + [[X_SPLIT, mid_at(X_SPLIT)[0]]]
C = LineString(cl).simplify(0.3)
J = C.intersection(LineString(x129['pts']))
assert J.geom_type == 'Point', J
sJ = C.project(J); cc = list(C.coords)
acc = 0; out = [list(cc[0])]
for a, b in zip(cc[:-1], cc[1:]):
    seg = math.dist(a, b)
    if acc < sJ < acc + seg - 0.5 and acc + 0.5 < sJ: out.append([J.x, J.y])
    out.append(list(b)); acc += seg
cl = [[round(x, 2), round(z, 2)] for x, z in out]
jx = next(i for i, p in enumerate(cl) if near(p, (J.x, J.y), 0.05))
S = cl[-1]
n0 = len(four['pts'])
four['pts'] = four['pts'] + cl[1:]
four['junctions'] = sorted(set([j for j in four['junctions'] if j != n0 - 1] + [n0 - 1 + jx, len(four['pts']) - 1]))
# 国道129号に交点を足す(古い2つの合流点は交差点の印だけ外す)
q = x129['pts']; k = next(i for i in range(len(q) - 1) if LineString([q[i], q[i + 1]]).distance(J) < 0.05)
q.insert(k + 1, [round(J.x, 2), round(J.y, 2)])
x129['junctions'] = sorted(set([j + (1 if j > k else 0) for j in x129['junctions'] if not near(q[j + (1 if j > k else 0)], (-4900.6, -718.2), 1.5)] + [k + 1]))
# 分かれ目 S から元の上下線まで: 真ん中の線から 3.25m(片側2車線の半分)→ 元の位置へ、なめらかに
def taper(L_target, sign):
    pts = []
    xs = [X_SPLIT - 6 * k for k in range(1, int((X_SPLIT - X_JOIN) // 6))]
    for x in xs:
        m, ze, zw = mid_at(x)
        zt = ze if sign < 0 else zw
        t = (X_SPLIT - x) / (X_SPLIT - X_JOIN); s = t * t * (3 - 2 * t)
        # 北が -z。上り(東行き)は北側 sign=-1
        z = (m + sign * 3.25) * (1 - s) + zt * s
        pts.append([round(x, 2), round(z, 2)])
    return pts
tw = taper(Lw, +1); te = taper(Le, -1)
# 下り(西行き): S → テーパー → 元の線の X_JOIN より西
wpts = [S] + tw + [p for p in wb['pts'] if p[0] < X_JOIN - 3]
wb['pts'] = wpts; wb['junctions'] = [0, len(wpts) - 1]
# 上り(東行き): 元の線の X_JOIN より西 → テーパー(逆順) → S
west_e = [p for p in eb['pts'] if p[0] < X_JOIN - 3]
epts = west_e + te[::-1] + [S]
eb['junctions'] = [0, len(epts) - 1]; eb['pts'] = epts
d['roads'] = [r for r in R if r is not wb0]
# 中央分離帯: この区間の古いものを消し、分かれ目から先のすき間に緑地帯を並べる
d['medians'] = [m for m in d['medians'] if not (X_JOIN - 8 < m[0] < E[0] + 2 and -760 < m[1] < -640)]
Lw2, Le2 = LineString(wpts), LineString(epts)
for x in [X_SPLIT - 2 - 2 * k for k in range(int((X_SPLIT - X_JOIN + 6) // 2))]:
    m, _, _ = mid_at(x) if x > X_JOIN else (None, 0, 0)
    pw = Point(x, -700); 
    vline = LineString([(x, -800), (x, -600)])
    a, b = Lw2.intersection(vline), Le2.intersection(vline)
    if a.is_empty or b.is_empty: continue
    za, zb = a.y, b.y; gap = abs(za - zb) - 6.5
    if gap < 0.4: continue
    # 向き: 2つの線のこの辺の向き
    p1, p2 = Lw2.interpolate(Lw2.project(Point(x, za)) - 1), Lw2.interpolate(Lw2.project(Point(x, za)) + 1)
    ang = math.atan2(p2.x - p1.x, p2.y - p1.y)
    d['medians'].append([round(x, 2), round((za + zb) / 2, 2), round(ang, 3), 2.1, round(gap - 0.3, 2), 1])
# 自動運転のルート: この区間だけ、新しい車線(左の車線 = 道の中心から 1.625m 左)に合わせる
def lane(points, west):
    L = LineString(points); out = []
    for k in range(int(L.length // 6) + 1):
        p = L.interpolate(k * 6); a = L.interpolate(max(0, k * 6 - 1)); b = L.interpolate(min(L.length, k * 6 + 1))
        tx, tz = b.x - a.x, b.y - a.y; l = math.hypot(tx, tz) or 1; tx, tz = tx / l, tz / l
        lx, lz = tz, -tx          # 進む向きの左
        out.append([round(p.x + lx * 1.625, 2), round(p.y + lz * 1.625, 2)])
    return out
# 西行き: 片側2車線の西行き側(中心から 3.25+1.625 = 4.875m 左)→ 下り線の左の車線
cen = four['pts']; ix = next(i for i, p in enumerate(cen) if p[0] < -4790)
seg4 = cen[ix - 1:]
def offset(points, d0):
    L = LineString(points); out = []
    for k in range(int(L.length // 6) + 1):
        p = L.interpolate(k * 6); a = L.interpolate(max(0, k * 6 - 1)); b = L.interpolate(min(L.length, k * 6 + 1))
        tx, tz = b.x - a.x, b.y - a.y; l = math.hypot(tx, tz) or 1; tx, tz = tx / l, tz / l
        out.append([round(p.x + tz * d0, 2), round(p.y - tx * d0, 2)])
    return out
wnew = offset(seg4, 4.875) + lane(wpts, True)[1:]
enew = lane(epts, False)[:-1] + offset(seg4[::-1], 4.875)
X0, X1 = -4790, X_JOIN - 20
w = routes['west']; i0 = next(i for i, p in enumerate(w) if p[0] < X0); i1 = next(i for i, p in enumerate(w) if p[0] < X1)
routes['west'] = w[:i0] + [p for p in wnew if X1 <= p[0] < X0] + w[i1:]
e = routes['east']; j0 = next(i for i, p in enumerate(e) if p[0] > X1); j1 = next(i for i, p in enumerate(e) if p[0] > X0)
routes['east'] = e[:j0] + [p for p in enew if X1 < p[0] <= X0] + e[j1:]
# 古い下り線の歩道の切れ端(どの道路の歩道にもかからない帯)を消す
from shapely.geometry import box
from shapely.ops import unary_union
RW = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
BX = box(-5130, -780, -4790, -640)
side = unary_union([LineString(r['pts']).buffer(RW(r) / 2 + 4.6) for r in d['roads'] if LineString(r['pts']).intersects(BX.buffer(50))])
d['strips'] = [t for t in d['strips'] if not (BX.contains(Point(t[0], t[1])) and not side.contains(Point(t[0], t[1])))]
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
RFILE.write_text(json.dumps(routes, separators=(',', ':')))
print('交差点', [round(J.x, 1), round(J.y, 1)], '分かれ目', S, '分離帯', sum(1 for m in d['medians'] if X_JOIN - 8 < m[0] < X_SPLIT + 1 and -760 < m[1] < -640))
