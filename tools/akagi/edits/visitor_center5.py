"""赤城山: 5 回目の指示(2026-11-27 17:24)。
赤 = 全部消して自然な元の状態に(駐車場のアスファルト・台地・建物・足した草と木)。
白 = 六角形の建物だけここへ移す(地面の上にそのまま建てる。斜面の分は土台)。小さい四角の建物は消す。
python3 tools/akagi/edits/visitor_center5.py
"""
import json
from pathlib import Path
from shapely.geometry import Polygon, Point
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = Polygon([(-42.5,49.75),(-99.5,104.5),(-108.75,90.75),(-79.5,33),(-50.25,44)])
WHITE = Polygon([(-113,37),(-111.25,47.75),(-101,50.5),(-96.75,39.75),(-101,33.75)])
d = json.loads(FILE.read_text())
l0 = len(d['lots']); d['lots'] = [L for L in d['lots'] if not RED.intersects(Polygon(L['pts']))]
hexh = next(h for h in d['houses'] if h['type'] == 'hexHouse')
d['houses'] = [h for h in d['houses'] if h['type'] not in ('hexHouse', 'orangeHouse')]
g0 = len(d['grassAreas']); d['grassAreas'] = [g for g in d['grassAreas'] if not RED.contains(Polygon(g['pts']).centroid)]
t0 = len(d['treesExact']); d['treesExact'] = [t for t in d['treesExact'] if not RED.contains(Point(t[0], t[1]))]
c = WHITE.centroid; rin = WHITE.exterior.distance(c); R = round(min(hexh['radius'], 0.95 * rin), 2)
d['houses'].append({'type': 'hexHouse', 'radius': R, 'r': [[round(c.x - 1, 2), round(c.y - 1, 2)], [round(c.x + 1, 2), round(c.y - 1, 2)], [round(c.x + 1, 2), round(c.y + 1, 2)], [round(c.x - 1, 2), round(c.y + 1, 2)]]})
print('敷地', l0 - len(d['lots']), '草', g0 - len(d['grassAreas']), '木', t0 - len(d['treesExact']), '建物の半径', R, '中心', round(c.x, 2), round(c.y, 2))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
