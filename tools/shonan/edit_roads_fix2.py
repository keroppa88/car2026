"""湘南: 道路の整理(続き)。
・相模川河口の東の南側: 新しい道路の東の端は、絵のとおり国道134号のすぐ南の縦の道路の上の端(x -3500, z -1044)へ
・消した道路に付いていた中央分離帯・植え込みの帯(strips/medians)の残りを消す
・国道134号の途切れ: x 8577 z 556(水路の所)、x 2798〜2808 z -1053〜-1100(上下線)を、両端をまっすぐつなぐ
python3 tools/shonan/edit_roads_fix2.py → make_lamps.py → build_surfaces.py
"""
import json
from pathlib import Path
from shapely.geometry import LineString, Point, box
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
near = lambda p, x, z, e=0.5: abs(p[0] - x) < e and abs(p[1] - z) < e
def by_ends(a, b):
    for r in R:
        if near(r['pts'][0], *a) and near(r['pts'][-1], *b): return r
    raise SystemExit(f'道路が見つからない {a} {b}')
# 1) 南の新しい道路の東の端
n2 = by_ends((-3830.89, -1005.48), (-3350.83, -937.0))
n2['pts'] = [[-3830.89, -1005.48], [-3500.15, -1044.01]]; n2['junctions'] = [0, 1]
r890 = by_ends((-3504.43, -1062.07), (-3373.77, -932.76))   # 縦の道路: 途中に入れた交点を外す
r890['pts'] = [p for p in r890['pts'] if not near(p, -3484.3, -956.04)]
r890['junctions'] = [i for i in range(len(r890['pts'])) if i in (0, 1, len(r890['pts']) - 1)]
# 2) 道路のない所の中央分離帯・植え込みの帯
def width(r): return 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
area = box(-3900, -1440, -3300, -900)
lines = [(LineString(r['pts']), width(r) / 2 + 8) for r in R if LineString(r['pts']).intersects(area.buffer(50))]
for k in ('strips', 'medians'):
    before = len(d[k])
    d[k] = [m for m in d[k] if not area.contains(Point(m[0], m[1])) or any(l.distance(Point(m[0], m[1])) < w for l, w in lines)]
    print(k, '消した', before - len(d[k]))
# 3) 国道134号の途切れをつなぐ
def join(a_end, b_start):   # 途切れた2本を1本の道路にまとめる(つなぎ目は交差点にしない)
    a = next(r for r in R if near(r['pts'][-1], *a_end))
    b = next(r for r in R if r is not a and near(r['pts'][0], *b_start) and r.get('name') == a.get('name'))
    n = len(a['pts'])
    a['pts'] = a['pts'] + b['pts']
    a['junctions'] = sorted({j for j in a['junctions'] if j != n - 1} | {j + n for j in b['junctions'] if j != 0})
    if any(r is not a and r is not b and any(near(q, *b_start) for q in r['pts']) for r in R): a['junctions'] = sorted(set(a['junctions']) | {n})   # 他の道路も来ている所は交差点のまま
    R.remove(b)
    print('つないだ', a.get('name'), a_end, '→', b_start, round(Point(a_end).distance(Point(b_start)), 1), 'm')
join((8568.7, 552.8), (8585.1, 555.3))      # 水路の所
join((2828.8, -1054.0), (2773.6, -1063.8))  # 上り線
join((2778.9, -1102.2), (2835.5, -1091.7))  # 下り線
# つないだ所にかぶっていた林・緑地は、道路の上から切り取る
import sys; sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map
M = Map(d)
for a in [(8568.7, 552.8), (2828.8, -1054.0), (2778.9, -1102.2)]:   # つないだ道路の全体: 歩道の幅まで林・緑地を外して、縁をそろえる
    r = next(r for r in R if any(near(q, *a) for q in r['pts']))
    M.cut(LineString(r['pts']).buffer(r.get('lanes', 2) * 3.25 / 2 + 4.5, cap_style=2, join_style=2), ['woods', 'parks'])
    L = LineString(r['pts'])
    d['strips'] = [m for m in d['strips'] if L.distance(Point(m[0], m[1])) > 12]   # 片側だけにあって段になる歩道の帯も外す
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok')
