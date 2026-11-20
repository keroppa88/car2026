"""真上の区画の絵(render_top.mjs の tile_XX.png に塗ったもの)を、コースのデータ(map/<コース>-course.json)に入れる。
区画の画像はゲームを正射影で写したものなので、塗った画素をそのまま世界座標へ移せる(斜めのずれなし)。
python3 tools/topview/apply_paint.py コース 区画フォルダ 区画名 塗った絵
色の決まり(榛名山 2026-11-20):
  水色 = アスファルトの拡張(道の高さの舗装)        → aprons(多角形)
  赤線 = ガードレールを外す所。赤のない所はガードレールを残す → railL / railR を 0 / 1(その区画の中の点だけ)
  濃い緑 = 木々                                    → woods(多角形)
  薄い緑(黄緑) = 芝生                              → meadows(多角形。木なし)
  黄色い線の枠 = 駐車している車の向き               → parkGuides([x, z, 向き(ラジアン), 長さ, 幅])
  ピンクの丸 = 伊香保温泉の案内看板                  → signs([x, z])
同じ区画を塗り直したときは、その区画の中の古い多角形を消してから入れ直す。
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]
course, tdir, tname, paint = sys.argv[1:5]
CJ = ROOT / f'map/{course}-course.json'; data = json.loads(CJ.read_text())
T = json.load(open(f'{tdir}/tiles.json')); tile = next(t for t in T['tiles'] if t['name'] == tname); K = T['m_per_px']
im = cv2.imread(paint); base = cv2.imread(f'{tdir}/{tname}.png')
assert im.shape == base.shape, ('大きさが違う', im.shape, base.shape)
(dx, dy), _ = cv2.phaseCorrelate(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.cvtColor(base, cv2.COLOR_BGR2GRAY).astype(np.float32))
assert abs(dx) < 1.5 and abs(dy) < 1.5, ('ずれている', dx, dy)
changed = np.abs(im.astype(int) - base.astype(int)).sum(2) > 60
B, G, Rr = [im[..., c].astype(int) for c in range(3)]
near = lambda rgb, tol=60: changed & (np.abs(Rr - rgb[0]) + np.abs(G - rgb[1]) + np.abs(B - rgb[2]) < tol)
masks = {'aprons': near((150, 215, 230)), 'red': near((230, 20, 40), 90), 'woods': near((35, 180, 70)), 'meadows': near((180, 230, 20)), 'yellow': near((245, 245, 0), 70), 'pink': near((245, 170, 200), 70)}
W = lambda px, py: [round(tile['x0'] + px * K, 2), round(tile['z0'] + py * K, 2)]
x0, z0, x1, z1 = tile['x0'], tile['z0'], tile['x0'] + T['size'], tile['z0'] + T['size']
inside = lambda poly: all(x0 <= x <= x1 and z0 <= z <= z1 for x, z in poly)
def polys(m, close=5, min_area=30):
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in cs:
        if cv2.contourArea(c) < min_area: continue
        c = cv2.approxPolyDP(c, 1.0, True)
        out.append([W(p[0][0] + 0.5, p[0][1] + 0.5) for p in c])
    return out
summary = {}
for key in ('aprons', 'woods', 'meadows'):
    old = [p for p in data.get(key, []) if not inside(p)]
    new = polys(masks[key]); data[key] = old + new; summary[key] = len(new)
# 駐車の向きの枠(黄色の線で囲んだ四角): 枠の内側の穴ごとに、いちばん小さい回した四角(枠どうしがくっついていても 1 つずつ取れる)
ym = masks['yellow'].astype(np.uint8)
cs, hier = cv2.findContours(ym, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
guides = []
for c, h in zip(cs, hier[0]):
    if h[3] < 0 or cv2.contourArea(c) < 4: continue          # 穴(内側の輪郭)だけ
    (cx, cy), (w, hh), ang = cv2.minAreaRect(c)
    a = math.radians(ang) if w >= hh else math.radians(ang + 90)   # 長い辺の向き(画面)
    L, Wd = max(w, hh) * K, min(w, hh) * K
    heading = math.atan2(math.cos(a), math.sin(a))   # 画面の向き(右=+x、下=+z)を、ゲームの向き atan2(dx, dz) に
    guides.append([*W(cx, cy), round(heading, 4), round(L, 2), round(Wd, 2)])
# 看板(ピンクの丸): 丸ごとの中心
cs, _ = cv2.findContours(masks['pink'].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
signs = [W(*cv2.minEnclosingCircle(c)[0]) for c in cs if cv2.contourArea(c) >= 6]
data['signs'] = [g for g in data.get('signs', []) if not (x0 <= g[0] <= x1 and z0 <= g[1] <= z1)] + signs
summary['signs'] = len(signs)
data['parkGuides'] = [g for g in data.get('parkGuides', []) if not (x0 <= g[0] <= x1 and z0 <= g[1] <= z1)] + guides
summary['parkGuides'] = len(guides)
# ガードレール: 道の点ごとに、左右それぞれ 路肩のあたり(中心から 2.5〜7.5m)に赤があれば外す。なければ残す
R = np.array(data['route']); n = len(R)
for key in ('railL', 'railR'):
    if key not in data or len(data[key]) != n: data[key] = [-1] * n
cnt = [0, 0]
for i in range(n):
    x, z = R[i, 0], R[i, 2]
    if not (x0 <= x < x1 and z0 <= z < z1): continue
    a, b = R[max(0, i - 1)], R[min(n - 1, i + 1)]; ddx, ddz = b[0] - a[0], b[2] - a[2]; l = math.hypot(ddx, ddz) or 1
    nx, nz = ddz / l, -ddx / l   # 進む向きの左(js/akagi-map.js と同じ)
    for si, side in enumerate((1, -1)):
        hit = False
        for o in np.arange(2.5, 7.6, 0.4):
            px, py = int((x + nx * side * o - x0) / K), int((z + nz * side * o - z0) / K)
            if 0 <= px < im.shape[1] and 0 <= py < im.shape[0] and masks['red'][max(0, py - 1):py + 2, max(0, px - 1):px + 2].any(): hit = True; break
        data['railL' if side > 0 else 'railR'][i] = 0 if hit else 1
        if hit: cnt[si] += 1
summary['rail_off_L'], summary['rail_off_R'] = cnt
CJ.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
print(summary)
