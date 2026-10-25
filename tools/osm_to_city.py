# OpenStreetMap のデータ(.osm)から、街のデータ(JSON)を作る。日本橋ステージ用。
# 使い方: python3 tools/osm_to_city.py 入力.osm 出力.json [中心の緯度 中心の経度 半径m | 範囲.json]
#   中心と半径を付けると、その正方形の範囲だけを切り出す(何枚かを統合した大きな .osm 用)。
#   範囲.json ({"lonlat": [[経度,緯度]...]}) を付けると、その多角形の内側だけを使う。
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
KZ = 110574.0
AREA = None
if len(sys.argv) == 4 and sys.argv[3].endswith('.json'):
    LL = json.load(open(sys.argv[3]))['lonlat']
    lat0 = (min(p[1] for p in LL) + max(p[1] for p in LL)) / 2
    lon0 = (min(p[0] for p in LL) + max(p[0] for p in LL)) / 2
    KX = math.cos(math.radians(lat0)) * 111320.0
    AREA = [[round((p[0] - lon0) * KX, 2), round(-(p[1] - lat0) * KZ, 2)] for p in LL]
    M = 60   # 範囲の外側に少し余白(川の水面などを見せる)
    X0, Z0 = min(p[0] for p in AREA) - M, min(p[1] for p in AREA) - M
    X1, Z1 = max(p[0] for p in AREA) + M, max(p[1] for p in AREA) + M
    CLIP = True
elif len(sys.argv) >= 6:
    lat0, lon0, HALF = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
    KX = math.cos(math.radians(lat0)) * 111320.0
    X0, Z0, X1, Z1 = -HALF, -HALF, HALF, HALF
    CLIP = True
else:
    lat0 = (float(b['minlat']) + float(b['maxlat'])) / 2
    lon0 = (float(b['minlon']) + float(b['maxlon'])) / 2
    KX = math.cos(math.radians(lat0)) * 111320.0
    CLIP = False
def xy(lat, lon): return [round((lon - lon0) * KX, 2), round(-(lat - lat0) * KZ, 2)]
if not CLIP:
    X0, Z0 = xy(float(b['maxlat']), float(b['minlon']))
    X1, Z1 = xy(float(b['minlat']), float(b['maxlon']))
def in_rect(p): return X0 <= p[0] <= X1 and Z0 <= p[1] <= Z1
def in_area(p):
    if AREA is None: return True
    c, n = False, len(AREA)
    for i in range(n):
        a, b = AREA[i], AREA[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]: c = not c
    return c
def inside(p): return in_rect(p) and in_area(p)

def clip_line(pts, refs):
    """線を範囲で切る。範囲内の連続した部分ごとに (点, 節ID) を返す。境目の点は節ID None"""
    if not CLIP: return [(pts, refs)]
    out, cp, cr = [], [], []
    for i, p in enumerate(pts):
        if inside(p):
            if not cp and i > 0: cp.append(edge_pt(pts[i - 1], p)); cr.append(None)
            cp.append(p); cr.append(refs[i])
        else:
            if cp:
                cp.append(edge_pt(p, pts[i - 1])); cr.append(None)
                if len(cp) >= 2: out.append((cp, cr))
                cp, cr = [], []
    if len(cp) >= 2: out.append((cp, cr))
    return out

def edge_pt(a, b):
    """a(外)から b(内)へ向かう線が範囲の境と交わる点(二分法)"""
    lo, hi = 0.0, 1.0
    for _ in range(30):
        m = (lo + hi) / 2
        if inside([a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m]): hi = m
        else: lo = m
    return [round(a[0] + (b[0] - a[0]) * hi, 2), round(a[1] + (b[1] - a[1]) * hi, 2)]

def clip_poly(p):
    """多角形を範囲の外枠(長方形)で切る(Sutherland-Hodgman)"""
    if not CLIP: return p
    for k, lim, keep_lo in ((0, X0, False), (0, X1, True), (1, Z0, False), (1, Z1, True)):
        if not p: break
        q = []
        ins = (lambda v: v[k] <= lim) if keep_lo else (lambda v: v[k] >= lim)
        for i in range(len(p)):
            a, c = p[i - 1], p[i]
            if ins(c):
                if not ins(a): q.append(cross(a, c, k, lim))
                q.append(c)
            elif ins(a): q.append(cross(a, c, k, lim))
        p = q
    return p if len(p) >= 3 else None

