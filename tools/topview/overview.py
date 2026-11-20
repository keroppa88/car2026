"""render_top.mjs の区画をつないだ全体図(区画の番号つき)を作る。python3 tools/topview/overview.py 出力フォルダ"""
import json, sys
from PIL import Image, ImageDraw, ImageFont
d = sys.argv[1]; t = json.load(open(f'{d}/tiles.json'))
S = 300   # 全体図での 1 区画の画素
cols = max(x['col'] for x in t['tiles']) + 1; rows = max(x['row'] for x in t['tiles']) + 1
im = Image.new('RGB', (cols * S, rows * S), (235, 235, 235)); g = ImageDraw.Draw(im)
try: font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 34)
except Exception: font = ImageFont.load_default()
for x in t['tiles']:
    im.paste(Image.open(f"{d}/{x['name']}.png").convert('RGB').resize((S, S)), (x['col'] * S, x['row'] * S))
for x in t['tiles']:
    X, Y = x['col'] * S, x['row'] * S
    g.rectangle([X, Y, X + S - 1, Y + S - 1], outline=(255, 255, 0), width=2)
    g.text((X + 8, Y + 4), x['name'].split('_')[1], fill=(255, 255, 0), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
im.save(f'{d}/overview.png'); print(im.size)
