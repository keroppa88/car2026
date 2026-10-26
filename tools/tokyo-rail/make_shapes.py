# 描いてもらった地図(赤=れんがの構築物、黄緑=宙に浮いたコンクリートの高架)から形を作る
#  → tools/tokyo-rail/shapes.json {brick:[[x,z]...]..., concrete:[...]}(日本橋マップの座標)
import json, numpy as np, cv2
from PIL import Image
from shapely.geometry import Polygon
from shapely.ops import unary_union
# 画像の軸の枠(ピクセル) ↔ 地図の座標
MAPS = [('tools/tokyo-rail/north.png', (72, 1304, -650, 450), (84, 2491, -2450, -300)),
        ('tools/tokyo-rail/south.png', (62, 1304, -1250, -100), (61, 2113, -400, 1500))]
out = {'brick': [], 'concrete': []}
for f, (px0, px1, x0, x1), (py0, py1, z0, z1) in MAPS:
    a = np.array(Image.open(f).convert('RGB')).astype(int); r, g, b = a[..., 0], a[..., 1], a[..., 2]
    for kind, m in (('brick', (r > 200) & (g < 70) & (b < 70)), ('concrete', (g > 180) & (r > 120) & (r < 230) & (b < 90))):
        m = m.astype(np.uint8) * 255
        m[:py0 + 2] = 0; m[py1 - 2:] = 0; m[:, :px0 + 2] = 0; m[:, px1 - 2:] = 0
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))
        m = cv2.morphologyEx(cv2.dilate(m, np.ones((3, 3), np.uint8)), cv2.MORPH_CLOSE, k)
        cs, hier = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cs:
            if cv2.contourArea(c) < 400: continue
            pts = [(x0 + (p[0][0] - px0) / (px1 - px0) * (x1 - x0), z0 + (p[0][1] - py0) / (py1 - py0) * (z1 - z0)) for p in c]
            out[kind].append(Polygon(pts).buffer(0))
res = {}
for kind in out:
    u = unary_union(out[kind]).simplify(1.5)
    res[kind] = [[[round(x, 1), round(z, 1)] for x, z in list(g.exterior.coords)[:-1]] for g in (getattr(u, 'geoms', None) or [u]) if g.area > 300]
# 重なりはれんがを優先
bu = unary_union([Polygon(p) for p in res['brick']])
cu = unary_union([Polygon(p) for p in res['concrete']]).difference(bu)
res['concrete'] = [[[round(x, 1), round(z, 1)] for x, z in list(g.exterior.coords)[:-1]] for g in (getattr(cu, 'geoms', None) or [cu]) if g.geom_type == 'Polygon' and g.area > 300]
json.dump(res, open('tools/tokyo-rail/shapes.json', 'w'))
print({k: len(v) for k, v in res.items()})
