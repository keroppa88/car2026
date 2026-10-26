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
EXTRA = None   # --extra plateau.json: 林(woods)・砂地(sands)・建物の高さ(heights)
if '--extra' in sys.argv:
    i = sys.argv.index('--extra'); EXTRA = sys.argv[i + 1]; del sys.argv[i:i + 2]
SEA = None   # --sea 海.json: 海の多角形(経度緯度)を水面として足す(浅く・砂浜色の岸)
if '--sea' in sys.argv:
    i = sys.argv.index('--sea'); SEA = sys.argv[i + 1]; del sys.argv[i:i + 2]
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

def clip_line_margin(pts, m):
    """走れる範囲を m だけ広げた多角形の中の部分に切る"""
    if not CLIP: return [(pts, None)]
    from shapely.geometry import LineString as _CL, Polygon as _CP
    poly = _CP(AREA).buffer(m) if AREA else _CP([(X0, Z0), (X1, Z0), (X1, Z1), (X0, Z1)])
    g = _CL(pts).intersection(poly)
    out = []
    for part in (getattr(g, 'geoms', None) or [g]):
        if part.geom_type == 'LineString' and part.length > 1:
            out.append(([[round(x, 2), round(z, 2)] for x, z in part.coords], None))
    return out

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

roads, elevated, buildings, water, parks, rivers, beaches, rocks = [], [], [], [], [], [], [], []
piers = []
parking = []   # 駐車場(アスファルトの面)
_stn_rails = []   # 東京駅の構内の線路(低い建物で埋める)
oiso_grey = []
_sea_woods = []
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
def is_beach(t): return t.get('natural') in ('beach', 'sand')
def is_water(t): return t.get('natural') == 'water' or t.get('waterway') in ('riverbank',) or 'water' in t and t.get('natural') == 'water'
def is_park(t): return t.get('leisure') in ('park', 'garden') or t.get('landuse') in ('grass', 'forest', 'recreation_ground')

