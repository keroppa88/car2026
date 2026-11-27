"""赤城山: 4 回目の指示(2026-11-27 17:10)。水色の範囲で取り消した草と木だけ元にもどす(脇道のアスファルトは消したまま)。
python3 tools/akagi/edits/visitor_center4.py <3 回目の前の akagi-course.json>
"""
import json, sys
from pathlib import Path
from shapely.geometry import Polygon, Point
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
BLUE = Polygon([(-200.25,213.75),(-58.25,76.5),(-52.75,81.5),(-81,159),(-93.75,204.25),(-136.25,229.5)])
prev = json.load(open(sys.argv[1])); d = json.loads(FILE.read_text())
g = [a for a in prev['grassAreas'] if BLUE.contains(Polygon(a['pts']).centroid)]
t = [a for a in prev['treesExact'] if BLUE.contains(Point(a[0], a[1]))]
d['grassAreas'] += [a for a in g if a not in d['grassAreas']]; d['treesExact'] += [a for a in t if a not in d['treesExact']]
print('草', len(g), '木', len(t))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
