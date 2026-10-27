"""稲村ヶ崎(2回目の画像指示): 国道134号の海側を砂浜に、海側の縁を少し海へ、岬の手前を緑地に、北の細い水路を削除。

リポジトリ直下で python tools/shonan/edit_inamuragasaki2.py を実行後、
python tools/shonan/build_surfaces.py で地表を再生成する。座標は x=東、z=南、単位m。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon, box
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
    SAND = box(8955, 600, 9690, 1000)     # 黄: 道路の海側を砂浜に
    GREEN = box(9690, 760, 9760, 1000)    # 黄緑: 砂浜の東端と岬の林のあいだ
    WEST = box(8975, 600, 9330, 1000)     # 赤: 海側の縁を海へ
    sea = unary_union([shape(q) for q in d['water'] if q.get('sea')])
    land = unary_union([shape(q) for k in ('beaches', 'piers', 'rocks') for q in d[k]])
    from shapely.affinity import translate
    from shapely.geometry import LineString
    road = unary_union([LineString(r['pts']) for r in d['roads'] if r['name'] == '国道134号' and any(8900 < x < 9800 for x, z in r['pts'])])
    # 道路より南(海側)だけ: 道路の線を南へ太らせた帯と、その南
    south = unary_union([Polygon([(x0, z0), (x1, z1), (x1, 1100), (x0, 1100)]) for g in getattr(road, 'geoms', [road]) for (x0, z0), (x1, z1) in zip(g.coords, list(g.coords)[1:]) if x1 > x0] +
                        [Polygon([(x1, z1), (x0, z0), (x0, 1100), (x1, 1100)]) for g in getattr(road, 'geoms', [road]) for (x0, z0), (x1, z1) in zip(g.coords, list(g.coords)[1:]) if x1 < x0]).buffer(0.5)
    land = land.intersection(south)
    # 赤: 海側の縁 12m を海へ(その点の 12m 北が陸でない所 = 南の縁)
    # 両端はなめらかに細くする(段差を作らない)
    red = unary_union([land.difference(translate(land, 0, -12 * min(1, (x - 8975) / 80, (9330 - x) / 80))).intersection(box(x, 600, x + 5, 1000))
                       for x in range(8975, 9330, 5) if min(x - 8975, 9330 - x) > 0])
    sand = land.intersection(SAND).difference(red)
    green = land.intersection(GREEN)
    cut = SAND.union(GREEN)
    for k in ('beaches', 'piers', 'rocks'):
        out = []
        for q in d[k]:
            g = shape(q)
            if g.intersects(cut): out += encode(g.difference(cut), **{a: b for a, b in q.items() if a not in ('o', 'h')})
            else: out.append(q)
        d[k] = out
    d['beaches'] += encode(sand)
    d['parks'] += encode(green, name='稲村ヶ崎・砂浜東の緑地')
    # 赤の部分は海へ
    big = max((i for i, q in enumerate(d['water']) if q.get('sea')), key=lambda i: shape(d['water'][i]).area)
    sg = shape(d['water'][big]).union(red)
    rest = encode(sg, **{a: b for a, b in d['water'][big].items() if a not in ('o', 'h')})
    d['water'] = d['water'][:big] + rest + d['water'][big + 1:]
    # 赤: 北の細い水路(道路から北へ延びる線)を削除
    n0 = len(d['rivers'])
    d['rivers'] = [r for r in d['rivers'] if not (all(9780 < x < 9870 and 700 < z < 880 for x, z in r['pts']))]
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('砂浜', round(sand.area), '/ 緑地', round(green.area), '/ 海へ', round(red.area), '/ 水路削除', n0 - len(d['rivers']))

if __name__ == '__main__':
    main()