# 外観を指定する建物(OSM の名前): wall=壁 base=1階 top=最上階 の色、style=窓の模様の番号
LOOK = {
    '江の島展望灯台シーキャンドル': {'wall': '#f4f3ef', 'style': 4, 'shrink': 0.5, 'special': 'seacandle'},   # 細い白い塔
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
    if hw in ('motorway', 'motorway_link') and SEA:
        hw = 'trunk' if hw == 'motorway' else 'trunk_link'   # 湘南: 西湘バイパスは地上の普通の道路として走れる
    if hw in ('motorway', 'motorway_link'):
        if t.get('tunnel') in ('yes', 'building_passage'): continue
        for cp, _ in clip_line(pts, refs):
            up = t.get('bridge') in ('yes', 'viaduct') or layer_of(t) >= 1   # 高架の部分か(違えば地上の取り付け道路)
            elevated.append({'pts': cp, 'lanes': lanes_of(t, 'trunk') if hw == 'motorway' else 1, 'up': up})
        continue
    if hw == 'service' and t.get('service') == 'parking_aisle': continue   # 駐車場の中の通路は道路にしない(駐車場の面で描く)
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
        # 範囲(+ 少し)の中の部分だけ
        for cp, _ in clip_line_margin(pts, 40):
            rivers.append({'pts': cp, 'w': w})
        continue
    rw = t.get('railway')
    if LMK and rw == 'rail' and t.get('tunnel') != 'yes':
        _stn_rails.append(pts)
    if rw in ('rail', 'light_rail') and t.get('tunnel') != 'yes' and layer_of(t) >= 1 and t.get('highspeed') == 'yes':   # 高架は新幹線のみ
        for cp, _ in clip_line(pts, [r for r in refs if r in N]):
            rails.append({'pts': cp, 'h': RAIL_H.get(min(layer_of(t), 3))})
        continue
    # 在来線の高架・東京駅の構内の線路も新幹線とまとめて、線路の敷地いっぱいの1つの構築物(れんがの高架)にする
    if LMK and rw == 'rail' and t.get('tunnel') != 'yes' and not t.get('layer', '0').startswith('-'):
        _stb = lambda p: -480 < p[0] < -60 and -830 < p[1] < -300
        if t.get('location') != 'underground' and t.get('covered') != 'yes' and t.get('service') not in ('yard', 'siding', 'spur'):   # 地上・高架の線路はぜんぶ(マップの端から端まで)
            for cp, _ in clip_line(pts, [r for r in refs if r in N]):
                rails.append({'pts': cp, 'h': RAIL_H[1], 'north': 1})
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
        if t.get('name') in LOOK:
            lk_ = LOOK[t['name']]; buildings[-1]['look'] = lk_
            if lk_.get('shrink'):   # 足元の形を中心に向かって縮める(高さはそのまま)
                pp = buildings[-1]['p']; cx_ = sum(q[0] for q in pp) / len(pp); cz_ = sum(q[1] for q in pp) / len(pp); s_ = lk_['shrink']
                buildings[-1]['p'] = [[round(cx_ + (q[0] - cx_) * s_, 2), round(cz_ + (q[1] - cz_) * s_, 2)] for q in pp]
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_water(t):
        o = clip_poly(pts[:-1])
        if o: water.append({'o': o, 'h': [], 'moat': is_moat(t)})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_beach(t):
        o = clip_poly(pts[:-1])
        if o: beaches.append({'o': o, 'h': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and t.get('landuse') == 'construction':
        if not CLIP or inside(centroid(pts[:-1])): sites.append({'o': pts[:-1]})
    elif refs[0] == refs[-1] and len(pts) >= 4 and t.get('amenity') == 'parking' and t.get('parking') not in ('underground', 'multi-storey', 'rooftop'):
        o = clip_poly(pts[:-1])
        if o: parking.append({'o': o, 'h': []})
    elif refs[0] == refs[-1] and len(pts) >= 4 and is_park(t):
        o = clip_poly(pts[:-1])
        if o: parks.append({'o': o, 'h': [], 'name': t.get('name', '')})

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
        elif t.get('amenity') == 'parking' and t.get('parking') not in ('underground', 'multi-storey', 'rooftop'):
            o = clip_poly(o)
            if o: parking.append({'o': o, 'h': [h for h in (clip_poly(h) for h in hs) if h]})
        elif is_water(t) or is_park(t):
            o = clip_poly(o)
            if not o: continue
            hs = [h for h in (clip_poly(h) for h in hs) if h]
            if is_water(t): water.append({'o': o, 'h': hs, 'moat': is_moat(t)})
            else: parks.append({'o': o, 'h': hs, 'name': t.get('name', '')})

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
        hit = any(lm[j].intersection(pb).area > 0.3 * min(max(pb.area, 1e-6), lm[j].area) for j in tree.query(pb))   # 建物の3割、またはランドマークの3割と重なれば外す
        if not hit: keep.append(b)
    # 東京駅丸の内駅舎の裏(線路側)の細長い建物は外す
    _st = [Polygon(r).buffer(45) for L_ in json.load(open(LMK))['landmarks'] if L_['label'] == '東京駅 丸の内駅舎' for r in L_['fp']]
    if _st:
        keep = [b for b in keep if not any(s.intersection(Polygon(b['p']).buffer(0)).area > 0.5 * Polygon(b['p']).buffer(0).area for s in _st)]
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

# 皇居・皇居外苑・北の丸公園・東御苑の中は建物なし(日比谷公園は別)
_NOBLD_IDS = ['534754971', '675408602', '624081603']
_nb = []
from shapely.geometry import Polygon as _NP, Point as _NPt
for wid in _NOBLD_IDS:
    if wid in WAYS:
        p_ = [N[r] for r in WAYS[wid][0] if r in N]
        if len(p_) >= 4: _nb.append(_NP(p_).buffer(0))
for rel in root.findall('relation'):
    if rel.get('id') in ('5415394', '3551852', '3551876'):
        for o in assemble([m.get('ref') for m in rel.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '')]):
            if len(o) >= 4: _nb.append(_NP(o).buffer(0))
_n0 = len(buildings)
buildings[:] = [b for b in buildings if not any(p_.contains(_NPt(centroid(b['p']))) for p_ in _nb)]
print('皇居まわりの緑地の建物を外す', _n0 - len(buildings))
# 大きな緑地(日比谷公園以外)の中は、工事中の敷地も細い道路も置かない
_green = list(_nb) + [_NP(p_['o']).buffer(0) for p_ in parks if p_.get('name') != '日比谷公園' and len(p_['o']) >= 4 and _NP(p_['o']).buffer(0).area > 20000]
sites[:] = [s_ for s_ in sites if not any(g_.buffer(5).contains(_NPt(centroid(s_['o']))) for g_ in _green)]
from shapely.geometry import LineString as _NL
_gu = None
from shapely.ops import unary_union as _NU
_gu = _NU(_green).buffer(3) if _green else None
_n1 = len(roads)
if _gu is not None:
    def _in_green(r):
        if r['kind'] in ('trunk', 'primary', 'secondary', 'tertiary'): return False
        ln = _NL(r['pts'])
        return ln.length > 0 and ln.intersection(_gu).length > 0.6 * ln.length
    roads[:] = [r for r in roads if not _in_green(r)]
print('緑地の中の細い道路を外す', _n1 - len(roads))

# 工事中の敷地の中の建物は外す(外観を指定した建物は残す)
if sites:
    from shapely.geometry import Polygon as _SP, Point as _SPt
    _sp = [_SP(s_['o']).buffer(0) for s_ in sites]
    buildings[:] = [b for b in buildings if b.get('look') or not any(sp.contains(_SPt(centroid(b['p']))) for sp in _sp)]

# 湘南・大磯: 西湘バイパスと並走する134号(花水川〜大磯の入口)は外し、134号は大磯の入口で西湘バイパスにつなぐ
if SEA:
    def _near(p, q, d=3): return math.dist(p, q) < d
    _gone = [r for r in roads if r['name'] == '国道134号' and all(-8665 < x < -8150 and -265 < z < -25 for x, z in r['pts'])]
    _gn = {n for r in _gone for n in r['nodes']}
    roads[:] = [r for r in roads if r not in _gone]
    _bp = next((r for r in roads if r['name'] == '西湘バイパス' and _near(r['pts'][-1], [-8621.28, -39.28])), None)
    _r876 = next((r for r in roads if r['name'] == '国道134号' and _near(r['pts'][-1], [-8639.82, -58.31])), None)
    if _bp and _r876:
        _r876['pts'].append(list(_bp['pts'][-1])); _r876['nodes'].append(_bp['nodes'][-1])
    # 外した道路にだけつながっていた短い細い道は外す
    _n0 = len(roads)
    roads[:] = [r for r in roads if not (r['kind'] not in ('trunk', 'primary', 'secondary') and (r['nodes'][0] in _gn or r['nodes'][-1] in _gn)
                                          and sum(math.dist(a, b) for a, b in zip(r['pts'], r['pts'][1:])) < 80)]
    print('大磯: 並走する134号を外す', len(_gone), '/ つながっていた細い道', _n0 - len(roads), '/ 西湘バイパスにつないだ', bool(_bp and _r876))
    # 公園・緑地にかかる細い道は、緑地の中の部分を切る
    from shapely.geometry import Polygon as _GP, Point as _GPt
    from shapely.ops import unary_union as _GU
    _pk = _GU([_GP(p_['o']).buffer(0) for p_ in parks if len(p_['o']) >= 3]).buffer(1)
    _new, _cut = [], 0
    for r in roads:
        if r['kind'] in ('trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link') or r['bridge'] or max(x for x, _ in r['pts']) > -7300: _new.append(r); continue   # 大磯の側だけ
        ins = [_pk.contains(_GPt(p)) for p in r['pts']]
        if not any(ins): _new.append(r); continue
        _cut += 1; run = []
        for i, p in enumerate(r['pts']):
            if ins[i]:
                if len(run) >= 2: _new.append({**r, 'pts': [r['pts'][j] for j in run], 'nodes': [r['nodes'][j] for j in run]})
                run = []
            else: run.append(i)
        if len(run) >= 2: _new.append({**r, 'pts': [r['pts'][j] for j in run], 'nodes': [r['nodes'][j] for j in run]})
    _new = [r for r in _new if sum(math.dist(a, b) for a, b in zip(r['pts'], r['pts'][1:])) > 12]
    roads[:] = _new
    print('緑地にかかる細い道を切る', _cut)

# 交差点の節(2本以上の車道が共有する点)
use = {}
for r in roads:
    for n in r['nodes']:
        if n is not None: use[n] = use.get(n, 0) + 1
for r in roads:
    ends = {r['nodes'][0], r['nodes'][-1]}
    r['junctions'] = [i for i, n in enumerate(r['nodes']) if use.get(n, 0) >= 2 or (n in ends and use.get(n, 0) >= 2)]
    del r['nodes']

# 湘南: 実データの細かい乱れを整理(デフォルメ)
if SEA:
    _MAJOR = ('trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link')
    def _len(r): return sum(math.dist(a, b) for a, b in zip(r['pts'], r['pts'][1:]))
    _n0 = len(roads)
    def _junk(r):
        if r['kind'] in _MAJOR or r['bridge']: return False
        L = _len(r); j = set(r['junctions']); e0, e1 = 0 in j, len(r['pts']) - 1 in j
        if not e0 and not e1 and not j: return L < 120            # どこにもつながらない短い道
        if e0 != e1 and len(j) <= 1: return L < 30                 # 行き止まりの短い枝
        return False
    roads[:] = [r for r in roads if not _junk(r)]
    # どこともつながっていない道路(いちばん大きな道路網に入らないもの)は外す
    _par = list(range(len(roads)))
    def _f(i):
        while _par[i] != i: _par[i] = _par[_par[i]]; i = _par[i]
        return i
    _at = {}
    for i, r in enumerate(roads):
        for p in r['pts']:
            k = (round(p[0], 1), round(p[1], 1))
            if k in _at: _par[_f(i)] = _f(_at[k])
            else: _at[k] = i
    _sz = {}
    for i, r in enumerate(roads): _sz[_f(i)] = _sz.get(_f(i), 0) + _len(r)
    _main = max(_sz, key=_sz.get)
    print('道路網の大きさ', sorted((round(v) for v in _sz.values()), reverse=True)[:12])
    _n1 = len(roads)
    roads[:] = [r for i, r in enumerate(roads) if _sz[_f(i)] > 2000]   # 大きな道路網(範囲の端で分かれたものも)は残す
    print('湘南: ほかとつながらない道路を外す', _n1 - len(roads))
    # 細い道の細かい折れ曲がりをならす(交差点の点は残す)
    from shapely.geometry import LineString as _SL
    for r in roads:
        if r['kind'] in _MAJOR or r['bridge'] or len(r['pts']) < 3: continue
        keep = set(r['junctions']) | {0, len(r['pts']) - 1}
        _sout, idx = [], []
        segs = sorted(keep)
        for a_, b_ in zip(segs, segs[1:]):
            s = _SL(r['pts'][a_:b_ + 1]).simplify(2.0) if b_ - a_ >= 2 else _SL(r['pts'][a_:b_ + 1])
            cs = [list(map(lambda v: round(v, 2), c)) for c in s.coords]
            if _sout: cs = cs[1:]
            _sout += cs; idx.append(len(_sout) - 1)
        r['junctions'] = sorted({0 if 0 in r['junctions'] else -1} - {-1} | {idx[k] for k, b_ in enumerate(segs[1:]) if b_ in r['junctions']})
        r['pts'] = _sout
    print('湘南: 短い行き止まり・孤立した道を外す', _n0 - len(roads))

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
    _u = _UU([_LS(r['pts']).buffer(2.7, cap_style=2) for r in rails if len(r['pts']) > 1 and not r.get('north')]).buffer(4.0).buffer(-4.0)
    _un = [_LS(r['pts']).buffer(3.5, cap_style=2) for r in rails if len(r['pts']) > 1 and r.get('north')]
    if _un: _u = _UU([_u, _UU(_un).buffer(12, join_style=2).buffer(-12, join_style=2)]).buffer(1).buffer(-1)
    if LMK and _un:
        # 線路まわりをぴったり囲む: 線路(+ 3.5m)とホームをまとめ、線路どうしのすき間だけ埋める(外へは広げない)
        _u = _UU([_UU(_un), _UU([_LS(r['pts']).buffer(3.5, cap_style=2) for r in rails if len(r['pts']) > 1])]
                 + [_PG(q['o']).buffer(0).buffer(2) for q in platforms if len(q['o']) >= 3])
        _u = _u.buffer(8, join_style=2).buffer(-8, join_style=2).simplify(0.8)
        # 描いてもらった地図の形をそのまま使う(赤=れんが、黄緑=宙に浮いたコンクリート)
        _SH = json.load(open('tools/tokyo-rail/shapes.json'))
        _brickU = _UU([_PG(p).buffer(0) for p in _SH['brick']])
        _concU = _UU([_PG(p).buffer(0) for p in _SH['concrete']])
        _u = _brickU
        # 線路の下を線路に沿って走る道路は外す(構築物の中に入ってしまうので)
        _core = _u.buffer(-1)
        _n0 = len(roads)
        _rls = [_LS(r['pts']) for r in rails if len(r['pts']) > 1]
        def _under(r):
            if len(r['pts']) < 2: return False
            ln = _LS(r['pts']); inn = ln.intersection(_core).length
            if not (inn > 25 and inn > 0.5 * ln.length): return False
            # 線路と平行に走る道路だけ外す(線路をくぐって横切る道路は残す)
            from shapely.strtree import STRtree as _ST2
            a_, b_ = r['pts'][0], r['pts'][-1]; L_ = math.dist(a_, b_) or 1
            m_ = ln.interpolate(0.5, normalized=True)
            nr = min(_rls, key=lambda q: q.distance(m_)); d0 = nr.project(m_)
            p1, p2 = nr.interpolate(max(0, d0 - 5)), nr.interpolate(min(nr.length, d0 + 5))
            tl = math.hypot(p2.x - p1.x, p2.y - p1.y) or 1
            return abs(((b_[0] - a_[0]) * (p2.x - p1.x) + (b_[1] - a_[1]) * (p2.y - p1.y)) / (L_ * tl)) > 0.8
        roads[:] = [r for r in roads if not _under(r)]
        print('線路の下を沿って走る道路を外す', _n0 - len(roads))
        # 構築物にかかる建物は外す
        _n0 = len(buildings)
        _all = _u.union(_concU)
        # 構築物の上のホーム・屋根(白い板)は置かない
        platforms[:] = [q for q in platforms if len(q['o']) < 3 or not _PG(q['o']).buffer(0).intersects(_all)]
        canopies[:] = [c for c in canopies if len(c['o']) < 3 or not _PG(c['o']).buffer(0).intersects(_all)]
        buildings[:] = [b for b in buildings if len(b['p']) < 3 or _PG(b['p']).buffer(0).intersection(_all).area < 0.2 * max(_PG(b['p']).buffer(0).area, 1)]
        print('線路の上の建物を外す', _n0 - len(buildings))
    _u = _u.difference(_UU([_PG(rg).buffer(0).buffer(1.5) for L_ in json.load(open(LMK))['landmarks'] if '丸の内駅舎' in L_['label'] for rg in L_['fp'] if len(rg) >= 3]))
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
    from shapely.geometry import box as _VB
    _pieces = []
    if LMK:
        _cut_z = -1600
        # 高架道路(首都高)は線路の上: 線路より低い所を通る首都高の下には構築物を置かない(埋もれないように)
        if BRG:
            from shapely.geometry import Point as _BPt
            _low = []
            for B_ in json.load(open(BRG))['bridges']:
                tp = B_['top']
                for r_ in B_['fp']:
                    if len(r_) < 3: continue
                    pg = _PG(r_).buffer(0)
                    if not pg.intersects(_u): continue
                    ys = [tp[k + 1] for k in range(0, len(tp), 3) if pg.buffer(1).contains(_BPt(tp[k], tp[k + 2])) and _u.contains(_BPt(tp[k], tp[k + 2]))]
                    if ys and min(ys) < RAIL_H[1] + 4: _low.append(pg.buffer(2, join_style=2))
            if _low:
                _u = _u.difference(_UU(_low))
                print('首都高の下を外す', len(_low))
        for g_ in (_u.intersection(_VB(-1e5, _cut_z, 1e5, 1e5)), _u.intersection(_VB(-1e5, -1e5, 1e5, _cut_z))):
            pass
        _brk = _u.buffer(-9, join_style=2).buffer(9, join_style=2)   # 細い枝(引き込み線など)は落とす
        _brk = _UU([_PG(g2.exterior) for g2 in (getattr(_brk, 'geoms', None) or [_brk]) if g2.geom_type == 'Polygon' and g2.area > 4000])   # 穴・小さな切れ端なし
        # 描いてもらった地図どおり: 赤=地面に接続したれんが、黄緑=宙に浮いたコンクリート(神田の先・有楽町の南の z 60〜230 と z 540〜)
        _cz = _UU([_VB(-1e5, -1e5, 1e5, _cut_z), _VB(-1e5, 60, 1e5, 230), _VB(-1e5, 540, 1e5, 1e5)])
        _G = lambda x: getattr(x, 'geoms', None) or [x]
        # れんが: 道路・川が重なる所だけ切り抜く(そこがトンネル/橋)。残りは全部壁で囲う。切り抜いた所には天井
        _cutR = _UU([_LS(r['pts']).buffer((4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25) / 2 + 1.5, cap_style=2)
                     for r in roads if len(r['pts']) > 1 and not r['bridge']]
                    + [_PG(w['o']).buffer(0) for w in water if len(w['o']) >= 3]
                    + [_LS(rv['pts']).buffer(rv['w'] / 2) for rv in rivers if len(rv['pts']) > 1])
        _cutR = _cutR.buffer(5, join_style=2).buffer(-5, join_style=2)   # 上下線のあいだ(中央分離帯)も一緒にあける(真ん中に柱を残さない)
        _bfill = _UU([_PG(g2.exterior) for g2 in _G(_u) if g2.geom_type == 'Polygon'])   # れんがの中の穴は埋める
        _solid = _bfill.difference(_cutR)
        _ceil = _bfill.intersection(_cutR)
        _pieces = [(g2, 0) for g2 in _G(_solid)] + [(g2, 2) for g2 in _G(_ceil)] + [(g2, 1) for g2 in _G(_concU.difference(_bfill))]
    else:
        _pieces = [(g2, 0) for g2 in (_u.geoms if hasattr(_u, 'geoms') else [_u])]
    for g_, _conc in _pieces:
        if g_.geom_type != 'Polygon' or g_.area < (2 if LMK else 50): continue
        g_ = g_.simplify(0.3)
        if g_.is_empty or g_.geom_type != 'Polygon': continue
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
        if _conc == 1: viaducts[-1]['concrete'] = 1   # 空中に浮いたコンクリートの高架(壁なし・下は通れる)
        if _conc == 2: viaducts[-1]['ceil'] = 1       # れんがのトンネル・橋の天井(壁なし・下は通れる)
    print('高架(まとめた形)', len(viaducts))
    # 東京駅 八重洲側: 外堀通りに沿った長い壁(薄いグレー + 白い斜めの屋根)
    yaesu = None
    if LMK:
        best = None
        for v in viaducts:
            if v.get('concrete') or v.get('ceil'): continue
            r_ = v['rings'][0]; pg = _PG([(x, z) for x, z, _ in r_]).buffer(0)
            for i in range(len(r_)):
                a_, b_ = r_[i], r_[(i + 1) % len(r_)]; mx, mz = (a_[0] + b_[0]) / 2, (a_[1] + b_[1]) / 2
                L_ = math.dist(a_[:2], b_[:2])
                if -200 < mx < -140 and -500 < mz < -380 and (best is None or L_ > best[0]):
                    nx, nz = (b_[1] - a_[1]) / L_, -(b_[0] - a_[0]) / L_
                    if pg.contains(__import__("shapely.geometry", fromlist=["Point"]).Point(mx + nx * 2, mz + nz * 2)): nx, nz = -nx, -nz   # 外向き
                    best = (L_, a_[:2], b_[:2], [round(nx, 3), round(nz, 3)], a_[2])
        if best: yaesu = {'a': best[1], 'b': best[2], 'n': best[3], 'h': best[4]}
    print('八重洲の壁', yaesu)
    # 大手町側: れんがの東側の北の端(ロータリーの手前)を10階建てのビルに
    if LMK:
        from shapely.geometry import box as _OB
        _ob = _OB(-135, -822, -65, -768)
        for v in list(viaducts):
            if v.get('concrete') or v.get('ceil'): continue
            pg = _PG([(x, z) for x, z, _ in v['rings'][0]], [[(x, z) for x, z, _ in h_] for h_ in v['rings'][1:]]).buffer(0)
            q = pg.intersection(_ob)
            if q.is_empty or q.area < 200: continue
            for g2 in (getattr(q, 'geoms', None) or [q]):
                if g2.geom_type == 'Polygon' and g2.area > 300:
                    buildings.append({'p': [[round(x, 2), round(z, 2)] for x, z in list(g2.simplify(0.5).buffer(0.5, join_style=2).exterior.coords)[:-1]], 'h': 35.0, 'holes': [], 'grey': 1})
            print('大手町のグレーのビル', round(q.area))

# 屋根だけのもの(building=roof)は駅のホームの近くだけ残す(街中のは宙に浮いて見えるので消す)
def _near_pf(o):
    cx, cz = centroid(o)
    return any(min((p[0] - cx) ** 2 + (p[1] - cz) ** 2 for p in pf['o']) < 40 ** 2 for pf in platforms)
canopies[:] = [c for c in canopies if _near_pf(c['o'])]

# 東京駅の構内(駅舎と北の高架のあいだ): 線路のすき間を低い建物で埋める
if False and LMK and _stn_rails:   # 構内は高架の構築物で埋めるので使わない
    from shapely.geometry import LineString as _QL, Polygon as _QP, box as _QB
    from shapely.ops import unary_union as _QU
    _box = _QB(-430, -800, -90, -340)
    _band = _QU([_QL(p).buffer(3) for p in _stn_rails if len(p) > 1]).buffer(8, join_style=2).buffer(-8, join_style=2).intersection(_box)
    _cut = []
    _cut += [_QP(q['o']).buffer(1.5) for q in platforms if len(q['o']) >= 3] + [_QP(c['o']).buffer(1.5) for c in canopies if len(c['o']) >= 3]
    _cut += [_QL(r['pts']).buffer((4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25) / 2 + 3) for r in roads if len(r['pts']) > 1]
    _cut += [_QP(rg).buffer(0).buffer(2) for L_ in json.load(open(LMK))['landmarks'] if '東京駅' in L_['label'] for rg in L_['fp'] if len(rg) >= 3]
    _fill = _band.difference(_QU(_cut))
    _nl = 0
    for q in (getattr(_fill, 'geoms', None) or [_fill]):
        q = q.buffer(-1, join_style=2)
        for q2 in (getattr(q, 'geoms', None) or [q]):
            if q2.geom_type != 'Polygon' or q2.area < 80: continue
            q2 = q2.simplify(0.5)
            buildings.append({'p': [[round(x, 2), round(z, 2)] for x, z in list(q2.exterior.coords)[:-1]], 'h': 7.0, 'holes': []}); _nl += 1
    print('東京駅の構内に低い建物', _nl)

woods = []
# OSM の森・林
for wid, (refs, t_) in WAYS.items():
    if (t_.get('natural') == 'wood' or t_.get('landuse') == 'forest') and refs[0] == refs[-1]:
        o = clip_poly(ring_pts(refs)[:-1])
        if o and len(o) >= 3: woods.append({'o': o, 'h': []})
if EXTRA:
    ex = json.load(open(EXTRA))
    for w_ in ex['woods']:
        o = clip_poly([xy(p[1], p[0]) for p in w_['o']])
        if o and len(o) >= 3: woods.append({'o': o, 'h': []})
    for s_ in ex['sands']:
        o = clip_poly([xy(p[1], p[0]) for p in s_['o']])
        if o and len(o) >= 3: beaches.append({'o': o, 'h': []})
    # 建物の高さを PLATEAU の実測に合わせる(足元の中心が建物の中に入るもの)
    from shapely.geometry import Polygon as _HP, Point as _HPt
    from shapely.strtree import STRtree as _HT
    pts_ = [_HPt(*xy(p[1], p[0])) for p in ex['heights']]
    hs_ = [p[2] for p in ex['heights']]
    tr_ = _HT(pts_); n_ = 0
    for b in buildings:
        try: pb = _HP(b['p']).buffer(0)
        except Exception: continue
        got = [hs_[j] for j in tr_.query(pb) if pb.contains(pts_[j])]
        if got: b['h'] = max(3.0, max(got)); n_ += 1
    print('林', len(woods), '砂地', len(beaches), 'PLATEAU の高さにした建物', n_)

if SEA:
    for s_ in json.load(open(SEA))['sea']:
        # 海は範囲で切らない(遠くまで見える)。ただし東の端(稲村ヶ崎)より先は切る
        from shapely.geometry import Polygon as _SP2, box as _SB
        _sg = _SP2([xy(p[1], p[0]) for p in s_['o']], [[xy(p[1], p[0]) for p in h] for h in s_['h'] if len(h) >= 3]).buffer(0).intersection(_SB(-1e6, -1e6, X1, 1e6))
        for _pg in getattr(_sg, 'geoms', [_sg]):
            if _pg.geom_type != 'Polygon' or _pg.area < 100: continue
            water.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(_pg.exterior.coords)[:-1]],
                          'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in _pg.interiors], 'sea': True})
    _sj = json.load(open(SEA))
    for key_, lst_ in (('beach', beaches), ('rock', rocks)):
        for b_ in _sj.get(key_, []):
            o = [xy(p[1], p[0]) for p in b_['o']]
            if len(o) >= 3: lst_.append({'o': o, 'h': []})
    woods.extend({'o': [xy(p[1], p[0]) for p in b_['o']], 'h': []} for b_ in _sj.get('wood', []) if len(b_['o']) >= 3)   # 稲村ヶ崎の岬は林
    print('海', sum(1 for w in water if w.get('sea')))

# 首都高(OSM の板)の高さ: 高架の部分は一定、地上の部分(上り下り口)は高架とつながる端から 6% の坂で地面へ
_tris, _trh = [], []
if BRG:
    from shapely.geometry import Polygon as _TP, Point as _TPt
    from shapely.strtree import STRtree as _TT
    for B_ in json.load(open(BRG))['bridges']:
        a = B_['top']
        for k in range(0, len(a) - 8, 9):
            tri = _TP([(a[k], a[k + 2]), (a[k + 3], a[k + 5]), (a[k + 6], a[k + 8])])
            if tri.area > 0.01: _tris.append(tri); _trh.append((a[k + 1] + a[k + 4] + a[k + 7]) / 3)
    _ttree = _TT(_tris) if _tris else None
def _deck_h(x, z):
    # 本物の高架(PLATEAU)の路面のうち、この点から 8m 以内で一番高いもの
    if not _tris: return None
    pt = _TPt(x, z); best = None
    for j in _ttree.query(pt.buffer(8)):
        if _tris[j].distance(pt) < 8 and (best is None or _trh[j] > best): best = _trh[j]
    return best
_ends = {}
for e in elevated:
    for p in (e['pts'][0], e['pts'][-1]): _ends.setdefault((round(p[0]), round(p[1])), []).append(e)
def _end_h(p, self_):
    # この端のつながる先の高さ: 本物の高架(PLATEAU)か、高架の部分の板
    h = _deck_h(p[0], p[1])
    if h is not None and h > 3: return h
    for dx in (-1, 0, 1):
        for dz in (-1, 0, 1):
            for o in _ends.get((round(p[0]) + dx, round(p[1]) + dz), []):
                if o is not self_ and o.get('up'): return ELEV_H
    return 0.0
for e in elevated:
    p = e['pts']
    if e.get('up'):
        e['hs'] = [ELEV_H] * len(p)
        # 本物の高架につながる端は、その高さに合わせる
        for idx in (0, len(p) - 1):
            h = _deck_h(*p[idx])
            if h is not None and h > 3: e['hs'][idx] = round(h, 1)
        continue
    s = [0.0]
    for (ax, az), (bx, bz) in zip(p, p[1:]): s.append(s[-1] + math.hypot(bx - ax, bz - az))
    h0, h1 = _end_h(p[0], e), _end_h(p[-1], e)
    e['hs'] = [round(max(0.0, h0 - 0.06 * d, h1 - 0.06 * (s[-1] - d)), 2) for d in s]
# どこにもつながらず宙で終わる端は、そこが上り下り口なので 6% の坂で地面へ下ろす
from shapely.geometry import LineString as _EL, Point as _EP
_elines = [(e, _EL(e['pts'])) for e in elevated if len(e['pts']) > 1]
_ramped = 0
for e, ln in _elines:
    p = e['pts']
    s = [0.0]
    for (ax, az), (bx, bz) in zip(p, p[1:]): s.append(s[-1] + math.hypot(bx - ax, bz - az))
    for idx in (0, len(p) - 1):
        if e['hs'][idx] < 1: continue
        q = _EP(p[idx])
        if (_deck_h(*p[idx]) or 0) > 3: continue
        if any(o is not e and l2.distance(q) < 2 for o, l2 in _elines): continue
        e['hs'] = [round(min(h, 0.06 * (d if idx == 0 else s[-1] - d)), 2) for h, d in zip(e['hs'], s)]
        _ramped += 1
print('上り下り口(地上の取り付け部分)', sum(1 for e in elevated if not e.get('up')), '/ 宙の端を地面へ下ろす', _ramped)

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

# 湘南・大磯: 建物のデータが少ないので、細い道の両側に小さな一戸建て(1〜2階)を並べる
if SEA:
    from shapely.geometry import Polygon as _HP2, LineString as _HL, Point as _HPt2, box
    from shapely.strtree import STRtree as _HT2
    import random as _rnd
    _rnd.seed(7)
    WEST_X = xy(35.31, 139.345)[0]   # 大磯より西
    _ap2 = _HP2(AREA).buffer(-5) if AREA else None
    _roadsU = [_HL(r['pts']).buffer((4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25) / 2 + 1.5) for r in roads if len(r['pts']) > 1]
    _wat2 = [_HP2(w['o']).buffer(0) for w in water] + [_HL(rv['pts']).buffer(rv['w'] / 2 + 3) for rv in rivers if len(rv['pts']) > 1]
    _occ = [_HP2(b['p']).buffer(2) for b in buildings if len(b['p']) >= 3]
    _TR, _TW, _TO = _HT2(_roadsU), _HT2(_wat2), _HT2(_occ)
    added = []
    for r in roads:
        if r['kind'] not in ('residential', 'unclassified', 'tertiary', 'living_street', 'service'): continue
        if max(p[0] for p in r['pts']) > WEST_X: continue
        half = (4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25) / 2
        ln = _HL(r['pts'])
        d = 6.0
        while d < ln.length - 6:
            p0, p1 = ln.interpolate(d), ln.interpolate(min(ln.length, d + 1))
            tx, tz = p1.x - p0.x, p1.y - p0.y; L = math.hypot(tx, tz) or 1; tx, tz = tx / L, tz / L
            for sd in (-1, 1):
                w_, dpt = 7 + _rnd.random() * 4, 7 + _rnd.random() * 4
                off = half + 3 + dpt / 2
                cx, cz = p0.x - tz * sd * off, p0.y + tx * sd * off
                hx, hz, nx, nz = tx * w_ / 2, tz * w_ / 2, -tz * dpt / 2, tx * dpt / 2
                poly = _HP2([(cx - hx - nx, cz - hz - nz), (cx + hx - nx, cz + hz - nz), (cx + hx + nx, cz + hz + nz), (cx - hx + nx, cz - hz + nz)])
                if _ap2 is not None and not _ap2.contains(poly): continue
                if any(_roadsU[j].intersects(poly) for j in _TR.query(poly)): continue
                if any(_wat2[j].intersects(poly) for j in _TW.query(poly)): continue
                if any(_occ[j].intersects(poly) for j in _TO.query(poly)): continue
                if any(a.intersects(poly) for a in added[-40:]): continue
                added.append(poly.buffer(1.5))
                buildings.append({'p': [[round(x, 2), round(z, 2)] for x, z in list(poly.exterior.coords)[:-1]], 'h': round(3.5 + _rnd.random() * 3.5, 1), 'holes': [], 'house': 1})
            d += 11 + _rnd.random() * 3
    print('大磯に足した一戸建て', len(added))
    # 大磯: 幹線道路の海側は、堤防の手前まで砂浜
    from shapely.ops import unary_union as _OU, nearest_points as _ONP
    _seaU = _OU([_HP2(w['o'], w.get('h') or []).buffer(0) for w in water if w.get('sea')])
    _trunk = _OU([_HL(r['pts']) for r in roads if r['kind'] in ('trunk', 'trunk_link', 'primary') and len(r['pts']) > 1])
    if _ap2 is not None and not _seaU.is_empty:
        land = _HP2(AREA).buffer(0).intersection(_seaU.buffer(260)).difference(_seaU).intersection(box(-1e7, -1e7, WEST_X, 1e7))
        land = land.difference(_OU(_roadsU + _occ + [a for a in added] + _wat2))
        nb = 0
        for q in (getattr(land, 'geoms', None) or [land]):
            if q.geom_type != 'Polygon' or q.area < 200: continue
            rp = q.representative_point(); np_ = _ONP(rp, _trunk)[1]
            if np_.y > rp.y: continue          # 幹線道路より海側(南 = z が大きい)だけ
            beaches.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]], 'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors]}); nb += 1
        print('大磯の砂浜', nb)
        # 大磯港(堤防・岸壁)と町の中は砂浜にしない → グレー。そこに接する足した一戸建ては外す
        ex0, ex1 = -9150 + (X1 - 9976), -8650 + (X1 - 9976)
        _port = _OU([box(ex0, -50, ex1, 700), box(ex0 - 300, -50, ex0, 400)]).difference(box(ex0 + 190, -50, ex1, 330))
        _keep, _grey = [], []
        for b in beaches[-nb:] if nb else []:
            pg = _HP2(b['o'], b.get('h') or []).buffer(0)
            for part, lst in ((pg.difference(_port), _keep), (pg.intersection(_port), _grey)):
                for q in (getattr(part, 'geoms', None) or [part]):
                    if q.geom_type == 'Polygon' and q.area > 20: lst.append(q)
        if nb: del beaches[-nb:]
        # 港の西の付け根に残る砂浜もグレー
        _pw = box(ex0 - 10, 420, ex1, 700)
        _keep = [q for q in _keep if not (q.area < 3000 and q.intersects(box(ex0 - 300, -50, ex1, 700)))]
        for b in list(beaches):
            pg = _HP2(b['o'], b.get('h') or []).buffer(0)
            if not pg.intersects(_pw): continue
            beaches.remove(b)
            for part, lst in ((pg.difference(_pw), _keep), (pg.intersection(_pw), _grey)):
                for q in (getattr(part, 'geoms', None) or [part]):
                    if q.geom_type == 'Polygon' and q.area > 5: lst.append(q)
        for q in _keep: beaches.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]], 'h': []})
        oiso_grey = [{'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]], 'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors]} for q in _grey]
        _gU = _OU(_grey).buffer(8) if _grey else None
        if _gU is not None:
            n0 = len(buildings)
            buildings[:] = [b for b in buildings if not (b.get('house') and _HP2(b['p']).intersects(_gU))]
            print('大磯港をグレーに', len(_grey), '/ 外した一戸建て', n0 - len(buildings))

