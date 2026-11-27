"""湘南: 座標の指示(2026-11-27 13:29)。
赤   = 中の物(駐車場・敷地・建物・道路・堤防など)を消して、ただの地面に。
       8・10 は周りの公園と同じ緑地、24〜26 は周りの林と同じ林、30〜35(海の中の灰色の板)は海に。
       28 は江ノ電の線路の西の端も消す。
ピンク = 中の物を全部消して地面で統一(水・道路も)。
白   = 輪になった道路の白線などを消して、アスファルト一色(駐車場と同じ面)に。
水色 = 道路をつなぐ(形はガイド)。
python3 tools/shonan/edit_batch12.py → python3 tools/shonan/make_foam.py → python3 tools/shonan/build_surfaces.py
"""
import sys, json, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape, encode
from shapely.geometry import Polygon, LineString, Point
from shapely.ops import unary_union

A = {
 1: [(9835.25,754),(9837,755.75),(9862,761.75),(9874.25,762.5),(9873.75,759.25),(9836,749.75)],
 2: [(9719.25,723.5),(9725,729.25),(9737.75,731.75),(9738.75,729.75),(9726.5,717.5)],
 3: [(9702.25,720.25),(9704.75,727.75),(9693.75,742),(9676.5,731.75),(9678,708.75),(9690,706.5)],
 4: [(9609.75,743),(9612.25,746),(9613.25,754.5),(9618.25,754.75),(9633.5,751.5),(9633.75,737.25),(9628,731),(9612.75,730.5),(9609.75,740.5)],
 5: [(9436,717),(9435.5,723.5),(9422.75,736.5),(9421.25,724.5),(9432.5,719.75),(9434.25,717)],
 6: [(9418,739.5),(9419.5,771.25),(9434,771.25),(9434,769.5),(9425.5,763),(9423.5,760.75),(9423,759.25),(9422.75,756.5),(9422.5,738)],
 7: [(8630.75,521),(8626,553),(8594.5,548.75),(8601.5,515)],
 8: [(5593.75,-208),(5668.75,-116.75),(5666.25,-108.25),(5648,-102.25),(5623.75,-127),(5614.25,-119),(5549.75,-192.25),(5570.75,-212),(5581.5,-200.75)],
 10: [(5593.75,-208),(5592.5,-210),(5581.5,-200.75)],
 11: [(1842.5,-1139.75),(1827,-1142),(1824.5,-1113),(1840.25,-1114.75)],
 12: [(-3443.75,-1125),(-3423.5,-1090),(-3378.25,-1082.75),(-3374.25,-1075.5),(-3358.75,-1016.75),(-3286,-1039),(-3362,-1167.75),(-3436.5,-1149.5),(-3435,-1127.75)],
 13: [(-8687,-147.25),(-8681.5,-135.75),(-8751.75,-103.5),(-8782,-83),(-8785.25,-88.5),(-8756.5,-109)],
 14: [(-8806,-39.25),(-8796,-43.25),(-8804.5,-68),(-8813.25,-64)],
 15: [(-8083,-843.25),(-8061.75,-827.75),(-8029,-833),(-8027.75,-852.5),(-8081.75,-864.75),(-8088.5,-856.25)],
 16: [(-9113.5,428.5),(-9120.5,427.75),(-9129.25,433.25),(-9131.25,444.25),(-9114.75,450.5),(-9102.5,440.25)],
 17: [(-9754.5,254),(-9733.25,254.75),(-9735.5,224.5),(-9758.5,233.5)],
 18: [(-9736.25,333),(-9720,451.25),(-9712.25,449.75),(-9725.75,328.75)],
 19: [(-9675.75,233.75),(-9664.75,234.25),(-9665.25,240.75),(-9656,242.75),(-9657,272.75),(-9664.25,272.25),(-9663,247.5),(-9673.5,245)],
 20: [(-9574.5,66.5),(-9580.25,93.75),(-9611.5,85.5),(-9603,71.5)],
 21: [(-9458.25,59.25),(-9469.75,56.25),(-9458,27),(-9444,30.5),(-9451.5,50.5)],
 22: [(-9369.25,-37.75),(-9363.75,-18.25),(-9348.75,-14.25),(-9345,-25.5),(-9350.25,-34),(-9360.75,-43)],
 23: [(-6172.25,-588.5),(-6181.5,-587.5),(-6178,-574.25),(-6193,-561),(-6191.5,-550.75),(-6183.5,-541.25),(-6168.25,-548),(-6166.75,-564.25),(-6170.5,-582)],
 24: [(-5618.75,-565.5),(-5616.75,-561.75),(-5620.75,-559),(-5626,-563),(-5624,-567.5)],
 25: [(-5643.75,-578),(-5640.75,-572.5),(-5649.5,-572.25),(-5652.5,-581.5),(-5645.75,-581.75)],
 26: [(-5598.5,-633.25),(-5661,-630.75),(-5654.75,-583.75),(-5648.25,-583.5),(-5650,-621.25),(-5604.25,-623.5)],
 27: [(-3791.75,-1419.25),(-3670.25,-1428.5),(-3718.25,-1500)],
 28: [(6703.5,2.5),(6711,-0.5),(6728,-22.25),(6662.5,-90.75),(6575.5,-52.25),(6584.75,-23.5),(6665.25,-47.75)],
 29: [(6014.25,1174.75),(6048.5,1185.75),(6065.25,1179.25),(6057.25,1165.5),(6058.75,1153.25),(6066.25,1144.25),(6075.25,1133.75),(6068,1120),(6064.75,1096),(6084.75,1075.25),(6110.75,1066),(6139.75,1085.25),(6197,1154.25),(6308.75,1298.25),(6417.5,1257.75),(6429.25,1290.5),(6100.75,1406.25),(5955.25,1353),(5947,1367.5),(5924.25,1353),(5951.5,1291.75),(5945,1257.75),(5985.25,1163.25)],
 30: [(5955.25,1376.5),(5950,1390.75),(5957.75,1417.5),(5995.5,1423.75),(6003.5,1406.5),(5984.25,1391)],
 31: [(5897.25,1362),(5900,1384),(5891,1393.25),(5857.75,1372.25),(5879,1356.5),(5896.75,1350)],
 32: [(5945,1385.25),(5949.75,1400.5),(5938.5,1411.75),(5920.25,1398.75),(5928.75,1383)],
 33: [(5625.75,1350.25),(5617.75,1402),(5595,1406.75),(5601,1355.75),(5604.75,1346.5)],
 34: [(5490.5,1401.25),(5510.5,1406.5),(5524.75,1400.75),(5520,1441.25),(5498.25,1419)],
 35: [(5580.75,1360),(5587.25,1353),(5599.5,1353.75),(5596,1380.5),(5588,1385)],
 36: [(5930.75,839),(5950.25,813.75),(5985.5,845),(6029,961),(6073.5,1044.75),(6038,1076.75),(5946,1051),(5933.25,1009),(5906.75,1042.5),(5847.5,1039.25),(5755.25,1015.5),(5783.5,974),(5792.75,934),(5827.25,879.75),(5875,864.25),(5927,850.25)],
}
G = {n: Polygon(p).buffer(0) for n, p in A.items()}
GROUND = [1, 2, 3, 4, 5, 6, 7, 12, 15, 16, 17, 20, 21, 22, 27, 28]
GREEN = {8: 'parks', 10: 'parks', 24: 'woods', 25: 'woods', 26: 'woods'}
SEA = [30, 31, 32, 33, 34, 35]
PINK = [29, 36]

