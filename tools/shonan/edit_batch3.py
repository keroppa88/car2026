"""湘南: 座標で指示してもらった修正のまとめ(2026-10-28 夕方)。
python3 tools/shonan/edit_batch3.py → make_foam.py → make_lamps.py → build_surfaces.py
"""
import sys, json, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape, encode
from shapely.geometry import Point, LineString, box, Polygon
from shapely.ops import unary_union

d = json.loads(FILE.read_text()); M = Map(d); R = d['roads']
near = lambda p, x, z, e=0.6: abs(p[0] - x) < e and abs(p[1] - z) < e
def road(first, last=None):
    for r in R:
        if near(r['pts'][0], *first) and (last is None or near(r['pts'][-1], *last)): return r
    raise SystemExit(f'道路が見つからない {first}')
width = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
gone = []
def drop(r, fill=None):
    gone.append(r)
    if fill: M.put(LineString(r['pts']).buffer(width(r) / 2 + 4.5, cap_style=2, join_style=2), fill, keep_water=True, clear=False)

# 相模川河口の東: -3713,-1093 〜 -3604,-1420 の道路(新しく足した北の直線と、産業道路の短い残り)を消して緑地に
drop(road((-3712.47, -1105.34), (-3603.0, -1421.0)), 'parks')
drop(road((-3712.47, -1105.34), (-3713.67, -1069.2)), 'parks')
# -3553,-1036 を通る直線(南の新しい道路)を消す
drop(road((-3830.89, -1005.48), (-3500.15, -1044.01)), 'parks')
# -3493,-1053 の飛び出た短い道路
drop(road((-3488.1, -1053.7)))
# -3189,-751 / -3590,-718 / -3673,-705 を通る道路(横の長い道路と、その西の端から南へ曲がる道路)
drop(road((-3469.7, -725.2), (-3177.3, -758.6)))
drop(road((-3469.7, -725.2), (-3590.4, -719.5)))
drop(road((-3590.4, -719.5), (-3651.5, -595.7)))
drop(road((-3644.0, -595.0), (-3617.7, -588.5)))   # 上の道路につながっていた短い切れ端
# -9288,440 の取り付け道路(幹線道路の邪魔)
drop(road((-9358.4, 436.8)))
d['roads'] = [r for r in R if not any(r is g for g in gone)]; R = d['roads']
print('消した道路', len(gone))

# 江の島への橋(湘南港臨港道路): 寸断されて見える3本を1本の道路にまとめる(街灯は長い橋として残す)
a = road((6216.5, 323.5)); b = road((6076.5, 508.2), (5962.5, 812.3)); c = road((5962.5, 812.3))
n = len(a['pts'])
a['pts'] = a['pts'] + b['pts'][1:] + c['pts'][1:]
a['junctions'] = sorted({0} | {len(a['pts']) - 1 - (len(c['pts']) - 1 - j) for j in c['junctions'] if j > 0})
a['longBridge'] = [n - 1, n]   # この区間は長い橋(街灯の位置に使う)
d['roads'] = [r for r in R if r is not b and r is not c]; R = d['roads']
print('江の島への橋を1本に', len(a['pts']), '点')

# 孤立した緑地・駐車場など
def drop_poly(kind, x, z):
    P = Point(x, z); before = len(d[kind])
    d[kind] = [q for q in d[kind] if not shape(q).buffer(0.5).contains(P)]
    return before - len(d[kind])
print('林', drop_poly('woods', 2181, -1445), '駐車場', drop_poly('parking', -9785, 161))
# 中央分離帯の緑地(座標の近く)を消す
pts = [(-4869, -708), (-4777, -766), (-4940, -686), (-4996, -697), (-5090, -677), (8256, 485), (8239, 482)]
before = len(d['medians'])
west = LineString([(-5090, -677), (-4996, -697), (-4940, -686), (-4869, -708), (-4777, -766)]).buffer(30)   # 指示の点を結んだ区間ぜんぶ
d['medians'] = [m for m in d['medians'] if min(math.hypot(m[0] - x, m[1] - z) for x, z in pts) > 12 and not west.contains(Point(m[0], m[1]))]
print('中央分離帯の緑地', before - len(d['medians']))
# -3742,-1051 の緑地のずれ: となりと同じ幅・同じ線にそろえる
for m in d['medians']:
    if near(m, -3736.6, -1053.1, 0.2):
        nx, nz = math.cos(m[2]), -math.sin(m[2])
        m[0] = round(m[0] - nx * 0.8, 2); m[1] = round(m[1] - nz * 0.8, 2); m[4] = 6.63
