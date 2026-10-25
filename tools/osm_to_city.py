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

# --landmarks 本物の形の建物.json を付けると、それと重なる OSM の建物を外す
LMK = None
if '--landmarks' in sys.argv:
    i = sys.argv.index('--landmarks'); LMK = sys.argv[i + 1]; del sys.argv[i:i + 2]
# --bridges 本物の形の高架.json を付けると、それと重なる首都高(見た目の板)を外す
BRG = None
if '--bridges' in sys.argv:
    i = sys.argv.index('--bridges'); BRG = sys.argv[i + 1]; del sys.argv[i:i + 2]
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
rails, platforms, canopies, sites = [], [], [], []   # sites: 工事中の敷地   # 線路の高架・ホーム・ホームの屋根(見た目)
RAIL_H = {1: 7.5, 2: 12.5, 3: 17.0}       # 高架の線路面の高さ(layer ごと)
def layer_of(t):
    try: return int(t.get('layer', '0'))
    except ValueError: return 0
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

# 皇居(OSM の way 534754971)の形
_PAL = WAYS.get('534754971')
_PALP = [N[r] for r in _PAL[0] if r in N] if _PAL else []
def in_palace(p):
    c, n = False, len(_PALP)
    for i in range(n):
        a, b = _PALP[i], _PALP[i - 1]
        if (a[1] > p[1]) != (b[1] > p[1]) and p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]: c = not c
    return c
def centroid(p): return [sum(v[0] for v in p) / len(p), sum(v[1] for v in p) / len(p)]
def area(p): return abs(sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))) / 2

def is_moat(t):   # 皇居などの濠
    n = t.get('name', '')
    return t.get('water') == 'moat' or n.endswith('濠') or n.endswith('堀') or 'お堀' in n
def is_water(t): return t.get('natural') == 'water' or t.get('waterway') in ('riverbank',) or 'water' in t and t.get('natural') == 'water'
def is_park(t): return t.get('leisure') in ('park', 'garden') or t.get('landuse') in ('grass', 'forest', 'recreation_ground')

# 外観を指定する建物(OSM の名前): wall=壁 base=1階 top=最上階 の色、style=窓の模様の番号
LOOK = {
    '日本橋野村ビル旧館': {'wall': '#5b3a2c', 'base': '#d6d5d0', 'baseH': 4.5, 'top': '#ecebe6', 'topH': 3.5, 'style': 1},
}
# OSM に高さが無い高層ビルの高さ(m)
HEIGHT_FIX = {'TOFROM YAESU TOWER': 250}
def height_of(t, pts):
    if t.get('name') in HEIGHT_FIX: return HEIGHT_FIX[t['name']]
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
    rw = t.get('railway')
    if rw in ('rail', 'light_rail') and t.get('tunnel') != 'yes' and layer_of(t) >= 1 and t.get('highspeed') == 'yes':   # 高架は新幹線のみ
        for cp, _ in clip_line(pts, [r for r in refs if r in N]):
            rails.append({'pts': cp, 'h': RAIL_H.get(min(layer_of(t), 3))})
        continue
    if rw == 'platform' and refs[0] == refs[-1] and len(pts) >= 4 and t.get('tunnel') != 'yes' and layer_of(t) >= 0:
        if not CLIP or inside(centroid(pts[:-1])): platforms.append({'o': pts[:-1], 'h': []})
        continue
    # 屋根だけのもの: ホームの屋根などは薄い屋根として描く(高さは layer から)
    if t.get('building') == 'roof' and refs[0] == refs[-1] and len(pts) >= 4 and not t.get('layer', '0').startswith('-'):
        if not CLIP or inside(centroid(pts[:-1])):
            L = layer_of(t)
            canopies.append({'o': pts[:-1], 'y': (RAIL_H[1] + 6.5) if L >= 1 else 5.0})
        continue
    # 地下の建物は作らない
    if t.get('layer', '0').startswith('-') or t.get('location') == 'underground': continue
    if 'building' in t and refs[0] == refs[-1] and len(pts) >= 4:
        if CLIP and not inside(centroid(pts[:-1])):
            continue   # 走れる範囲の外の建物は置かない(皇居の中も建物なし・森だけ)
        buildings.append({'p': pts[:-1], 'h': height_of(t, pts), 'holes': []})
        if t.get('name') in LOOK: buildings[-1]['look'] = LOOK[t['name']]
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_water(t):
        o = clip_poly(pts[:-1])
        if o: water.append({'o': o, 'h': [], 'moat': is_moat(t)})
    elif refs[0] == refs[-1] and len(pts) >= 4 and t.get('landuse') == 'construction':
        if not CLIP or inside(centroid(pts[:-1])): sites.append({'o': pts[:-1]})
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
        if t.get('landuse') == 'construction' or '再開発' in t.get('name', ''):
            if not CLIP or inside(centroid(o)): sites.append({'o': o})
        elif 'building' in t:
            if CLIP and not inside(centroid(o)): continue
            buildings.append({'p': o, 'h': height_of(t, o), 'holes': hs})
        elif is_water(t) or is_park(t):
            o = clip_poly(o)
            if not o: continue
            hs = [h for h in (clip_poly(h) for h in hs) if h]
            if is_water(t): water.append({'o': o, 'h': hs, 'moat': is_moat(t)})
            else: parks.append({'o': o, 'h': hs})

