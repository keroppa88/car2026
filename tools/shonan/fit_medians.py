"""湘南: 中央分離帯の緑地帯を、両側の車道の白線(車道の縁)にぴったり沿わせて作り直す(全域)。はみ出さない。
元の長方形の範囲を、近くの車道の線に沿って 2m ごとに調べ、両側の車道のすき間の真ん中に、すき間の幅(-0.3m)の短い長方形を並べる。
長方形の6番目の値 1 = となりと続いている(植え込みの端を縮めない)。
python3 tools/shonan/fit_medians.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
lines = [LineString(r['pts']) for r in R]
polys = [l.buffer(W(r) / 2, cap_style=2, join_style=2) for l, r in zip(lines, R)]
tl, tp = STRtree(lines), STRtree(polys)
def intervals(p, n, maxd=40):   # 点 p から向き n へ 0〜maxd の線が車道に入っている区間
    ray = LineString([p, (p[0] + n[0] * maxd, p[1] + n[1] * maxd)])
    out = []
    for j in tp.query(ray):
        x = ray.intersection(polys[j])
        for g in getattr(x, 'geoms', [x]):
            if g.is_empty or g.geom_type != 'LineString': continue
            ds = sorted(math.hypot(c[0] - p[0], c[1] - p[1]) for c in g.coords)
            out.append((ds[0], ds[-1]))
    out.sort(); merged = []
    for a, b in out:
        if merged and a <= merged[-1][1] + 0.05: merged[-1][1] = max(merged[-1][1], b)
        else: merged.append([a, b])
    return merged
new = []
for cx, cz, ang, ln, wd, *_ in d['medians']:
    c = Point(cx, cz)
    js = [j for j in tl.query(c.buffer(wd / 2 + 25)) if not R[j].get('bridge')]
    if not js: continue
    j = min(js, key=lambda j: lines[j].distance(c)); L = lines[j]
    tx, tz = math.sin(ang), math.cos(ang)
    s0, s1 = sorted([L.project(Point(cx - tx * ln / 2, cz - tz * ln / 2)), L.project(Point(cx + tx * ln / 2, cz + tz * ln / 2))])
    if s1 - s0 < 1: continue
    m = max(1, round((s1 - s0) / 2)); run = []
    for k in range(m + 1):
        s = s0 + (s1 - s0) * k / m
        p = L.interpolate(s); a = L.interpolate(max(0, s - 1)); b = L.interpolate(min(L.length, s + 1))
        dx, dz = b.x - a.x, b.y - a.y; l = math.hypot(dx, dz) or 1; dx, dz = dx / l, dz / l
        nx, nz = dz, -dx
        side = 1 if (cx - p.x) * nx + (cz - p.y) * nz > 0 else -1
        nx, nz = nx * side, nz * side
        iv = intervals((p.x, p.y), (nx, nz))
        if not iv or iv[0][0] > 0.5: run.append(None); continue
        e1 = iv[0][1]
        e2 = iv[1][0] if len(iv) > 1 else None
        if e2 is None or e2 - e1 > 30: run.append(None); continue   # 向こうに車道がない: 中央分離帯ではない
        w = e2 - e1 - 0.3
        if w < 0.5: run.append(None); continue
        mid = (e1 + e2) / 2
        run.append((p.x + nx * mid, p.y + nz * mid, math.atan2(dx, dz), w))
    for k in range(len(run) - 1):
        a, b = run[k], run[k + 1]
        if not a or not b: continue
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        ln2 = math.hypot(b[0] - a[0], b[1] - a[1])
        if ln2 < 0.3: continue
        cont = 1 if (k > 0 and run[k - 1]) or (k + 2 < len(run) and run[k + 2]) else 0
        new.append([round(mx, 2), round(mz, 2), round(math.atan2(b[0] - a[0], b[1] - a[1]), 4), round(ln2 + 0.05, 2), round(min(a[3], b[3]), 2), cont])
# 重なった元の長方形から同じ所が二重にできるので、中心が 0.8m 以内のものは1つに
grid, uniq = {}, []
for m in new:
    k = (round(m[0] / 0.8), round(m[1] / 0.8))
    if any((k[0] + a, k[1] + b) in grid for a in (-1, 0, 1) for b in (-1, 0, 1)): continue
    grid[k] = 1; uniq.append(m)
new = uniq
print('中央分離帯', len(d['medians']), '→', len(new), '個の短い長方形')
d['medians'] = new
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
