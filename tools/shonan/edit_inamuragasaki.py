"""稲村ヶ崎東端: 指示画像に沿って海・緑地・護岸の境界を整理する。

リポジトリ直下で python tools/shonan/edit_inamuragasaki.py を実行後、
build_surfaces.py で地表を再生成する。座標は x=東、z=南、単位m。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon, Point, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'

def shape(q):
    return Polygon(q['o'], q.get('h', [])).buffer(0)

def polygons(g):
    if g.geom_type == 'Polygon':
        if g.area > .05:
            yield g
    elif hasattr(g, 'geoms'):
        for q in g.geoms:
            yield from polygons(q)

def encode(g, **properties):
    return [dict(o=[[float(x),float(z)] for x,z in list(p.exterior.coords)[:-1]],
                 h=[[[float(x),float(z)] for x,z in list(h.coords)[:-1]] for h in p.interiors],
                 **properties) for p in polygons(g)]

def main():
    data = json.loads(FILE.read_text())
    # 赤: 残す護岸の海側を1本の線で区切る。既存の海まで延ばし、細い陸を残さない。
    removed = Polygon([(8975,777),(9398,812),(9398,910),(8975,910)])
    # 黄緑: 北側の細い入り込みは、道路の北縁まで続くシンプルな緑地にする。
    inlet = Polygon([(9474,777),(9485,677),(9528,677),(9512,716),(9534,777)])
    # オレンジ: 砂浜の東側を護岸へ。西端は砂浜から斜めに取り付き、北は既存の道路際。
    beach_cut = Polygon([(8970,780),(9065,710),(9450,770),(9450,910),(8970,910)])
    old_grey = [shape(q) for q in data['piers'] if q.get('name') == '稲村ヶ崎・西の護岸']
    grey_beach = unary_union([shape(q).intersection(beach_cut) for q in data['beaches'] if shape(q).bounds[0] < 9000 and shape(q).area > 100000] + old_grey)
    grey_beach = grey_beach.difference(removed).simplify(1.5,preserve_topology=True)
    # 道路下の小区間もグレーにそろえる。上端は道路に少し食い込ませ、隙間を作らない。
    grey_bridge = Polygon([(9467,785),(9537,779),(9534,801),(9467,806)])
    # 岬右端は既存の陸だけを緑地化する。海へ拡張しない。
    wet = unary_union([shape(q) for q in data['water']])
    dry = box(data['bounds'][0]-300,data['bounds'][1]-300,data['bounds'][2],data['bounds'][3]+300).difference(wet)
    cape = dry.intersection(box(9917,819,9976,1000))
    old_cape = [shape(q) for q in data['parks'] if shape(q).covers(Point(9925,890)) or q.get('name') == '稲村ヶ崎・岬の緑地']
    cape = unary_union([cape]+old_cape).simplify(1.5,preserve_topology=True)

    for key in ['beaches','piers','parks','rocks','lots','parking']:
        out = []
        for q in data[key]:
            if key == 'piers' and q.get('name') in ['稲村ヶ崎・西の護岸','稲村ヶ崎・道路下の護岸']:
                continue
            if key == 'parks' and (shape(q).covers(Point(9925,890)) or q.get('name') in ['稲村ヶ崎・岬の緑地','稲村ヶ崎・道路北の緑地']):
                continue
            mask = removed
            if key == 'beaches' and shape(q).bounds[0] < 9000 and shape(q).area > 100000:
                mask = mask.union(beach_cut).union(grey_bridge).union(inlet)
            g = shape(q)
            if g.intersects(mask):
                out.extend(encode(g.difference(mask),**{k:v for k,v in q.items() if k not in ('o','h')}))
            else:
                out.append(q)
        data[key] = out
    data['piers'] += encode(grey_beach,name='稲村ヶ崎・西の護岸') + encode(grey_bridge,name='稲村ヶ崎・道路下の護岸')
    data['parks'] += encode(inlet,name='稲村ヶ崎・道路北の緑地') + encode(cape,name='稲村ヶ崎・岬の緑地')

    water = []
    fill = inlet.union(grey_bridge)
    for q in data['water']:
        g = shape(q)
        # 既存の細い水面は北側を緑地、南側を護岸へ置き換えるため外す。
        if g.bounds[0] > 9480 and g.bounds[2] < 9540 and g.bounds[1] > 670 and g.bounds[3] < 820:
            continue
        if q.get('sea') and g.area > 100000000:
            g = g.union(removed)
        if g.intersects(fill) or (q.get('sea') and g.area > 100000000):
            water += encode(g.difference(fill),**{k:v for k,v in q.items() if k not in ('o','h')})
        else:
            water.append(q)
    data['water'] = water
    # 削除した陸上や新しい緑地内に建物・木の切れ端を残さない。
    clear = removed.union(inlet)
    n0 = len(data['buildings'])
    data['buildings'] = [b for b in data['buildings'] if not clear.contains(Polygon(b['p']).buffer(0).centroid)]
    data['trees'] = [p for p in data['trees'] if not removed.contains(Point(p[0],p[1]))]
    FILE.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')))
    print('護岸',round(grey_beach.area+grey_bridge.area),'m² / 緑地',round(inlet.area+cape.area),'m² / 建物削除',n0-len(data['buildings']))

if __name__ == '__main__':
    main()
