"""湘南: 意味のない色違いをなくす(全域)。
1) 敷地(lots)と道路のあいだなどに残った、幅 6m 未満の細いグレーの地面は、となりの敷地に含める(敷地の色にそろう)
2) くっついている敷地(1m 以内)は同じ色にする(いちばん大きい敷地の色)。色の番号を lots の 'c' に入れる
python3 tools/shonan/unify_lot_colors.py → build_surfaces.py
"""
import sys, json, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape, encode
from shapely.geometry import LineString, box, Point
from shapely.ops import unary_union
from shapely.strtree import STRtree
d = json.loads(FILE.read_text())
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
SW = d.get('sidewalk', 4.5)
X0, Z0, X1, Z1 = d['bounds']
kinds = ('lots', 'parks', 'woods', 'beaches', 'piers', 'parking', 'water', 'rocks')
covered = unary_union([shape(q) for k in kinds for q in d.get(k, [])] +
                      [LineString(r['pts']).buffer(W(r) / 2 + (0 if r.get('bridge') else SW), cap_style=2, join_style=2) for r in d['roads']])
ground = box(X0, Z0, X1, Z1).difference(covered)
narrow = ground.difference(ground.buffer(-3, join_style=2).buffer(3, join_style=2))
lots = [shape(q) for q in d['lots']]; tl = STRtree(lots)
add = {}
n = 0
for p in getattr(narrow, 'geoms', [narrow]):
    if p.geom_type != 'Polygon' or p.area < 1: continue
    cand = [j for j in tl.query(p.buffer(0.5)) if lots[j].distance(p) < 0.5]
    if not cand: continue
    j = max(cand, key=lambda j: lots[j].buffer(0.5).intersection(p.boundary).length)
    add.setdefault(j, []).append(p); n += 1
newlots = []
for j, q in enumerate(d['lots']):
    g = lots[j]
    if j in add: g = unary_union([g] + [p.buffer(0.05) for p in add[j]]).buffer(0)
    newlots += encode(g)
print('細い地面を敷地に', n, 'か所', round(sum(p.area for v in add.values() for p in v)), 'm²')
d['lots'] = newlots
# 2) くっついた敷地は同じ色
lots = [shape(q) for q in d['lots']]; tl = STRtree(lots)
par = list(range(len(lots)))
def f(i):
    while par[i] != i: par[i] = par[par[i]]; i = par[i]
    return i
for i, g in enumerate(lots):
    for j in tl.query(g.buffer(1)):
        if j != i and lots[j].distance(g) < 1: par[f(i)] = f(j)
groups = {}
for i in range(len(lots)): groups.setdefault(f(i), []).append(i)
NC = 9
for v in groups.values():
    big = max(v, key=lambda i: lots[i].area); c = lots[big].centroid
    s = (abs(int(round(c.x * 7 + c.y * 3))) * 9301 + 49297) % 233280 or 7; s = (s * 9301 + 49297) % 233280
    col = int(s / 233280 * NC)
    for i in v: d['lots'][i]['c'] = col
print('敷地', len(lots), '→ 色のかたまり', len(groups))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
