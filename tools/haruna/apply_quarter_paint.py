"""榛名山: 4 分けの全体図(haruna_11_上左.jpg など、1 画素 0.25m)に塗った絵を入れる。絵は切り抜き・縮小されていてもよい
(下絵と特徴点で合わせ、ずれは 1 画素以下になることを確かめる)。
  赤線   = ガードレールを残す。塗った範囲の中で、赤の無い所はガードレールを外す   → railL / railR
  水色   = アスファルトを足す(待避所・横道)                                    → aprons
  オレンジ = 砂の所を足す(待避所・横道)                                        → sands
  水色・オレンジのそばの赤線 = 足した所のふち(道から遠い側)に沿ったガードレール。道と足した所の間の赤は使わない → extraRails
  黄緑の線 = 展望台のウッドデッキと木の柵(線の道から遠い側にデッキ)         → decks(折れ線)
python3 tools/haruna/apply_quarter_paint.py 絵 下絵(4 分けの 1 枚) [絵 下絵 ...]
"""
import json, sys, math
from pathlib import Path
import numpy as np, cv2
from scipy import ndimage
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize
ROOT = Path(__file__).resolve().parents[2]
CJ = ROOT / 'map/haruna-course.json'; data = json.loads(CJ.read_text())
Q = {q['name']: q for q in json.load(open(ROOT / 'tools/haruna/paint/top_quarters.json'))}
R = np.array(data['route']); n = len(R); EDGE = 3.6 + 0.9
tan = np.gradient(R[:, [0, 2]], axis=0); tan /= np.linalg.norm(tan, axis=1, keepdims=True); NRM = np.c_[tan[:, 1], -tan[:, 0]]   # 進む向きの左
tree = cKDTree(R[:, [0, 2]])
args = sys.argv[1:]; summary = []
for paint, base in zip(args[::2], args[1::2]):
    q = Q[Path(base).name]; K = q['m_per_px']
    P = cv2.imread(paint); B = cv2.imread(base)
    s = 0.35; Bs = cv2.resize(B, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    sift = cv2.SIFT_create(8000); k1, d1 = sift.detectAndCompute(cv2.cvtColor(P, cv2.COLOR_BGR2GRAY), None); k2, d2 = sift.detectAndCompute(cv2.cvtColor(Bs, cv2.COLOR_BGR2GRAY), None)
    g = [a for a, c in cv2.BFMatcher().knnMatch(d1, d2, k=2) if a.distance < 0.75 * c.distance]
    A, inl = cv2.estimateAffinePartial2D(np.float32([k1[a.queryIdx].pt for a in g]), np.float32([k2[a.trainIdx].pt for a in g]), method=cv2.RANSAC, ransacReprojThreshold=3)
    A[:, :] /= s   # 絵の画素 → 下絵の画素
    Bw = cv2.warpAffine(B, cv2.invertAffineTransform(A), (P.shape[1], P.shape[0]), flags=cv2.INTER_AREA)
    (sx, sy), _ = cv2.phaseCorrelate(cv2.cvtColor(P, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.cvtColor(Bw, cv2.COLOR_BGR2GRAY).astype(np.float32))
    assert abs(sx) < 1 and abs(sy) < 1, ('ずれている', sx, sy)
    Pi = P.astype(int); d = np.abs(Pi - Bw.astype(int)).sum(2); b_, g_, r_ = Pi[..., 0], Pi[..., 1], Pi[..., 2]
    def clean(m, area):
        k, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8)); out = np.zeros_like(m)
        for j in range(1, k):
            if st[j, cv2.CC_STAT_AREA] >= area: out |= lab == j
        return out
    red = clean((d > 60) & (r_ > 150) & (g_ < 110) & (b_ < 110) & (r_ - g_ > 70), 25)
    ora = clean((d > 80) & (r_ > 200) & (g_ > 140) & (b_ < 90), 15)
    blu = clean((d > 80) & (b_ > 180) & (g_ > 170) & (r_ < 190), 15)
    lim = clean((d > 80) & (g_ > 190) & (r_ > 140) & (b_ < 90) & (r_ < 220), 40)
    have = (np.abs(Bw.astype(int) - (40, 44, 40)).sum(2) > 12)   # 下絵の区画のある所(暗い灰色でない)
    sc = math.hypot(A[0, 0], A[1, 0]) * K                         # 絵の 1 画素 = 何 m
    toW = lambda u, v: (q['x0'] + (A[0, 0] * u + A[0, 1] * v + A[0, 2]) * K, q['z0'] + (A[1, 0] * u + A[1, 1] * v + A[1, 2]) * K)
    Ai = cv2.invertAffineTransform(A)
    toP = lambda x, z: (Ai[0, 0] * (x - q['x0']) / K + Ai[0, 1] * (z - q['z0']) / K + Ai[0, 2], Ai[1, 0] * (x - q['x0']) / K + Ai[1, 1] * (z - q['z0']) / K + Ai[1, 2])
    # 多角形(水色・オレンジ)
    polys = {}
    for key, m in (('aprons', blu), ('sands', ora)):
        mm = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        cs, _ = cv2.findContours(mm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE); polys[key] = []
        for c in cs:
            if cv2.contourArea(c) < 12: continue
            c = cv2.approxPolyDP(c, 0.8, True)
            polys[key].append([[round(v, 2) for v in toW(p[0][0] + 0.5, p[0][1] + 0.5)] for p in c])
        data[key] = data.get(key, []) + polys[key]
    area = (blu | ora); near_area = ndimage.distance_transform_edt(~area) * sc < 4.0
    # 道の中心からの距離(絵の画素ごと)
    H_, W_ = red.shape; ys, xs = np.nonzero(red)
    wx, wz = toW(xs, ys); dc, _ = tree.query(np.c_[wx, wz])
    _, ii = tree.query(np.c_[wx, wz]); toward = np.c_[R[ii, 0] - wx, R[ii, 2] - wz]; toward /= np.linalg.norm(toward, axis=1, keepdims=True) + 1e-9
    def in_area(ox, oz):
        uu, vv = toP(wx + ox, wz + oz); uu = np.clip(np.round(uu).astype(int), 0, W_ - 1); vv = np.clip(np.round(vv).astype(int), 0, H_ - 1); return area[vv, uu]
    road_side_in = in_area(toward[:, 0] * 2, toward[:, 1] * 2)      # 道の側が足した所 → ふち(外)の赤
    far_side_in = in_area(-toward[:, 0] * 2, -toward[:, 1] * 2)     # 外の側が足した所 → 道と足した所の間の赤(使わない)
    na = near_area[ys, xs] & (dc > EDGE + 0.5)
    keep = na & road_side_in & ~far_side_in; drop = na & far_side_in
    extra = np.zeros_like(red); extra[ys[keep], xs[keep]] = True
    gone = np.zeros_like(red); gone[ys[drop], xs[drop]] = True
    normal = red & ~extra & ~gone
    # ガードレール(道ぞい): 塗った範囲の中の点だけ
    cnt = [0, 0, 0]
    for i in range(n):
        u, v = toP(R[i, 0], R[i, 2])
        if not (0 <= u < W_ and 0 <= v < H_) or not have[int(v), int(u)]: continue
        cnt[2] += 1
        for side, key in ((1, 'railL'), (-1, 'railR')):
            hit = False; beside = False
            for o in np.arange(3.0, 10.01, 0.25):
                uu, vv = toP(R[i, 0] + NRM[i, 0] * side * o, R[i, 2] + NRM[i, 1] * side * o); uu, vv = int(round(uu)), int(round(vv))
                if 0 <= uu < W_ and 0 <= vv < H_ and normal[max(0, vv - 1):vv + 2, max(0, uu - 1):uu + 2].any(): hit = True; break
            uu, vv = toP(R[i, 0] + NRM[i, 0] * side * (EDGE + 1.5), R[i, 2] + NRM[i, 1] * side * (EDGE + 1.5))
            if 0 <= int(uu) < W_ and 0 <= int(vv) < H_ and area[int(vv), int(uu)]: beside = True
            data[key][i] = 1 if hit and not beside else 0
            cnt[0 if side > 0 else 1] += hit and not beside
    # 足した所のふちのガードレール: 細線にして、端から端へたどる
    def trace(mask, minlen=4):
      sk = skeletonize(cv2.dilate(mask.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
      lab, k = ndimage.label(sk, np.ones((3, 3)))
      lines = []
      for j in range(1, k + 1):
          pts = np.argwhere(lab == j)
          if len(pts) * sc < minlen: continue
          idx = {tuple(p): t for t, p in enumerate(pts)}
          nb = [[idx[(p[0] + a, p[1] + b)] for a in (-1, 0, 1) for b in (-1, 0, 1) if (a or b) and (p[0] + a, p[1] + b) in idx] for p in pts]
          def far(s0):
              dist = {s0: 0}; prev = {s0: None}; fr = [s0]
              while fr:
                  nx = []
                  for u in fr:
                      for w in nb[u]:
                          if w not in dist: dist[w] = dist[u] + 1; prev[w] = u; nx.append(w)
                  fr = nx
              e = max(dist, key=dist.get); return e, prev
          e1, _ = far(0); e2, prev = far(e1)
          path = []; u = e2
          while u is not None: path.append(pts[u]); u = prev[u]
          c = cv2.approxPolyDP(np.array([[p[1], p[0]] for p in path], np.float32).reshape(-1, 1, 2), max(0.5, 0.4 / sc), False)
          lines.append([[round(v, 2) for v in toW(p[0][0], p[0][1])] for p in c])
      return lines
    lines = trace(extra)
    decks = trace(lim, 3)
    data['decks'] = data.get('decks', []) + decks
    data['extraRails'] = data.get('extraRails', []) + lines
    summary.append({'絵': Path(paint).name, '1画素m': round(sc, 3), 'ずれ': (round(sx, 2), round(sy, 2)), '道の点': cnt[2], '残す左右': cnt[:2], 'aprons': len(polys['aprons']), 'sands': len(polys['sands']), 'extraRails': len(lines), 'decks': len(decks)})
# 9m より短いガードレールの切れはしは外す
for key in ('railL', 'railR'):
    f = data[key]; i = 0
    while i < n:
        if f[i] == 1:
            j = i
            while j + 1 < n and f[j + 1] == 1: j += 1
            if j - i + 1 < 3:
                for t in range(i, j + 1): f[t] = 0
            i = j + 1
        else: i += 1
CJ.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
for s_ in summary: print(s_)
