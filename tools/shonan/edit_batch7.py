"""湘南: 座標の指示(2026-10-29 17:35)。
・湘南新道(1585,-1137 / 1668,-1253): 上下線と中央分離帯・交差点の取り付けを消し、2車線の道路1本(両側に歩道、横断歩道なし)に。
  最後は曲げて国道134号に直角につなぐ
・6453,242 の重なった横断歩道を両方とも置かない
・中央分離帯の緑地のない所(上下線のすき間がグレーのまま)を緑地で埋める(全域)
python3 tools/shonan/edit_batch7.py → fit_medians は使わない(ここで足す) → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
near = lambda p, q, e=1.0: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
# ---- 湘南新道 ----
up = next(r for r in R if r.get('name') == '戸塚茅ヶ崎線（湘南新道）' and r.get('oneway') and near(r['pts'][0], (1585, -1138), 2))
dn = next(r for r in R if r.get('name') == '戸塚茅ヶ崎線（湘南新道）' and r.get('oneway') and near(r['pts'][-1], (1585, -1138), 2))
cn = next(r for r in R if r.get('name') == '戸塚茅ヶ崎線（湘南新道）' and not r.get('oneway'))
Lu, Ld = LineString(up['pts']), LineString(dn['pts'])
cl = []
for k in range(int(Lu.length // 5) + 1):
    p = Lu.interpolate(Lu.length - k * 5); q = Ld.interpolate(Ld.project(p))   # 北東の端から
    cl.append(((p.x + q.x) / 2, (p.y + q.y) / 2))
cl = LineString(cl).simplify(0.5)
# 国道134号(北側の車線)に直角に: 交差点の点 J、その 35m 北が曲がり終わり
r161 = next(r for r in R if r.get('name') == '国道134号' and near(r['pts'][0], (3083.5, -1007.8)))
L161 = LineString(r161['pts'])
sJ = L161.project(Point(1572, -1081)); J = L161.interpolate(sJ)
a, b = L161.interpolate(sJ - 3), L161.interpolate(sJ + 3)
tx, tz = (b.x - a.x) / 6, (b.y - a.y) / 6; nx, nz = tz, -tx
if nz > 0: nx, nz = -nx, -nz   # 北(z が小さい方)向き
P1 = (J.x + nx * 35, J.y + nz * 35)
cut = cl.project(Point(P1))
main = [c for c in cl.coords if cl.project(Point(c)) < cut - 25]
B = main[-1]
# B → P1 を、P1 で向きが直角になるようになめらかに(2次ベジェ: 制御点は P1 から 25m 北)
C = (P1[0] + nx * 25, P1[1] + nz * 25)
curve = [((1 - t) ** 2 * B[0] + 2 * (1 - t) * t * C[0] + t * t * P1[0], (1 - t) ** 2 * B[1] + 2 * (1 - t) * t * C[1] + t * t * P1[1]) for t in [i / 8 for i in range(1, 9)]]
pts = [[round(x, 2), round(z, 2)] for x, z in main + curve + [(J.x, J.y)]]
new = {'pts': pts, 'lanes': 2, 'oneway': False, 'kind': 'primary', 'name': '戸塚茅ヶ崎線（湘南新道）', 'junctions': [len(pts) - 1], 'noCrosswalk': True}
d['roads'] = [r for r in R if r is not up and r is not dn and r is not cn] + [new]; R = d['roads']
# 国道の線に交差点の点を入れる
i = max(range(len(r161['pts']) - 1), key=lambda i: -LineString(r161['pts'][i:i + 2]).distance(J))
r161['pts'].insert(i + 1, pts[-1]); r161['junctions'] = sorted({(j + 1 if j > i else j) for j in r161['junctions']} | {i + 1})
zone = LineString(pts).buffer(20)
b0 = len(d['medians']); d['medians'] = [m for m in d['medians'] if not zone.contains(Point(m[0], m[1]))]
print('湘南新道を1本に', len(pts), '点', round(LineString(pts).length), 'm  中央分離帯', b0 - len(d['medians']))
# ---- 横断歩道を置かない所 ----
d['noCrosswalks'] = d.get('noCrosswalks', []) + [[6453, 242], [-7315, -504], [round(J.x, 1), round(J.y, 1)]]   # 湘南新道の交差点も横断歩道なし
# ---- 中央分離帯のすき間を埋める ----
lines = [LineString(r['pts']) for r in R]
polys = [l.buffer(W(r) / 2, cap_style=2, join_style=2) for l, r in zip(lines, R)]
tp = STRtree(polys)
mt = STRtree([Point(m[0], m[1]) for m in d['medians']]) if d['medians'] else None
from shapely.geometry import Polygon
bl = [Polygon(b['p']).buffer(0) for b in d['buildings']]; tb = STRtree(bl)
def intervals(p, n, maxd=32):
    ray = LineString([p, (p[0] + n[0] * maxd, p[1] + n[1] * maxd)]); out = []
    for j in tp.query(ray):
        x = ray.intersection(polys[j])
        for g in getattr(x, 'geoms', [x]):
            if g.is_empty or g.geom_type != 'LineString': continue
            ds = sorted(math.hypot(c[0] - p[0], c[1] - p[1]) for c in g.coords); out.append((ds[0], ds[-1], j))
    out.sort(); return out
# 前に指示で中央分離帯の緑地を消した所には足さない
from shapely.ops import unary_union
NOFILL = unary_union([LineString([(6062, 251), (6189, 321), (6408, 267)]).buffer(30),
    LineString([(-5090, -677), (-4996, -697), (-4940, -686), (-4869, -708), (-4777, -766)]).buffer(30),
    Point(8248, 483).buffer(25), Point(6450, 240).buffer(25), Point(1565, -1105).buffer(40)] + [Point(x, z).buffer(15) for x, z in [(-4869, -708), (-4777, -766)]])
add = []
for i, r in enumerate(R):
    if not r.get('oneway') or r.get('bridge') or r['kind'] not in ('trunk', 'primary', 'secondary', 'tertiary') or (r.get('lanes') or 1) < 2: continue
    L = lines[i]
    for k in range(int(L.length // 2)):
        s = k * 2 + 1; p = L.interpolate(s); a2 = L.interpolate(max(0, s - 1)); b2 = L.interpolate(min(L.length, s + 1))
        dx, dz = b2.x - a2.x, b2.y - a2.y; l = math.hypot(dx, dz) or 1; dx, dz = dx / l, dz / l
        nx2, nz2 = -dz, dx   # 進む向きの右(左側通行の中央分離帯側)
        iv = intervals((p.x, p.y), (nx2, nz2))
        e1 = 0
        for a3, b3, j in iv:
            if a3 <= e1 + 0.05: e1 = max(e1, b3); continue
            # 次の車道 j: 逆向きの一方通行なら上下線のすき間
            Lj = lines[j]; sj = Lj.project(p); c1 = Lj.interpolate(max(0, sj - 1)); c2 = Lj.interpolate(min(Lj.length, sj + 1))
            ex, ez = c2.x - c1.x, c2.y - c1.y; el = math.hypot(ex, ez) or 1
            if R[j].get('oneway') and (ex * dx + ez * dz) / el < -0.8:
                w = a3 - e1 - 0.3; mid = (a3 + e1) / 2; c = (p.x + nx2 * mid, p.y + nz2 * mid)
                gapl = LineString([(p.x + nx2 * e1, p.y + nz2 * e1), (p.x + nx2 * a3, p.y + nz2 * a3)])
                if any(bl[q].intersects(gapl) for q in tb.query(gapl)): break   # 間に建物がある: 別々の道
                if NOFILL.contains(Point(p.x, p.y)): break
                if 0.5 < w < 20 and (mt is None or not any(Point(c).distance(Point(d['medians'][q][0], d['medians'][q][1])) < 1.6 for q in mt.query(Point(c).buffer(1.6)))):
                    add.append([round(c[0], 2), round(c[1], 2), round(math.atan2(dx, dz), 4), 2.05, round(w, 2), 1])
            break
grid = {}
uniq = []
for m in add:
    k = (round(m[0] / 0.6), round(m[1] / 0.6))   # 0.6m の升目で、となり(1.2m 以内)だけを同じとみなす
    if any((k[0] + a, k[1] + b) in grid for a in (-1, 0, 1) for b in (-1, 0, 1)): continue
    grid[k] = 1; uniq.append(m)
add = uniq
d['medians'] += add
print('中央分離帯のすき間を埋めた', len(add))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
