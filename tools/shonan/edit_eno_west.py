"""江の島対岸の西端(港の防波堤と砂浜の間): 指示画像のとおりに 海/コンクリート/砂浜 を置き換える。
防波堤の四角い出っ張りを消し、防波堤と砂浜の間の水路を海へ開け、砂浜の縁をなめらかに。
画像: 真上から(カメラ 6380,500,440)の 1280x720 描画。画素→世界: x = 6893.2 - 0.8018*px, z = 424.06 - 0.8018*(py-380)
"""
import sys, json
from pathlib import Path
import numpy as np, cv2
from PIL import Image
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE

IMG = sys.argv[1]
K = 0.8018
def world(px, py): return (6893.2 - K * px, 424.06 - K * (py - 380))
a = np.asarray(Image.open(IMG).convert('RGB')).astype(int)
X0, X1, Y0, Y1 = 0, 210, 370, 600            # 指示のある範囲(道路より上)
sub = a[Y0:Y1, X0:X1]
pal = {'sea': (75, 120, 118), 'piers': (178, 180, 176), 'beaches': (246, 230, 188)}
dist = {k: np.abs(sub - np.array(v)).sum(2) for k, v in pal.items()}
best = np.argmin(np.stack(list(dist.values())), 0); kinds = list(pal)
d = json.loads(FILE.read_text()); M = Map(d)
regs = {}
for i, k in enumerate(kinds):
    m = ((best == i) & (dist[k] < 90)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    cs, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    ps = []
    for j, c in enumerate(cs):
        if hier[0][j][3] != -1 or len(c) < 3: continue
        f = lambda c: [world(p[0][0] + X0 + .5, p[0][1] + Y0 + .5) for p in c]
        hs = [f(cs[h]) for h in range(len(cs)) if hier[0][h][3] == j and len(cs[h]) >= 3]
        g = Polygon(f(c), hs).buffer(0)
        if g.area > 4: ps.append(g)
    regs[k] = unary_union(ps).buffer(0.8, join_style=2).buffer(-0.8, join_style=2).simplify(0.5)
    print(k, round(regs[k].area))
for k in ('beaches', 'piers', 'sea'):   # 海を最後に(水路を確実に開ける)
    M.put(regs[k], k)
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
