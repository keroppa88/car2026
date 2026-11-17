# 塗ってもらった周回の線(赤)を、道路に沿ったデモ用の道すじにする。
# 使い方: python3 paint_to_route.py 塗った画像 下絵(make_paint_map.py の出力) 出力json
# 塗った画像は下絵を縮小しただけのもの(位置ずれ無し)を想定。念のため位相相関で確かめる。
import json, sys, math, heapq
import numpy as np, cv2, os
DEBUG = os.environ.get('DEBUG')
PAINT, BASE, OUT = sys.argv[1:4]
meta = json.load(open(BASE.rsplit('.', 1)[0] + '_meta.json'))
d = json.load(open('map/nihonbashi-city.json'))
pa = cv2.imread(PAINT); H, W = pa.shape[:2]
base = cv2.resize(cv2.imread(BASE), (W, H), interpolation=cv2.INTER_AREA)
(sx_, sy_), resp = cv2.phaseCorrelate(cv2.cvtColor(pa, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.cvtColor(base, cv2.COLOR_BGR2GRAY).astype(np.float32))
assert abs(sx_) < 1 and abs(sy_) < 1, ('ずれ', sx_, sy_)
red = lambda im: (im[..., 2].astype(int) > 190) & (im[..., 1] < 130) & (im[..., 0] < 110) & (im[..., 2].astype(int) - im[..., 1] > 100)
mask = red(pa)   # スタート印(下絵の赤)は道すじの上にあるのでそのまま使う
mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
kx, kz = meta['w'] * meta['m_per_px'] / W, meta['h'] * meta['m_per_px'] / H     # 1px あたりの m
dist = cv2.distanceTransform((1 - mask).astype(np.uint8), cv2.DIST_L2, 5) * kx       # 塗りからの距離(m)
def dpaint(x, z):
    px, py = int((x - meta['x0']) / kx), int((z - meta['z0']) / kz)
    return float(dist[py, px]) if 0 <= px < W and 0 <= py < H else 1e9
# 輪の順番: 太らせた塗りの内側の輪郭
ring = cv2.dilate(mask, np.ones((3, 3), np.uint8))
cs, hier = cv2.findContours(ring, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
inner = max((c for c, h in zip(cs, hier[0]) if h[3] >= 0), key=cv2.contourArea)
loop = [(meta['x0'] + p[0][0] * kx, meta['z0'] + p[0][1] * kz) for p in inner]
# 道路網(一方通行はなるべく守る、首都高は除く)
SKIP = {'footway', 'path', 'track', 'steps', 'pedestrian', 'motorway', 'motorway_link'}
key = lambda p: (round(p[0] * 2), round(p[1] * 2))
pos, adj = {}, {}
for r in d['roads']:
    if r['kind'] in SKIP: continue
    pts = r['pts']
    for a, b in zip(pts, pts[1:]):
        ka, kb = key(a), key(b); pos[ka] = a; pos[kb] = b
        L = math.dist(a, b); m = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        c = L * (1 + (max(0, dpaint(*m) - 8) / 3) ** 2)
        adj.setdefault(ka, []).append((kb, c))
        adj.setdefault(kb, []).append((ka, c if not r['oneway'] else c * 3))   # 一方通行の逆走は 3 倍高くつく(禁止はしない)
# 地図データで道が途切れている所(中央分離帯の手前で終わる道など)は、塗りの近くなら 30m までつなぐ
onp = [k for k in pos if dpaint(*pos[k]) < 10]
for u in onp:
    for v in onp:
        L = math.dist(pos[u], pos[v])
        if 0 < L < 30 and v not in [x for x, _ in adj.get(u, [])]:
            adj.setdefault(u, []).append((v, L * 3)); adj.setdefault(v, []).append((u, L * 3))
def reach(s, g):
    seen = {s}; st = [s]
    while st:
        u = st.pop()
        for v in g.get(u, ()):
            v = v[0] if isinstance(v, tuple) and len(v) == 2 and isinstance(v[1], float) else v
            if v not in seen: seen.add(v); st.append(v)
    return seen
s0 = min(pos, key=lambda k: math.dist(pos[k], (398.4, -685.4)))
radj = {}
for u, vs in adj.items():
    for v, _ in vs: radj.setdefault(v, []).append(u)
ok = reach(s0, adj) & reach(s0, radj)   # スタートから行けて、戻ってこられる所だけ
nodes = [k for k in pos if k in ok]; P = np.array([pos[k] for k in nodes])
near = lambda x, z: nodes[int(np.argmin((P[:, 0] - x) ** 2 + (P[:, 1] - z) ** 2))]
def dijkstra(s):
    D = {s: 0}; prev = {}; q = [(0, s)]
    while q:
        c, u = heapq.heappop(q)
        if c > D[u]: continue
        for v, w in adj.get(u, []):
            if c + w < D.get(v, 1e18): D[v] = c + w; prev[v] = u; heapq.heappush(q, (c + w, v))
    return D, prev
PD = np.array([dpaint(*pos[k]) for k in nodes])
# 進む向き: スタートの向き(西北西)に合わせて輪の向きを決める
SX, SZ, SH = 398.4, -685.4, -2.035
i0 = min(range(len(loop)), key=lambda i: math.dist(loop[i], (SX, SZ)))
j = (i0 + 20) % len(loop)
if (loop[j][0] - loop[i0][0]) * math.sin(SH) + (loop[j][1] - loop[i0][1]) * math.cos(SH) < 0: loop = loop[::-1]; i0 = len(loop) - 1 - i0
loop = loop[i0:] + loop[:i0]
# 輪を 250m おきに区切り、区切りごとに最短路でつなぐ。塗りから外れる道はとても高くつく。
# その場での折り返し(Uターン)はなるべくしない。区切りの近く(45m以内)で、塗った道を通って着く点のうち、いちばん安く着ける点へ。
def dijkstra2(s, sp):
    D = {(sp, s): 0}; prev = {}; q = [(0, sp, s)]
    while q:
        c, pu, u = heapq.heappop(q)
        if c > D[(pu, u)]: continue
        for v, w in adj.get(u, []):
            if v == pu: w += 500   # その場での折り返しはなるべくしない
            st = (u, v)
            if c + w < D.get(st, 1e18): D[st] = c + w; prev[st] = (pu, u); heapq.heappush(q, (c + w, u, v))
    return D, prev
wps, acc = [], 0
for a, b in zip(loop, loop[1:]):
    acc += math.dist(a, b)
    if acc >= 250: wps.append(b); acc = 0
hx, hz = math.sin(SH), math.cos(SH)
# 出だしの向き: スタートから前へ進む隣の点を「ひとつ前」とみなさないよう、後ろ側の隣を前の点にする
behind = min(adj, key=lambda k: math.dist(pos[k], (SX - hx * 15, SZ - hz * 15)))
state = (behind, s0); route = [s0]
for w in wps + [None]:
    D, prev = dijkstra2(state[1], state[0])
    if w is None: goal = [k for k in D if k[1] == s0 and k != state]
    else:
        near_ = {nodes[i] for i in np.nonzero(((P[:, 0] - w[0]) ** 2 + (P[:, 1] - w[1]) ** 2 < 45 ** 2) & (PD < 4))[0]}
        goal = [k for k in D if k[1] in near_ and dpaint(*pos[k[0]]) < 4]   # 塗った道を通って着く
    if not goal: continue
    g = min(goal, key=lambda k: D[k])
    seg = [g]
    while seg[-1] != state: seg.append(prev[seg[-1]])
    route += [st[1] for st in seg[::-1][1:]]; state = g
    if DEBUG and D[g] > 3000: print([[round(v) for v in pos[st[1]]] + [round(dpaint(*pos[st[1]]))] for st in seg[::-1]][:30])
    if DEBUG: print(w and [round(v) for v in w], round(D[g]), round(sum(math.dist(pos[a[1]], pos[b[1]]) for a, b in zip(seg, seg[1:]))))
route = route[:-1]
if DEBUG: json.dump({'wps': wps, 'loop': loop[::10]}, open('/tmp/claude-0/-home-claude/0561a10a-9173-57c4-885b-5a9b3770069e/scratchpad/tk/dbg.json', 'w'))
pts = [pos[k] for k in route]
# 行き戻り(枝の往復)を取り除く
out = []
for p in pts:
    if len(out) >= 2 and math.dist(out[-2], p) < 1e-6: out.pop(); continue
    if out and math.dist(out[-1], p) < 1e-6: continue
    out.append(p)
# 細かな折り返し(とがった所)を削る
def cosang(a, b, c):
    v1 = (b[0] - a[0], b[1] - a[1]); v2 = (c[0] - b[0], c[1] - b[1])
    return (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2) + 1e-9)
changed = True
while changed:
    changed = False
    n = len(out) - 1   # 最後はスタートに戻る点
    for i in range(1, n):
        if cosang(out[i - 1], out[i], out[i + 1]) < -0.3:
            if DEBUG: print('折り返しを削る', [round(v) for v in out[i]])
            del out[i]; changed = True; break
L = sum(math.dist(a, b) for a, b in zip(out, out[1:]))
far = max(dpaint(*p) for p in out)
json.dump({'loop': [[round(x, 2), round(z, 2)] for x, z in out[:-1]]}, open(OUT, 'w'))
print('点', len(out), '長さ', round(L), 'm  塗りから最大', round(far, 1), 'm')
