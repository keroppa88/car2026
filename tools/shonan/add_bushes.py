"""湘南: 指示の絵で線を引いた所に、草むら・茂みを置く。
水色 = 低い草むら(雑草など、高さ 1m)、ピンク = 雑木林のような茂み(高さ 2m)。
絵の画素 → 地図の座標は照合で求めた射影変換 top/bush?_Hw.npy。線路の路盤・車道にかかる所は除く。
出力: city.json の bushes = [{pts: [[x,z],...], h: 1 | 2}]
python3 tools/shonan/add_bushes.py B D ...(絵の名前)
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import LineString, Point, MultiPoint
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; TOP = ROOT / 'tools/shonan/paint/top'
FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
keepout = unary_union([LineString(q[:2] for q in d['enoden']['pts']).buffer(2.3)] if d.get('enoden') else [] )
car = unary_union([LineString(r['pts']).buffer(W(r) / 2 + 0.3, cap_style=2) for r in d['roads']])
out = [b for b in d.get('bushes', []) if b.get('src') not in sys.argv[1:]]
for name in sys.argv[1:]:
    A = cv2.imread(str(TOP / f'bush{name}_base.png')).astype(int); B = cv2.imread(str(TOP / f'bush{name}_paint.png')).astype(int)
    Hw = np.load(TOP / f'bush{name}_Hw.npy')
    b, g, r = B[..., 0], B[..., 1], B[..., 2]
    changed = np.abs(A - B).sum(2) > 60
    pink = changed & (r > 220) & (g > 140) & (g < 200) & (b > 170) & (b < 225)
    blue = changed & (b > 210) & (g > 190) & (r > 120) & (r < 190)
    for mask, h in ((pink, 2), (blue, 1)):
        m = cv2.morphologyEx(mask.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        n, lab = cv2.connectedComponents(m)
        for k in range(1, n):
            ys, xs = np.nonzero(lab == k)
            if len(xs) < 15: continue
            pts = cv2.perspectiveTransform(np.float32(np.stack([xs + .5, ys + .5], 1))[None], Hw)[0]
            c = pts.mean(0); u, s_, vt = np.linalg.svd(pts - c); ax = vt[0]
            t = (pts - c) @ ax; order = np.argsort(t)
            # 線に沿って 2m ごとに、その辺の点の平均
            line = []
            for t0 in np.arange(t.min(), t.max() + 0.01, 2.0):
                sel = np.abs(t - t0) < 1.5
                if sel.any(): line.append(pts[sel].mean(0).tolist())
            if len(line) < 2: continue
            L = LineString(line).simplify(0.3)
            rest = L.difference(keepout.union(car))
            for part in getattr(rest, 'geoms', [rest]):
                if part.geom_type == 'LineString' and part.length > 2:
                    out.append({'pts': [[round(x, 2), round(z, 2)] for x, z in part.coords], 'h': h, 'src': name})
print('草むら(1m)', sum(1 for b in out if b['h'] == 1), '本', round(sum(LineString(b['pts']).length for b in out if b['h'] == 1)), 'm  茂み(2m)', sum(1 for b in out if b['h'] == 2), '本', round(sum(LineString(b['pts']).length for b in out if b['h'] == 2)), 'm')
d['bushes'] = out
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