def cross(a, c, k, lim):
    t = (lim - a[k]) / (c[k] - a[k])
    return [round(a[0] + (c[0] - a[0]) * t, 2), round(a[1] + (c[1] - a[1]) * t, 2)]
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

roads, elevated, buildings, water, parks, rivers = [], [], [], [], [], []
RIVER_W = {'隅田川': 160, '神田川': 24, '日本橋川': 26, '亀島川': 22}

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

def centroid(p): return [sum(v[0] for v in p) / len(p), sum(v[1] for v in p) / len(p)]
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
        for cp, _ in clip_line(pts, refs):
            elevated.append({'pts': cp, 'lanes': lanes_of(t, 'trunk') if hw == 'motorway' else 1})
        continue
    if hw in DRIVE:
        if t.get('tunnel') in ('yes',) or t.get('layer', '0').startswith('-'): continue
        if t.get('area') == 'yes': continue
        oneway = t.get('oneway') in ('yes', '1', 'true') or t.get('junction') == 'roundabout'
        for cp, cr in clip_line(pts, [r for r in refs if r in N]):
            roads.append({'pts': cp, 'lanes': lanes_of(t, hw), 'oneway': oneway, 'kind': hw,
                          'bridge': t.get('bridge') == 'yes', 'name': t.get('name', ''), 'nodes': cr})
        continue
    if t.get('waterway') in ('river', 'canal') and t.get('tunnel') != 'yes' and t.get('tunnel') != 'culvert':
        w = RIVER_W.get(t.get('name', ''), 30 if t['waterway'] == 'river' else 14)
        try: w = float(t.get('width', '').split()[0])
        except (ValueError, IndexError): pass
        if not CLIP or any(in_rect(p) for p in pts): rivers.append({'pts': pts, 'w': w})
        continue
    if 'building' in t and refs[0] == refs[-1] and len(pts) >= 4:
        if CLIP and not inside(centroid(pts[:-1])): continue   # 建物は中心が範囲内のものだけ
        buildings.append({'p': pts[:-1], 'h': height_of(t, pts), 'holes': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_water(t):
        o = clip_poly(pts[:-1])
        if o: water.append({'o': o, 'h': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_park(t):
        o = clip_poly(pts[:-1])
        if o: parks.append({'o': o, 'h': []})

for rel in root.findall('relation'):
    t = tags(rel)
    if t.get('type') != 'multipolygon': continue
    outer = [m.get('ref') for m in rel.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '')]
    inner = [m.get('ref') for m in rel.findall('member') if m.get('type') == 'way' and m.get('role') == 'inner']
    outs, ins = assemble(outer), assemble(inner)
    for o in outs:
        o = o[:-1] if o[0] == o[-1] else o
        hs = [h[:-1] if h[0] == h[-1] else h for h in ins]
        if 'building' in t:
            if CLIP and not inside(centroid(o)): continue
            buildings.append({'p': o, 'h': height_of(t, o), 'holes': hs})
        elif is_water(t) or is_park(t):
            o = clip_poly(o)
            if not o: continue
            hs = [h for h in (clip_poly(h) for h in hs) if h]
            (water if is_water(t) else parks).append({'o': o, 'h': hs})

# 交差点の節(2本以上の車道が共有する点)
use = {}
for r in roads:
    for n in r['nodes']:
        if n is not None: use[n] = use.get(n, 0) + 1
for r in roads:
    ends = {r['nodes'][0], r['nodes'][-1]}
    r['junctions'] = [i for i, n in enumerate(r['nodes']) if use.get(n, 0) >= 2 or (n in ends and use.get(n, 0) >= 2)]
    del r['nodes']

json.dump({'bounds': [X0, Z0, X1, Z1], 'area': AREA, 'rivers': rivers, 'roads': roads, 'elevated': elevated, 'buildings': buildings,
           'water': water, 'parks': parks}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
print('roads', len(roads), 'elevated', len(elevated), 'buildings', len(buildings), 'water', len(water), 'parks', len(parks), 'rivers', len(rivers),
      'bounds', [round(v) for v in (X0, Z0, X1, Z1)])
