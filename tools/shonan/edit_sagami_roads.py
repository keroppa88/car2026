"""湘南: 相模川河口の東、国道134号まわりの煩雑な道路を整理する(指示の絵と座標どおり)。
・北: 交差点(x -3715, z -1117)から北(x -3603, z -1421)へ延びる取り付け道路・産業道路・細い道を全部消し、まっすぐな2車線の道路1本に。跡は緑地
・南: 国道134号の南に沿って曲がる細い道を消し、西の縦の道路の端(x -3828, z -1009)と東の道路のつなぎ目(x -3362, z -950)をまっすぐ結ぶ
python3 tools/shonan/edit_sagami_roads.py → make_lamps.py → build_surfaces.py
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

d = json.loads(FILE.read_text()); M = Map(d)
R = d['roads']
key = lambda r: (r['kind'], round(r['pts'][0][0], 1), round(r['pts'][0][1], 1))
def find(x, z, kind=None):   # 最初の点で道路を探す(番号はずれるので座標で)
    for r in R:
        if abs(r['pts'][0][0] - x) < 0.5 and abs(r['pts'][0][1] - z) < 0.5 and (kind is None or r['kind'] == kind): return r
    raise SystemExit(f'道路が見つからない {x},{z}')
north = [find(-3712.47, -1105.34, 'trunk_link'), find(-3673, -1311, 'trunk_link') if False else None]
north = []
for r in R:   # 北の取り付け道路・産業道路・細い道(交差点の北 -1100 より北、x -3740〜-3590)
    xs, zs = [p[0] for p in r['pts']], [p[1] for p in r['pts']]
    if r['kind'] in ('trunk_link', 'primary', 'unclassified', 'service') and max(zs) <= -1086 and min(xs) > -3745 and max(xs) < -3590 and min(zs) < -1100:
        north.append(r)
south = [r for r in R if r['kind'] == 'service' and (
    (abs(r['pts'][0][0] + 3788) < 2 and abs(r['pts'][0][1] + 1023) < 2) or   # 国道134号の南に沿う細い道
    (abs(r['pts'][0][0] + 3717) < 2 and abs(r['pts'][0][1] + 1068) < 2) or
    (abs(r['pts'][0][0] + 3411) < 2 and abs(r['pts'][0][1] + 1000) < 2))]
gone = north + south
print('消す道路', len(north), '(北)', len(south), '(南)')
for r in gone: print('  ', r['kind'], r.get('name'), [[round(v) for v in p] for p in (r['pts'][0], r['pts'][-1])])
old = unary_union([LineString(r['pts']).buffer((r.get('lanes', 1) * 3.25) / 2 + 4.5) for r in north])
d['roads'] = [r for r in R if not any(r is g for g in gone)]
# 西の縦の道路(南の細い道へ伸びていた端を落とす)
w = find(-3460.63, -751.46, 'service')
if abs(w['pts'][-1][0] + 3787.59) < 1:
    w['pts'] = w['pts'][:-1]; w['junctions'] = [j for j in w['junctions'] if j < len(w['pts'])] + ([len(w['pts']) - 1] if len(w['pts']) - 1 not in w['junctions'] else [])
# 新しい道路
n1 = {'pts': [[-3712.47, -1105.34], [-3603.0, -1421.0]], 'lanes': 2, 'oneway': False, 'kind': 'primary', 'junctions': [0]}
n2 = {'pts': [[-3830.89, -1005.48], [-3350.83, -937.0]], 'lanes': 2, 'oneway': False, 'kind': 'unclassified', 'junctions': [0, 1]}
# 交わる道路があれば、両方に交点を入れてつなぐ
for n in (n1, n2):
    L = LineString(n['pts'])
    for r in d['roads']:
        P = r['pts']
        for i in range(len(P) - 1):
            seg = LineString([P[i], P[i + 1]])
            x = seg.intersection(L)
            if x.is_empty or x.geom_type != 'Point': continue
            if min(Point(q).distance(x) for q in (P[i], P[i + 1], n['pts'][0], n['pts'][-1])) < 3: continue   # 端どうしは既につながっている
            q = [round(x.x, 2), round(x.y, 2)]
            r['pts'].insert(i + 1, q); r['junctions'] = sorted({(j + 1 if j > i else j) for j in r['junctions']} | {i + 1})
            # 新しい道路にも(進む順に)
            s = L.project(x); k = 1
            while k < len(n['pts']) and L.project(Point(n['pts'][k])) < s: k += 1
            n['pts'].insert(k, q); n['junctions'] = sorted({(j + 1 if j >= k else j) for j in n['junctions']} | {k})
            L = LineString(n['pts'])
            print('  交点', q, r['kind'], r.get('name'))
            break
d['roads'] += [n1, n2]
# 北の消した道路の跡は緑地(新しい道路の所は除く)
keep = unary_union([LineString(r['pts']).buffer((r.get('lanes', 1) * 3.25) / 2 + 4.5) for r in d['roads']])
M.put(old.difference(keep), 'parks', keep_water=True, clear=False)
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok 道路', len(d['roads']))
