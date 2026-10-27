"""湘南: 海・川の小さな破片(◀ のような切れ込み・小さな池)を全域から取り除き、まわりの陸の種類で埋める。
python3 tools/shonan/clean_sea_slivers.py → build_surfaces.py
"""
from pathlib import Path
import json
from shapely.geometry import Polygon
from shapely.ops import unary_union
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
LAND = ('beaches', 'piers', 'woods', 'parks', 'rocks', 'lots', 'parking')
W = 4.0   # 幅 8m 未満の切れ込み・とげ

def enc(p, **kw):
    return dict(o=[[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]],
                h=[[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors], **kw)

def parts(g):
    return [p for p in (getattr(g, 'geoms', None) or [g]) if p.geom_type == 'Polygon' and p.area > .5]

def main():
    d = json.loads(FILE.read_text())
    shp = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
    removed = []
    out = []
    for q in d['water']:
        g = shp(q)
        if not q.get('sea') and g.area < 1500: removed.append(g); continue          # 小さな池・切れ端
        g2 = g.buffer(-W, join_style=2).buffer(W, join_style=2)
        g2 = unary_union([p for p in parts(g2) if p.area > 1500 or q.get('sea') is None and p.area > 300])
        if g2.is_empty: removed.append(g); continue
        removed.append(g.difference(g2))
        out += [enc(p, **{k: v for k, v in q.items() if k not in ('o', 'h')}) for p in parts(g2)]
    d['water'] = out
    gone = unary_union(removed)
    # 塗った絵で「海」と塗った所(細い水路など)は残す
    import sys; sys.path.insert(0, str(Path(__file__).parent / 'paint')); sys.argv = sys.argv[:1]
    import apply_paint as AP
    tiles = {t['file'][3:5]: t for t in json.loads((AP.TOP / 'tiles.json').read_text())}
    for extra in AP.TOP.glob('tiles_*.json'): tiles.update({t['file'][:-4]: t for t in json.loads(extra.read_text())})
    keep = []
    for f in AP.TOP.glob('*_paint.png'):
        n = f.name[:-10]; n = n[3:] if n.startswith('top') else n
        m = AP.masks(n).get('sea')
        if m is not None and getattr(m, 'any', lambda: False)(): keep.append(AP.to_world(m, tiles[n]).buffer(1))
    keep = unary_union(keep)
    back = gone.intersection(keep)
    gone = gone.difference(keep)
    if not back.is_empty:
        big = max(range(len(out)), key=lambda i: Polygon(out[i]['o']).area if out[i].get('sea') else 0)
        g = Polygon(out[big]['o'], out[big].get('h', [])).buffer(0).union(back)
        out[big:big + 1] = [enc(p, **{k: v for k, v in out[big].items() if k not in ('o', 'h')}) for p in parts(g)]
    # 消した所は、となりの陸の種類で埋める(いちばん長く接している種類)
    lands = {k: unary_union([shp(q) for q in d[k]]) for k in LAND}
    add = {k: [] for k in LAND}
    for p in parts(gone):
        best, bl = None, 0
        ring = p.buffer(1.5)
        for k, g in lands.items():
            l = g.intersection(ring).area
            if l > bl: best, bl = k, l
        if best: add[best].append(p)
    for k, ps in add.items():
        if ps: d[k] += [enc(p) for p in parts(unary_union(ps))]
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('海・川の破片', len(parts(gone)), '個', round(gone.area), 'm² →', {k: len(v) for k, v in add.items() if v})

if __name__ == '__main__':
    main()
