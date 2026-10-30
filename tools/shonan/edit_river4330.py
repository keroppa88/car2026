"""湘南 -4330,-1151: 相模川を北の地図の端までのばす(川の幅のまま、この川だけ)。"""
import json
from pathlib import Path
from shapely.geometry import Polygon, box, LineString
from shapely.ops import unary_union
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
from shapely.geometry import Point
i = next(i for i, w in enumerate(d['water']) if not w.get('sea') and Polygon(w['o'], w.get('h', [])).buffer(0).contains(Point(-4330, -1151)))
w = d['water'][i]; g = Polygon(w['o'], w.get('h', [])).buffer(0)
zmin = d['bounds'][1] - 300   # 地面の板の北の端(osm-city.js の ground と同じ)
ext = box(-4490.0, zmin, -4183.0, -1175.0)
# 何かとぶつからないか
hit = [r for r in d['roads'] if LineString(r['pts']).intersects(ext)] + [b for b in d['buildings'] if Polygon(b['p']).intersects(ext)]
print('ぶつかるもの', len(hit))
u = unary_union([g, ext]).buffer(0)
w['o'] = [[round(x, 2), round(z, 2)] for x, z in list(u.exterior.coords)[:-1]]
w['h'] = [[[round(x, 2), round(z, 2)] for x, z in list(r.coords)[:-1]] for r in u.interiors]
# 同じ所にある他の地面(敷地・緑地など)は川から外す
for k in ('lots', 'parks', 'woods', 'piers', 'parking', 'beaches', 'rocks'):
    keep = []
    if k not in d: continue
    for q in d[k]:
        p = Polygon(q['o'], q.get('h', [])).buffer(0)
        if p.intersects(ext) and p.intersection(ext).area > 1:
            print('重なりを切る', k, round(p.intersection(ext).area))
            rest = p.difference(ext)
            for part in getattr(rest, 'geoms', [rest]):
                if part.geom_type == 'Polygon' and part.area > 20:
                    keep.append({**q, 'o': [[round(x, 2), round(z, 2)] for x, z in list(part.exterior.coords)[:-1]], 'h': [[[round(x, 2), round(z, 2)] for x, z in list(r.coords)[:-1]] for r in part.interiors]})
            continue
        keep.append(q)
    d[k] = keep
print('川の面積', round(g.area), '→', round(u.area))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
