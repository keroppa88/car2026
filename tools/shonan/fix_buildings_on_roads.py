"""湘南: 車道(縁石まで)にかかる建物を直す。かかる部分を削り、残りが元の4割未満か10㎡未満なら建物ごと消す。
python3 tools/shonan/fix_buildings_on_roads.py → build_surfaces.py
"""
import json
from pathlib import Path
from shapely.geometry import LineString, Polygon
from shapely.strtree import STRtree
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
car = [LineString(r['pts']).buffer(W(r) / 2 + 0.3, cap_style=2, join_style=2) for r in d['roads']]   # 車道+縁石
t = STRtree(car)
cut = gone = 0; out = []
for b in d['buildings']:
    g = Polygon(b['p'], b.get('holes') or []).buffer(0)
    hit = [car[j] for j in t.query(g) if car[j].intersects(g)]
    over = sum(g.intersection(h).area for h in hit)
    if b.get('look') or over < 0.5: out.append(b); continue
    rest = g
    for h in hit: rest = rest.difference(h)
    parts = [p for p in getattr(rest, 'geoms', [rest]) if p.geom_type == 'Polygon']
    if not parts: gone += 1; continue
    p = max(parts, key=lambda q: q.area).simplify(0.2)
    if p.area < 10 or p.area < g.area * 0.4: gone += 1; continue
    b = dict(b); b['p'] = [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]
    b['holes'] = [[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors]
    out.append(b); cut += 1
d['buildings'] = out
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('削った', cut, '棟  消した', gone, '棟  残り', len(out))