d = json.loads(FILE.read_text()); M = Map(d)
key = lambda q: (round(q[0], 2), round(q[1], 2))
RW = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25

def cut_roads(region):
    """region の中の道路を切る(外に残る 6m 以上の部分は残す)"""
    out, n = [], 0
    for r in d['roads']:
        L = LineString(r['pts'])
        if not L.intersects(region): out.append(r); continue
        n += 1
        rest = L.difference(region)
        s = [0.0]
        for a, b in zip(r['pts'][:-1], r['pts'][1:]): s.append(s[-1] + math.dist(a, b))
        for piece in getattr(rest, 'geoms', [rest]):
            if piece.is_empty or piece.length < 6: continue
            s0, s1 = L.project(Point(piece.coords[0])), L.project(Point(piece.coords[-1]))
            idx = [i for i in range(len(r['pts'])) if s0 + 0.3 < s[i] < s1 - 0.3]
            pts = [[round(c, 2) for c in piece.coords[0]]] + [r['pts'][i] for i in idx] + [[round(c, 2) for c in piece.coords[-1]]]
            if s0 < 0.3: pts[0] = r['pts'][0]
            if s1 > s[-1] - 0.3: pts[-1] = r['pts'][-1]
            q = {**r, 'pts': pts}
            if r.get('longBridge'):   # 長い橋の区間の番号を付け直す
                a, b = r['longBridge']; old = [0 if s0 < 0.3 else None] + idx + [len(r['pts']) - 1 if s1 > s[-1] - 0.3 else None]
                lb = [k for k, i in enumerate(old) if i is not None and a <= i <= b]
                if lb: q['longBridge'] = [lb[0], lb[-1]]
                else: q.pop('longBridge')
            out.append(q)
    d['roads'] = out
    return n