# 同じ形の建物が重なって登録されていたら1つにする(高さの分かる方を残す)
def _key(b):
    xs = [p[0] for p in b['p']]; zs = [p[1] for p in b['p']]
    return (round(sum(xs) / len(xs) / 3), round(sum(zs) / len(zs) / 3), round((max(xs) - min(xs)) / 3), round((max(zs) - min(zs)) / 3))
_best = {}
for b in buildings:
    k = _key(b)
    if k not in _best or (_best[k]['h'] is None and b['h'] is not None): _best[k] = b
print('重なった建物を1つに:', len(buildings) - len(_best))
buildings[:] = list(_best.values())

if LMK:
    from shapely.geometry import Polygon
    from shapely.strtree import STRtree
    lm = [Polygon(r).buffer(0) for L in json.load(open(LMK))['landmarks'] for r in L['fp']]
    tree = STRtree(lm)
    keep = []
    for b in buildings:
        try: pb = Polygon(b['p']).buffer(0)
        except Exception: keep.append(b); continue
        hit = any(lm[j].intersection(pb).area > 0.3 * max(pb.area, 1e-6) for j in tree.query(pb))
        if not hit: keep.append(b)
    print('ランドマークと重なる OSM の建物を外す:', len(buildings) - len(keep))
    buildings[:] = keep

if BRG:
    from shapely.geometry import Polygon, Point
    from shapely.ops import unary_union
    cover = unary_union([Polygon(r).buffer(4) for B_ in json.load(open(BRG))['bridges'] for r in B_['fp'] if len(r) >= 4])
    kept = []
    for e in elevated:
        run = []
        for i in range(len(e['pts']) - 1):
            a, b = e['pts'][i], e['pts'][i + 1]
            if cover.contains(Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)):
                if len(run) >= 2: kept.append({**e, 'pts': run})
                run = []
            else:
                if not run: run = [a]
                run.append(b)
        if len(run) >= 2: kept.append({**e, 'pts': run})
    print('本物の高架に置き換えた首都高:', len(elevated), '→ 残り', len(kept))
    elevated[:] = kept

# 工事中の敷地の中の建物は外す(外観を指定した建物は残す)
if sites:
    from shapely.geometry import Polygon as _SP, Point as _SPt
    _sp = [_SP(s_['o']).buffer(0) for s_ in sites]
    buildings[:] = [b for b in buildings if b.get('look') or not any(sp.contains(_SPt(centroid(b['p']))) for sp in _sp)]

