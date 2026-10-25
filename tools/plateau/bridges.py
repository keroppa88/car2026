# PLATEAU の橋梁モデル(LOD2)を読み、OSM の線路の高架・首都高と重ねて種類を見分ける
# → /home/claude/plateau/bridges.pkl
import glob, json, math, pickle, sys
from lxml import etree
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union
G = '{http://www.opengis.net/gml}'; BR = '{http://www.opengis.net/citygml/bridge/2.0}'
area = json.load(open('/home/claude/car2026/tools/tokyo-center-area.json'))['lonlat']
lat0 = (min(p[1] for p in area) + max(p[1] for p in area)) / 2
lon0 = (min(p[0] for p in area) + max(p[0] for p in area)) / 2
KX, KZ = math.cos(math.radians(lat0)) * 111320.0, 110574.0
def xz(la, lo): return ((lo - lon0) * KX, -(la - lat0) * KZ)
city = json.load(open('/home/claude/car2026/map/nihonbashi-city.json'))
rail = unary_union([LineString(r['pts']).buffer(3) for r in city['rails'] if len(r['pts']) > 1])
moto = unary_union([LineString(e['pts']).buffer(e['lanes'] * 1.8 + 1) for e in city['elevated'] if len(e['pts']) > 1])
road = unary_union([LineString(r['pts']).buffer(4) for r in city['roads'] if len(r['pts']) > 1])
def ring(el):
    p = [float(v) for v in el.text.split()]
    return [(p[i], p[i + 1], p[i + 2]) for i in range(0, len(p), 3)]
out = []
for f in sorted(glob.glob(sys.argv[1] + '/*_brid_*.gml')):
    for _, b in etree.iterparse(f, tag=BR + 'Bridge', huge_tree=True):
        polys = {'wall': [], 'roof': [], 'ground': [], 'other': []}
        for kind, tag in (('wall', 'WallSurface'), ('roof', 'RoofSurface'), ('roof', 'OuterFloorSurface'), ('ground', 'GroundSurface'), ('ground', 'OuterCeilingSurface'), ('other', 'ClosureSurface')):
            for s in b.iter(BR + tag):
                for pg in s.iter(G + 'Polygon'):
                    e = pg.find(f'{G}exterior//{G}posList')
                    if e is not None: polys[kind].append((ring(e), [ring(i) for i in pg.findall(f'{G}interior//{G}posList')]))
        # BridgeConstructionElement / installation など: 壁あつかい
        for s in list(b.iter(BR + 'BridgeConstructionElement')) + list(b.iter(BR + 'BridgeInstallation')):
            for pg in s.iter(G + 'Polygon'):
                e = pg.find(f'{G}exterior//{G}posList')
                if e is not None: polys['wall'].append((ring(e), []))
        tops = [Polygon([xz(p[0], p[1]) for p in r[0]]).buffer(0) for r in polys['roof'] + polys['ground'] if len(r[0]) >= 4]
        tops = [t for t in tops if t.area > 0.01]
        if not tops: b.clear(); continue
        fp = unary_union(tops)
        a = fp.area or 1
        kind = 'rail' if fp.intersection(rail).area > 0.5 * a else 'moto' if fp.intersection(moto).area > 0.5 * a else 'road' if fp.intersection(road).area > 0.5 * a else 'other'
        hs = [p[2] for k in polys for r in polys[k] for p in r[0]]
        out.append({'file': f.split('/')[-1], 'fn': b.findtext(BR + 'function'), 'kind': kind, 'fp': fp, 'polys': polys,
                    'zmin': min(hs), 'zmax': max(hs), 'len': max(fp.bounds[2] - fp.bounds[0], fp.bounds[3] - fp.bounds[1])})
        b.clear()
from collections import Counter
print(Counter((o['kind'], o['fn']) for o in out))
for k in ('rail', 'moto'):
    L = [o for o in out if o['kind'] == k]
    print(k, len(L), '長さ計', round(sum(o['len'] for o in L)), '高さ', round(min(o['zmin'] for o in L), 1) if L else '-', round(max(o['zmax'] for o in L), 1) if L else '-')
pickle.dump(out, open('/home/claude/plateau/bridges.pkl', 'wb'))
