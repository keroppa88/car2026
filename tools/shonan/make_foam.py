"""砂浜の波打ち際に沿った「白い泡の帯」を作る(海側へ幅 W m)。
リポジトリ直下で python3 tools/shonan/make_foam.py → map/shonan-foam.json
出力: 帯ごとに pts=[x,z,...]、各頂点の d(岸からの距離 m)、u(岸に沿った距離 m)。
"""
from pathlib import Path
import json, math
from shapely.geometry import Polygon, Point, LineString, MultiLineString
from shapely.ops import unary_union, linemerge

ROOT = Path(__file__).resolve().parents[2]
d = json.loads((ROOT / 'map/shonan-city.json').read_text())
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
sea = unary_union([shape(q) for q in d['water'] if q.get('sea')])
beach = unary_union([shape(q) for q in d['beaches']])
LAND = ('beaches', 'piers', 'rocks', 'parks', 'woods', 'lots', 'parking')
land = unary_union([shape(q) for k in LAND for q in d.get(k, [])])
sea = sea.difference(land)          # 砂浜などの下に潜っている海は除く(見えている海だけ)
inner = sea.buffer(-0.3)
W, STEP, ROWS = 16.0, 3.0, (0.0, 0.25, 0.5, 0.75, 1.0)

shore = sea.boundary.intersection(beach.buffer(1.5))
lines = linemerge([g for g in getattr(shore, 'geoms', [shore]) if g.geom_type == 'LineString'] +
                  [p for g in getattr(shore, 'geoms', []) if g.geom_type == 'MultiLineString' for p in g.geoms])
lines = [l for l in getattr(lines, 'geoms', [lines]) if l.length >= 20]

strips = []
for l in lines:
    l = l.simplify(2.5)
    n = max(2, int(l.length / STEP) + 1)
    pts = [l.interpolate(i / (n - 1), normalized=True) for i in range(n)]
    xs = [(p.x, p.y) for p in pts]
    cols = []
    for i, (x, z) in enumerate(xs):
        a, b = xs[max(i - 3, 0)], xs[min(i + 3, n - 1)]
        tx, tz = b[0] - a[0], b[1] - a[1]; L = math.hypot(tx, tz) or 1
        nx, nz = -tz / L, tx / L
        if not inner.contains(Point(x + nx * 3, z + nz * 3)): nx, nz = -nx, -nz
        # 海が狭い所は帯を細くする(対岸の陸へはみ出さない)
        w = W
        ok = lambda w: inner.contains(LineString([(x + nx * 0.5, z + nz * 0.5), (x + nx * w, z + nz * w)]))
        while w > 2 and not ok(w): w *= 0.7
        cols.append((x, z, nx, nz, w, i * l.length / (n - 1)) if ok(w) else None)   # 海側に水が無い所は帯を切る
    run = []
    for c in cols + [None]:
        if c: run.append(c); continue
        if len(run) >= 3:
            out_pts, out_d, out_u, out_e = [], [], [], []
            for j, (x, z, nx, nz, w, u) in enumerate(run):
                for r in ROWS:
                    out_pts += [round(x + nx * w * r, 2), round(z + nz * w * r, 2)]
                    out_d.append(round(W * r, 2))   # 色付けは名目の幅で
                    out_u.append(round(u, 1))
                    out_e.append(round(min(j, len(run) - 1 - j) * STEP, 1))   # 帯の端までの距離(端をぼかす)
            strips.append(dict(pts=out_pts, d=out_d, u=out_u, e=out_e, n=len(run)))
        run = []

(ROOT / 'map/shonan-foam.json').write_text(json.dumps(dict(rows=len(ROWS), width=W, strips=strips), separators=(',', ':')))
print('帯', len(strips), '本  岸の長さ', round(sum(l.length for l in lines)), 'm')
