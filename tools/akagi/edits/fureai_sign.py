"""赤城山: 指示(2026-11-27 22:25)。ふもとの駐車場の出入口。黄緑 = 草、赤 = 写真の入口の看板(こげ茶の木の枠に白い板、文字「赤城ふれあいの森」)。"""
import json
from pathlib import Path
from shapely.geometry import Polygon
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
GRASS = [(-1489.5,1771),(-1490.5,1770),(-1491.25,1771),(-1491.25,1773),(-1490.75,1775),(-1483.75,1784.75),(-1482.25,1785.25),(-1480.5,1783.5),(-1481.5,1780.5)]
RED = Polygon([(-1487.5,1774.5),(-1489,1775.75),(-1488.5,1776.25),(-1487,1775),(-1487.25,1774.75)])
d = json.loads(FILE.read_text())
d['grassAreas'].append({'pts': [list(p) for p in GRASS], 'fade': 1.0, 'inner': 1})
c = RED.centroid; d.setdefault('signBoards', []).append({'x': round(c.x, 2), 'z': round(c.y, 2), 'text': '赤城ふれあいの森'})
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
