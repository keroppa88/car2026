"""湘南 -4479,-768: 川沿いの道路(国道134号から南の行き止まりまで)を消して、ただの地面(薄いグレー)にする。
その道路と隣の道をつないでいた短い道も消す。"""
import json
from pathlib import Path
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
key = lambda q: (round(q[0], 2), round(q[1], 2))
main = next(r for r in R if key(r['pts'][0]) == (-4495.0, -639.0) or (len(r['pts']) == 10 and abs(r['pts'][0][0] + 4495) < 1 and abs(r['pts'][0][1] + 639) < 1))
cut = next(i for i, q in enumerate(main['pts']) if abs(q[0] + 4489) < 1 and abs(q[1] + 789) < 1)   # 国道134号との交差点
gone = {key(q) for q in main['pts'][:cut]}
main['pts'] = main['pts'][cut:]; main['junctions'] = [j - cut for j in main['junctions'] if j >= cut]
link = [r for r in R if len(r['pts']) == 2 and any(key(q) in gone for q in r['pts']) and r.get('lanes') == 1]
for r in link:
    other = [key(q) for q in r['pts'] if key(q) not in gone]
    for o in R:   # つないでいた先の道の「交差点の印」も外す
        if o is r or o is main: continue
        o['junctions'] = [j for j in o['junctions'] if key(o['pts'][j]) not in other or sum(key(q) in other for x in R if x is not r for q in x['pts']) > 1]
d['roads'] = [r for r in R if r not in link]
print('消した長さの道路の点', len(gone), ' つなぎの道', len(link))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
