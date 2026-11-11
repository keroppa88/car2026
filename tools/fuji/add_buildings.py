"""富士スピードウェイ: OSM の建物をすべて map/fuji-course.json の buildings に足す(make_fuji.py はホームストレートわきだけ)。
観客席(leisure=bleachers)は kind='stand'。コースをまたぐ看板の橋 gantries(コースの点の番号)もここで書く。
python3 tools/fuji/add_buildings.py   (何度実行してもよい)
"""
import json, math
from pathlib import Path
import numpy as np
from lxml import etree
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
lat0, lon0 = d['origin']; KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
G = d['ground']; Hh = np.array(G['h'], float).reshape(G['nz'], G['nx']) / 10
def gy(x, z):
    fx = min(max((x - G['x0']) / G['cell'], 0), G['nx'] - 1.001); fz = min(max((z - G['z0']) / G['cell'], 0), G['nz'] - 1.001)
    ix, iz = int(fx), int(fz); tx, tz = fx - ix, fz - iz
    return (Hh[iz, ix] * (1 - tx) + Hh[iz, ix + 1] * tx) * (1 - tz) + (Hh[iz + 1, ix] * (1 - tx) + Hh[iz + 1, ix + 1] * tx) * tz
R = np.array([[p[0], p[2]] for p in d['route']])
keep = [b for b in d['buildings'] if not b.get('extra')]
have = {(round(b['p'][0][0]), round(b['p'][0][1])) for b in keep}
N = {}; add = []
for _, e in etree.iterparse(str(ROOT / 'tools/fuji/fuji.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = ((float(e.get('lon')) - lon0) * KX, -(float(e.get('lat')) - lat0) * KZ)
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}; nd = [n.get('ref') for n in e.findall('nd')]
        stand = t.get('leisure') == 'bleachers'
        if not ('building' in t or stand) or len(nd) < 4 or nd[0] != nd[-1]: continue
        pts = [N[q] for q in nd[:-1]]
        if (round(pts[0][0]), round(pts[0][1])) in have: continue
        P = np.array(pts); c = P.mean(0)
        if not (G['x0'] + 10 < c[0] < G['x0'] + (G['nx'] - 1) * G['cell'] - 10 and G['z0'] + 10 < c[1] < G['z0'] + (G['nz'] - 1) * G['cell'] - 10): continue
        if np.hypot(*(R - c).T).min() < 9: continue     # コースの上にかかる物(橋など)は置かない
        area = 0.5 * abs(np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]))
        h = float(t['building:levels']) * 3.5 if t.get('building:levels') else 3.5 if area < 120 else 6 if area < 1500 else 9
        add.append({'p': [[round(a, 2), round(b, 2)] for a, b in pts], 'h': h, 'y': round(min(gy(*p) for p in pts), 2),
                    'roof': t.get('building') == 'roof', 'name': t.get('name', ''), 'extra': 1, **({'kind': 'stand'} if stand else {})})
d['buildings'] = keep + add
# 看板の橋: 空撮でコースをまたいでいる所。[コースの点, 文字, 支柱の側(+1 左 / -1 右 / 0 両側)]。支柱1本のL字が基本
d['gantries'] = [[117, 'Audi Sport', -1], [237, 'GOODYEAR', 1], [417, 'DUNLOP', -1], [503, 'ENEOS', 1], [664, 'LEON', -1],
                 [1166, 'MICHELIN', 0], [1301, 'Sammy   LAP  TIME  FLAG   SEGA SAMMY', 0, '#1a3f8f'], [1392, 'Panasonic      Panasonic', 0, '#1d4fb0']]
# 路面の看板ペイント: [コースの点, 横(m, 左が+), 長さ, 幅, 地の色, 文字の色, 文字]
d['decals'] = [[24, 26, 30, 10, '#ffffff', '#d71e28', 'TOYOTA GAZOO Racing'], [216, -24, 16, 8, '#d71e28', '#ffffff', 'Coca-Cola'], [993, 16, 22, 7, '#2a63c8', '#ffffff', 'Panasonic']]
F.write_text(json.dumps(d, separators=(',', ':')))
print('建物', len(keep), '+', len(add), ' うち観客席', sum(1 for b in add if b.get('kind')))
