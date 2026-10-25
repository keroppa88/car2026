# ランドマークごとに、対応する PLATEAU の建物を選ぶ → /home/claude/plateau/selected.pkl
import json, pickle
from lxml import etree
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
LM = json.load(open('/home/claude/car2026/tools/plateau/landmarks.json'))
B = pickle.load(open('/home/claude/plateau/near.pkl', 'rb'))
want = {m['osm'] for m in LM if m['found']}
# OSM の形(way / relation の外周)
N, W, Rl = {}, {}, {}
for _, e in etree.iterparse('/home/claude/osm16/merged.osm', events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lon')), float(e.get('lat')))
    elif e.tag == 'way': W[e.get('id')] = [n.get('ref') for n in e.findall('nd')]
    elif e.tag == 'relation' and 'relation/' + e.get('id') in want:
        Rl[e.get('id')] = [m.get('ref') for m in e.findall('member') if m.get('type') == 'way' and m.get('role') in ('outer', '')]
    if e.tag in ('way', 'relation'): e.clear()
def wpoly(wid):
    pts = [N[i] for i in W.get(wid, []) if i in N]
    return Polygon(pts).buffer(0) if len(pts) >= 4 and W[wid][0] == W[wid][-1] else None
for b in B:
    b['shape'] = Polygon([(p[1], p[0]) for p in b['fp']]).buffer(0)
used, sel = set(), []
for m in LM:
    if not m['found']: continue
    kind, oid = m['osm'].split('/') if '/' in m['osm'] else ('pos', '')
    area = None
    if kind == 'way': area = wpoly(oid)
    elif kind == 'relation':
        ps = [wpoly(w) for w in Rl.get(oid, [])]; ps = [p for p in ps if p]
        area = unary_union(ps) if ps else None
    pt = Point(m['lon'], m['lat'])
    if area is not None and area.area > 0:
        got = [b for b in B if b['shape'].intersection(area).area > 0.5 * b['shape'].area or area.intersection(b['shape']).area > 0.5 * area.area]
    else:
        got = []
    got = [b for b in got if b['id'] not in used]
    if not got:   # 形で見つからなければ点で: 点を含む建物、なければ一番近い建物
        free = [b for b in B if b['id'] not in used]
        got = [b for b in free if b['shape'].contains(pt)] or [min(free, key=lambda b: b['shape'].distance(pt))]
    used |= {b['id'] for b in got}
    sel.append({'label': m['label'], 'parts': got})
    hs = [round(b['h'] or 0) for b in got]
    print(m['label'], len(got), '高さ', max(hs) if hs else '-', '面', sum(len(b['walls']) + len(b['roofs']) for b in got))
pickle.dump(sel, open('/home/claude/plateau/selected.pkl', 'wb'))
