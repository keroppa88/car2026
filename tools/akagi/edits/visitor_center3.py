"""赤城山: 3 回目の指示(2026-11-27 17:07)。
水色 = 元にもどす(脇道のアスファルトと、この範囲に足した草・木を取り消す)。
黄緑 = 駐車場の両端のアスファルトを削って緑地(草)に。
赤   = 建物の台地をアスファルトと同じ高さ(いちばん近い道の高さ: road)にして、境目をなくす。
python3 tools/akagi/edits/visitor_center3.py
"""
import json
from pathlib import Path
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
BLUE = Polygon([(-200.25,213.75),(-58.25,76.5),(-52.75,81.5),(-81,159),(-93.75,204.25),(-136.25,229.5)])
GREEN = [[(-48.5,55.5),(-50.5,54.75),(-52.5,54.75),(-54.25,55),(-54.5,53.75),(-52.5,51.25),(-47,53),(-47,54)],
         [(-56,60.25),(-54,59.5),(-52.5,59.5),(-55.5,62.25)],
         [(-91,90.75),(-89.75,93),(-89,94.25),(-92,97.25),(-94.75,93)],
         [(-82.5,86.5),(-83,88.75),(-80.75,86.5)]]
d = json.loads(FILE.read_text())
def ring(g):
    g = g.buffer(0)
    if g.geom_type != 'Polygon': g = max(g.geoms, key=lambda q: q.area)
    return [[round(x, 2), round(z, 2)] for x, z in list(g.exterior.coords)[:-1]]
L = d['lots']
lot1, lot24, pad = L[-3], L[-2], L[-1]
assert lot1.get('road') and lot24.get('road') and pad.get('surface') == 'grass'
# 水色: 脇道を消す。この範囲に足した草・木(4 回前の指示)も消す
L.remove(lot24)
n0 = len(d['grassAreas']); d['grassAreas'] = [g for g in d['grassAreas'] if not BLUE.contains(Polygon(g['pts']).centroid)]
t0 = len(d['treesExact']); d['treesExact'] = [t for t in d['treesExact'] if not BLUE.contains(Point(t[0], t[1]))]
print('草', n0 - len(d['grassAreas']), '木', t0 - len(d['treesExact']))
# 黄緑: 駐車場から外して草
lot1['pts'] = ring(Polygon(lot1['pts']).difference(unary_union([Polygon(g) for g in GREEN])))
for g in GREEN: d['grassAreas'].append({'pts': [list(p) for p in g], 'fade': 1.0, 'inner': 1})
# 赤: 台地は道と同じ高さ(駐車場と同じ決め方)
pad.pop('plane'); pad['road'] = True
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
# (17:10 の指示) 取り消した所の草と木は残す → visitor_center4.py
