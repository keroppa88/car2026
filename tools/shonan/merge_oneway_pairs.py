"""湘南: 細い道で、一方通行の2本が並んで(12m 以内)同じ所を往復しているものは、ふつうの1車線の道路1本にまとめる(全域)。
python3 tools/shonan/merge_oneway_pairs.py → build_surfaces.py
"""
import json
from pathlib import Path
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']; L = [LineString(r['pts']) for r in R]
minor = [i for i, r in enumerate(R) if r.get('oneway') and not r.get('bridge') and r['kind'] in ('service', 'residential', 'unclassified', 'tertiary', 'living_street', 'secondary')]
t = STRtree([L[i] for i in minor]); used = set(); pairs = []
for i in minor:
    for b in t.query(L[i].buffer(10)):
        j = minor[b]
        if j <= i or i in used or j in used: continue
        if L[i].hausdorff_distance(L[j]) < 12 and abs(L[i].length - L[j].length) < 0.4 * max(L[i].length, L[j].length):
            pairs.append((i, j)); used |= {i, j}
gone = set(); new = []
for i, j in pairs:
    A, B = L[i], L[j]
    n = max(2, int(A.length // 4) + 1)
    pts = []
    for k in range(n):
        p = A.interpolate(A.length * k / (n - 1)); q = B.interpolate(B.project(p))
        pts.append([round((p.x + q.x) / 2, 2), round((p.y + q.y) / 2, 2)])
    cl = LineString(pts).simplify(0.3); pts = [[round(x, 2), round(z, 2)] for x, z in cl.coords]
    olds = [R[i]['pts'][0], R[i]['pts'][-1], R[j]['pts'][0], R[j]['pts'][-1]]
    # 元の端につながっていた道路は、新しい道路の近い端へ
    for r in R:
        if r is R[i] or r is R[j]: continue
        for e in (0, -1):
            if any(abs(r['pts'][e][0] - o[0]) < 0.5 and abs(r['pts'][e][1] - o[1]) < 0.5 for o in olds):
                end = min((pts[0], pts[-1]), key=lambda q: Point(q).distance(Point(r['pts'][e])))
                r['pts'][e] = list(end)
    new.append({'pts': pts, 'lanes': 1, 'oneway': False, 'kind': R[i]['kind'], 'junctions': [0, len(pts) - 1]})
    gone |= {i, j}
    print('1本に', R[i]['kind'], [round(v) for v in pts[0]], '→', [round(v) for v in pts[-1]], round(cl.length), 'm')
d['roads'] = [r for k, r in enumerate(R) if k not in gone] + new
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
