"""赤城山: 指示(2026-11-27 18:47)。赤 = 地面をアスファルトの色に塗るだけ(paintAreas)。
そのうえで本線とのつなぎ目だけ直す: 赤のうち本線の路肩から 8m までは地面を本線の路面の高さに(rampAreas、外へ 4m でなめらかに)。
python3 tools/akagi/edits/side_road_paint.py
"""
import json
from pathlib import Path
from shapely.geometry import Polygon, LineString
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = [(-56.25,79.5),(-55.75,82.5),(-56,87.25),(-60,94),(-63.5,99.5),(-69.5,109.75),(-75,116.75),(-84.75,131),(-90.75,139.5),(-96,152.25),(-97.25,160),(-100.25,171.25),(-98,176.5),(-91,184.5),(-107.5,203),(-127.75,218),(-137.25,219.5),(-153.75,219.25),(-157,216.25),(-174.5,217.75),(-184.25,215.25),(-194.25,213.25),(-199.5,212.5),(-190.75,204.5),(-178.5,206.75),(-167.75,208.25),(-161,204.25),(-150,209.5),(-146.25,208.5),(-106.25,170.75),(-104.25,162.75),(-102.25,154),(-98.75,145.25),(-95.25,138.5),(-83,120),(-74.75,109.25),(-66.5,97),(-61,89.75),(-60,86.75),(-60,83.5),(-62,81),(-57.25,76.25)]
d = json.loads(FILE.read_text())
d['paintAreas'].append({'pts': [list(p) for p in RED]})
road = LineString([(p[0], p[2]) for p in d['route']])
near = Polygon(RED).buffer(0).intersection(road.buffer(4.5 + 8)).difference(road.buffer(4.5 - 0.3))
ramps = [p for p in getattr(near, 'geoms', [near]) if p.geom_type == 'Polygon' and p.area > 2]
for p in ramps: d.setdefault('rampAreas', []).append({'pts': [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]], 'blend': 4})
print('つなぎ目', len(ramps), [round(p.area) for p in ramps])
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
