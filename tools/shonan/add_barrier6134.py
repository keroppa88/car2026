"""湘南 6134,295: 上下線が離れた橋(国道134号)の中央側の車線の縁に、コンクリートの厚い柵(高さ 0.9m・厚さ 0.45m)を置く。
→ city.json の barriers = [{pts: [[x,z],...], h, w}](js/osm-city.js の buildBarriers が描く)"""
import json, math
from pathlib import Path
from shapely.geometry import LineString
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
near = lambda p, q, e=1.5: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
a = next(r for r in d['roads'] if near(r['pts'][0], (6083, 263)) and near(r['pts'][-1], (6184, 303)))
b = next(r for r in d['roads'] if near(r['pts'][0], (6176, 311)) and near(r['pts'][-1], (6074, 271)))
W = lambda r: r['lanes'] * 3.25
out = [x for x in d.get('barriers', []) if x.get('src') != '6134']
for r, o in ((a, b), (b, a)):
    L = LineString(r['pts']); O = LineString(o['pts'])
    for sd in (1, -1):
        e = L.parallel_offset(W(r) / 2 + 0.3, 'left' if sd > 0 else 'right')
        if e.distance(O) < L.distance(O): break   # 相手の道路の側(中央側)
    pts = [[round(x, 2), round(z, 2)] for x, z in e.coords]
    out.append({'pts': pts, 'h': 0.9, 'w': 0.45, 'src': '6134'})
d['barriers'] = out
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print([x['pts'] for x in out])
