# 藤沢市の PLATEAU から、湘南ステージ用の追加データを作る → tools/shonan/plateau.json
#  woods : 土地利用(luse)の「山林(203)」の多角形 = 防砂林・松林
#  sands : 土地利用の「その他自然地(205)」= 砂浜など
#  heights: 建物(bldg)の足元の中心と高さ(OSM の建物の高さを本物に合わせる)
# 使い方: python3 tools/shonan/plateau_extra.py <gmlフォルダ>
import sys, glob, json
from lxml import etree
G = '{http://www.opengis.net/gml}'
NS = {'luse': 'http://www.opengis.net/citygml/landuse/2.0', 'bldg': 'http://www.opengis.net/citygml/building/2.0', 'gml': 'http://www.opengis.net/gml'}
def ring(el):
    p = [float(v) for v in el.text.split()]
    return [[round(p[i + 1], 6), round(p[i], 6)] for i in range(0, len(p), 3)]   # [経度, 緯度]
woods, sands, heights = [], [], []
for f in sorted(glob.glob(sys.argv[1] + '/*_luse_*.gml')):
    for _, e in etree.iterparse(f, tag='{http://www.opengis.net/citygml/landuse/2.0}LandUse', huge_tree=True):
        c = e.findtext('luse:class', namespaces=NS)
        if c in ('203', '205'):
            for pg in e.iter(G + 'Polygon'):
                ext = pg.find(f'{G}exterior//{G}posList')
                if ext is None: continue
                (woods if c == '203' else sands).append({'o': ring(ext), 'h': [ring(i) for i in pg.findall(f'{G}interior//{G}posList')]})
        e.clear()
for f in sorted(glob.glob(sys.argv[1] + '/*_bldg_*.gml')):
    for _, b in etree.iterparse(f, tag='{http://www.opengis.net/citygml/building/2.0}Building', huge_tree=True):
        h = b.findtext('bldg:measuredHeight', namespaces=NS)
        fp = b.find('.//bldg:lod0RoofEdge//gml:posList', NS)
        if fp is None: fp = b.find('.//bldg:lod0FootPrint//gml:posList', NS)
        if h and fp is not None and float(h) > 0:
            r = ring(fp)
            heights.append([round(sum(p[0] for p in r) / len(r), 6), round(sum(p[1] for p in r) / len(r), 6), round(float(h), 1)])
        b.clear()
        while b.getprevious() is not None: del b.getparent()[0]
json.dump({'woods': woods, 'sands': sands, 'heights': heights}, open('/home/claude/car2026/tools/shonan/plateau.json', 'w'))
print('山林', len(woods), 'その他自然地', len(sands), '建物の高さ', len(heights))
