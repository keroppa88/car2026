"""富士スピードウェイ: ピット出口の空撮に塗った絵(tools/fuji/paint/pitexit_paint.png)を地面に反映する。
赤 (237,28,36) = ピットロード・ホームストレート(路面の色) / ピンク (255,174,201) = コンクリート(舗装) / 黄 (255,201,14) = コンクリートで囲まれた、人のいる場所(コンクリート扱い)。塗っていない舗装は草地(建物・パドックの中は残す)
絵の画素 → 地図 の対応は pitexit_paint_H.npy(空撮を全体の空撮と特徴点で照合して求めたもの)。
空撮の路面はコースの線より右へ約 2.75m ずれて写っているので、その分だけ左へ戻して重ねる。
python3 tools/fuji/apply_pitexit_paint.py   (edit_pit_exit.py のあとに)
"""
import json
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]; F = ROOT / 'map/fuji-course.json'; d = json.loads(F.read_text())
P = cv2.imread(str(ROOT / 'tools/fuji/paint/pitexit_paint.png')); M = np.load(ROOT / 'tools/fuji/paint/pitexit_paint_H.npy')
R = np.array([[p[0], p[2]] for p in d['route']]); n = len(R); st = d['start']; t = R[(st + 5) % n] - R[st]; t /= np.linalg.norm(t)
SH = np.array([t[1], -t[0]]) * 2.75                                   # 左へ 2.75m
L = d['landcover']; W, H = L['W'], L['H']
G = np.array([[1, 0, L['x0'] + 0.5 - SH[0]], [0, 1, L['z0'] + 0.5 - SH[1]], [0, 0, 1.0]])   # 升目 → (ずらす前の)地図
J = P.astype(int); near = lambda rgb: (np.abs(J - np.array(rgb[::-1])).max(2) <= 8).astype(np.uint8) * 255
warp = lambda m: cv2.warpPerspective(m, np.linalg.inv(M) @ G, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP) > 127
red, pink, yel = warp(near((237, 28, 36))), warp(near((255, 174, 201))), warp(near((255, 201, 14)))
inside = warp(np.full(P.shape[:2], 255, np.uint8))
k = lambda s: np.ones((s, s), np.uint8); cl = lambda m, s: cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, k(s)) > 0
yel = cl(yel, 3); red = cl(red | yel, 7) & ~yel                         # 白線・破線・縞のすき間を埋める
pink = cv2.morphologyEx(cl(pink, 3).astype(np.uint8), cv2.MORPH_OPEN, k(2)) > 0
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'; ov = cv2.imread(str(ovp), 0)
# 塗りのふちを滑らかに(ギザギザをなくす)
def smooth(m, r=1.5, win=9):
    # 輪郭を取り出して、輪郭の点を前後 win 点(約 win m)で平均してから塗り直す → 写真の模様に沿ったギザギザが消える
    m = cv2.morphologyEx((cv2.GaussianBlur(m.astype(np.float32), (0, 0), r) > 0.5).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE); out = np.zeros_like(m)
    if hier is None: return out > 0
    for k in sorted(range(len(cs)), key=lambda k: hier[0][k][3] >= 0):
        c = cs[k]
        c = c[:, 0].astype(np.float32)
        if len(c) < 12 or cv2.contourArea(c) < 20: continue
        w = min(win, len(c) // 4 * 2 + 1); ker = np.ones(w) / w
        c = np.stack([np.convolve(np.r_[c[-w:, j], c[:, j], c[:w, j]], ker, 'same')[w:-w] for j in (0, 1)], 1)
        cv2.fillPoly(out, [np.round(c * 8).astype(np.int32)], 1 if hier[0][k][3] < 0 else 0, shift=3)
    return out > 0
red, pink, yel = smooth(red), smooth(pink | yel), smooth(yel)
# コースのそば(45m 以内)のコンクリートは、柵の後ろの通路などの帯: コースに平行で途切れない帯に直す
def band(m, maxd=45):
    Rp = R - [L['x0'], L['z0']]; seg = np.linalg.norm(np.roll(Rp, -1, 0) - Rp, axis=1); cum = np.r_[0, np.cumsum(seg)]; M = int(cum[-1])
    ss = np.arange(M) * cum[-1] / M; Pp = np.stack([np.interp(ss, cum, np.r_[Rp[:, k], Rp[0, k]]) for k in (0, 1)], 1)
    Tt = np.roll(Pp, -3, 0) - np.roll(Pp, 3, 0); Tt /= np.linalg.norm(Tt, axis=1)[:, None]; Nl = np.stack([Tt[:, 1], -Tt[:, 0]], 1)
    mk = np.zeros((H, W), np.uint8); ip = np.round(Pp).astype(int); mk[ip[:, 1].clip(0, H - 1), ip[:, 0].clip(0, W - 1)] = 1
    from scipy import ndimage
    dist, (iy, ix) = ndimage.distance_transform_edt(1 - mk, return_indices=True)
    km = np.full((H, W), -1, np.int32); km[ip[:, 1].clip(0, H - 1), ip[:, 0].clip(0, W - 1)] = np.arange(M); kk = km[iy, ix]
    yy, xx = np.mgrid[0:H, 0:W]; off = (xx - Pp[kk, 0]) * Nl[kk, 0] + (yy - Pp[kk, 1]) * Nl[kk, 1]
    zone = (dist < maxd) & inside; sel = m & zone; out = m & ~zone
    for sg in (1, -1):
        A = sel & (off * sg > 0); k_ = kk[A]; o_ = np.abs(off[A]).round().astype(int)
        cnt = np.zeros((M, maxd + 2)); np.add.at(cnt, (k_, o_), 1)
        cnt = ndimage.uniform_filter1d(cnt, 31, axis=0, mode='wrap')                 # 前後 31m で多数決
        on = cnt > 0.4
        on = ndimage.binary_closing(on, np.ones((1, 5)))                            # 帯の中のすき間を埋める
        Z = zone & (off * sg > 0); oo = np.abs(off[Z]).round().astype(int).clip(0, maxd + 1)
        o2 = out[Z]; o2 |= on[kk[Z], oo]; out[Z] = o2
    return out
pink = band(pink & ~red)
# 塗っていない所は草地(ただし建物・観客席・ピットとパドックの中は残す)
R2 = R; NR = np.stack([-(np.roll(R2, -2, 0) - np.roll(R2, 2, 0))[:, 1], (np.roll(R2, -2, 0) - np.roll(R2, 2, 0))[:, 0]], 1); NR /= np.linalg.norm(NR, axis=1)[:, None]
pad = np.zeros((H, W), np.uint8)
poly = [R2[i] + NR[i] * 7.0 for i in range(1240, 1434)] + [R2[i] + NR[i] * 70 for i in range(1433, 1239, -1)]
cv2.fillPoly(pad, [np.round(np.array(poly) - [L['x0'], L['z0']]).astype(np.int32)], 1)
lc0 = cv2.imread(str(ROOT / 'map/fuji-landcover.png')).astype(int)
srcm = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); colm = lambda key: np.array(tuple(int(q) for q in srcm.split(f"'{key}': (")[1].split(')')[0].split(',')))
isc = lambda key: (np.abs(lc0 - colm(key)).max(2) <= 2)
grey = isc('paved') | isc('parking') | (np.abs(lc0 - np.array([75, 73, 71])).max(2) <= 2)
road = np.ones((H, W), np.uint8); cv2.polylines(road, [np.round(R2 - [L['x0'], L['z0']]).astype(np.int32)], True, 0, 1)
oncourse = cv2.distanceTransform(road, cv2.DIST_L2, 5) < 9
toGrass = cv2.erode(inside.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool) & ~red & ~pink & grey & (pad == 0) & ~oncourse
ov[toGrass] = 2; print('塗っていない舗装 → 草地', int(toGrass.sum()), 'm2')
ov[pink & ~red & inside] = 3; ov[red & inside] = 1
cv2.imwrite(str(ovp), ov)
lc = cv2.imread(str(ROOT / 'map/fuji-landcover.png'))
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); col = lambda key: tuple(int(q) for q in src.split(f"'{key}': (")[1].split(')')[0].split(','))
for c, v in {1: (75, 73, 71), 2: col('grass'), 3: col('paved'), 5: (206, 206, 204)}.items(): lc[ov == c] = v
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), lc)
# 黄(人のいる場所)は edit_pit_lane.py が壁と床で作るので、ここではコンクリートの色だけ
d.pop('pitIsland', None)
F.write_text(json.dumps(d, separators=(',', ':')))
NR = np.stack([-(np.roll(R, -2, 0) - np.roll(R, 2, 0))[:, 1], (np.roll(R, -2, 0) - np.roll(R, 2, 0))[:, 0]], 1); NR /= np.linalg.norm(NR, axis=1)[:, None]
for nm, m in (('黄', yel), ('赤', red)):
    if not (m & inside).any(): continue
    ys, xs = np.nonzero(m & inside); q = np.stack([xs + L['x0'] + 0.5, ys + L['z0'] + 0.5], 1)[::7]
    i = np.array([np.hypot(*(R - p).T).argmin() for p in q]); o = np.array([(p - R[a]) @ NR[a] for p, a in zip(q, i)])
    print(nm, int(m.sum()), 'm2', [(int(a), round(float(o[i == a].min()), 1), round(float(o[i == a].max()), 1)) for a in range(i.min(), i.max() + 1, 12) if (i == a).any()])
