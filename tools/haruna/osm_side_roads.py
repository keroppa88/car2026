"""榛名山: OpenStreetMap の、本線(県道33号)以外の道を map/haruna-course.json の osmRoads に入れる(コースから 150m 以内)。
走る予定はない見た目だけの道。種類ごとに幅と路面:
  tertiary 6m / unclassified 5m / residential 4.5m / service 3.5m = アスファルト、track 3m = 土の林道、path・footway・steps・pedestrian 1.5m = 山道
手で描いた横道(sideRoads)は消し、OSM の道と重なる手描きの待避所・砂の所(細長いもの)も消す。
python3 tools/haruna/osm_side_roads.py
"""
import json, math
from pathlib import Path
import numpy as np
from lxml import etree
from scipy.spatial import cKDTree
from matplotlib.path import Path as MPath
ROOT = Path(__file__).resolve().parents[2]
CJ = ROOT / 'map/haruna-course.json'; d = json.loads(CJ.read_text())
MAIN = {'691869699', '691869698', '1574747383', '691869704', '1574747384', '1574747381', '1576969852', '1576969851', '1574747382', '691869703', '405586760', '405586761', '197294653'}
WIDTH = {'tertiary': 6, 'unclassified': 5, 'residential': 4.5, 'service': 3.5, 'track': 3, 'path': 1.5, 'footway': 1.5, 'steps': 1.5, 'pedestrian': 2.5}
KIND = lambda h: 'asphalt' if h in ('tertiary', 'unclassified', 'residential', 'service') else 'dirt' if h == 'track' else 'trail'
N, W = {}, {}
for _, e in etree.iterparse(str(ROOT / 'tools/haruna/haruna.osm'), events=('end',)):
    if e.tag == 'node': N[e.get('id')] = (float(e.get('lat')), float(e.get('lon')))
    elif e.tag == 'way': W[e.get('id')] = ([n.get('ref') for n in e.findall('nd')], {x.get('k'): x.get('v') for x in e.findall('tag')}); e.clear()
lat0, lon0 = d['origin']; KX = math.cos(math.radians(lat0)) * 111320.0; KZ = 110574.0
R = np.array(d['route'])[:, [0, 2]]; tr = cKDTree(R)
roads = []
for wid, (refs, t) in W.items():
    h = t.get('highway')
    if wid in MAIN or h not in WIDTH or t.get('area') == 'yes': continue
    P = np.array([[(N[r][1] - lon0) * KX, -(N[r][0] - lat0) * KZ] for r in refs if r in N])
    if len(P) < 2: continue
    dd, _ = tr.query(P)
    if dd.min() > 150: continue
    # 150m より外の端は切る(区切った区間ごと)
    keep = dd < 170; runs = []; cur = []
    for k, ok in enumerate(keep):
        if ok: cur.append(P[k].round(2).tolist())
        elif cur: runs.append(cur); cur = []
    if cur: runs.append(cur)
    for run in runs:
        if len(run) >= 2: roads.append({'pts': run, 'w': WIDTH[h], 'kind': KIND(h), 'hw': h, 'name': t.get('name', '')})
d['osmRoads'] = roads
d.pop('sideRoads', None)
# OSM の道と重なる、手描きの細長い待避所・砂の所を消す
segs = []
for r in roads:
    if r['kind'] == 'trail': continue
    P = np.array(r['pts'])
    for a, b in zip(P, P[1:]):
        L = np.linalg.norm(b - a)
        for t in np.arange(0, L, 1.0): segs.append(a + (b - a) * t / L)
st = cKDTree(np.array(segs))
removed = 0
for key in ('aprons', 'sands'):
    out = []
    for poly in d.get(key, []):
        A = np.array(poly); c = A.mean(0); _, s, _ = np.linalg.svd(A - c); elong = s[0] / (s[1] + 1e-9)
        xs = np.linspace(A[:, 0].min(), A[:, 0].max(), 30); zs = np.linspace(A[:, 1].min(), A[:, 1].max(), 30)
        G = np.array([[x, z] for x in xs for z in zs]); G = G[MPath(A).contains_points(G)]
        on = (st.query(G)[0] < 4).mean() if len(G) else 0
        if elong > 2.5 and on > 0.35: removed += 1; continue
        out.append(poly)
    d[key] = out
CJ.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
from collections import Counter
print('道', len(roads), Counter(r['kind'] for r in roads), ' 手描きを消した', removed)
