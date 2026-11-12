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
    if t.get('highway') in WID and t['highway'] != 'track': cv2.polylines(keep, [pts], False, 1, WID[t['highway']] - 2)   # 道の幅ちょうど(はみ出しは残さない)
    if t.get('highway') in WID and t['highway'] != 'track': roads.append((pts, WID[t['highway']] - 2))
    closed = nd[0] == nd[-1] and len(pts) > 3
    if closed and t.get('amenity') in ('parking', 'motorcycle_parking'): cv2.fillPoly(keep, [pts], 1); cv2.polylines(keep, [pts], True, 1, 6)
    if closed and ('building' in t or t.get('leisure') == 'bleachers'): cv2.fillPoly(keep, [pts], 1); cv2.polylines(keep, [pts], True, 1, 30 if cv2.contourArea(pts.astype(np.float32)) > 1000 else 12)
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
roadz = np.zeros((H, W), np.uint8)
for pts, w in roads: cv2.polylines(roadz, [pts], False, 1, w + 2)
zone = (grey | isc(ROAD)) & (dist < 45) & (roadz == 0)   # 道を通ってつながった所は退避エリアにしない
nc, cc = cv2.connectedComponents(zone.astype(np.uint8), connectivity=4)
edge = np.unique(cc[(dist > 8.5) & (dist < 10.5) & zone]); edge = edge[edge > 0]
run = np.isin(cc, edge).astype(np.uint8)
# 退避エリアは、ある程度の広さのあるものだけ: 幅 6m 未満の細い帯・はみ出しと、600m2 未満のかけらは残さない
run = cv2.morphologyEx(run, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
n2, c2, st2, _ = cv2.connectedComponentsWithStats(run, connectivity=8)
run = np.isin(c2, np.where(st2[:, cv2.CC_STAT_AREA] >= 600)[0][1:]).astype(np.uint8)
keep |= run
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
# 小さなかたまり・すき間・道のわきの破片(どの色も 300m2 未満、地図全体)は、まわりでいちばん多い色に
cols_, lab_ = np.unique(img.reshape(-1, 3), axis=0, return_inverse=True); lab_ = lab_.reshape(H, W)
nearc = np.ones((H, W), bool); done = 0   # 地図全体
for it in range(3):
    ch = 0
    for c in range(len(cols_)):
        if (cols_[c] == np.array(ROAD)).all(): continue
        nc3, cc3, st3, _ = cv2.connectedComponentsWithStats((lab_ == c).astype(np.uint8), connectivity=4)
        for i in np.where(st3[1:, cv2.CC_STAT_AREA] < 300)[0] + 1:
            x, y, w, h, a = st3[i]; sl = (slice(max(0, y - 2), y + h + 2), slice(max(0, x - 2), x + w + 2))
            msk = cc3[sl] == i
            if nearc[sl][msk].mean() < 0.5 or np.isin(ov[sl][msk], [1, 2, 3, 4]).mean() > 0.5: continue
            ring = cv2.dilate(msk.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~msk
            nb = lab_[sl][ring]; nb = nb[(nb != c) & ~(cols_[nb] == np.array(ROAD)).all(1)]
            if len(nb): o = lab_[sl]; o[msk] = np.bincount(nb).argmax(); lab_[sl] = o; ch += 1
    done += ch
    if not ch: break
img = cols_[lab_].astype(np.uint8); print('コースのそばの小さなかたまり・すき間', done)
# 離れ小島の灰色(どの道・駐車場・建物・コースの縁にもつながっていない、または 600m2 未満)は、まわりの自然の色に
g3 = np.zeros((H, W), bool)
for c in GREYS: g3 |= isc(c)
anchor = (cv2.dilate(rm.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0) | isc(col('parking')) | isc(col('building')) | (dist < 11) | np.isin(ov, [1, 3, 4])
for pts in [p for p, w in roads]: pass
nc4, cc4, st4, _ = cv2.connectedComponentsWithStats(g3.astype(np.uint8), connectivity=8)
ok_ids = set(np.unique(cc4[anchor & g3]).tolist())
iso = np.zeros((H, W), bool)
for i in range(1, nc4):
    if (i not in ok_ids) or st4[i, cv2.CC_STAT_AREA] < 600: iso |= False
ids_bad = [i for i in range(1, nc4) if (i not in ok_ids) or st4[i, cv2.CC_STAT_AREA] < 600]
iso = np.isin(cc4, ids_bad) & ~np.isin(ov, [1, 3, 4])
_, (iy3, ix3) = ndimage.distance_transform_edt(g3 | isc(ROAD), return_indices=True)
nat3 = img[iy3, ix3]; img[iso] = nat3[iso]; print('離れ小島の灰色', int(iso.sum()), 'm2', len(ids_bad), 'か所')
# コースの縁石のすぐ外(コースの中心から 11m まで)は、そのすぐ外(11〜13m)と同じ色にする → 縁にしみ・点が残らない
far = dist >= 11
_, (iy2, ix2) = ndimage.distance_transform_edt(~far, return_indices=True)
edge = (dist < 11) & (ov == 0) & ~isc(ROAD)
img[edge] = img[iy2, ix2][edge]
# コース・近道のわきの細長いアスファルト(幅 7m 未満の帯・はみ出し)は草地などに(道路・駐車場・建物・手の直しは除く)
for b in d.get('branches', []): cv2.polylines(rl, [np.round(np.array(b['pts']) - [x0, z0]).astype(np.int32)], False, 0, 1)
dist2 = cv2.distanceTransform(rl, cv2.DIST_L2, 5)
pv = isc(col('paved')).astype(np.uint8)
thinp = (pv > 0) & (cv2.morphologyEx(pv, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) == 0) & (dist2 < 25) & ~rm & ~np.isin(ov, [1, 3, 4])
nat_ = ~(isc(col('paved')) | isc(col('parking')) | isc(col('building')) | isc(ROAD))
_, (iy4, ix4) = ndimage.distance_transform_edt(~nat_, return_indices=True)
img[thinp] = img[iy4, ix4][thinp]; print('コースわきの細長いアスファルト → 自然の色', int(thinp.sum()), 'm2')
# コース・近道とアスファルトの間の細長い草地(幅 5m 未満)はアスファルトに
for b in d.get('branches', []): cv2.polylines(rl, [np.round(np.array(b['pts']) - [x0, z0]).astype(np.int32)], False, 0, 1)
dist2 = cv2.distanceTransform(rl, cv2.DIST_L2, 5)
gm = isc(col('grass')).astype(np.uint8)
thin = (gm > 0) & (cv2.morphologyEx(gm, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) == 0) & (dist2 < 16) & (dist2 > 7)
greyn = np.zeros((H, W), bool)
for c in GREYS: greyn |= isc(c)
thin &= cv2.dilate(greyn.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
img[thin & (ov != 2)] = col('paved'); print('コースとアスファルトの間の細い草地 → アスファルト', int(thin.sum()), 'm2')
# 手で塗った直しを最後に重ねる
for k, c in {1: ROAD, 2: col('grass'), 3: col('paved'), 4: col('parking')}.items(): img[ov == k] = c
# 7 = 消す: まわりの自然の色(草地・砂地・森)で埋める
er = ov == 7
if er.any():
    natm = ~(isc(col('paved')) | isc(col('parking')) | isc(col('building')) | isc(ROAD)) & ~er
    _, (iy7, ix7) = ndimage.distance_transform_edt(~natm, return_indices=True); img[er] = img[iy7, ix7][er]
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), img)