def fix_junctions():
    cnt = {}
    for r in d['roads']:
        for q in r['pts']: cnt[key(q)] = cnt.get(key(q), 0) + 1
    for r in d['roads']:
        r['junctions'] = [i for i, q in enumerate(r['pts']) if cnt.get(key(q), 0) > 1]

def clear_small(region):
    """建物(半分以上が中)・木・歩道の帯・中央分離帯・船・植え込みを消す"""
    def mostly(p):
        g = Polygon(p).buffer(0); return g.area > 0 and g.intersection(region).area > 0.5 * g.area
    b = len(d['buildings']); d['buildings'] = [x for x in d['buildings'] if not mostly(x['p'])]
    d['trees'] = [t for t in d['trees'] if not region.contains(Point(t[0], t[1]))]
    d['strips'] = [t for t in d['strips'] if not region.contains(Point(t[0], t[1]))]
    d['medians'] = [t for t in d['medians'] if not region.contains(Point(t[0], t[1]))]
    d['boats'] = [t for t in d['boats'] if not region.contains(Point(t['x'], t['z']))]
    for k in ('bushes', 'barriers'):
        d[k] = [t for t in d[k] if not LineString(t['pts']).intersects(region)]
    return b - len(d['buildings'])

def cut_kinds(region, kinds, only_inside=False):
    """kinds の面を region で切る。only_inside: 半分以上が中にある面だけ(周りの大きな面は残す)"""
    for k in kinds:
        out = []
        for q in d[k]:
            g = shape(q)
            if g.intersects(region) and g.intersection(region).area > .5 and (not only_inside or g.intersection(region).area > 0.5 * g.area):
                out += encode(g.difference(region), **{a: b for a, b in q.items() if a not in ('o', 'h')})
            else: out.append(q)
        d[k] = out

# ---- 赤: ただの地面 ----
for n in GROUND:
    g = G[n]
    nb = clear_small(g); nr = cut_roads(g)
    cut_kinds(g, ('lots', 'parking', 'piers', 'beaches', 'rocks'))
    cut_kinds(g, ('parks', 'woods'), only_inside=(n != 27))   # 周りの緑地・林の縁はそのまま、中の小さな緑だけ消す
    M.cut_water(g)
    print('赤', n, '建物', nb, '道路', nr)
# 28: 江ノ電の線路の西の端
P = d['enoden']['pts']; L = LineString([p[:2] for p in P])
i = next(k for k, p in enumerate(P) if not G[28].contains(Point(p[0], p[1])))
cross = LineString([P[i - 1][:2], P[i][:2]]).intersection(G[28].exterior)
c = cross if cross.geom_type == 'Point' else list(cross.geoms)[0]
d['enoden']['pts'] = [[round(c.x, 2), round(c.y, 2), P[i][2]]] + P[i:]
print('江ノ電 消した点', i)

# ---- 赤: 周りと同じ緑 ----
for n, kind in GREEN.items():
    g = G[n]
    nb = clear_small(g); nr = cut_roads(g)
    M.put(g, kind, keep_water=True, clear=False)
    print('緑', n, kind, '建物', nb, '道路', nr)

# ---- 赤: 海の中の灰色の板 → 海(砂浜はそのまま) ----
for n in SEA:
    g = G[n]
    plates = unary_union([shape(q) for k in ('piers', 'rocks', 'lots', 'parking') for q in d[k] if shape(q).intersects(g)]).intersection(g)
    clear_small(g)
    M.put(plates.buffer(0.05).intersection(g), 'sea')
    print('海', n, round(plates.area), 'm²')

# ---- ピンク: 全部消して地面で統一 ----
for n in PINK:
    g = G[n]
    nb = clear_small(g); nr = cut_roads(g)
    M.put(g, 'ground')   # 陸の面・水面を全部切る(地面になる)
    d.setdefault('groundAreas', []).append([list(p) for p in A[n]])   # 江の島の地形の上も地面の色に(build_surfaces.py)
    print('ピンク', n, '建物', nb, '道路', nr)

# ---- 白: 輪の道路 → アスファルト一色 ----
g = G[23]
nr = cut_roads(g); clear_small(g)
M.put(g, 'parking', keep_water=True, clear=False)
print('白 23 道路', nr)

# ---- 水色: 道路をつなぐ ----
R = d['roads']
def find(p, e=0.6):
    return [r for r in R if any(abs(q[0] - p[0]) < e and abs(q[1] - p[1]) < e for q in (r['pts'][0], r['pts'][-1]))]
