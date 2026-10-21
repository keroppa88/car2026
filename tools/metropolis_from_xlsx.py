# メトロポリスの地図をエクセル(マス目に色を塗ったもの)から読み、
# map/metropolis-grid.txt と js/tokyoeki-city.js の METRO_GRID を書き換える。
# 使い方: python3 tools/metropolis_from_xlsx.py tools/metropolis-map.xlsx
# 色: 灰色=道路 / 水色=川 / 黒=橋 / 赤=丸の内風 / オレンジ=香港・チャイナタウン / 紫=ニューヨーク / 緑=公園 / 白(塗りなし)=中小ビル街
# 範囲は塗られたセルを含む長方形(シートの使用範囲)。要るもの: openpyxl
import sys, re
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1]).active
def code(c):
    if not (c.fill and c.fill.fill_type): return '.'
    f = c.fill.fgColor
    if f.type == 'theme':
        return {(0, -0.15): '#', (4, 0.6): '~', (8, 0.4): 'P', (1, 0.0): 'B'}.get((f.theme, round(f.tint, 2)), '.')
    return {'FFFFC000': 'O', 'FFFF0000': 'R', 'FF92D050': 'G', 'FF000000': 'B'}.get(f.rgb, '.')
rows = [''.join(code(ws.cell(r, c)) for c in range(ws.min_column, ws.max_column + 1)) for r in range(ws.min_row, ws.max_row + 1)]
open('map/metropolis-grid.txt', 'w').write('\n'.join(rows) + '\n')
p = 'js/tokyoeki-city.js'; s = open(p).read()
arr = 'export const METRO_GRID = [\n' + ',\n'.join("  '" + r + "'" for r in rows) + ',\n]'
s = re.sub(r"export const METRO_GRID = \[.*?\n\]", lambda m: arr, s, count=1, flags=re.S)
open(p, 'w').write(s)
print(len(rows), 'x', len(rows[0]))
