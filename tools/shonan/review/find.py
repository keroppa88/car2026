"""湘南: おかしな道路・建物の候補を探して、真上からの確認用の地図に色で示す(まだ何も消さない)。
python3 tools/shonan/review/find.py 出力フォルダ
赤=消す候補(本当に孤立した道路・短い行き止まり)、オレンジ=つなぎ直す候補(本線と少しずれているだけの道路網)、紫=車道にはみ出す建物
結果の一覧は 出力フォルダ/candidates.json(道路は最初の点の座標で特定)
"""
import sys, json, math
from pathlib import Path
from collections import defaultdict
from shapely.geometry import LineString, Polygon, Point
from shapely.strtree import STRtree
from shapely.ops import unary_union
from PIL import Image, ImageDraw, ImageFont
ROOT = Path(__file__).resolve().parents[3]
OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
d = json.loads((ROOT / 'map/shonan-city.json').read_text()); R = d['roads']
W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
L = [LineString(r['pts']) for r in R]
tree = STRtree(L)
par = list(range(len(R)))
def f(i):
    while par[i] != i: par[i] = par[par[i]]; i = par[i]
    return i
for i, l in enumerate(L):
    for j in tree.query(l.buffer(1.5)):
        if j != i and L[j].distance(l) < 1.5: par[f(i)] = f(j)
comp = defaultdict(list)
for i in range(len(R)): comp[f(i)].append(i)
comps = sorted(comp.values(), key=lambda v: -sum(L[i].length for i in v))
main = set(comps[0]); mainL = unary_union([L[i] for i in main])
iso_red, iso_orange = [], []
for v in comps[1:]:
    g = unary_union([L[i] for i in v]); gap = g.distance(mainL); length = sum(L[i].length for i in v)
    has_trunk = any(R[i]['kind'] in ('trunk', 'trunk_link', 'primary') for i in v)
    (iso_orange if (gap < 20 and length > 60) or has_trunk else iso_red).append((v, round(gap, 1), round(length)))
from shapely.ops import nearest_points
gaps = []   # 大きな道路網が本線と少しずれている所(継ぎ目)。道路網は塗らず、ずれている所に丸を付ける
for v, g_, n_ in iso_orange:
    a, b = nearest_points(unary_union([L[i] for i in v]), mainL); gaps.append(((a.x + b.x) / 2, (a.y + b.y) / 2, g_))
cnt = defaultdict(int)
for r in R:
    for q in r['pts']: cnt[tuple(q)] += 1
stubs, stub_fix = [], []   # 行き止まり: 先の 15m 以内に別の道路があれば「つなぎ直す」、無ければ「消す」
for i, r in enumerate(R):
    if r['kind'] in ('trunk', 'trunk_link', 'primary') or i not in main or L[i].length >= 40: continue
    for q in (r['pts'][0], r['pts'][-1]):
        if cnt[tuple(q)] != 1: continue
        near = min((L[j].distance(Point(q)) for j in tree.query(Point(q).buffer(16)) if j != i), default=99)
        if near <= 1.5: continue
        (stub_fix if near < 15 or r.get('bridge') else stubs).append(i); break
car = [L[i].buffer(W(R[i]) / 2) for i in range(len(R))]; ct = STRtree(car)
bld = []
for k, b in enumerate(d['buildings']):
    g = Polygon(b['p']).buffer(0)
    a = sum(g.intersection(car[j]).area for j in ct.query(g))
    if a > 2: bld.append((k, round(a, 1), round(g.area, 1)))
key = lambda i: [round(R[i]['pts'][0][0], 2), round(R[i]['pts'][0][1], 2)]
json.dump({'gaps': gaps, 'red_isolated': [[key(i) for i in v] for v, _, _ in iso_red], 'orange_reconnect': [{'roads': [key(i) for i in v], 'gap': g, 'len': n} for v, g, n in iso_orange],
           'red_stubs': [key(i) for i in stubs], 'orange_stubs': [key(i) for i in stub_fix], 'purple_buildings': [{'i': k, 'over': a, 'area': ar} for k, a, ar in bld]}, open(OUT / 'candidates.json', 'w'), ensure_ascii=False)
