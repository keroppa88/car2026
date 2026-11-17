# TOKYO(nihonbashi) の上から見た道路図を作る。デモで周回させる道を塗ってもらう下絵。
# 1px = M_PER_PX m。x は右、z は下。左上の世界座標を map_meta.json に残す。
import json, sys, math
from PIL import Image, ImageDraw, ImageFont
CITY = 'map/nihonbashi-city.json'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'tokyo_paint_base.png'
M_PER_PX = 1.0
d = json.load(open(CITY))
xs = [p[0] for p in d['area']]; zs = [p[1] for p in d['area']]
x0, x1, z0, z1 = min(xs) - 20, max(xs) + 20, min(zs) - 20, max(zs) + 20
W, H = int((x1 - x0) / M_PER_PX), int((z1 - z0) / M_PER_PX)
P = lambda p: ((p[0] - x0) / M_PER_PX, (p[1] - z0) / M_PER_PX)
im = Image.new('RGB', (W, H), (232, 228, 218)); g = ImageDraw.Draw(im)
g.polygon([P(p) for p in d['area']], fill=(246, 244, 238))
for k, col in (('parks', (196, 222, 176)), ('woods', (170, 206, 150)), ('water', (150, 196, 232))):
    for a in d[k]: g.polygon([P(p) for p in a['o']], fill=col)
for r in d['rivers']: g.line([P(p) for p in r['pts']], fill=(150, 196, 232), width=max(1, int(r['w'] / M_PER_PX)))
for b in d['buildings']: g.polygon([P(p) for p in b['p']], fill=(214, 208, 200), outline=(190, 184, 176))
for r in d['roads']:
    if r['kind'] in ('footway', 'path', 'track', 'steps', 'pedestrian'): continue
    w = max(2, int((r.get('lanes') or 1) * 3.2 / M_PER_PX) + (2 if not r.get('oneway') else 0))
    g.line([P(p) for p in r['pts']], fill=(110, 110, 116) if r['bridge'] else (90, 90, 96), width=w, joint='curve')
try: font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 60)
except Exception: font = ImageFont.load_default()
# スタート(コレド日本橋前)を赤い矢印で
sx, sz, hd = 398.4, -685.4, -2.035
cx, cy = P((sx, sz)); dx, dy = math.sin(hd), math.cos(hd)
g.line([(cx - dx * 40, cy - dy * 40), (cx + dx * 60, cy + dy * 60)], fill=(220, 0, 0), width=12)
g.ellipse([cx - 22, cy - 22, cx + 22, cy + 22], outline=(220, 0, 0), width=8)
g.text((cx + 40, cy - 90), 'スタート', fill=(220, 0, 0), font=font)
im.save(OUT, optimize=True)
json.dump({'x0': x0, 'z0': z0, 'm_per_px': M_PER_PX, 'w': W, 'h': H}, open(OUT.rsplit('.', 1)[0] + '_meta.json', 'w'))
print(W, H)
