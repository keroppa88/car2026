"""富士スピードウェイ: 地面の塗り分け図(1画素 = 1m、map/fuji-landcover.png)から、ゲームが使う細かい図を作る
→ map/fuji-landcover-hd.png(大きさは 4096 画素以内)。いちばん最後に実行する。

- 草地・森・砂地(自然のもの): 有機的な形のまま、1m の階段だけをなめらかにする(色ごとにぼかして、いちばん強い色)
- アスファルト・駐車場・建物の下・路面の色(人が作ったもの): かたまりごとに輪郭を折れ線にまとめて(1.5〜3m の誤差で)、
  細かい図にくっきり塗る → ふちはまっすぐな線(曲がる所は短い直線のつながり)。クネクネ・ギザギザを残さない
"""
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
ROOT = Path(__file__).resolve().parents[2]
I = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); H, W = I.shape[:2]; S = 4096 / max(W, H); W2, H2 = int(W * S), int(H * S)
cols, lab = np.unique(I.reshape(-1, 3), axis=0, return_inverse=True); lab = lab.reshape(H, W)
src = (ROOT / 'tools/fuji/make_landcover_mosaic.py').read_text()
col = lambda key: tuple(int(q) for q in src.split(f"'{key}': (")[1].split(')')[0].split(','))
GREY = [col('paved'), col('parking'), col('building'), (75, 73, 71)]          # 下から順に塗る(路面の色がいちばん上)
gid = [int(np.where((cols == np.array(g)).all(1))[0][0]) for g in GREY if (cols == np.array(g)).all(1).any()]
# 1. 自然のもの: 灰色の所はいちばん近い自然の色で埋めてから、なめらかにする
gm = np.isin(lab, gid)
_, (iy, ix) = ndimage.distance_transform_edt(gm, return_indices=True); nat = lab[iy, ix]
best = np.full((H2, W2), -1, np.float32); out = np.zeros((H2, W2), np.int32)
for k in np.unique(nat):
    f = cv2.GaussianBlur(cv2.resize((nat == k).astype(np.float32), (W2, H2), interpolation=cv2.INTER_LINEAR), (0, 0), 1.6 * S / 2)
    sel = f > best; best[sel] = f[sel]; out[sel] = k
# 2. 人が作ったもの: かたまりの輪郭を折れ線にして、くっきり塗る(穴は木の形の順に、塗る・抜くを交互に)
SH = 4; sc = S * (1 << SH)
def smooth_line(q, w):
    # 輪郭(1m の階段)を前後 w 点の平均でならしてから、まっすぐな所は 1 本の直線にまとめる → ギザギザ・うねりを残さない
    if len(q) >= 2 * w + 3:
        ker = np.ones(w) / w
        q = np.stack([np.convolve(np.r_[q[-w:, t], q[:, t], q[:w, t]], ker, 'same')[w:-w] for t in (0, 1)], 1)
    return cv2.approxPolyDP(q.astype(np.float32).reshape(-1, 1, 2), 0.6, True)[:, 0].astype(np.float64)
for g in [None] + gid:   # None: 灰色ぜんぶを 1 つにして、いちばん下に舗装の色で塗る(灰色どうしのすき間に草が出ない)
    m = (np.isin(lab, gid) if g is None else (lab == g)).astype(np.uint8)
    m = cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cs, hier = cv2.findContours(m, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    if hier is None: continue
    hier = hier[0]; depth = np.zeros(len(cs), int)
    for i in range(len(cs)):
        p = hier[i][3]
        while p >= 0: depth[i] += 1; p = hier[p][3]
    mask = np.zeros((H2, W2), np.uint8)
    for i in np.argsort(depth, kind='stable'):
        a = cv2.contourArea(cs[i])
        if a < 30: continue
        q = smooth_line(cs[i][:, 0].astype(np.float64), 15 if a > 3000 else 9 if a > 400 else 5)
        if len(q) < 3: continue
        cv2.fillPoly(mask, [np.round((q + 0.5) * sc - 0.5 * (1 << SH)).astype(np.int32)], 1 if depth[i] % 2 == 0 else 0, lineType=cv2.LINE_8, shift=SH)
    out[mask > 0] = gid[0] if g is None else g
# 手で塗った直しは、細かい図でもそのまま(塗った範囲に別の色を混ぜない)
ovp = ROOT / 'tools/fuji/paint/final_overrides.png'   # あとから塗った絵の範囲(apply_user_fixes.sh)
if ovp.exists():
    # 塗った範囲の輪郭を、なめらかな線(前後 7 点の平均でならした折れ線)にして細かい図にくっきり塗る
    ov = cv2.imread(str(ovp), 0)
    for k, c in {2: col('grass'), 3: col('paved'), 4: col('parking'), 1: (75, 73, 71)}.items():
        i = np.where((cols == np.array(c)).all(1))[0]
        if not len(i): continue
        m = (ov == k).astype(np.uint8)
        cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
        if hier is None: continue
        mask = np.zeros((H2, W2), np.uint8)
        for j in sorted(range(len(cs)), key=lambda j: hier[0][j][3] >= 0):
            q = cs[j][:, 0].astype(np.float64)
            if len(q) < 3: continue
            q = smooth_line(q, 9 if cv2.contourArea(cs[j]) > 400 else 5)
            if len(q) < 3: continue
            cv2.fillPoly(mask, [np.round((q + 0.5) * sc - 0.5 * (1 << SH)).astype(np.int32)], 1 if hier[0][j][3] < 0 else 0, lineType=cv2.LINE_8, shift=SH)
        out[mask > 0] = i[0]
cv2.imwrite(str(ROOT / 'map/fuji-landcover-hd.png'), cols[out].astype(np.uint8), [cv2.IMWRITE_PNG_COMPRESSION, 9])
print(W2, H2, '色', len(cols), '灰色', len(gid))
