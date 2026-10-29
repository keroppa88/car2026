"""湘南: 座標の指示(2026-10-29 20:33)。
・-3811,-880〜-3834,-1007 の細い道を消す(その手前 -3813,-868 で止める)
・-3470,-700 の道路を消す
・-3053,-658〜-3058,-707 の部分を消す
・-4193,-913 の横断歩道を置かない
"""
import json
from pathlib import Path
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
near = lambda p, q, e=0.6: abs(p[0] - q[0]) < e and abs(p[1] - q[1]) < e
out = []
for r in d['roads']:
    p = r['pts']
    if near(p[0], (-3460.6, -751.5)) and near(p[-1], (-3830.9, -1005.5)):
        r['pts'] = p[:5]; r['junctions'] = [j for j in r['junctions'] if j < 5]; print('切った', p[4])
    elif near(p[0], (-3468.1, -665.4)) and near(p[-1], (-3469.7, -725.2)):
        print('消した -3470,-700'); continue
    elif near(p[0], (-3054.5, -702.6)) and near(p[-1], (-3663.5, -584.8)):
        r['pts'] = p[1:]; r['junctions'] = [j - 1 for j in r['junctions'] if j >= 1]; print('切った', p[1])
    out.append(r)
d['roads'] = out
d['noCrosswalks'] = d.get('noCrosswalks', []) + [[-4193, -913]]
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