print('赤(孤立)', sum(len(v) for v, _, _ in iso_red), '本 /', len(iso_red), 'かたまり  オレンジ', len(iso_orange), 'かたまり  赤(行き止まり)', len(stubs), '  紫(建物)', len(bld))
red = set(i for v, _, _ in iso_red for i in v) | set(stubs); orange = set(i for v, _, n in iso_orange if n < 500 for i in v) | set(stub_fix); purple = set(k for k, _, _ in bld)
# 地図: 塗り用の絵と同じ枠(1px=1m)
tiles = json.loads((ROOT / 'tools/shonan/paint/top/tiles.json').read_text())
shape = lambda q: Polygon(q['o'], q.get('h', [])).buffer(0)
layers = [('water', (71, 122, 118)), ('beaches', (246, 229, 186)), ('parks', (128, 176, 91)), ('woods', (109, 146, 80)), ('piers', (176, 178, 174))]
for t in tiles:
    x0, z0, Wd, Ht = t['x0'], t['z0'], t['W'], t['H']
    im = Image.new('RGB', (Wd, Ht), (205, 204, 199)); dr = ImageDraw.Draw(im)
    P = lambda pts: [(x - x0, z - z0) for x, z in pts]
    from shapely.geometry import box
    B = box(x0, z0, x0 + Wd, z0 + Ht)
    for k, col in layers:
        for q in d[k]:
            g = shape(q)
            if not g.intersects(B): continue
            for p in getattr(g, 'geoms', [g]):
                dr.polygon(P(p.exterior.coords), fill=col)
                for h in p.interiors: dr.polygon(P(h.coords), fill=(205, 204, 199))
    for i, r in enumerate(R):
        if not L[i].intersects(B.buffer(20)): continue
        col = (225, 30, 30) if i in red else (255, 140, 0) if i in orange else (60, 62, 66) if r['kind'] in ('trunk', 'primary') else (110, 112, 116)
        dr.line(P(r['pts']), fill=col, width=max(3, int(W(r))) + (4 if col[0] > 200 else 0))
    for k, b in enumerate(d['buildings']):
        xs = [p[0] for p in b['p']]; zs = [p[1] for p in b['p']]
        if max(xs) < x0 or min(xs) > x0 + Wd or max(zs) < z0 or min(zs) > z0 + Ht: continue
        if k in purple: dr.polygon(P(b['p']), fill=(170, 40, 200), outline=(90, 0, 120))
        else: dr.polygon(P(b['p']), fill=(238, 236, 230), outline=(150, 150, 150))
    for gx_, gz_, gg in gaps:
        cx, cz = gx_ - x0, gz_ - z0
        if -30 < cx < Wd + 30 and -30 < cz < Ht + 30:
            dr.ellipse([cx - 25, cz - 25, cx + 25, cz + 25], outline=(255, 140, 0), width=6); dr.text((cx + 28, cz - 6), f'gap {gg}m', fill=(200, 90, 0))
    for gx in range(int(math.ceil(x0 / 100) * 100), int(x0 + Wd), 100):   # 100m ごとの目盛り(座標)
        dr.line([(gx - x0, 0), (gx - x0, 12)], fill=(0, 0, 0), width=2); dr.text((gx - x0 + 3, 2), str(gx), fill=(0, 0, 0))
    for gz in range(int(math.ceil(z0 / 100) * 100), int(z0 + Ht), 100):
        dr.line([(0, gz - z0), (12, gz - z0)], fill=(0, 0, 0), width=2); dr.text((14, gz - z0 - 5), str(gz), fill=(0, 0, 0))
    dr.rectangle([0, Ht - 22, 560, Ht], fill=(255, 255, 255))
    dr.text((6, Ht - 18), f"{t['file'][:-4]}  red=delete  orange=reconnect  purple=building over road", fill=(0, 0, 0))
    im.save(OUT / ('review_' + t['file']))