def on_road(r, p):
    """道路 r の上の p に一番近い点を頂点として入れ、その座標を返す"""
    Lr = LineString(r['pts']); s = Lr.project(Point(p)); q = Lr.interpolate(s); q = [round(q.x, 2), round(q.y, 2)]
    acc = 0
    for i in range(len(r['pts']) - 1):
        seg = math.dist(r['pts'][i], r['pts'][i + 1])
        if acc + seg >= s:
            if math.dist(q, r['pts'][i]) < 1.5: return r['pts'][i]
            if math.dist(q, r['pts'][i + 1]) < 1.5: return r['pts'][i + 1]
            r['pts'].insert(i + 1, q); return q
        acc += seg
    return r['pts'][-1]
def road_at(p, kind=None, name=None):
    return min((r for r in R if (kind is None or r['kind'] == kind) and (name is None or r.get('name') == name)), key=lambda r: LineString(r['pts']).distance(Point(p)))
new = []
# 11: 行き止まり(1835,-1140)から南の国道134号へ
r11 = find((1835.27, -1140.0), 1.0)[0] if find((1835.27, -1140.0), 1.0) else None
t = road_at((1833, -1112), 'trunk')
q = on_road(t, (1833.2, -1111.8))
end = r11['pts'][-1] if math.dist(r11['pts'][-1], (1835, -1140)) < 2 else r11['pts'][0]
d11 = q
if end is r11['pts'][-1]: r11['pts'].append(q)
else: r11['pts'].insert(0, q)
# 13: (-8686,-140) の行き止まりを、(-8783,-88) の交差点までのばす
r13 = find((-8686, -140), 1.5)[0]
j13 = find((-8783, -88), 1.5)[0]; p13 = j13['pts'][0] if math.dist(j13['pts'][0], (-8783, -88)) < 1.5 else j13['pts'][-1]
mid = [[-8722.0, -122.5], [-8754.0, -106.0]]
if math.dist(r13['pts'][-1], (-8686, -140)) < 1.5: r13['pts'] += mid + [p13]
else: r13['pts'] = [p13] + mid[::-1] + r13['pts']
# 14: (-8800,-44) の行き止まりを、(-8812,-65) の交差点までのばす
r14 = find((-8800, -44), 1.5)[0]
j14 = [r for r in find((-8812, -65), 1.5) if r is not r14][0]; p14 = j14['pts'][0] if math.dist(j14['pts'][0], (-8812, -65)) < 1.5 else j14['pts'][-1]
if math.dist(r14['pts'][-1], (-8800, -44)) < 1.5: r14['pts'].append(p14)
else: r14['pts'].insert(0, p14)
# 18: (-9728,334) の交差点から南の西湘バイパスへ
j18 = find((-9728, 334), 1.5)[0]; p18 = j18['pts'][0] if math.dist(j18['pts'][0], (-9728, 334)) < 1.5 else j18['pts'][-1]
t = road_at((-9716, 452), 'trunk', '西湘バイパス')
q = on_road(t, (-9715.6, 452.4))
new.append({'pts': [p18, [-9723.3, 392.0], q], 'lanes': 2, 'oneway': False, 'kind': 'unclassified', 'name': '', 'bridge': False, 'junctions': []})
# 19: (-9670,235) の行き止まりを、南の国道1号へ
r19 = find((-9670, 235), 1.5)[0]
t = road_at((-9660, 271), 'trunk', '国道1号')
q = on_road(t, (-9660.3, 270.9))
add = [[-9668.5, 243.0], [-9662.5, 251.0], q]
if math.dist(r19['pts'][0], (-9670, 235)) < 1.5: r19['pts'] = add[::-1] + r19['pts']
else: r19['pts'] += add
d['roads'] += new
fix_junctions()
# つないだ道路の上の建物・木・敷地・歩道の帯を消す
segs = [(r11, [end, d11]), (r13, [[-8686, -140], *mid, p13]), (r14, [[-8800, -44], p14]), (r19, [[-9670, 235], *add]), (new[0], new[0]['pts'])]
foot = unary_union([LineString(pts).buffer(RW(r) / 2 + 1.5) for r, pts in segs]).difference(unary_union([LineString(r['pts']).buffer(RW(r) / 2 + 3) for r in R if r['kind'] in ('trunk', 'primary', 'secondary')]))
nb = clear_small(foot)
d['buildings'] = [b for b in d['buildings'] if not Polygon(b['p']).buffer(0).intersects(foot)]
cut_kinds(foot, ('lots', 'parking', 'woods', 'parks', 'piers'))
print('水色 道路をつないだ。上の建物', nb)

FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok 道路', len(d['roads']), '建物', len(d['buildings']))
