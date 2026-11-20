"""render_top.mjs の区画を 1 枚につなぐ(縮めない。区画のない所は暗い灰色)。塗ってもらう下絵の全体版。
python3 tools/topview/mosaic.py 区画フォルダ 出力.jpg [品質]
mosaic.json に、絵の左上の世界座標(x0, z0)と 1 画素の大きさ(m)を書く。上が北(-z)、右が東(+x)
"""
import json, sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
d, out = sys.argv[1:3]; q = int(sys.argv[3]) if len(sys.argv) > 3 else 92
t = json.load(open(f'{d}/tiles.json')); px = t['px']
c0 = min(x['col'] for x in t['tiles']); r0 = min(x['row'] for x in t['tiles'])
cols = max(x['col'] for x in t['tiles']) - c0 + 1; rows = max(x['row'] for x in t['tiles']) - r0 + 1
im = Image.new('RGB', (cols * px, rows * px), (40, 44, 40))
for x in t['tiles']: im.paste(Image.open(f"{d}/{x['name']}.png").convert('RGB'), ((x['col'] - c0) * px, (x['row'] - r0) * px))
im.save(out, quality=q, subsampling=0)
first = min(t['tiles'], key=lambda x: (x['row'], x['col']))
x0 = min(x['x0'] for x in t['tiles']); z0 = min(x['z0'] for x in t['tiles'])
json.dump({'course': t['course'], 'x0': x0, 'z0': z0, 'm_per_px': t['m_per_px'], 'w': im.width, 'h': im.height}, open(out.rsplit('.', 1)[0] + '.json', 'w'))
print(im.size)
