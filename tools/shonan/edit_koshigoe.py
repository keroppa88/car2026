"""腰越漁港〜小動岬(画像指示): 赤=海へ、オレンジ=コンクリート、黄=砂浜。

リポジトリ直下で python tools/shonan/edit_koshigoe.py → python tools/shonan/build_surfaces.py。
座標は x=東、z=南、単位m。線はシンプルに直線・なめらかな線で引く。
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
    roads = unary_union([LineString(r['pts']).buffer((r['lanes'] * 3.25 if (r['oneway'] or r['lanes'] > 1) else 4.5) / 2 + 1)
                         for r in d['roads'] if len(r['pts']) > 1])
    woods = unary_union([shape(q) for q in d['woods'] + d['parks']])
    # 赤1: 西の防波堤の内側(川の口)と、港の中の砂の三角 → 海
    red1 = Polygon([(6866, 262), (6880, 268), (6884, 300), (6966, 326), (6955, 350), (6925, 372), (6905, 372), (6880, 330), (6866, 300)])
    # オレンジ: 道路の南、建物の右の帯 → コンクリート
    orange = Polygon([(6896, 292), (6962, 312), (6966, 326), (6884, 300), (6886, 288)])
    # 赤2: 岬の南の端(駐車場)と、林の南の海ぎわ → 海(林は残す)
    red2 = Polygon([(6925, 436), (6968, 432), (6972, 470), (7095, 492), (7110, 540), (6925, 540)]).difference(woods)
    # 黄: 岬の東から砂浜の始まりまで、道路の南を砂浜に。海側の縁はまっすぐ
    r134 = unary_union([LineString(r['pts']) for r in d['roads'] if r['name'] == '国道134号' and any(7100 < x < 7500 for x, z in r['pts'])])
    def road_z(x):
        g = r134.intersection(LineString([(x, 0), (x, 2000)]))
        return max(p.y for p in ([g] if g.geom_type == 'Point' else list(g.geoms)) if p.geom_type == 'Point')
    # 東の元の砂浜の海岸線(x=7600)へ、まっすぐなめらかにつなぐ
    sand0 = unary_union([shape(q) for q in d['beaches']])
    c = sand0.intersection(LineString([(7600, 0), (7600, 2000)]))
    zE = max(p[1] for g in getattr(c, 'geoms', [c]) for p in g.coords)
    top = [(x, road_z(x)) for x in range(7150, 7601, 10)]
    yellow = Polygon(top + [(7600, zE), (7150, 452)]).difference(roads)   # 道路の南だけ。海側の縁は1本の直線
    red = unary_union([red1, red2]).difference(roads)
    for k in ('beaches', 'piers', 'rocks', 'lots', 'parking'):
        out = []
        for q in d[k]:
            g = shape(q)
            m = red.union(orange).union(yellow)
            if g.intersects(m) and g.intersection(m).area > .5: out += encode(g.difference(m), **{a: b for a, b in q.items() if a not in ('o', 'h')})
            else: out.append(q)
        d[k] = out
    d['piers'] += encode(orange, name='腰越漁港・道路わきのコンクリート')
    d['beaches'] += encode(yellow, name='小動岬・東の砂浜')
    water = []
    for q in d['water']:
        g = shape(q)
        if q.get('sea') and g.area > 1e6: g = g.union(red).difference(orange).difference(yellow)
        elif g.intersects(orange.union(yellow)): g = g.difference(orange).difference(yellow)
        else: water.append(q); continue
        water += encode(g, **{a: b for a, b in q.items() if a not in ('o', 'h')})
    d['water'] = water
    n0 = len(d['buildings'])
    clear = red.union(yellow)
    d['buildings'] = [b for b in d['buildings'] if not clear.contains(Polygon(b['p']).buffer(0).centroid)]
    from shapely.geometry import Point
    d['trees'] = [p for p in d['trees'] if not clear.contains(Point(p[0], p[1]))]
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('海へ', round(red.area), '/ コンクリート', round(orange.area), '/ 砂浜', round(yellow.area), '/ 建物', n0 - len(d['buildings']))

if __name__ == '__main__':
    main()
