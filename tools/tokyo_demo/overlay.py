# 道すじを塗り画像に重ねて確かめる。python3 overlay.py 塗り画像 下絵 route.json 出力png
import json, sys, cv2, numpy as np
PAINT, BASE, R, OUT = sys.argv[1:5]
meta = json.load(open(BASE.rsplit('.', 1)[0] + '_meta.json'))
im = cv2.imread(PAINT); H, W = im.shape[:2]
kx, kz = meta['w'] / W, meta['h'] / H
pts = np.array([[(x - meta['x0']) / kx, (z - meta['z0']) / kz] for x, z in json.load(open(R))['loop']], np.int32)
cv2.polylines(im, [pts], True, (255, 60, 0), 2)
for i in range(0, len(pts), max(1, len(pts) // 40)):
    a, b = pts[i], pts[(i + 3) % len(pts)]
    cv2.arrowedLine(im, tuple(int(v) for v in a), tuple(int(v) for v in b), (200, 0, 160), 2, tipLength=0.4)
x0, y0 = pts.min(0) - 40; x1, y1 = pts.max(0) + 40
cv2.imwrite(OUT, im[max(0, y0):y1, max(0, x0):x1])
