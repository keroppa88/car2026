"""真上からの地図(topNN.png)に塗ってもらった絵(topNN_paint.png)を、そのまま地図データへ落とし込む。
塗られた色はゲームの色そのもの: 海・砂浜・林・緑地・コンクリート・地面。元の絵と違うピクセルだけを、その色の種類に置き換える。
python3 tools/shonan/paint/apply_paint.py 02 03 ...   (リポジトリ直下)
"""
import sys, json
from pathlib import Path
import numpy as np, cv2
from PIL import Image
from shapely.geometry import Polygon
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from edit_batch2 import Map

ROOT = Path(__file__).resolve().parents[3]
TOP = Path(__file__).parent / 'top'
FILE = ROOT / 'map/shonan-city.json'
PALETTE = {   # 塗る色 → 地図の種類
    (71, 122, 118): 'sea', (246, 229, 186): 'beaches', (109, 146, 80): 'woods',
    (128, 176, 91): 'parks', (181, 230, 29): 'parks', (176, 178, 174): 'piers', (162, 161, 156): 'ground',
}
ORDER = ['ground', 'sea', 'beaches', 'piers', 'parks', 'woods']

def masks(n):
    stem = n if not n.isdigit() else f'top{n}'
    T = np.array(Image.open(TOP / f'{stem}.png').convert('RGB')).astype(int)
    P = np.array(Image.open(TOP / f'{stem}_paint.png').convert('RGB')).astype(int)
    changed = np.abs(P - T).sum(2) > 30
    out = {}
    for col, kind in PALETTE.items():
        m = (changed & (np.abs(P - np.array(col)).sum(2) <= 12)).astype(np.uint8)
        out[kind] = out.get(kind, 0) | m
    return out

def to_world(mask, tile):
    m = cv2.morphologyEx(mask * 255, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    polys = []
    if hier is None: return Polygon()
    for i, c in enumerate(cs):
        if hier[0][i][3] != -1 or len(c) < 3: continue
        holes = [cs[j] for j in range(len(cs)) if hier[0][j][3] == i and len(cs[j]) >= 3]
        f = lambda c: [(tile['x0'] + (p[0][0] + .5) * tile['mPerPx'], tile['z0'] + (p[0][1] + .5) * tile['mPerPx']) for p in c]
        g = Polygon(f(c), [f(h) for h in holes]).buffer(0)
        if g.area > 4: polys.append(g)
    return unary_union(polys).buffer(0.6, join_style=2).buffer(-0.6, join_style=2).simplify(0.4)

def main():
    tiles = {t['file'][3:5]: t for t in json.loads((TOP / 'tiles.json').read_text())}
    for extra in TOP.glob('tiles_*.json'):   # 追加の絵(eno1 など)は名前で呼ぶ
        tiles.update({t['file'][:-4]: t for t in json.loads(extra.read_text())})
    d = json.loads(FILE.read_text()); M = Map(d); painted_all = []
    # 1回目は絵の全幅、2回目は受け持ちの範囲だけ(重なりで塗り方が食い違う所は受け持ちの絵を優先)
    for n, core in [(n, False) for n in sys.argv[1:]] + [(n, True) for n in sys.argv[1:]]:
        ms = masks(n)
        for kind in ORDER:
            if kind not in ms or not ms[kind].any(): continue
            g = to_world(ms[kind], tiles[n])
            # となりの絵と重なる所(150m)は半分ずつ受け持つ(後の絵で前の絵を上書きしない)
            T_ = tiles[n]; from shapely.geometry import box as _b
            if core and n.isdigit(): g = g.intersection(_b(T_['x0'] + 75, -1e5, T_['x0'] + T_['W'] * T_['mPerPx'] - 75, 1e5))
            if g.is_empty: continue
            M.put(g, kind, clear=True)   # 塗った面の上の建物・木は消す
            painted_all.append(g)
            if core: print(f'{n}: {kind} {round(g.area)} m²')
    # 道路の上に塗った所は、その道路をなくす(塗った面に半分以上入っている道路を外す)
    from shapely.geometry import LineString
    painted = unary_union(painted_all).buffer(-1.0) if painted_all else Polygon()
    n0 = len(d['roads'])
    out = []
    for r in d['roads']:
        if len(r['pts']) < 2: out.append(r); continue
        ln = LineString(r['pts'])
        if not ln.intersects(painted) or ln.intersection(painted).length < 3: out.append(r); continue
        if r.get('bridge') or r['kind'].startswith('trunk'): out.append(r); continue   # 幹線・橋は残す
        jset = {tuple(r['pts'][i]) for i in r['junctions']}
        rest = ln.difference(painted)
        for g in (getattr(rest, 'geoms', None) or [rest]):
            if g.geom_type != 'LineString' or g.length < 8: continue
            pts = [[round(x, 2), round(z, 2)] for x, z in g.coords]
            out.append({**r, 'pts': pts, 'junctions': [i for i, p in enumerate(pts) if tuple(p) in jset]})
    d['roads'] = out
    print('塗った面の下の道路を外す', n0 - len(d['roads']))
    # 同じ種類の面はつなげて1枚にする(境目の細い線が出ないように)
    from shapely.geometry import Polygon as _P
    # 幅 1.5m 未満の細い切れ端(謎の線)は消し、同じ種類の面のすき間 1m 以下は埋める
    def solid(q):
        g = _P(q['o'], q.get('h', [])).buffer(0)
        return g.buffer(-0.75, join_style=2).buffer(0.75, join_style=2)
    for k in ('beaches', 'piers', 'woods', 'parks', 'rocks', 'lots', 'parking'):
        g = unary_union([solid(q) for q in d[k]]).buffer(1.0, join_style=2).buffer(-1.0, join_style=2)
        d[k] = [{'o': [[round(x, 2), round(z, 2)] for x, z in list(p.exterior.coords)[:-1]], 'h': [[[round(x, 2), round(z, 2)] for x, z in list(h.coords)[:-1]] for h in p.interiors if _P(h).area > 4]}
                for p in (getattr(g, 'geoms', None) or [g]) if p.geom_type == 'Polygon' and p.area > 20]
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))

if __name__ == '__main__':
    main()
