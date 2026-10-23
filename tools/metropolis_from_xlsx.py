# メトロポリスの地図をエクセル(マス目に色を塗ったもの)から読み、map/metropolis-grid.txt に書く。
# 使い方: python3 tools/metropolis_from_xlsx.py tools/metropolis-map.xlsx
# 色 → 文字:
#   灰色=道路 #   水色=水 ~   黄色=砂地(地面) S   黄緑=木と芝生 G   薄いオレンジ=公園の中の建物 O
#   塗りなし(白)=建物 .
# 範囲は塗られたセルを含む長方形。要るもの: openpyxl
import sys
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
THEME = {(4, 0.6): '~', (0, -0.25): '#', (0, -0.15): '#', (6, 0.4): 'G', (6, 0.6): 'G', (7, 0.4): 'O'}
RGB = {'FFFFFF00': 'S'}
def code(c):
    f = c.fill
    if not (f and f.fill_type): return None
    g = f.fgColor
    return THEME.get((g.theme, round(g.tint, 2))) if g.type == 'theme' else RGB.get(g.rgb)
cells = {}
for row in ws.iter_rows():
    for c in row:
        k = code(c)
        if k: cells[(c.row, c.column)] = k
# 水に囲まれた本体の範囲(離れた飛び地の1マスは無視): 水のマスの外接長方形
water = [p for p, k in cells.items() if k == '~']
r0 = min(p[0] for p in water); r1 = max(p[0] for p in water)
c0 = min(p[1] for p in water); c1 = max(p[1] for p in water)
rows = [''.join(cells.get((r, c), '.') for c in range(c0, c1 + 1)) for r in range(r0, r1 + 1)]
open('map/metropolis-grid.txt', 'w').write('\n'.join(rows) + '\n')
print(len(rows), 'x', len(rows[0]))
# js/tokyoeki-city.js の METRO_GRID も書き換える
import re
p = 'js/tokyoeki-city.js'; s = open(p).read()
arr = 'export const METRO_GRID = [\n' + ',\n'.join("  '" + r + "'" for r in rows) + ',\n]'
s = re.sub(r"export const METRO_GRID = \[.*?\n\]", lambda m: arr, s, count=1, flags=re.S)
open(p, 'w').write(s)
