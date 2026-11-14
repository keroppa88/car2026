"""赤城山: 空撮に塗った絵の囲みを、コースの座標の多角形にして map/akagi-course.json に入れる。
  赤の囲み → meadows(木なし、ただの草原)
  黄の囲み → bushes(木なし、草むら)
  ピンクの囲み → parkings(駐車場)、ピンクの小さな印(×) → toilets(白い平屋の小さな建物)
位置合わせ: 絵 → 自分で描いた空撮(paint/ref_top.png、カメラは paint/ref_job.json)の変換 H(register は SIFT + 道の形)。
python3 tools/akagi/apply_top_paint.py paint/top_paint1.png paint/H_paint1_to_ref.npy
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; P = ROOT / 'tools/akagi'
img = cv2.imread(str(P / sys.argv[1])).astype(int); Hm = np.load(P / sys.argv[2])
job = json.loads((P / 'paint/ref_job.json').read_text()); cam = job['cams'][0]; W, Hh = job['W'], job['H']
f = (Hh / 2) / math.tan(math.radians(cam['fov'] / 2)); cx, cy, cz = cam['pos']
data = json.loads((ROOT / 'map/akagi-course.json').read_text()); G = data['ground']
gh = np.array(G['h']).reshape(G['nz'], G['nx'])
def T(x, z):
    fx = np.clip((x - G['x0']) / G['cell'], 0, G['nx'] - 1.001); fz = np.clip((z - G['z0']) / G['cell'], 0, G['nz'] - 1.001)
    ix, iz = int(fx), int(fz); tx, tz = fx - ix, fz - iz
    return (gh[iz, ix] * (1 - tx) + gh[iz, ix + 1] * tx) * (1 - tz) + (gh[iz + 1, ix] * (1 - tx) + gh[iz + 1, ix + 1] * tx) * tz
def world(u, v):
    q = Hm @ [u, v, 1]; u2, v2 = q[0] / q[2], q[1] / q[2]   # 自分の空撮の画素
    y = 200.0
    for _ in range(6):   # 真上からのカメラ(上 = 北): 地面の高さで交わる所
        x = cx + (u2 - W / 2) / f * (cy - y); z = cz + (v2 - Hh / 2) / f * (cy - y); y = T(x, z)
    return [round(float(x), 2), round(float(z), 2)]
b, g, r = img[..., 0], img[..., 1], img[..., 2]
masks = {'meadows': (r > 170) & (g < 90) & (b < 90), 'bushes': (r > 180) & (g > 150) & (b < 90),
         'parkings': (r > 200) & (g > 130) & (g < 215) & (b > 150) & (r - g > 25)}
out = {}
for key, m in masks.items():
    m = m.astype(np.uint8)
    cl = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))   # 線の切れ目をふさぐ
    # 囲みの中を塗りつぶす(外から塗って、届かなかった所 = 囲みの中と線)。その外形を、線の外側のふちでとる
    ff = np.pad(cl, 1); fl = ff.copy(); cv2.floodFill(fl, None, (0, 0), 2); filled = (fl[1:-1, 1:-1] != 2).astype(np.uint8)
    cs, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    polys = []
    for c in cs:
        if cv2.contourArea(c) < 20: continue
        c = cv2.approxPolyDP(c, 0.8, True)[:, 0]
        polys.append([world(u, v) for u, v in c])
    out[key] = polys
    if key == 'parkings':   # 囲みの線から離れた印(×)= トイレ
        fill = np.zeros_like(m); cv2.drawContours(fill, cs, -1, 1, 3)
        inner = m & (1 - fill)
        n, lab, st, cen = cv2.connectedComponentsWithStats(inner.astype(np.uint8))
        out['toilets'] = [world(*cen[k]) for k in range(1, n) if st[k, cv2.CC_STAT_AREA] >= 2]
for k, v in out.items(): print(k, len(v), [len(p) if isinstance(p[0], list) else p for p in v])
data.update(out)
(ROOT / 'map/akagi-course.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
