"""富士スピードウェイ: 地面の塗り分け図(1画素 = 1m、map/fuji-landcover.png)のふちを滑らかにして、細かい図(約 0.5m)にする
→ map/fuji-landcover-hd.png(ゲームはこちらを使う。大きさは 4096 画素以内)。いちばん最後に実行する。
色ごとに「その色らしさ」を細かくしてぼかし、いちばん強い色を選ぶ → 1m の階段がなめらかな曲線になる。
"""
from pathlib import Path
import numpy as np, cv2
ROOT = Path(__file__).resolve().parents[2]
I = cv2.imread(str(ROOT / 'map/fuji-landcover.png')); H, W = I.shape[:2]; S = 4096 / max(W, H); W2, H2 = int(W * S), int(H * S)
cols, lab = np.unique(I.reshape(-1, 3), axis=0, return_inverse=True); lab = lab.reshape(H, W)
best = np.full((H2, W2), -1, np.float32); out = np.zeros((H2, W2), np.int32)
for k in range(len(cols)):
    m = (lab == k).astype(np.float32)
    if m.sum() < 1: continue
    f = cv2.GaussianBlur(cv2.resize(m, (W2, H2), interpolation=cv2.INTER_LINEAR), (0, 0), 1.6 * S / 2)
    sel = f > best; best[sel] = f[sel]; out[sel] = k
cv2.imwrite(str(ROOT / 'map/fuji-landcover-hd.png'), cols[out].astype(np.uint8), [cv2.IMWRITE_PNG_COMPRESSION, 9])
print(W2, H2, '色', len(cols))
