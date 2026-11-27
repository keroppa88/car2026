"""赤城山: 指示(2026-11-27 19:16)。水色で囲んだ所(六角形の建物の西)のアスファルトの色を消す(paintAreas から切り取る)。"""
import json
from pathlib import Path
from shapely.geometry import Polygon
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
CUT = Polygon([(-107.5,36.5),(-111.75,42.5),(-112,41.25),(-108.5,36.75)])
d = json.loads(FILE.read_text()); out = []
for A in d['paintAreas']:
    g = Polygon(A['pts']).buffer(0).difference(CUT.buffer(0.05))
    for p in getattr(g, 'geoms', [g]):
        if p.geom_type == 'Polygon' and p.area > 1: out.append({**A, 'pts': [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]})
print(len(d['paintAreas']), '→', len(out), [round(Polygon(a['pts']).area) for a in out])
d['paintAreas'] = out
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
