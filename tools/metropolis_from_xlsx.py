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

# ---- 建物の敷地(太い罫線の区分け) ----
# 白のマスを隣へ広げ、中太線・太線の罫線は越えない。囲まれたまとまりが1つの敷地(1棟)。
# 太い罫線に1辺でも接するまとまりを「区分けした敷地」として出す(太い罫線の無い区画は自動で分ける)。
THICK = {'medium', 'thick', 'double', 'mediumDashed', 'mediumDashDot', 'mediumDashDotDot', 'slantDashDot'}
def thick(r, c, side):
    b = getattr(ws.cell(r, c).border, side)
    return bool(b and b.style in THICK)
def wall(r, c, dr, dc):          # (r,c) と (r+dr,c+dc) の間に太い罫線があるか
    side = {(0, 1): ('right', 'left'), (0, -1): ('left', 'right'), (1, 0): ('bottom', 'top'), (-1, 0): ('top', 'bottom')}[(dr, dc)]
    return thick(r, c, side[0]) or thick(r + dr, c + dc, side[1])
H, W = len(rows), len(rows[0])
seen = set(); lots = []
for r in range(H):
    for c in range(W):
        if rows[r][c] != '.' or (r, c) in seen: continue
        stack = [(r, c)]; seen.add((r, c)); cells = []; touched = False
        while stack:
            a, b = stack.pop(); cells.append((a, b))
            for dr, dc in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                if wall(r0 + a, c0 + b, dr, dc): touched = True; continue
                na, nb = a + dr, b + dc
                if 0 <= na < H and 0 <= nb < W and rows[na][nb] == '.' and (na, nb) not in seen:
                    seen.add((na, nb)); stack.append((na, nb))
        # 太い罫線に接するまとまりは、外周だけを囲んだものも含めて1棟にする
        if touched: lots.append(sorted(cells))
print(len(lots), 'lots', [len(l) for l in lots])
# js/tokyoeki-city.js の METRO_GRID も書き換える
import re
p = 'js/tokyoeki-city.js'; s = open(p).read()
arr = 'export const METRO_GRID = [\n' + ',\n'.join("  '" + r + "'" for r in rows) + ',\n]'
s = re.sub(r"export const METRO_GRID = \[.*?\n\]", lambda m: arr, s, count=1, flags=re.S)
lotsjs = 'export const METRO_LOTS = [\n' + ',\n'.join('  ' + str([[a, b] for a, b in l]).replace(' ', '') for l in lots) + ',\n]'
if 'export const METRO_LOTS' in s:
    s = re.sub(r"export const METRO_LOTS = \[.*?\n\]", lambda m: lotsjs, s, count=1, flags=re.S)
else:
    s = s.replace('export const CELL = ', lotsjs + ';\n// 区分けした敷地(太い罫線で囲んだ白のマスのまとまり)。1つの敷地に1棟。\nexport const CELL = ', 1)
open(p, 'w').write(s)
