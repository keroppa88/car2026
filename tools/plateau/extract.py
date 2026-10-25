# PLATEAU の CityGML(建物 LOD2)から、ランドマークの近くの建物だけを取り出す。
# 使い方: python3 tools/plateau/extract.py <gmlフォルダ> → /home/claude/plateau/near.pkl
import sys, glob, json, pickle, math
from lxml import etree
NS = {'bldg': 'http://www.opengis.net/citygml/building/2.0', 'gml': 'http://www.opengis.net/gml',
      'core': 'http://www.opengis.net/citygml/2.0'}
G = '{http://www.opengis.net/gml}'
LM = [x for x in json.load(open('/home/claude/car2026/tools/plateau/landmarks.json')) if x['found']]
R = 0.0025   # 約250m 以内
def near(la, lo): return any(abs(la - m['lat']) < R and abs(lo - m['lon']) < R * 1.2 for m in LM)
def ring(el):
    p = [float(v) for v in el.text.split()]
    return [(p[i], p[i + 1], p[i + 2]) for i in range(0, len(p), 3)]
def polys(el, path):
    out = []
    for ms in el.iterfind(path, NS):
        for pg in ms.iter(G + 'Polygon'):
            ext = pg.find(f'{G}exterior//{G}posList')
            if ext is None: continue
            ints = [ring(i) for i in pg.findall(f'{G}interior//{G}posList')]
            out.append((ring(ext), ints))
    return out
res, seen = [], set()
for f in sorted(glob.glob(sys.argv[1] + '/*.gml')):
    n = 0
    for _, b in etree.iterparse(f, events=('end',), tag='{http://www.opengis.net/citygml/building/2.0}Building', huge_tree=True):
        if b.getparent() is not None and b.getparent().tag.endswith('consistsOfBuildingPart'): continue
        bid = b.get(G + 'id')
        fp = polys(b, 'bldg:lod0RoofEdge') or polys(b, 'bldg:lod0FootPrint')
        if fp and bid not in seen:
            la = sum(p[0] for p in fp[0][0]) / len(fp[0][0]); lo = sum(p[1] for p in fp[0][0]) / len(fp[0][0])
            if near(la, lo):
                seen.add(bid)
                nm = b.findtext('gml:name', namespaces=NS)
                walls = polys(b, './/bldg:WallSurface//bldg:lod2MultiSurface')
                roofs = polys(b, './/bldg:RoofSurface//bldg:lod2MultiSurface') + polys(b, './/bldg:OuterCeilingSurface//bldg:lod2MultiSurface')
                inst = polys(b, './/bldg:BuildingInstallation//bldg:lod2Geometry') + polys(b, './/bldg:outerBuildingInstallation//bldg:lod2MultiSurface')
                h = b.findtext('bldg:measuredHeight', namespaces=NS)
                res.append({'id': bid, 'file': f.split('/')[-1], 'name': nm, 'fp': fp[0][0], 'walls': walls, 'roofs': roofs,
                            'inst': inst, 'h': float(h) if h else None})
                n += 1
        b.clear()
        while b.getprevious() is not None: del b.getparent()[0]
    print(f.split('/')[-1], n, flush=True)
pickle.dump(res, open('/home/claude/plateau/near.pkl', 'wb'))
print('total', len(res))
