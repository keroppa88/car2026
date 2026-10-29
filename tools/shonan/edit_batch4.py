"""湘南: 座標の指示(2026-10-29)。
・6355,298〜6457,259: 国道134号の1車線の細い区間を片側2車線に(幹線道路のまま続ける)。道路にかぶる緑地(6450,240 の中央分離帯・帯)を消す
・8571,565〜8550,653: 細い水路(海と同じ色、幅 4m)
python3 tools/shonan/edit_batch4.py → make_foam.py → make_lamps.py → build_surfaces.py
"""
import sys, json, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE
from shapely.geometry import LineString, Point
from shapely.ops import unary_union
d = json.loads(FILE.read_text()); M = Map(d)
for r in d['roads']:
    if r.get('name') == '国道134号' and r.get('lanes') == 1 and abs(r['pts'][0][0] - 6461.7) < 0.5 and abs(r['pts'][0][1] - 233.2) < 0.5:
        r['lanes'] = 2; print('片側2車線に', len(r['pts']), '点')
for k in ('medians', 'strips'):
    before = len(d[k]); d[k] = [m for m in d[k] if math.hypot(m[0] - 6450, m[1] - 240) > 22]; print(k, '消した', before - len(d[k]))
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
ch = LineString([(8571, 565), (8550, 653)]).buffer(2.0, cap_style=2)
roads = unary_union([LineString(r['pts']).buffer(W(r) / 2 + 0.3) for r in d['roads'] if LineString(r['pts']).distance(ch) < 20])
ch = ch.difference(roads)
M.put(ch, 'sea', keep_water=True)
print('水路', round(ch.area), 'm²')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