# 交差点の節(2本以上の車道が共有する点)
use = {}
for r in roads:
    for n in r['nodes']:
        if n is not None: use[n] = use.get(n, 0) + 1
for r in roads:
    ends = {r['nodes'][0], r['nodes'][-1]}
    r['junctions'] = [i for i, n in enumerate(r['nodes']) if use.get(n, 0) >= 2 or (n in ends and use.get(n, 0) >= 2)]
    del r['nodes']

# 線路の高さ: 首都高の高さの 4/5 くらい。首都高と交わる所では線路が下をくぐる
ELEV_H = 9.5   # 本物の形が無い首都高(OSM の線から作る板)の高さ
if BRG:
    import statistics
    tops_all = []
    for B_ in json.load(open(BRG))['bridges']:
        ys = B_['top'][1::3]
        if ys: tops_all.append(statistics.median(ys))
    tops_all.sort()
    E_ = tops_all[int(len(tops_all) * 0.75)] if tops_all else 10.5
    ELEV_H = round(max(9.5, E_ * 1.15), 1)
    base = round(E_ * 0.8, 1)
    grid = {}
    for B_ in json.load(open(BRG))['bridges']:
        a = B_['top']
        for k in range(0, len(a), 3):
            grid.setdefault((int(a[k] // 20), int(a[k + 2] // 20)), []).append((a[k], a[k + 1], a[k + 2]))
    def deck_near(x, z):
        best = None
        for gx in range(int(x // 20) - 1, int(x // 20) + 2):
            for gz in range(int(z // 20) - 1, int(z // 20) + 2):
                for (px, py, pz) in grid.get((gx, gz), []):
                    if (px - x) ** 2 + (pz - z) ** 2 < 15 ** 2 and py > 3 and (best is None or py < best): best = py
        for e in elevated:
            p = e['pts']
            for i in range(len(p) - 1):
                (ax, az), (bx, bz) = p[i], p[i + 1]; dx, dz = bx - ax, bz - az; L2 = dx * dx + dz * dz or 1
                u = max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L2))
                if (x - ax - dx * u) ** 2 + (z - az - dz * u) ** 2 < 15 ** 2: best = ELEV_H if best is None else min(best, ELEV_H)
        return best
    for r in rails:   # 交わる所を取りこぼさないよう 8m ごとに点を足す
        q = [r['pts'][0]]
        for (ax, az), (bx, bz) in zip(r['pts'], r['pts'][1:]):
            n = max(1, int(math.hypot(bx - ax, bz - az) // 8))
            q += [[round(ax + (bx - ax) * k / n, 2), round(az + (bz - az) * k / n, 2)] for k in range(1, n + 1)]
        r['pts'] = q
    for r in rails:
        hs = []
        for x, z in r['pts']:
            d = deck_near(x, z)
            hs.append(base)   # 高架は一定の高さ(首都高の 4/5)を保つ
        r['h'] = base; r['hs'] = hs
    RAIL_H = {1: base, 2: base, 3: base}
    for c in canopies:
        if c['y'] > 6: c['y'] = base + 6.0
    print('線路の高さ', base, 'm / 首都高(本物の形)の高さの目安', E_, 'm / OSM の首都高の板', ELEV_H, 'm')

# 並んだ線路はまとめて1本の幅広い高架にする(東京駅の北へ1本、南へ1本)
viaducts = []
if rails:
    from shapely.geometry import LineString as _LS, Polygon as _PG
    from shapely.ops import unary_union as _UU
    import mapbox_earcut as _ec, numpy as _np
    _u = _UU([_LS(r['pts']).buffer(2.7, cap_style=2) for r in rails if len(r['pts']) > 1]).buffer(4.0).buffer(-4.0)
    _rp = [(x, z, h) for r in rails for (x, z), h in zip(r['pts'], r.get('hs') or [r['h']] * len(r['pts']))]
    _rg = {}
    for x, z, h in _rp: _rg.setdefault((int(x // 25), int(z // 25)), []).append((x, z, h))
    def _h_at(x, z):
        best = (1e18, RAIL_H[1])
        for gx in range(int(x // 25) - 1, int(x // 25) + 2):
            for gz in range(int(z // 25) - 1, int(z // 25) + 2):
                for (px, pz, h) in _rg.get((gx, gz), []):
                    d = (px - x) ** 2 + (pz - z) ** 2
                    if d < best[0]: best = (d, h)
        return best[1]
    for g_ in (_u.geoms if hasattr(_u, 'geoms') else [_u]):
        if g_.area < 50: continue
        g_ = g_.simplify(0.5)
        ext = list(g_.exterior.coords)[:-1]
        holes = [list(i.coords)[:-1] for i in g_.interiors]
        rings = [ext] + holes
        pts = [p for r_ in rings for p in r_]
        ends = _np.cumsum([len(r_) for r_ in rings]).astype(_np.uint32)
        idx = _ec.triangulate_float64(_np.array(pts, dtype=float), ends)
        hs = [round(_h_at(x, z), 1) for x, z in pts]
        top = []
        for k in idx: top += [round(pts[k][0], 1), hs[k], round(pts[k][1], 1)]
        viaducts.append({'top': top, 'rings': [[[round(x, 1), round(z, 1), round(_h_at(x, z), 1)] for x, z in r_] for r_ in rings]})
    print('高架(まとめた形)', len(viaducts))

# 屋根だけのもの(building=roof)は駅のホームの近くだけ残す(街中のは宙に浮いて見えるので消す)
def _near_pf(o):
    cx, cz = centroid(o)
    return any(min((p[0] - cx) ** 2 + (p[1] - cz) ** 2 for p in pf['o']) < 40 ** 2 for pf in platforms)
canopies[:] = [c for c in canopies if _near_pf(c['o'])]

# ホームは近くの高架の高さに合わせる
def _near_h(o):
    cx, cz = centroid(o); best = (1e9, RAIL_H[1])
    for r in rails:
        for p in r['pts']:
            d = (p[0] - cx) ** 2 + (p[1] - cz) ** 2
            if d < best[0]: best = (d, r['h'])
    return best[1] if best[0] < 60 ** 2 else 0.0
for pf in platforms: pf['y'] = _near_h(pf['o'])
# ---- 街路樹 ----
#  ・歩道が車線1本(3.25m)より広い所は、車道側に約18mおきに植える(交差点の近くは除く)
#  ・車道に挟まれた狭い所(中央分離帯など)は木なしの緑地帯(medians)
#  ・丸の内はビルのまわりの空き地の外周にも植える
#  ・木の並ぶ帯(植え込み)は芝生の色: strips = [中心x, 中心z, 向き, 長さ, 幅]
from shapely.geometry import Polygon as _P, Point as _Pt, LineString as _L
from shapely.strtree import STRtree as _T
def _road_w(r): return 4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25
_bld = [_P(b['p']).buffer(0) for b in buildings if len(b['p']) >= 3]
if LMK:
    _bld += [_P(r).buffer(0) for L_ in json.load(open(LMK))['landmarks'] for r in L_['fp'] if len(r) >= 3]
_bld = [p for p in _bld if not p.is_empty]
_asp_road = [i for i, r in enumerate(roads) if len(r['pts']) > 1]
_asp = [_L(roads[i]['pts']).buffer(_road_w(roads[i]) / 2) for i in _asp_road]
_wat = [_P(w['o']).buffer(0) for w in water] + [_L(rv['pts']).buffer(rv['w'] / 2) for rv in rivers if len(rv['pts']) > 1]
# 高架(線路・首都高・KK線)の下とそのまわり 4m には植えない
_wat += [_L(r['pts']).buffer(2.7 + 4) for r in rails if len(r['pts']) > 1] + [_P(p['o']).buffer(4) for p in platforms]
_wat += [_L(e['pts']).buffer(e['lanes'] * 1.63 + 0.8 + 4) for e in elevated if len(e['pts']) > 1]
_wat += [_P(s_['o']).buffer(2) for s_ in sites]   # 工事中の敷地には植えない
if BRG:
    _wat += [_P(r_).buffer(4) for B_ in json.load(open(BRG))['bridges'] for r_ in B_['fp'] if len(r_) >= 4]
TB, TA, TW = _T(_bld), _T(_asp), _T(_wat)
_junc = [r['pts'][i] for r in roads for i in r['junctions']]
_jgrid = {}
for x, z in _junc: _jgrid.setdefault((int(x // 20), int(z // 20)), []).append((x, z))
def _near_junc(x, z, d):
    for gx in range(int(x // 20) - 1, int(x // 20) + 2):
        for gz in range(int(z // 20) - 1, int(z // 20) + 2):
            for (jx, jz) in _jgrid.get((gx, gz), []):
                if (jx - x) ** 2 + (jz - z) ** 2 < d * d: return True
    return False
def _bld_dist(pt, lim):
    best = lim
    for j in TB.query(pt.buffer(lim)):
        best = min(best, _bld[j].distance(pt))
    return best
def _free(pt, r=0.9):
    b = pt.buffer(r)
    if any(_asp[j].intersects(b) for j in TA.query(b)): return False
    if any(_wat[j].intersects(b) for j in TW.query(b)): return False
    if any(_bld[j].intersects(b) for j in TB.query(b)): return False
    return inside([pt.x, pt.y])
trees, strips, medians = [], [], []
SPACING = 18.0
_tgrid = {}
def _try(x, z, min_side, strip=None):
    k = (int(x // 9), int(z // 9))
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            for (tx, tz) in _tgrid.get((k[0] + dx, k[1] + dz), []):
                if (tx - x) ** 2 + (tz - z) ** 2 < 8.0 ** 2: return
    pt = _Pt(x, z)
    if not _free(pt): return
    if min_side and _bld_dist(pt, min_side) < min_side: return
    _tgrid.setdefault(k, []).append((x, z)); trees.append([round(x, 1), round(z, 1)])
    if strip: strips.append([round(x, 1), round(z, 1)] + [round(v, 2) for v in strip])
def _median(ri, x0, z0, nx, nz, maxd=16.0):
    """縁石(x0,z0)から外向き(nx,nz)に、ほかの車道までの距離。無ければ None"""
    ray = _L([(x0 + nx * 0.2, z0 + nz * 0.2), (x0 + nx * maxd, z0 + nz * maxd)])
    best = None
    for j in TA.query(ray):
        if _asp_road[j] == ri: continue
        g = _asp[j].intersection(ray)
        if g.is_empty: continue
        d = _Pt(x0, z0).distance(g)
        if best is None or d < best: best = d
    return best
MAJOR = ('trunk', 'primary', 'secondary', 'tertiary')
for ri, r in enumerate(roads):
    if r['bridge']: continue
    if not (r['kind'] in MAJOR or (r['oneway'] and r['lanes'] >= 2) or r['lanes'] >= 4): continue
    half = _road_w(r) / 2
    p = r['pts']; acc = 0.0; nxt = SPACING / 2
    for (ax, az), (bx, bz) in zip(p, p[1:]):
        L = math.hypot(bx - ax, bz - az)
        if L < 0.1: continue
        tx, tz = (bx - ax) / L, (bz - az) / L
        ang = math.atan2(tx, tz)
        while nxt <= acc + L:
            s = nxt - acc; cx, cz = ax + tx * s, az + tz * s
            if not _near_junc(cx, cz, 14):
                for sd in (-1, 1):
                    nx, nz = -tz * sd, tx * sd
                    ex, ez = cx + nx * half, cz + nz * half          # 縁石
                    m = _median(ri, ex, ez, nx, nz)
                    if m is not None:
                        # 車道に挟まれた狭い所: 木は植えず、黄緑の緑地帯だけ
                        if 1.0 <= m <= 12.0:
                            mx_, mz_ = ex + nx * m / 2, ez + nz * m / 2
                            if inside([mx_, mz_]): medians.append([round(mx_, 1), round(mz_, 1), round(ang, 3), SPACING + 0.4, round(m - 0.3, 2)])
                    else:
                        # 歩道の幅(縁石から建物まで)が 4m 以上なら、縁石から 1.3m の所に植える
                        _try(ex + nx * 1.3, ez + nz * 1.3, 2.7, (ang, SPACING, 1.8))
            nxt += SPACING
        acc += L
# 丸の内: ビルのまわりの空き地の外周
MARU = (139.7580, 35.6760, 139.7668, 35.6890)   # 経度・緯度の範囲
mx0, mz0 = xy(MARU[3], MARU[0]); mx1, mz1 = xy(MARU[1], MARU[2])
for poly in _bld:
    c = poly.centroid
    if not (mx0 < c.x < mx1 and mz0 < c.y < mz1) or poly.area < 1500: continue
    ring = poly.buffer(4.0, join_style=2).exterior
    n = max(1, int(ring.length // SPACING))
    for k in range(n):
        d0 = k * ring.length / n
        q, q2 = ring.interpolate(d0), ring.interpolate(min(ring.length, d0 + 1))
        _try(q.x, q.y, 3.0, (math.atan2(q2.x - q.x, q2.y - q.y), 4.0, 2.0))
print('街路樹', len(trees), '工事中', len(sites))

# ---- 敷地(ビルのまわりの空き地): 建物の外側 7m までを敷地とみなし、歩道(車道 + 4.5m)とは重ねない ----
from shapely.ops import unary_union as _UU2
SIDEWALK = 4.5
_band = _UU2([_L(r['pts']).buffer(_road_w(r) / 2 + SIDEWALK) for r in roads if len(r['pts']) > 1 and not r['bridge']])
_lots = _UU2([p.buffer(7, join_style=2) for p in _bld if p.area > 60]).difference(_band)
_lots = _lots.difference(_UU2([_P(w['o']).buffer(0) for w in water] + [_P(p['o']).buffer(0) for p in parks]))
lots = []
for g_ in (_lots.geoms if hasattr(_lots, 'geoms') else [_lots]):
    if g_.geom_type != 'Polygon' or g_.area < 30: continue
    g_ = g_.simplify(0.6)
    if g_.is_empty or g_.geom_type != 'Polygon': continue
    lots.append({'o': [[round(x, 1), round(z, 1)] for x, z in list(g_.exterior.coords)[:-1]],
                 'h': [[[round(x, 1), round(z, 1)] for x, z in list(i.coords)[:-1]] for i in g_.interiors if i.length > 8]})
print('敷地', len(lots))

json.dump({'bounds': [X0, Z0, X1, Z1], 'elevH': ELEV_H, 'trees': trees, 'palace': [[round(x, 1), round(z, 1)] for x, z in _PALP], 'sites': sites, 'lots': lots, 'sidewalk': SIDEWALK, 'viaducts': viaducts, 'strips': strips, 'medians': medians, 'area': AREA, 'rivers': rivers, 'rails': rails, 'platforms': platforms, 'canopies': canopies, 'roads': roads, 'elevated': elevated, 'buildings': buildings,
           'water': water, 'parks': parks}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
print('roads', len(roads), 'elevated', len(elevated), 'buildings', len(buildings), 'water', len(water), 'parks', len(parks), 'rivers', len(rivers), 'rails', len(rails), 'platforms', len(platforms), 'canopies', len(canopies),
      'bounds', [round(v) for v in (X0, Z0, X1, Z1)])
