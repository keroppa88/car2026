# OpenStreetMap のデータ(.osm)から、街のデータ(JSON)を作る。日本橋ステージ用。
# 使い方: python3 tools/osm_to_city.py tools/nihonbashi.osm map/nihonbashi-city.json
# 座標: 範囲の中心が原点、x が東、z が南(北は -z)、1単位 = 1m。
# 出力:
#   roads:    [{pts, lanes, oneway, kind, bridge}]  地上の車道(トンネルは除く)
#   elevated: [{pts, lanes}]                        首都高(見た目だけ)
#   buildings:[{p:[[x,z]...], h, holes}]            建物(階数があれば 3.5m × 階)
#   water:    [{o, h}]                              水面(外周 o と穴 h)
#   parks:    [{o, h}]                              公園・芝生
#   bounds:   [x0, z0, x1, z1]
# 地図データ © OpenStreetMap contributors (ODbL)
import sys, math, json
import xml.etree.ElementTree as ET

src, out = sys.argv[1], sys.argv[2]
root = ET.parse(src).getroot()
b = root.find('bounds').attrib
lat0 = (float(b['minlat']) + float(b['maxlat'])) / 2
lon0 = (float(b['minlon']) + float(b['maxlon'])) / 2
KX = math.cos(math.radians(lat0)) * 111320.0
KZ = 110574.0
def xy(lat, lon): return [round((lon - lon0) * KX, 2), round(-(lat - lat0) * KZ, 2)]
X0, Z0 = xy(float(b['maxlat']), float(b['minlon']))
X1, Z1 = xy(float(b['minlat']), float(b['maxlon']))
N = {n.get('id'): xy(float(n.get('lat')), float(n.get('lon'))) for n in root.findall('node')}
tags = lambda e: {t.get('k'): t.get('v') for t in e.findall('tag')}
WAYS = {}
for w in root.findall('way'):
    WAYS[w.get('id')] = ([n.get('ref') for n in w.findall('nd')], tags(w))

DRIVE = {'trunk': 4, 'trunk_link': 1, 'primary': 4, 'primary_link': 1, 'secondary': 4, 'secondary_link': 1,
         'tertiary': 2, 'tertiary_link': 1, 'unclassified': 2, 'residential': 2, 'service': 1, 'living_street': 1}
def lanes_of(t, kind):
    v = (t.get('lanes') or '').split(';')[0]
    if v.isdigit(): n = int(v)
    else:
        n = DRIVE[kind]
        oneway = t.get('oneway') in ('yes', '1', 'true')
        if oneway: n = 2 if kind in ('trunk', 'primary', 'secondary') else 1   # 上下線が別の道(片側)・一方通行の細い道
    return max(1, min(n, 8))

roads, elevated, buildings, water, parks = [], [], [], [], []

def ring_pts(refs): return [N[r] for r in refs if r in N]

def assemble(way_ids):
    """マルチポリゴンの外周の線をつないで輪にする"""
    segs = [WAYS[i][0][:] for i in way_ids if i in WAYS]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for k, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]; segs.pop(k); changed = True; break
                if s[-1] == cur[-1]: cur += s[::-1][1:]; segs.pop(k); changed = True; break
                if s[-1] == cur[0]: cur = s + cur[1:]; segs.pop(k); changed = True; break
                if s[0] == cur[0]: cur = s[::-1] + cur[1:]; segs.pop(k); changed = True; break
        pts = ring_pts(cur)
        if len(pts) >= 3: rings.append(pts)
    return rings

def area(p): return abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2

def is_water(t): return t.get('natural') == 'water' or t.get('waterway') in ('riverbank',) or 'water' in t and t.get('natural') == 'water'
def is_park(t): return t.get('leisure') in ('park', 'garden') or t.get('landuse') in ('grass', 'forest', 'recreation_ground')

def height_of(t, pts):
    lv = (t.get('building:levels') or '').split(';')[0]
    if t.get('height'):
        try: return round(float(t['height'].split()[0]), 1)
        except ValueError: pass
    if lv.replace('.', '').isdigit(): return round(float(lv) * 3.5, 1)
    return None

for wid, (refs, t) in WAYS.items():
    pts = ring_pts(refs)
    if len(pts) < 2: continue
    hw = t.get('highway')
    if hw in ('motorway', 'motorway_link'):
        if t.get('tunnel') in ('yes', 'building_passage'): continue
        elevated.append({'pts': pts, 'lanes': lanes_of(t, 'trunk') if hw == 'motorway' else 1})
        continue
    if hw in DRIVE:
        if t.get('tunnel') in ('yes',) or t.get('layer', '0').startswith('-'): continue
        if t.get('area') == 'yes': continue
        oneway = t.get('oneway') in ('yes', '1', 'true') or t.get('junction') == 'roundabout'
        roads.append({'pts': pts, 'lanes': lanes_of(t, hw), 'oneway': oneway, 'kind': hw,
                      'bridge': t.get('bridge') == 'yes', 'name': t.get('name', ''), 'nodes': refs})
        continue
    if 'building' in t and refs[0] == refs[-1] and len(pts) >= 4:
        buildings.append({'p': pts[:-1], 'h': height_of(t, pts), 'holes': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_water(t):
        water.append({'o': pts[:-1], 'h': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_park(t):
        parks.append({'o': pts[:-1], 'h': []})

for rel in root.findall('relation'):
    t = tags(rel)
    if t.get('type') != 'multipolygon': continue
    outer = [m.get('ref') for m in rel.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '')]
    inner = [m.get('ref') for m in rel.findall('member') if m.get('type') == 'way' and m.get('role') == 'inner']
    outs, ins = assemble(outer), assemble(inner)
    for o in outs:
        o = o[:-1] if o[0] == o[-1] else o
        hs = [h[:-1] if h[0] == h[-1] else h for h in ins]
        if 'building' in t: buildings.append({'p': o, 'h': height_of(t, o), 'holes': hs})
        elif is_water(t): water.append({'o': o, 'h': hs})
        elif is_park(t): parks.append({'o': o, 'h': hs})

# 交差点の節(2本以上の車道が共有する点)
use = {}
for r in roads:
    for n in r['nodes']: use[n] = use.get(n, 0) + 1
for r in roads:
    ends = {r['nodes'][0], r['nodes'][-1]}
    r['junctions'] = [i for i, n in enumerate(r['nodes']) if use.get(n, 0) >= 2 or (n in ends and use.get(n, 0) >= 2)]
    del r['nodes']

json.dump({'bounds': [X0, Z0, X1, Z1], 'roads': roads, 'elevated': elevated, 'buildings': buildings,
           'water': water, 'parks': parks}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
print('roads', len(roads), 'elevated', len(elevated), 'buildings', len(buildings), 'water', len(water), 'parks', len(parks),
      'bounds', [round(v) for v in (X0, Z0, X1, Z1)])
