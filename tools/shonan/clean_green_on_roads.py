"""湘南: 林・緑地(woods/parks)のうち、車道と歩道(道路の中心から 半幅+歩道 4.5m)に入り込んでいる所を全域で切り取る。
林の木や森の壁の絵が歩道・車道の上に立たないように(木は緑地の上だけ)。
python3 tools/shonan/clean_green_on_roads.py → build_surfaces.py
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE, shape
from shapely.geometry import LineString
from shapely.ops import unary_union
d = json.loads(FILE.read_text()); M = Map(d)
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
SW = d.get('sidewalk', 4.5)
area = lambda k: sum(shape(q).area for q in d[k])
before = {k: area(k) for k in ('woods', 'parks')}
roads = unary_union([LineString(r['pts']).buffer(W(r) / 2 + (0.3 if r.get('bridge') else SW + 0.3), cap_style=2, join_style=2) for r in d['roads']])
M.cut(roads, ['woods', 'parks'])
for k in ('woods', 'parks'): d[k] = [q for q in d[k] if shape(q).area > 20]   # 切った残りの細かい切れ端は消す
print({k: round(before[k] - area(k)) for k in before}, 'm² 切り取り')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