# 横断歩道を置かない所
d['noCrosswalks'] = d.get('noCrosswalks', []) + [[-3742, -1060], [-3703, -1076], [-3665, -1097]]
# 道路を覆っている緑地を外す(-7856,-357〜-7869,-394 と -8137,-293〜-8130,-272)
for r in R:
    L = LineString(r['pts'])
    if L.distance(Point(-7862, -375)) < 3 or L.distance(Point(-8133, -282)) < 3:
        M.cut(L.buffer(width(r) / 2 + 4.5, cap_style=2, join_style=2), ['woods', 'parks'])
        M.clear(L.buffer(width(r) / 2 + 4.5))
# 砂浜を消して海に(-7555,-459 / -7543,-445 / -7503,-459)
for x, z in [(-7555, -459), (-7543, -445), (-7503, -459)]:
    for q in list(d['beaches']):
        g = shape(q)
        if g.area < 5000 and g.buffer(0.5).contains(Point(x, z)): d['beaches'].remove(q); M.put(g, 'sea', clear=False)
# 水の上のグレーの破片・点線(どの面にも入っていない地面のすき間)を海で埋める
zones = [box(-4140, -910, -4000, -780),   # -4110,-883 〜 -4028,-815 のまわりは広めに
         LineString([(-7441, -441), (-7439, -312)]).buffer(10), LineString([(-7493, -358), (-7498, -442)]).buffer(10),
         Point(-7495, -323).buffer(12), Point(-7555, -419).buffer(40)]
kinds = ('water', 'beaches', 'piers', 'parks', 'woods', 'lots', 'parking', 'rocks')
for zz in zones:
    covered = unary_union([shape(q).intersection(zz) for k in kinds for q in d[k] if shape(q).intersects(zz)])
    gap = zz.difference(covered)
    gap = unary_union([p for p in getattr(gap, 'geoms', [gap]) if p.geom_type == 'Polygon' and p.area > 0.01])
    roads_here = unary_union([LineString(r['pts']).buffer(width(r) / 2 + 4.6) for r in R if LineString(r['pts']).distance(zz) < 30])
    gap = gap.difference(roads_here)
    # 1m² 未満のすき間は面として残らないので、となりの水の面を広げて埋める
    for part in getattr(gap, 'geoms', [gap]):
        if part.is_empty: continue
        g = part.buffer(0.3, join_style=2)
        ws = [q for q in d['water'] if shape(q).intersects(g)]
        if not ws: M.put(g, 'sea', keep_water=True, clear=False); continue
        q = max(ws, key=lambda q: shape(q).intersection(g.buffer(0.5)).area)
        i = d['water'].index(q)
        d['water'][i:i + 1] = encode(shape(q).union(g), **{a: b for a, b in q.items() if a not in ('o', 'h')})
    print('すき間を海に', round(gap.area, 1), 'm²')
# 道路のない所に残った中央分離帯・歩道の帯(北の跡)
lines_ = [LineString(r['pts']) for r in R]
for k in ('medians', 'strips'):
    d[k] = [m for m in d[k] if not box(-3760, -1440, -3590, -1100).contains(Point(m[0], m[1])) or min(l.distance(Point(m[0], m[1])) for l in lines_) < 12]
# 消した北の道路の跡: 緑地のあいだに残ったグレーの地面も緑地に(ぎざぎざを残さない)
zz = box(-3748, -1428, -3598, -1100)
covered = unary_union([shape(q).intersection(zz) for k in kinds for q in d[k] if shape(q).intersects(zz)])
gap = zz.difference(covered)
keep = unary_union([LineString(r['pts']).buffer(width(r) / 2 + 4.6) for r in R if LineString(r['pts']).distance(zz) < 30])
gap = gap.difference(keep)
M.put(gap.buffer(0.3, join_style=2), 'parks', keep_water=True, clear=False)
print('跡のグレーを緑地に', round(gap.area), 'm²')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok')
