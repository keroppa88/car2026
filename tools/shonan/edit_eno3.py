"""江の島: 削れた陸地を補う(指示の絵 eno3_paint.png でグレーに塗った所をコンクリートに)。
そのうえで、島の中に残った海(建物のすき間の切れ端も)をコンクリートにする(防波堤に囲まれた大きな海=ヨットハーバーは残す)。あいまいな所はコンクリート。
絵の画素 → 地図の座標は、照合で求めた射影変換 top/eno3_Hw.npy(ずれ 0.5m 程度)。
python3 tools/shonan/edit_eno3.py → make_foam.py → make_lamps.py → build_surfaces.py
"""
import sys, json
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape, LAND_KINDS
TOP = Path(__file__).parent / 'paint/top'
A = cv2.imread(str(TOP / 'eno3_base.png')).astype(int); B = cv2.imread(str(TOP / 'eno3_paint.png')).astype(int)
Hw = np.load(TOP / 'eno3_Hw.npy')
b, g, r = B[..., 0], B[..., 1], B[..., 2]
changed = np.abs(A - B).sum(2) > 40
grey = (np.abs(r - g) < 14) & (np.abs(g - b) < 14) & (r > 140) & (r < 215)
mask = (changed & grey).astype(np.uint8) * 255
mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
cs, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
w = lambda c: [tuple(v) for v in cv2.perspectiveTransform(np.float32([[p[0][0] + .5, p[0][1] + .5] for p in c])[None], Hw)[0]]
ps = []
for i, c in enumerate(cs):
    if hier[0][i][3] != -1 or len(c) < 3: continue
    holes = [w(cs[j]) for j in range(len(cs)) if hier[0][j][3] == i and len(cs[j]) >= 3]
    p = Polygon(w(c), holes).buffer(0)
    if p.area > 4: ps.append(p)
paint = unary_union(ps).buffer(0.8, join_style=2).buffer(-0.8, join_style=2).simplify(0.4)
H, W = mask.shape
frame = Polygon(w([[[0, 0]], [[W - 1, 0]], [[W - 1, H - 1]], [[0, H - 1]]]))
print('絵の範囲', [round(v) for v in frame.bounds], 'グレー', round(paint.area), 'm²')
d = json.loads(FILE.read_text()); M = Map(d)
M.put(paint, 'piers', clear=False)
# 島の中の海: 陸(+道路)をつなげて閉じた形の内側にある海は、全部コンクリート
roads = unary_union([__import__('shapely.geometry', fromlist=['LineString']).LineString(r['pts']).buffer(3) for r in d['roads']])
land = unary_union([shape(q) for k in LAND_KINDS for q in d[k]] + [roads]).intersection(frame.buffer(200))
closed = land.buffer(15, join_style=2).buffer(-15, join_style=2)   # 外の海と細くつながっている所も島の中とみなす
filled = unary_union([Polygon(p.exterior) for p in getattr(closed, 'geoms', [closed]) if p.geom_type == 'Polygon'])
inside_sea = M.water(sea_only=False).intersection(filled).intersection(frame)
parts = [p for p in getattr(inside_sea, 'geoms', [inside_sea]) if p.geom_type == 'Polygon' and p.area > 0.5]
# 防波堤に囲まれたヨットハーバーなど大きな海は残す。小さな海・細い切れ端だけ埋める
thin = lambda p: p.buffer(-4).is_empty
inside_sea = unary_union([p for p in parts if p.area < 3000 or thin(p)])
# ループ道路のまわりの細い水の切れ端(幅 12m 未満)も埋める
water = M.water(sea_only=False).intersection(frame)
near_island = Polygon(w([[[980, 560]], [[1120, 560]], [[1120, 690]], [[980, 690]]]))   # 右下のループ道路のまわりだけ(海岸の形は変えない)
slivers = water.difference(water.buffer(-6, join_style=2).buffer(6, join_style=2)).intersection(near_island)
slivers = unary_union([p for p in getattr(slivers, 'geoms', [slivers]) if p.geom_type == 'Polygon' and p.area > 0.5])
inside_sea = inside_sea.union(slivers)
print('島の中の海', round(inside_sea.area), 'm²')
M.put(inside_sea, 'piers', clear=False)
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok')
