"""湘南: 座標の指示(2026-10-29 夕方)。
・6062,251〜6189,321〜6408,267 の国道134号の中央分離帯の緑地(黄緑)・植え込みを消す
・6126,288 の橋(国道134号の上下線の橋): 橋の付け根からそのまま車道と歩道を伸ばす(ふつうの道路として描く。街灯は長い橋として残す)
・5519,-161 / 5435,-224 の砂浜の上の小さな建物を消す
・5066,-700 の幹線道路から分かれた短い道路を消す
python3 tools/shonan/edit_batch5.py → make_lamps.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point, Polygon
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
zone = LineString([(6062, 251), (6189, 321), (6408, 267)]).buffer(30)
b = len(d['medians']); d['medians'] = [m for m in d['medians'] if not zone.contains(Point(m[0], m[1]))]; print('中央分離帯の緑地', b - len(d['medians']))
near = lambda p, q, e=0.5: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
for r in d['roads']:
    if r.get('bridge') and r.get('name') == '国道134号' and (near(r['pts'][0], (6083.4, 263.5)) or near(r['pts'][0], (6175.7, 310.6))):
        r['bridge'] = False; r.pop('pair', None); r['longBridge'] = [0, len(r['pts']) - 1]; print('橋をふつうの道路に', r['pts'][0])
b = len(d['buildings'])
d['buildings'] = [x for x in d['buildings'] if not any(Polygon(x['p']).buffer(3).contains(Point(p)) for p in [(5519, -161), (5435, -224)])]
print('砂浜の上の建物', b - len(d['buildings']))
b = len(d['roads']); d['roads'] = [r for r in d['roads'] if not (near(r['pts'][0], (5058.4, -690.6)) and near(r['pts'][-1], (5073.3, -708.9)))]; print('分かれた道路', b - len(d['roads']))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
