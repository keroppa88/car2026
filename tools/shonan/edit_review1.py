"""湘南: 確認用の地図(review/find.py)で決めた修正 その1。
・オレンジの行き止まり(すぐ先に別の道路があるのにつながっていない 40m 未満の道)を消す。赤(住宅地の袋小路など)は残す
・国道134号の切れ目(x 6890, z 256 と、その東の橋の始まりのあいだ 5m)をつなぐ
python3 tools/shonan/edit_review1.py → make_lamps.py → build_surfaces.py
"""
import json
from pathlib import Path
from shapely.geometry import LineString
ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
keys = json.loads((ROOT / 'tools/shonan/review/review1.json').read_text())['delete_stubs']
near = lambda p, q, e=0.006: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
before = len(d['roads'])
d['roads'] = [r for r in d['roads'] if not (LineString(r['pts']).length < 40 and r['kind'] not in ('trunk', 'trunk_link', 'primary') and any(near(r['pts'][0], k) for k in keys))]
print('消した行き止まり', before - len(d['roads']), '/', len(keys))
for r in d['roads']:
    if r.get('name') == '国道134号' and r.get('bridge') and near(r['pts'][0], (6894.8, 258.4), 0.1):
        r['pts'].insert(0, [6890.0, 256.1]); r['junctions'] = sorted({0} | {j + 1 for j in r['junctions']})
        print('国道134号の切れ目をつないだ')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
