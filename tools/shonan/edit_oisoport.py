"""湘南 大磯の港(-8943,416)の指示の絵(paint/top/oisoport_*)を反映する。
ピンク = 白い2階建ての建物(高さ 7m)、黄緑 = 緑地(少し色の違う平らな緑地 lawns)。"""
import json
from pathlib import Path
import numpy as np, cv2
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
ROOT = Path(__file__).resolve().parents[2]; TOP = ROOT / 'tools/shonan/paint/top'; FILE = ROOT / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
B = cv2.imread(str(TOP / 'oisoport_paint.png')).astype(int); Hw = np.load(TOP / 'oisoport_Hw.npy')
b, g, r = B[..., 0], B[..., 1], B[..., 2]
W = lambda q: cv2.perspectiveTransform(np.float32(q).reshape(-1, 1, 2), Hw).reshape(-1, 2)
RW = lambda rd: 4.5 if rd.get('lanes') == 1 and not rd.get('oneway') else rd.get('lanes', 2) * 3.25
roads = unary_union([LineString(rd['pts']).buffer(RW(rd) / 2 + 2.0) for rd in d['roads']])
def comps(mask, min_px=30):
    n, lab, st, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
    return [(lab == i) for i in range(1, n) if st[i, 4] >= min_px]
def rect(mk):
    cs, _ = cv2.findContours(mk.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    c = max(cs, key=cv2.contourArea)
    return Polygon(W(c.reshape(-1, 2) + 0.5)).buffer(0).minimum_rotated_rectangle.difference(roads)
ring = lambda p: [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]]
big = lambda p: max([q for q in getattr(p, 'geoms', [p]) if q.geom_type == 'Polygon'], key=lambda q: q.area)
d['lawns'] = d.get('lawns', [])
for mk in comps((r > 150) & (r < 200) & (g > 210) & (b < 60)):
    p = big(rect(mk)); d['lawns'].append({'o': ring(p)}); print('緑地', round(p.area), 'm²')
for mk in comps((r > 230) & (g > 150) & (g < 200) & (b > 180) & (b < 225)):
    p = big(rect(mk)); d['buildings'].append({'p': ring(p.simplify(0.3)), 'h': 7.0, 'holes': [], 'look': {'wall': 0xeeede8}}); print('白い2階建て', round(p.area), 'm²')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
