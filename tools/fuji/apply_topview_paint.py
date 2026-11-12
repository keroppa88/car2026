"""富士スピードウェイ: 真上ビューの画面に塗った絵(手描きの丸・塗りつぶし)を地面に反映する
python3 tools/fuji/apply_topview_paint.py 絵 カメラ.json [出力フォルダ] [--red 草地|舗装] [--blue 草地|舗装] [--lblue 草地|舗装(水色を使う絵)] [--reset]
カメラ.json: {"W","H","pos":[x,y,z],"up":[ux,0,uz],"fov"}(tools/shonan/paint/render.mjs で描いたときのもの。真下向き)
赤・青は、線で囲んでも塗りつぶしてもよい(囲みの中も塗る)。ふつうは 赤 = アスファルト、青 = 草地。--red / --blue で入れかえられる
→ tools/fuji/paint/area_overrides.png に重ねる(3 = 舗装、2 = 草地)
"""
import sys, json, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; d = json.loads((ROOT / 'map/fuji-course.json').read_text())
P = cv2.imread(sys.argv[1]); cam = json.loads(Path(sys.argv[2]).read_text()); args = sys.argv[1:]; opt = lambda k, dflt: args[args.index(k) + 1] if k in args else dflt
DBG = Path(sys.argv[3]) if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else None
CLS = {'草地': 2, 'grass': 2, '舗装': 3, 'paved': 3, 'なし': 0}; RC, BC = CLS[opt('--red', '舗装')], CLS[opt('--blue', '草地')]
Wp, Hp = cam['W'], cam['H']; pos = np.array(cam['pos'], float); U = np.array([cam['up'][0], cam['up'][2]], float); U /= np.linalg.norm(U)
Rt = np.array([-U[1], U[0]]); f = Hp / 2 / math.tan(math.radians(cam['fov'] / 2))
G = d['ground']; gh = (np.array(G['h'], np.float32) / 10).reshape(G['nz'], G['nx'])
def ground(x, z): return ndimage.map_coordinates(gh, [np.clip((z - G['z0']) / G['cell'], 0, G['nz'] - 1), np.clip((x - G['x0']) / G['cell'], 0, G['nx'] - 1)], order=1)
def to_px(x, z, y):   # 地図 → 画面
    k = f / (pos[1] - y); dx, dz = x - pos[0], z - pos[2]
    return Wp / 2 + (dx * Rt[0] + dz * Rt[1]) * k, Hp / 2 - (dx * U[0] + dz * U[1]) * k
J = P.astype(int); b, g, r = J[..., 0], J[..., 1], J[..., 2]
# 赤: ペイントの赤(237,28,36)ちょうどの所は小さくても全部。色がにじんだ赤(jpg)は 15 画素以上のかたまりだけ(画面の赤い車・屋根・縁石を拾わない)
tight = (np.abs(r - 237) < 14) & (np.abs(g - 28) < 16) & (np.abs(b - 36) < 16)
loose = (r > 190) & (g < 120) & (b < 100); nl, cl, sl, _ = cv2.connectedComponentsWithStats(loose.astype(np.uint8), connectivity=8)
red = (tight | np.isin(cl, np.where(sl[:, cv2.CC_STAT_AREA] >= 15)[0][1:])).astype(np.uint8)
red_raw = red.copy(); blue = ((b > 150) & (r < 90) & (b - g > 50)).astype(np.uint8)
if '--lblue' in args: blue = ((np.abs(r - 150) < 18) & (np.abs(g - 216) < 16) & (np.abs(b - 234) < 16)).astype(np.uint8); BC = CLS[opt('--lblue', '舗装')]   # 水色を青の代わりに
if opt('--blue', '') == 'なし': blue = np.zeros_like(blue)   # 青を使わない絵(画面の青い車を拾わない)
blue_raw = blue.copy()
# 赤: 囲みの中を塗る(線のすき間は閉じる)。青: 塗りの穴を埋めて少し広げる
red = cv2.morphologyEx(red, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)); rf = np.zeros_like(red)
for c in cv2.findContours(red, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]:
    if cv2.contourArea(cv2.convexHull(c)) > 20: cv2.fillPoly(rf, [c], 1)
blue = cv2.morphologyEx(blue, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)); bf = np.zeros_like(blue)
for c in cv2.findContours(blue, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]:
    if cv2.contourArea(cv2.convexHull(c)) > 4: cv2.fillPoly(bf, [c], 1)
blue = ndimage.binary_fill_holes(cv2.dilate(bf, np.ones((3, 3), np.uint8)) | cv2.dilate(cv2.morphologyEx(blue, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)), np.ones((5, 5), np.uint8))).astype(np.uint8)
# 地図の升目(1m)ごとに、地面の高さつきで画面の位置を求めて引く
L = d['landcover']; W, H = L['W'], L['H']
xs, zs = np.meshgrid(np.arange(W) + L['x0'] + 0.5, np.arange(H) + L['z0'] + 0.5)
y = ground(xs.ravel(), zs.ravel()).reshape(H, W)
u, v = to_px(xs, zs, y); u = u.astype(np.float32); v = v.astype(np.float32)
pick = lambda m: cv2.remap(m * 255, u, v, cv2.INTER_LINEAR, borderValue=0) > 127
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0)
rf = cv2.dilate(rf, np.ones((3, 3), np.uint8))
mr, mb = pick(rf), pick(blue)
# 塗った形のまま(線のかすれ・小さな穴だけふさぐ)
fillg = lambda m: ndimage.binary_fill_holes(cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))))
mr, mb = fillg(mr), fillg(mb)
# 赤と青が重なった所は、絵でより近いほうの色(塗った線そのものを優先)
both = mr & mb
if both.any():
    dr = cv2.remap(ndimage.distance_transform_edt(red_raw == 0).astype(np.float32), u, v, cv2.INTER_LINEAR, borderValue=1e6)
    db = cv2.remap(ndimage.distance_transform_edt(blue_raw == 0).astype(np.float32), u, v, cv2.INTER_LINEAR, borderValue=1e6)
    mr = mr & ~(both & (db < dr))
ov[mb] = BC; ov[mr] = RC
# 真上ビューの直しは別の層にも残す(あとから塗った絵ほど上)。ほかの手順が area_overrides.png を書き直しても、
# merge_topview.py でいちばん上に重ね直す
tvp = ROOT / 'tools/fuji/paint/topview_overrides.png'
tv = cv2.imread(str(tvp), 0) if tvp.exists() and '--reset' not in sys.argv else np.zeros_like(ov)
tv[mb] = BC; tv[mr] = RC; cv2.imwrite(str(tvp), tv)
cv2.imwrite(str(ovp), ov); print('赤', int(mr.sum()), 'm2 →', RC, ' 青', int((mb & ~mr).sum()), 'm2 →', BC, '(2 草地 / 3 舗装)')
if DBG:   # 確かめ: コースの線を絵に重ねる
    R = np.array(d['route']); a = P.copy(); pu, pv = to_px(R[:, 0], R[:, 2], R[:, 1])
    cv2.polylines(a, [np.stack([pu, pv], 1).astype(np.int32)], True, (0, 255, 255), 1); cv2.imwrite(str(DBG / 'tv_fit.png'), a)
