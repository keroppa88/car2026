"""塗った絵と、地図に落とし込んだ後の真上の絵を比べる。ズレたピクセルをピンクで示す。"""
import sys, json
import numpy as np
from PIL import Image
from pathlib import Path
TOP = Path(__file__).parent / 'top'; OUT = Path(sys.argv[1])
tiles = {a['file'][3:5]: a for a in json.loads((TOP / 'tiles.json').read_text())}
for n in sys.argv[2:]:
    T = np.array(Image.open(TOP / f'top{n}.png').convert('RGB')).astype(int)
    P = np.array(Image.open(TOP / f'top{n}_paint.png').convert('RGB')).astype(int)
    A = np.array(Image.open(OUT / f'after{n}.png').convert('RGB')).astype(int)
    painted = np.abs(P - T).sum(2) > 30
    P = P.copy(); P[np.abs(P - [181, 230, 29]).sum(2) < 15] = [128, 176, 91]   # 黄緑で塗った所は緑地の色
    painted[:, :75] = painted[:, -75:] = False   # となりの絵の受け持ち
    bad = (np.abs(A - P).sum(2) > 40) & painted
    import cv2
    bad2 = cv2.morphologyEx(bad.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)   # 1〜2pxの縁は除く
    print(n, '塗った所', painted.sum(), 'ズレ', bad2.sum(), f'{100 * bad2.sum() / max(1, painted.sum()):.1f}%')
    v = A.copy(); v[bad2] = [255, 0, 255]
    Image.fromarray(v.astype(np.uint8)).save(OUT / f'check{n}.png')
