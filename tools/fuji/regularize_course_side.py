"""富士スピードウェイ: コースのわきの塗り分けを、コースに平行なくっきりした帯にする(しみ・ぎざぎざ・色の途切れをなくす)
1. コースの両わき(縁石の外 8.7m 〜 45m)を 1m ごとに横に見て、内側から 2 本の帯の色と外の端を測る
2. 色はコースに沿って 31m の多数決、幅は同じ色どうしで 31m の中央値 → 15m の平均でならす
3. ならした幅まではその色で塗り直し、はみ出していた所は、その外の帯の色にする
4. 小さなかたまり(200m2 未満)は、まわりでいちばん多い色にする(しみ消し)
ホームストレートのピット側(コースの点 1190〜1434 の右)は edit_pit_lane.py で決めてあるので触らない。
python3 tools/fuji/regularize_course_side.py   (edit_shortcut_island.py のあと、make_trees_cars.py の前に)
"""
import json
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]; d = json.loads((ROOT / 'map/fuji-course.json').read_text())
L = d['landcover']; img = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); H, W = img.shape[:2]
cols, lab = np.unique(img.reshape(-1, 3), axis=0, return_inverse=True); lab = lab.reshape(H, W).astype(np.int32)
R = np.array([[p[0], p[2]] for p in d['route']]) - [L['x0'], L['z0']]; n = len(R)
# コースを 1m ごとに細かく
seg = np.linalg.norm(np.roll(R, -1, 0) - R, axis=1); cum = np.r_[0, np.cumsum(seg)]; m = int(cum[-1])
s = np.arange(m) * cum[-1] / m; P = np.stack([np.interp(s, cum, np.r_[R[:, k], R[0, k]]) for k in (0, 1)], 1)
ridx = np.interp(s, cum, np.arange(n + 1)) % n                       # 細かい点 → コースの点の番号
T = np.roll(P, -3, 0) - np.roll(P, 3, 0); T /= np.linalg.norm(T, axis=1)[:, None]; NL = np.stack([T[:, 1], -T[:, 0]], 1)   # 左
mark = np.zeros((H, W), np.uint8); ip = np.round(P).astype(int); mark[ip[:, 1].clip(0, H - 1), ip[:, 0].clip(0, W - 1)] = 1
dist, (iy, ix) = ndimage.distance_transform_edt(1 - mark, return_indices=True)
kmap = np.full((H, W), -1, np.int32); kmap[ip[:, 1].clip(0, H - 1), ip[:, 0].clip(0, W - 1)] = np.arange(m); near_k = kmap[iy, ix]
yy, xx = np.mgrid[0:H, 0:W]; off = (xx - P[near_k, 0]) * NL[near_k, 0] + (yy - P[near_k, 1]) * NL[near_k, 1]
K0, K1, ST = 8.7, 45.0, 0.5; os_ = np.arange(K0, K1, ST)
def at(img2, x, y): return img2[np.clip(np.round(y).astype(int), 0, H - 1), np.clip(np.round(x).astype(int), 0, W - 1)]
skip = lambda k, sg: sg < 0 and 1190 <= ridx[k] <= 1434
out = lab.copy()
for sg in (1, -1):
    # 内側から 2 本の帯(色と外の端)と、その外の色を測る
    C1 = np.full(m, -1); W1 = np.zeros(m); C2 = np.full(m, -1); W2 = np.zeros(m); C3 = np.full(m, -1)
    def runs(cl, lim):
        out_, j = [], 0
        while j < lim:
            c = cl[j]; k = j; gap = 0
            while k < lim:
                if cl[k] == c: gap = 0
                else:
                    gap += 1
                    if gap > 3: k -= gap - 1; break
                k += 1
            out_.append((c, K0 + k * ST)); j = k
        return out_
    for k in range(m):
        xs = P[k, 0] + NL[k, 0] * sg * os_; ys = P[k, 1] + NL[k, 1] * sg * os_
        cl = at(lab, xs, ys); dd = at(dist, xs, ys); kk = at(near_k, xs, ys)
        ok = (dd >= K0 - 0.5) & (np.abs(((kk - k + m // 2) % m) - m // 2) < 60)   # 別のコースの所に入ったら止める
        lim = len(os_) if ok.all() else int(np.argmin(ok))
        if lim < 2: continue
        rr = runs(cl, lim)
        C1[k], W1[k] = rr[0]
        if len(rr) > 1: C2[k], W2[k] = rr[1]
        if len(rr) > 2: C3[k] = rr[2][0]
    hw = 15
    def mode(A, k):
        w = np.take(A, range(k - hw, k + hw + 1), mode='wrap'); w = w[w >= 0]
        return np.bincount(w).argmax() if len(w) else -1
    def width(Cc, Wd, c, k):
        sel = np.take(Cc, range(k - hw, k + hw + 1), mode='wrap') == c
        return np.median(np.take(Wd, range(k - hw, k + hw + 1), mode='wrap')[sel]) if sel.any() else 0
    S1 = np.array([mode(C1, k) for k in range(m)]); S2 = np.array([mode(C2, k) for k in range(m)]); S3 = np.array([mode(C3, k) for k in range(m)])
    V1 = ndimage.uniform_filter1d(np.array([width(C1, W1, S1[k], k) for k in range(m)]), 15, mode='wrap')
    V2 = ndimage.uniform_filter1d(np.array([width(C2, W2, S2[k], k) for k in range(m)]), 15, mode='wrap'); V2 = np.maximum(V2, V1)
    # 細い灰色の帯(幅 6m 未満)は、となりの自然の色(草地・森・砂地)にする
    GREY = [i for i, c in enumerate(cols) if abs(int(c[0]) - int(c[2])) <= 6 and c[1] < 150]
    nat = lambda c: c >= 0 and c not in GREY
    for k in range(m):
        if S2[k] in GREY and V2[k] - V1[k] < 6 and (nat(S1[k]) or nat(S3[k])): S2[k] = S1[k] if nat(S1[k]) else S3[k]
        if S1[k] in GREY and V1[k] - K0 < 4 and nat(S2[k]): S1[k] = S2[k]
    side = (off * sg > 0) & (dist >= K0 - 0.5) & (dist <= K1)
    kk = near_k[side]; oo = np.abs(off[side]); cur = lab[side].copy(); valid = S1[kk] >= 0
    sk = np.array([skip(k, sg) for k in range(m)])[kk]; valid &= ~sk
    b1 = valid & (oo <= V1[kk]); has2 = valid & (S2[kk] >= 0)
    b2 = has2 & (oo > V1[kk]) & (oo <= V2[kk])
    spill = has2 & (S3[kk] >= 0) & (oo > V2[kk]) & (oo <= V2[kk] + 12) & ((cur == S2[kk]) | (cur == S1[kk]))
    cur[b1] = S1[kk][b1]; cur[b2] = S2[kk][b2]; cur[spill] = S3[kk][spill]
    inner, outer = b1 | b2, spill
    o2 = out[side]; o2[valid] = cur[valid]; out[side] = o2
    print('左' if sg > 0 else '右', '塗り直し', int((inner | outer).sum()), 'm2')
# しみ消し
for it in range(3):
    changed = 0
    for c in range(len(cols)):
        nc, cc, st, _ = cv2.connectedComponentsWithStats((out == c).astype(np.uint8), connectivity=4)
        for i in np.where(st[1:, cv2.CC_STAT_AREA] < 200)[0] + 1:
            x, y, w, h, a = st[i]; sl = (slice(max(0, y - 2), y + h + 2), slice(max(0, x - 2), x + w + 2))
            msk = cc[sl] == i; ring = cv2.dilate(msk.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~msk
            nb = out[sl][ring]; nb = nb[nb != c]
            if len(nb): o = out[sl]; o[msk] = np.bincount(nb).argmax(); out[sl] = o; changed += 1
    print('しみ', it, changed)
    if not changed: break
# コースから 70m 以内の、灰色の小さなかたまり(1500m2 未満)と、自然の色の小さなかたまり(500m2 未満)は、まわりの色に
GR = [i for i, c in enumerate(cols) if abs(int(c[0]) - int(c[2])) <= 6 and int(c[1]) < 150 and not (c == np.array([75, 73, 71])).all()]
nearc = dist < 70
def absorb(mask_fn, lim):
    cnt = 0
    for c in range(len(cols)):
        mk = mask_fn(c)
        if mk is None: continue
        nc, cc, st, _ = cv2.connectedComponentsWithStats(mk.astype(np.uint8), connectivity=8)
        for i in np.where(st[1:, cv2.CC_STAT_AREA] < lim)[0] + 1:
            x, y, w, h, a = st[i]; sl = (slice(max(0, y - 2), y + h + 2), slice(max(0, x - 2), x + w + 2))
            msk = cc[sl] == i
            if not nearc[sl][msk].mean() > 0.5: continue
            ring = cv2.dilate(msk.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~msk
            nb = out[sl][ring]; nb = nb[~np.isin(nb, GR + [c])]
            if len(nb): o = out[sl]; o[msk] = np.bincount(nb).argmax(); out[sl] = o; cnt += 1
    return cnt
greyall = np.isin(out, GR)
print('灰色のしみ', absorb(lambda c: (np.isin(out, GR)) if c == GR[0] else None, 1500))
print('自然の色のしみ', absorb(lambda c: (out == c) if c not in GR else None, 500))
# 手で塗った直し(area_overrides.png)は、いちばん最後に必ず重ねる
ovp = ROOT / 'tools/fuji/paint/area_overrides.png'
if ovp.exists():
    ov = cv2.imread(str(ovp), 0)
    srcm = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text(); colm = lambda key: tuple(int(q) for q in srcm.split(f"'{key}': (")[1].split(')')[0].split(','))
    ci = lambda bgr: int(np.where((cols == np.array(bgr)).all(1))[0][0]) if (cols == np.array(bgr)).all(1).any() else None
    for k, bgr in {1: (75, 73, 71), 2: colm('grass'), 3: colm('paved'), 4: colm('parking')}.items():
        i = ci(bgr)
        if i is not None: out[ov == k] = i
cv2.imwrite(str(ROOT / 'map/fuji-landcover.png'), cols[out].astype(np.uint8))
