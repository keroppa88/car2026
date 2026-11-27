"""赤城山: 9 回目の指示(2026-11-27 18:20)。赤 = 地面に塗ったアスファルトの色を消す(paintAreas から切り取る)。黄緑 = 草、水色 = 木 1 本ずつ。
python3 tools/akagi/edits/visitor_center9.py
"""
import json
from pathlib import Path
from shapely.geometry import Polygon
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = Polygon([(-108.75,38),(-112,42.5),(-112.5,41.25),(-111.25,36.75)])
TREES = [[(-106.5,33.5),(-107.5,32.25),(-107.75,33.25)], [(-99.25,33),(-100,32),(-100.75,32.5)], [(-52,24.5),(-55.5,24),(-54.75,25.75)], [(-61.25,34),(-63,32),(-63.75,33)],
         [(-51.75,30.25),(-49.5,31.5),(-52.75,32)], [(-65,39),(-66.25,37.5),(-66.75,38.5)], [(-110.25,48.5),(-110.75,47.25),(-110.75,48.5)], [(-82.5,30),(-81.25,32.5),(-82.25,31.5)],
         [(-77.75,22.5),(-76.75,24),(-78.5,23.5)]]
GRASS = [(-91.75,35.25),(-82.5,7),(-80.75,12.5),(-83.25,25.25),(-84,39.5)]
d = json.loads(FILE.read_text())
out = []
for A in d['paintAreas']:
    g = Polygon(A['pts']).buffer(0).difference(RED.buffer(0.05))
    for p in getattr(g, 'geoms', [g]):
        if p.area > 1: out.append({**A, 'pts': [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]})
d['paintAreas'] = out
for t in TREES: c = Polygon(t).centroid; d['treesExact'].append([round(c.x, 2), round(c.y, 2), 11])
d['grassAreas'].append({'pts': [list(p) for p in GRASS], 'fade': 1.5, 'inner': 2})
print('塗り', len(out), [len(a['pts']) for a in out])
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
