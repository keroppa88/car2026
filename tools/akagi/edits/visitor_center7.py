"""赤城山: 7 回目の指示(2026-11-27 18:00)。赤 = 地面をアスファルトの色に塗る(板は使わず、地面そのものの色を変える: paintAreas)。中の木は消す。
python3 tools/akagi/edits/visitor_center7.py
"""
import json
from pathlib import Path
from shapely.geometry import Polygon, Point
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = [(-102.5,47.25),(-82.75,53.75),(-82.5,55.25),(-87.5,61),(-81,71.25),(-78.5,74.25),(-76,74.5),(-71.75,77.75),(-71.25,78.25),(-67.5,74.75),(-72,69.25),(-71.25,65.75),(-65.75,61),(-59.25,56.5),(-53.75,54.5),(-51,55),(-49,56.75),(-44.25,52.25),(-49.5,48.5),(-54.25,48.25),(-57.25,48),(-66.25,51.5),(-70.5,56.25),(-72.25,56),(-79.25,49.75),(-90.5,46),(-96.75,44),(-99,42.5),(-110.5,37.75),(-111.5,41)]
d = json.loads(FILE.read_text()); P = Polygon(RED)
d.setdefault('paintAreas', []).append({'pts': [list(p) for p in RED]})
t0 = len(d['treesExact']); d['treesExact'] = [t for t in d['treesExact'] if not P.contains(Point(t[0], t[1]))]
print('木', t0 - len(d['treesExact']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
