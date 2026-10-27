"""湘南の画像指示(2回目まとめ): 江の島対岸・相模川河口・花水川河口・茅ヶ崎ヘッドランド。
色の指示どおりに面を置き換える。細部にはこだわらず、矩形・直線のシンプルな形で。

リポジトリ直下で python tools/shonan/edit_batch2.py → clean_fragments.py → build_surfaces.py。
座標は x=東、z=南、単位m。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon, LineString, Point, box
from shapely.ops import unary_union

FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
LAND_KINDS = ('beaches', 'piers', 'rocks', 'parks', 'woods', 'lots', 'parking')
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)

def polys(g):
    if g.geom_type == 'Polygon':
        if g.area > 1: yield g
    elif hasattr(g, 'geoms'):
        for q in g.geoms: yield from polys(q)

def encode(g, **kw):
    return [dict(o=[[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]],
                 h=[[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors], **kw) for p in polys(g)]

class Map:
    def __init__(self, d): self.d = d
    def water(self, sea_only=False):
        return unary_union([shape(q) for q in self.d['water'] if q.get('sea') or not sea_only])
    def cut(self, region, kinds):
        for k in kinds:
            out = []
            for q in self.d[k]:
                g = shape(q)
                if g.intersects(region) and g.intersection(region).area > .5:
                    out += encode(g.difference(region), **{a: b for a, b in q.items() if a not in ('o', 'h')})
                else: out.append(q)
            self.d[k] = out
    def cut_water(self, region):
        out = []
        for q in self.d['water']:
            g = shape(q)
            if g.intersects(region) and g.intersection(region).area > .5:
                out += encode(g.difference(region), **{a: b for a, b in q.items() if a not in ('o', 'h')})
            else: out.append(q)
        self.d['water'] = out
        self.d['rivers'] = [r for r in self.d['rivers'] if not region.buffer(-1).intersects(LineString(r['pts']))] if region.area > 0 else self.d['rivers']
    def clear(self, region):
        self.d['buildings'] = [b for b in self.d['buildings'] if not region.contains(Polygon(b['p']).buffer(0).centroid)]
        self.d['trees'] = [p for p in self.d['trees'] if not region.contains(Point(p[0], p[1]))]
    def put(self, region, kind, keep_water=False, clear=True):
        """region を kind(beaches / piers / parks / ground / sea)にする"""
        region = region.buffer(0)
        if region.is_empty: return
        self.cut(region, LAND_KINDS)
        if not keep_water or kind == 'sea': self.cut_water(region)
        if clear: self.clear(region)
        if kind == 'sea':
            big = max(range(len(self.d['water'])), key=lambda i: shape(self.d['water'][i]).area if self.d['water'][i].get('sea') else 0)
            q = self.d['water'][big]
            self.d['water'] = self.d['water'][:big] + encode(shape(q).union(region), **{a: b for a, b in q.items() if a not in ('o', 'h')}) + self.d['water'][big + 1:]
        elif kind != 'ground':
            self.d[kind] += encode(region)

def main():
    d = json.loads(FILE.read_text()); M = Map(d)
    # 砂浜の中の小さな護岸の切れ端(▽)は砂浜にする
    sand = unary_union([shape(q) for q in d['beaches']]).buffer(3)
    d['piers'] = [q for q in d['piers'] if not (sand.contains(shape(q)) and shape(q).area < 3000)]

    # ---- 江の島対岸 ----
    M.put(box(6050, 478, 6095, 525), 'beaches')                         # 砂浜の上の小さな敷地と建物 → 砂浜
    harbor = box(5680, 290, 6040, 680).difference(M.water(sea_only=False)).difference(unary_union([shape(q) for q in d['parks'] + d['woods'] + d['beaches']]))
    M.put(harbor.buffer(3, join_style=2).buffer(-3, join_style=2), 'piers', keep_water=True, clear=False)   # 港・防波堤 → コンクリート

    # ---- 相模川河口 ----
    M.put(box(-4640, -1225, -4490, -1030), 'ground')                    # 赤: 左上の細い入り江と緑の切れ端
    M.put(box(-4425, -1300, -4330, -1225), 'ground')                    # 赤: 川の上の丸い出っ張り
    west = box(-5000, -620, -4760, -440).difference(M.water(True))
    M.put(west, 'beaches', keep_water=True)                              # 黄: 西の砂浜を海まで
    M.put(box(-4800, -600, -4470, -250).difference(M.water(True)).difference(west), 'piers', keep_water=True, clear=False)   # 橙: 港
    M.put(Polygon([(-4105, -810), (-3845, -810), (-3845, -575), (-4040, -575)]), 'beaches')   # 黄: 河口の東
    M.put(unary_union([box(-4040, -575, -3845, -555), box(-3845, -810, -3830, -555)]), 'piers')   # 橙: 縁のコンクリート
    M.put(box(-3830, -960, -3560, -560).difference(M.water(True)), 'parks', keep_water=True)    # 黄緑: 南の公園
    M.put(box(-4200, -1420, -3700, -960).difference(M.water()), 'parks', keep_water=True, clear=False)   # 黄緑: 北のゴルフ場

    # ---- 花水川河口 ----
    channel = LineString([(-7470, -480), (-7462, -150)]).buffer(28, cap_style=2)
    # 両岸の砂浜の海側の縁をまっすぐ結んだ線より陸側の水面だけを砂浜にする
    mouth = Polygon([(-7720, -460), (-7100, -460), (-7100, -352), (-7720, -248)]).intersection(M.water()).difference(channel)
    M.put(mouth, 'beaches')                                              # 黄: 河口を砂浜で狭める
    M.put(Polygon([(-7430, -480), (-7250, -480), (-7100, -352), (-7430, -300)]).difference(channel), "beaches")# 黄: 東の岸の三角
    shore = box(-7100, -560, -5800, -150)
    for k in ('piers', 'rocks'):
        g = unary_union([shape(q) for q in d[k] if shape(q).intersects(shore)]).intersection(shore)
        M.put(g, 'beaches', keep_water=True)                             # 黄: 東の砂浜の海側の帯 → 砂浜

    # ---- 茅ヶ崎(ヘッドランド・漁港) ----
    M.put(box(-1760, -790, -1560, -520).difference(M.water(True)).difference(box(-1600, -730, -1555, -670)), 'piers', keep_water=True, clear=False)   # 橙: 漁港
    M.put(box(-1600, -730, -1555, -670).difference(M.water(True)), 'beaches', keep_water=True)   # 黄: 漁港の東のすき間
    green = unary_union([shape(q) for q in d['parks'] + d['woods']])
    band = box(-820, -840, 170, -440).difference(M.water(True)).difference(green)
    M.put(band, 'piers', keep_water=True, clear=False)                  # 橙: 砂浜〜ヘッドランドをコンクリート

    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('ok')

if __name__ == '__main__':
    main()
