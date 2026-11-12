"""富士スピードウェイ: アスファルトは「意味のある所」にだけ残す。それ以外の灰色は、となりの自然の色(草地を優先)にする。
アスファルトがあってよい所:
  1. 移動用の道: OSM の道路(service・tertiary など)。途切れずに舗装で描く
  2. 退避エリア(ランオフ): コースの縁石の外に接していて、コースから 60m 以内でつながっている灰色
  3. 駐車場: OSM の駐車場の中(まわり 3m まで)
  4. 建物のまわり: OSM の建物・観客席から 25m 以内と、建物に触れる広い舗装(パドック・広場)の太い本体
  5. 手で塗った直し(tools/fuji/paint/area_overrides.png の 1 路面・3 舗装・4 駐車場)
最後に、手で塗った直し(草地 2 も)をもう一度重ねる。
python3 tools/fuji/asphalt_rules.py   (regularize_course_side.py のあと、edit_shortcut_island.py の前に)
"""
import json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
from lxml import etree
ROOT = Path(__file__).resolve().parents[2]; d = json.loads((ROOT / 'map/fuji-course.json').read_text())
L = d['landcover']; x0, z0 = L['x0'], L['z0']
img = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); H, W = img.shape[:2]
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda k: tuple(int(q) for q in src.split(f"'{k}': (")[1].split(')')[0].split(','))
ROAD = (75, 73, 71); GREYS = [col('paved'), col('parking'), col('building')]
isc = lambda c: (img == np.array(c, np.uint8)).all(2)
grey = np.zeros((H, W), bool)
for c in GREYS: grey |= isc(c)
keep = np.zeros((H, W), np.uint8)
# 1. 道路  3. 駐車場  4. 建物
lat0, lon0 = d['origin']; KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
N = {}; roads = []; WID = {'tertiary': 9, 'secondary': 9, 'service': 7, 'residential': 7, 'unclassified': 7, 'track': 5, 'raceway': 11}
for _, e in etree.iterparse(str(ROOT / 'tools/fuji/fuji.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = ((float(e.get('lon')) - lon0) * KX - x0, -(float(e.get('lat')) - lat0) * KZ - z0); continue
    if e.tag != 'way': continue
    t = {x.get('k'): x.get('v') for x in e.findall('tag')}; nd = [n.get('ref') for n in e.findall('nd')]
    pts = np.round([N[q] for q in nd if q in N]).astype(np.int32)
    if len(pts) < 2: continue
    if t.get('highway') in WID: cv2.polylines(keep, [pts], False, 1, WID[t['highway']])
    if t.get('highway') in WID and t['highway'] != 'track': roads.append((pts, WID[t['highway']] - 2))
    closed = nd[0] == nd[-1] and len(pts) > 3
    if closed and t.get('amenity') in ('parking', 'motorcycle_parking'): cv2.fillPoly(keep, [pts], 1); cv2.polylines(keep, [pts], True, 1, 6)
    if closed and ('building' in t or t.get('leisure') == 'bleachers'): cv2.fillPoly(keep, [pts], 1); cv2.polylines(keep, [pts], True, 1, 50)
# 4'. 建物を含む広い舗装(パドック・広場): 建物に触れる灰色のかたまりの、太い本体(幅 16m 以上)は残す(細いはみ出しは残さない)
bldg = keep.copy()
nc0, cc0 = cv2.connectedComponents(grey.astype(np.uint8), connectivity=8)
ids = np.unique(cc0[(bldg > 0) & grey]); ids = ids[ids > 0]
body = cv2.morphologyEx(np.isin(cc0, ids).astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (16, 16)))
keep |= body
# 2. 退避エリア: コースの縁石の外に接する灰色(コースから 60m 以内でつながっている所)
R = np.array([[p[0] - x0, p[2] - z0] for p in d['route']])
rl = np.ones((H, W), np.uint8); cv2.polylines(rl, [np.round(R).astype(np.int32)], True, 0, 1); dist = cv2.distanceTransform(rl, cv2.DIST_L2, 5)
for b in d.get('branches', []): cv2.polylines(keep, [np.round(np.array(b['pts']) - [x0, z0]).astype(np.int32)], False, 1, int(b['w']) + 6)
zone = (grey | isc(ROAD)) & (dist < 60)
nc, cc = cv2.connectedComponents(zone.astype(np.uint8), connectivity=4)
edge = np.unique(cc[(dist > 8.5) & (dist < 10.5) & zone]); edge = edge[edge > 0]
keep |= np.isin(cc, edge).astype(np.uint8)
# 5. 手で塗った直し
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0) if ovp.exists() else np.zeros((H, W), np.uint8)
keep |= np.isin(ov, [1, 3, 4]).astype(np.uint8)
# 意味のない灰色 → いちばん近い自然の色(草地・森・砂地)。草地がまわりにあれば草地
bad = grey & (keep == 0) & (dist > 9)
natural = ~(grey | isc(ROAD)) & (dist > 9)
_, (iy, ix) = ndimage.distance_transform_edt(~natural, return_indices=True)
fill = img[iy, ix]
gr = np.array(col('grass'), np.uint8); near_grass = cv2.dilate(isc(col('grass')).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
fill[near_grass] = gr
img[bad] = fill[bad]; print('意味のない灰色 → 自然の色', int(bad.sum()), 'm2')
# 残った灰色のうち、小さなかけら(150m2 未満)も自然の色に
grey2 = np.zeros((H, W), bool)
for c in GREYS: grey2 |= isc(c)
nc, cc, st, _ = cv2.connectedComponentsWithStats(grey2.astype(np.uint8), connectivity=8)
small = np.isin(cc, np.where(st[:, cv2.CC_STAT_AREA] < 150)[0][1:]) & (np.isin(ov, [3, 4]) == False)
img[small] = fill[small]; print('灰色のかけら', int(small.sum()), 'm2')
# 道はつながっているもの: OSM の道路は途切れずに舗装で描く(コースの上・手で塗った草地は除く)
rm = np.zeros((H, W), np.uint8)
for pts, w in roads: cv2.polylines(rm, [pts], False, 1, w)
rm = (rm > 0) & (dist > 9.5) & ~isc(ROAD) & ~isc(col('parking')) & ~isc(col('building'))
img[rm] = col('paved'); print('道路をつなぐ', int(rm.sum()), 'm2')
# 手で塗った直しを最後に重ねる
for k, c in {1: ROAD, 2: col('grass'), 3: col('paved'), 4: col('parking')}.items(): img[ov == k] = c
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), img)
