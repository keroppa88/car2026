"""稲村ヶ崎(3回目): 国道134号の海側(オレンジ)をコンクリートの護岸にし、海岸線を突起のないシンプルな線にする。

リポジトリ直下で python tools/shonan/edit_inamuragasaki3.py → python tools/shonan/build_surfaces.py。
道路の中心線から一定の幅(西端だけ元の広い砂浜へなめらかにつなぐ)で海岸線を引き、
その線より陸側(道路の南)はコンクリート、海側は海にする。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon, LineString, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)

def polys(g):
    if g.geom_type == 'Polygon':
        if g.area > .5: yield g
    elif hasattr(g, 'geoms'):
        for q in g.geoms: yield from polys(q)

def encode(g, **kw):
    return [dict(o=[[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]],
                 h=[[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors], **kw) for p in polys(g)]

def main():
    d = json.loads(FILE.read_text())
    X0, X1 = 8700, 9690   # 西の砂浜(8700〜)も含めて海岸線を1本のなめらかな線にする
    road = unary_union([LineString(r['pts']) for r in d['roads'] if r['name'] == '国道134号' and any(8800 < x < 9800 for x, z in r['pts'])])
    def road_z(x):
        g = road.intersection(LineString([(x, 0), (x, 2000)]))
        pts = [g] if g.geom_type == 'Point' else list(getattr(g, 'geoms', []))
        return max(p.y for p in pts if p.geom_type == 'Point')
    # 西端は元の砂浜の海岸線に合わせ、そこから 150m で幅 30m へなめらかに
    sea = unary_union([shape(q) for q in d['water'] if q.get('sea')])
    beach = unary_union([shape(q) for q in d['beaches']])
    def shore_now(x):   # 西どなりの砂浜の海側の端
        c = beach.intersection(LineString([(x, 0), (x, 2000)]))
        return max(p[1] for g in getattr(c, 'geoms', [c]) for p in g.coords)
    w0 = shore_now(X0 - 3) - road_z(X0)
    xs = list(range(X0, X1, 10)) + [X1]
    sm = lambda u: u * u * (3 - 2 * u)   # 端がなめらかにつながる補間
    shore = [(x, road_z(x) + w0 + (30 - w0) * sm(min(1, (x - X0) / 450))) for x in xs]
    shore = LineString(shore).simplify(0.5)
    S = list(shore.coords)
    land_side = Polygon([(X0, 0), (X1, 0)] + S[::-1][:1] + S[::-1][1:] if False else [(X0, 0)] + S + [(X1, 0)])   # 海岸線より北
    sea_side = Polygon(S + [(X1, 1100), (X0, 1100)])
    south = unary_union([sea_side, land_side]).difference(land_side.difference(box(X0, 0, X1, 2000)))
    region_s = box(X0, 0, X1, 1100)
    # 道路より南の陸側の帯 = 海岸線より北で、道路の南
    roadband = unary_union([LineString(r['pts']).buffer((r['lanes'] * 3.25 if r['oneway'] or r['lanes'] > 1 else 4.5) / 2 + 0.5) for r in d['roads'] if r['name'] == '国道134号'])
    south_of_road = unary_union([Polygon([(x, road_z(x)) for x in range(X0, X1 + 1, 5)] + [(X1, 1100), (X0, 1100)])])
    sand = south_of_road.intersection(land_side).buffer(0)
    newsea = south_of_road.intersection(sea_side).buffer(0)
    cut = south_of_road
    for k in ('beaches', 'piers', 'rocks', 'parks', 'lots', 'parking'):
        out = []
        for q in d[k]:
            g = shape(q)
            if g.intersects(cut) and g.intersection(cut).area > 1: out += encode(g.difference(cut), **{a: b for a, b in q.items() if a not in ('o', 'h')})
            else: out.append(q)
        d[k] = out
    # 西の砂浜からは斜めに取り付く(海側 x=8970 → 道路側 x=9065)
    diag = Polygon([(X0, 0), (9065, 0), (9065, road_z(9065)), (8970, 1100), (X0, 1100)])
    d['beaches'] += encode(sand.intersection(diag))
    d['piers'] += encode(sand.difference(diag), name='稲村ヶ崎・道路の海側の護岸')   # オレンジ: コンクリート
    water = []
    for q in d['water']:
        g = shape(q)
        if q.get('sea') and g.area > 1e6: g = g.union(newsea)
        elif g.intersects(cut) and g.intersection(cut).area > 1: g = g.difference(cut)
        else: water.append(q); continue
        water += encode(g, **{a: b for a, b in q.items() if a not in ('o', 'h')})
    d['water'] = water
    n0 = len(d['buildings'])
    d['buildings'] = [b for b in d['buildings'] if not cut.contains(Polygon(b['p']).buffer(0).centroid)]
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('砂浜', round(sand.area), '/ 海', round(newsea.area), '/ 西端の幅', round(w0), '/ 建物', n0 - len(d['buildings']))

if __name__ == '__main__':
    main()