# 湘南: 幹線道路に面した建物・海沿いの建物・江の島の建物は白っぽい色を多めに(JS 側で white を見る)
if SEA:
    from shapely.geometry import Polygon as _WP, LineString as _WL
    from shapely.ops import unary_union as _WU
    _main = _WU([_WL(r['pts']).buffer(4.5 + r['lanes'] * 1.7) for r in roads if r['kind'] in ('trunk', 'primary') and len(r['pts']) > 1]).buffer(18)
    _seaz = _WU([_WP(w['o']).buffer(0) for w in water if w.get('sea')]).buffer(160)
    _eno = _WP([xy(35.2955, 139.472), xy(35.2955, 139.489), xy(35.3010, 139.489), xy(35.3010, 139.472)])
    _nw = 0
    for b in buildings:
        try: pb = _WP(b['p']).buffer(0)
        except Exception: continue
        if pb.intersects(_main) or pb.intersects(_seaz) or _eno.contains(pb.centroid): b['white'] = 1; _nw += 1
    print('白っぽくする建物', _nw)

# 上下線が別々の橋が並んでいる所は1本の橋にまとめる(JS で床を広げ、真ん中にグレーの壁)
from shapely.geometry import LineString as _BL, Point as _BP
_br = [r for r in roads if r['bridge'] and len(r['pts']) > 1]
_HANA = [-7495.0, -460.0]   # 花水川橋は上下線の2本のまま
for r in _br:
    if SEA and min(math.dist(p, _HANA) for p in r['pts']) < 250: continue
    ln = _BL(r['pts']); m = ln.interpolate(0.5, normalized=True)
    a, b = r['pts'][0], r['pts'][-1]; L = math.dist(a, b) or 1; tx, tz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
    best = None
    for o in _br:
        if o is r: continue
        lo = _BL(o['pts']); d = lo.distance(m)
        if d > 40 or d < 3: continue
        oa, ob = o['pts'][0], o['pts'][-1]; oL = math.dist(oa, ob) or 1
        if ((ob[0] - oa[0]) * tx + (ob[1] - oa[1]) * tz) / oL > -0.8: continue   # 逆向き・平行のものだけ
        if best is None or d < best[0]: best = (d, lo)
    if best:
        q = best[1].interpolate(best[1].project(m))
        side = 1 if (tz * (q.x - m.x) - tx * (q.y - m.y)) > 0 else -1   # 左(offset の正)なら 1
        r['pair'] = {'side': side, 'gap': round(best[0], 2), 'wall': 1 if id(r) < id(best[1]) else 0}
