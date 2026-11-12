"""富士スピードウェイ: 二股(本コース + 近道)の白線を、2本の路面を合わせた形のふちから 0.425m 内側に 1本の続いた線として作る
→ map/fuji-course.json の forkLines(折れ線のリスト [[x,z],...])と forkRange([i0, i1]: この間の本コースの白線は js で引かない)
python3 tools/fuji/make_fork_lines.py
"""
import json
from pathlib import Path
import numpy as np
from shapely.geometry import LineString, Polygon, MultiLineString
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R); HALF = 7.5; IN = 0.425
br = next(b for b in d['branches'] if b['w'] > 9); a, b = sorted((br['from'], br['to']))
i0, i1 = a - 10, b + 10                      # 線を作り直す本コースの範囲
T = np.roll(R, -1, 0) - np.roll(R, 1, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NL = np.stack([T[:, 1], -T[:, 0]], 1)
def strip(idx, h): idx = np.array(idx) % n; return Polygon(np.r_[R[idx] + NL[idx] * h, (R[idx] - NL[idx] * h)[::-1]])
main = strip(range(i0 - 4, i1 + 5), HALF)
bl = LineString(br['pts']); bw = bl.buffer(br['w'] / 2, cap_style=2, join_style=2)
road = unary_union([main, bw]).buffer(0)
inset = road.buffer(-IN, join_style=1, resolution=8)
keep = unary_union([strip(range(i0, i1 + 1), HALF + 3), bl.buffer(br['w'] / 2 + 3, cap_style=2)])
lines = inset.boundary.intersection(keep)
geoms = list(lines.geoms) if hasattr(lines, 'geoms') else [lines]
from shapely.ops import linemerge
merged = linemerge(MultiLineString([g for g in geoms if g.length > 0.5]))
out = [g for g in (merged.geoms if hasattr(merged, 'geoms') else [merged])]
d['forkLines'] = [[[round(x, 2), round(z, 2)] for x, z in np.array(g.segmentize(1.0).coords)] for g in out if g.length > 2]
d['forkRange'] = [i0, i1]
F.write_text(json.dumps(d, separators=(',', ':')))
print('線', len(d['forkLines']), [round(g.length) for g in out], '範囲', i0, i1)
