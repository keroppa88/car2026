"""湘南: 小さな破片(砂浜・堤防・岩場・緑地・敷地・駐車場・池の小さな切れ端)を全部取り除く。

リポジトリ直下で python tools/shonan/clean_fragments.py → python tools/shonan/build_surfaces.py。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon

FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
MIN = {'beaches': 400, 'piers': 150, 'rocks': 300, 'parks': 300, 'woods': 300, 'lots': 60, 'parking': 150, 'water': 300}

def close_holes(d, key, gap=3.0, hole=3000):
    # 同じ種類の面をまとめ、すき間(3m 以下)と小さな穴(3000m² 以下)を埋める。道路・建物・水の所は埋めない
    from shapely.ops import unary_union
    from shapely.geometry import LineString
    items = d.get(key, [])
    if not items: return
    g = unary_union([Polygon(q['o'], q.get('h', [])).buffer(0) for q in items])
    g = g.buffer(gap, join_style=2).buffer(-gap, join_style=2)
    def fill(p):
        return Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area > hole])
    g = unary_union([fill(p) for p in (getattr(g, 'geoms', None) or [g]) if p.geom_type == 'Polygon'])
    # 重なりは地表の生成で優先順に処理される(穴埋めだけ。ほかの面は削らない)
    d[key] = [{'o': [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]],
               'h': [[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors]}
              for p in (getattr(g, 'geoms', None) or [g]) if p.geom_type == 'Polygon' and p.area > 1]

def main():
    d = json.loads(FILE.read_text())
    # 砂浜・護岸・岩場の中の▽のような地面の穴やすき間を埋める(名前はなくなる)
    for key in ('beaches', 'piers', 'rocks'): close_holes(d, key)
    out = {}
    for k, m in MIN.items():
        keep = []
        for q in d.get(k, []):
            try: g = Polygon(q['o'], q.get('h', [])).buffer(0)
            except Exception: continue
            if k == 'water' and q.get('sea'): keep.append(q); continue
            # 鋭いとげ・三角の切れ端を落とす(1.5m 内側へ縮めてから戻す)
            if k != 'water':
                g2 = g.buffer(-1.5, join_style=2).buffer(1.5, join_style=2)
                if not g2.is_empty and g2.area > 0.8 * g.area: g = g2
            # 面積が小さいもの、または幅がとても細い(面積/周長 < 1.2m)切れ端
            if g.area < m or g.area / max(g.length, 1) < 1.2: continue
            # 穴の小さいものも埋める
            for p in (getattr(g, 'geoms', None) or [g]):
                if p.geom_type != 'Polygon' or p.area < m: continue
                r = dict(q); r['o'] = [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]
                r['h'] = [[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors if Polygon(h).area >= m]
                keep.append(r)
        out[k] = len(d.get(k, [])) - len(keep); d[k] = keep
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('取り除いた破片', out)

if __name__ == '__main__':
    main()
