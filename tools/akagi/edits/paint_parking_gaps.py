"""赤城山: 指示(2026-11-27 19:35)。ふもとの駐車場の出入口: 道と駐車場の間に緑地が見える所(赤)を、地面にアスファルトの色で塗る(paintAreas)。"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
RED = [[(-1495,1765),(-1498.75,1762.75),(-1502,1761.75),(-1499,1759.75),(-1497.5,1760.5),(-1494.25,1764.25)],
       [(-1486.5,1775),(-1491.75,1768.5),(-1491,1767.75),(-1487,1771.75)]]
d = json.loads(FILE.read_text())
for r in RED: d['paintAreas'].append({'pts': [list(p) for p in r]})
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
