# 湘南ステージの範囲と海を作る。
#  範囲 = 国道134号(稲村ヶ崎〜大磯)に沿った帯(陸側 320m)+ 江の島。海側は海岸線まで(砂浜を含む)。
#  海   = 海岸線より南。江の島などの島は抜く。
# 使い方: python3 tools/shonan/make_area.py tools/shonan.osm → tools/shonan/area.json, tools/shonan/sea.json
import sys, json, math
from lxml import etree
from shapely.geometry import LineString, Polygon, MultiLineString, box
from shapely.ops import linemerge, unary_union
src = sys.argv[1]
N, ways = {}, {}
for _, e in etree.iterparse(src, events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lon')), float(e.get('lat')))
    elif e.tag == 'way':
        t = {x.get('k'): x.get('v') for x in e.findall('tag')}
        if t.get('natural') == 'coastline' or t.get('ref') == '134' or (t.get('highway') and t.get('bridge') == 'yes'):
            ways[e.get('id')] = ([n.get('ref') for n in e.findall('nd')], t)
        e.clear()
lons = [p[0] for p in N.values()]; lats = [p[1] for p in N.values()]
lat0 = (min(lats) + max(lats)) / 2; lon0 = (min(lons) + max(lons)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xy(p): return ((p[0] - lon0) * KX, (p[1] - lat0) * KZ)   # y は北が正
def ll(p): return [round(p[0] / KX + lon0, 6), round(p[1] / KZ + lat0, 6)]
def line(refs): return [xy(N[r]) for r in refs if r in N]
coast_open, islands, road, bridges = [], [], [], []
for wid, (refs, t) in ways.items():
    pts = line(refs)
    if len(pts) < 2: continue
    if t.get('natural') == 'coastline':
        (islands if refs[0] == refs[-1] else coast_open).append(pts)
    if t.get('ref') == '134' and t.get('tunnel') != 'yes': road.append(pts)
    elif t.get('highway') and t.get('bridge') == 'yes': bridges.append(pts)
# 海岸線: つないで一番長いもの(本土)を使う
ml = linemerge(MultiLineString(coast_open))
chains = list(ml.geoms) if hasattr(ml, 'geoms') else [ml]
# 島になる閉じた海岸線(江の島など)
for g in chains:
    if g.is_ring and g.length > 200: islands.append(list(g.coords))
# 本土の海岸線: 長い鎖を西から順に直線でつなぐ(データの切れ目を埋める)
mains = sorted([g for g in chains if not g.is_ring and g.length > 500], key=lambda g: min(p[0] for p in g.coords))
c = []
for g in mains:
    q = list(g.coords)
    if q[0][0] > q[-1][0]: q = q[::-1]
    c += q
W = (max(lons) - min(lons)) * KX / 2 + 2000
print('本土の海岸線の鎖', len(mains), [round(g.length) for g in mains])
south = -6000
sea = Polygon([(-W, c[0][1]), *c, (W, c[-1][1]), (W, south), (-W, south)]).buffer(0)
isl = unary_union([Polygon(p).buffer(0) for p in islands if len(p) >= 4])
sea = sea.difference(isl)
# 帯: 134号の線を陸側に 320m、海側に 30m(海岸線までで切る)
r134 = unary_union([LineString(p) for p in road])
band = r134.buffer(320).difference(sea.buffer(-40))      # 砂浜と波打ち際 40m は入れる
# 134号と海の間(海から 450m 以内の陸)も入れる: 道が内陸へ曲がる所(相模川の河口など)に灰色の地面が出ないように
band = unary_union([band, sea.buffer(450).difference(sea.buffer(-40)).intersection(r134.buffer(900))])
# 江の島: 島と、島へ渡る橋(島に届く橋の道路)を入れる
isl_big = max(isl.geoms, key=lambda g: g.area) if hasattr(isl, 'geoms') else isl
br = [LineString(p).buffer(12) for p in bridges if len(p) > 1 and LineString(p).distance(isl_big) < 30]
band = unary_union([band, isl_big.buffer(30), *br]).buffer(10).buffer(-10)
if hasattr(band, 'geoms'): band = max(band.geoms, key=lambda g: g.area)
# 東の端(稲村ヶ崎): 海沿いから北へ向かう134号と、その上(北)の街は切る。134号のそば 60m だけ残す
EAST_CUT, TOWN_CUT = xy((139.5252, lat0))[0], xy((139.5200, lat0))[0]   # 稲村ヶ崎の岬のすぐ東まで
band = band.difference(box(EAST_CUT, -1e6, 1e6, 1e6))
band = band.difference(box(TOWN_CUT, -1e6, 1e6, 1e6).difference(r134.buffer(60)).difference(sea.buffer(-1).buffer(80)))
if hasattr(band, 'geoms'): band = max(band.geoms, key=lambda g: g.area)
# 稲村ヶ崎〜七里ヶ浜の海側: 岬は林、岬から七里ヶ浜までは細い岩場、七里ヶ浜は砂浜(両端はなだらかに細くなる)
coast_line = LineString(c)
def coast_part(lon_a, lon_b):
    xa, xb = xy((lon_a, lat0))[0], xy((lon_b, lat0))[0]
    return coast_line.intersection(box(xa, -1e6, xb, 1e6))
seaward = band.difference(r134.buffer(9, cap_style=2))
_beach = [seaward.intersection(coast_part(139.4800, 139.5190).buffer(45))]          # 七里ヶ浜〜江の島(端は丸く細る)
_rock = [seaward.intersection(coast_part(139.5185, 139.5232).buffer(10)).difference(_beach[0])]
_wood = [seaward.intersection(box(xy((139.5228, lat0))[0], -1e6, 1e6, 1e6)).difference(_rock[0])]
def polys(gs):
    out = []
    for g in gs:
        for p in getattr(g, 'geoms', [g]):
            if p.geom_type == 'Polygon' and p.area > 30: out.append(p.simplify(1.5))
    return out
_beach, _rock, _wood = polys(_beach), polys(_rock), polys(_wood)
print('七里ヶ浜の砂浜', len(_beach), '岩場', len(_rock), '岬の林', len(_wood))
band = band.simplify(4)
json.dump({'name': '湘南(稲村ヶ崎〜大磯)', 'lonlat': [ll(p) for p in band.exterior.coords][:-1]}, open('tools/shonan/area.json', 'w'), ensure_ascii=False)
seas = sea.intersection(box(-W, south, W, max(lats) * 0 + 99999)).simplify(3)
polys = list(seas.geoms) if hasattr(seas, 'geoms') else [seas]
json.dump({'beach': [{'o': [ll(p) for p in g.exterior.coords][:-1]} for g in _beach],
           'rock': [{'o': [ll(p) for p in g.exterior.coords][:-1]} for g in _rock],
           'wood': [{'o': [ll(p) for p in g.exterior.coords][:-1]} for g in _wood], 'sea': [{'o': [ll(p) for p in g.exterior.coords][:-1], 'h': [[ll(p) for p in i.coords][:-1] for i in g.interiors]} for g in polys if g.area > 1000]},
          open('tools/shonan/sea.json', 'w'))
print('帯の面積 km2', round(band.area / 1e6, 2), '頂点', len(band.exterior.coords), '海', len(polys), '島', len(islands))