print('並んだ橋をまとめる', sum(1 for r in roads if r.get('pair')))

# 公園・林・砂地は走れる範囲(+ 少し)の中だけにする(範囲の外の灰色の地面に浮かないように)
if CLIP and AREA and SEA:   # 湘南だけ(日本橋は皇居まわりの緑地を範囲の外にも見せる)
    from shapely.geometry import Polygon as _AP
    _ap = _AP(AREA).buffer(30)
    def _clip_list(lst):
        out = []
        for it in lst:
            try: g_ = _AP(it['o'], it.get('h') or []).buffer(0).intersection(_ap)
            except Exception: continue
            for q in (getattr(g_, 'geoms', None) or [g_]):
                if q.geom_type == 'Polygon' and q.area > 20:
                    out.append({**it, 'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]],
                                'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors]})
        return out
    _n = len(parks); parks[:] = _clip_list(parks)
    # 緑地: 近い切れ端どうしをつなぎ、細かい凸凹と小さすぎる切れ端をなくす
    from shapely.ops import unary_union as _PU
    _pu = _PU([_AP(p_['o'], p_.get('h') or []).buffer(0) for p_ in parks]).buffer(6, join_style=2).buffer(-6, join_style=2).simplify(1.0)
    parks[:] = []
    for q in (getattr(_pu, 'geoms', None) or [_pu]):
        if q.geom_type == 'Polygon' and q.area > 150:
            parks.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]],
                          'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors if _AP(i).area > 60], 'name': ''})
    print('緑地をまとめる', _n, '→', len(parks))
    woods[:] = _clip_list(woods)
    # 河口: 川の先が砂浜でふさがっていたら、川の端から一番近い海まで水路を通す
    from shapely.geometry import Point as _MP, LineString as _ML
    from shapely.ops import nearest_points as _NPs
    _seap = _PU0 = None
    _sp = [_AP(w['o'], w.get('h') or []).buffer(0) for w in water if w.get('sea')]
    if _sp:
        from shapely.ops import unary_union as _MU
        _seap = _MU(_sp)
        _mouths = []
        _ends = [tuple(e_) for rv in rivers for e_ in (rv['pts'][0], rv['pts'][-1])]
        _beachU = _MU([_AP(b['o'], b.get('h') or []).buffer(0) for b in beaches + rocks]).buffer(3)
        for rv in rivers:
            for end in (rv['pts'][0], rv['pts'][-1]):
                pe = _MP(end)
                if _seap.contains(pe) or _seap.distance(pe) > 300: continue
                if sum(1 for e_ in _ends if math.dist(e_, end) < 5) > 1: continue   # 川の途中のつなぎ目
                q = _NPs(pe, _seap)[1]
                seg = _ML([end, (q.x, q.y)])
                if seg.length < 1 or seg.difference(_beachU.union(_ML(rv['pts']).buffer(rv['w']))).length > 0.3 * seg.length: continue   # 砂浜でふさがっている所だけ
                ch = _ML([end, (q.x + (q.x - pe.x) / max(1e-6, pe.distance(q)) * 15, q.y + (q.y - pe.y) / max(1e-6, pe.distance(q)) * 15)]).buffer(max(rv['w'], 30) / 2, cap_style=2)
                _mouths.append(ch)
        # 大きな川(面の水)が海の近くで終わっていたら、河口を大きく開ける
        for w in [w for w in water if not w.get('sea')]:
            pw = _AP(w['o'], w.get('h') or []).buffer(0)
            if pw.area < 20000 or pw.distance(_seap) > 150: continue
            near = pw.intersection(_seap.buffer(160))
            if near.is_empty: continue
            mouth = near.union(_seap.intersection(near.buffer(160))).convex_hull.buffer(10)
            _mouths.append(mouth)
        for ch in _mouths:
            water.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(ch.exterior.coords)[:-1]], 'h': [], 'sea': True})
        # 水と水のあいだの細い陸(すき間)は水で埋める
        _allw = _MU([_AP(w['o'], w.get('h') or []).buffer(0) for w in water] + [_ML(rv['pts']).buffer(rv['w'] / 2) for rv in rivers if len(rv['pts']) > 1])
        _sl = _allw.buffer(8, join_style=2).buffer(-8, join_style=2).difference(_allw)
        _nsl = 0
        for q in (getattr(_sl, 'geoms', None) or [_sl]):
            if q.geom_type == 'Polygon' and q.area > 15 and q.area / max(q.length, 1) < 4:
                q = q.buffer(1, join_style=2)
                water.append({'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]], 'h': [], 'sea': True}); _nsl += 1
        print('水のすき間を埋める', _nsl)
        # 砂浜・岩場から川と水路を抜く
        _wet = _MU([_AP(w['o'], w.get('h') or []).buffer(0) for w in water if not w.get('sea')]
                   + [_ML(rv['pts']).buffer(rv['w'] / 2) for rv in rivers if len(rv['pts']) > 1] + _mouths)
        def _minus(lst):
            out = []
            for it in lst:
                g_ = _AP(it['o'], it.get('h') or []).buffer(0).difference(_wet)
                for q in (getattr(g_, 'geoms', None) or [g_]):
                    if q.geom_type == 'Polygon' and q.area > 20:
                        out.append({**it, 'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]],
                                    'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors]})
            return out
        beaches[:] = _minus(beaches); rocks[:] = _minus(rocks)
        print('河口の水路', len(_mouths))
    beaches[:] = _clip_list(beaches)
    # 砂浜から突き出た細い所(堤防・突堤: 鋭角・直線のもの)は砂浜から外してグレーにする
    from shapely.ops import unary_union as _PU
    _bu = _PU([_AP(b['o'], b.get('h') or []).buffer(0) for b in beaches])
    _open = _bu.buffer(-7, join_style=2).buffer(7, join_style=1)
    _thin = _bu.difference(_open).buffer(0)
    def _pl(g, minA):
        return [{'o': [[round(x, 2), round(z, 2)] for x, z in list(q.exterior.coords)[:-1]],
                 'h': [[[round(x, 2), round(z, 2)] for x, z in list(i.coords)[:-1]] for i in q.interiors]}
                for q in getattr(g, 'geoms', [g]) if q.geom_type == 'Polygon' and q.area > minA]
    beaches[:] = _pl(_open.intersection(_bu), 20)
    piers = _pl(_thin, 15)
    print('砂浜', len(beaches), '堤防(グレー)', len(piers))
    _wn = [w for w in water if not w.get('sea')]
    water[:] = [w for w in water if w.get('sea')] + _clip_list(_wn)   # 範囲の外の池などは描かない
    print('公園・林・砂地を範囲で切る', _n, '→', len(parks))

# TOKYO: ホーム・屋根の板は使わない(駅はれんがの構築物。宙に浮く白い板になるので)
if LMK:
    print('ホーム・屋根の板を消す', len(platforms) + len(canopies)); platforms[:] = []; canopies[:] = []
# 橋(道路)の上にかぶさる建物・屋根・塔は消す(橋をふさがないように)
from shapely.geometry import Polygon as _BP2, LineString as _BL2
from shapely.ops import unary_union as _BU2
_brU = _BU2([_BL2(r['pts']).buffer((4.5 if r['lanes'] == 1 and not r['oneway'] else r['lanes'] * 3.25) / 2 + 3) for r in roads if r['bridge'] and len(r['pts']) > 1])
if not _brU.is_empty:
    def _onbr(o):
        try: return _BP2(o).buffer(0).intersection(_brU).area > 5
        except Exception: return False
    _n0 = len(buildings) + len(canopies)
    buildings[:] = [b for b in buildings if b.get('look') or not _onbr(b['p'])]
    canopies[:] = [c for c in canopies if not _onbr(c['o'])]
    print('橋の上の建物を消す', _n0 - len(buildings) - len(canopies))
# 走れる範囲の外にぽつんとある駐車場・小さな緑地は消す(どこにもつながっていないので)
if AREA:
    from shapely.geometry import Polygon as _OP
    _OA = _OP(AREA).buffer(5)
    def _outside(o):
        try: return not _OP(o).buffer(0).intersects(_OA)
        except Exception: return False
    _n0 = len(parking) + len(parks)
    parking[:] = [p_ for p_ in parking if not _outside(p_['o'])]
    parks[:] = [p_ for p_ in parks if not (_outside(p_['o']) and _OP(p_['o']).buffer(0).area < 20000)]   # 皇居などの大きな緑地は残す
    print('範囲の外の駐車場・小さな緑地を消す', _n0 - len(parking) - len(parks))
json.dump({'bounds': [X0, Z0, X1, Z1], 'elevH': ELEV_H, 'trees': trees, 'piers': piers + oiso_grey, 'parking': parking, 'rocks': rocks, 'beaches': beaches, 'woods': woods, 'palace': [[round(x, 1), round(z, 1)] for x, z in _PALP], 'sites': sites, 'lots': lots, 'sidewalk': SIDEWALK, 'viaducts': viaducts, 'yaesu': yaesu if 'yaesu' in globals() else None, 'strips': strips, 'medians': medians, 'area': AREA, 'rivers': rivers, 'rails': rails, 'platforms': platforms, 'canopies': canopies, 'roads': roads, 'elevated': elevated, 'buildings': buildings,
           'water': water, 'parks': parks}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
print('roads', len(roads), 'elevated', len(elevated), 'buildings', len(buildings), 'water', len(water), 'parks', len(parks), 'rivers', len(rivers), 'rails', len(rails), 'platforms', len(platforms), 'canopies', len(canopies),
      'bounds', [round(v) for v in (X0, Z0, X1, Z1)])
