"""湘南: 行き止まりの短い道路を、分かれる所から消す(全域)。
行き止まりの端から、道路が分かれる点(3本以上が集まる点)までたどり、その長さが 100m 以内なら消す。
幹線(trunk・primary・secondary とその取り付け)・橋は消さない。1回だけ(消した結果できた新しい行き止まりは消さない)。
python3 tools/shonan/prune_stubs.py → make_lamps.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from collections import defaultdict
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); R = d['roads']
K = lambda p: (round(p[0], 1), round(p[1], 1))
MAJOR = ('trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link')
adj = defaultdict(set)          # 点 → (道路, 区間番号)
for ri, r in enumerate(R):
    for i in range(len(r['pts']) - 1): adj[K(r['pts'][i])].add((ri, i)); adj[K(r['pts'][i + 1])].add((ri, i))
deg = {k: len(v) for k, v in adj.items()}
def other(ri, i, k):
    a, b = K(R[ri]['pts'][i]), K(R[ri]['pts'][i + 1]); return b if a == k else a
gone = set(); total = 0; n = 0
for k0, e0 in list(adj.items()):
    if deg[k0] != 1: continue
    path, k, prev, L, ok = [], k0, None, 0.0, True
    while True:
        es = [e for e in adj[k] if e != prev]
        if not es: break
        e = es[0]; ri, i = e
        if R[ri]['kind'] in MAJOR or R[ri].get('bridge'): ok = False; break
        path.append(e); L += math.dist(R[ri]['pts'][i], R[ri]['pts'][i + 1]); prev = e
        k = other(ri, i, k)
        if deg[k] != 2 or L > 100: break
    if ok and path and L <= 100 and deg[k] >= 3:
        gone |= set(path); total += L; n += 1
# 区間を消して、道路を残りの続く部分に分け直す
out = []
for ri, r in enumerate(R):
    segs = [i for i in range(len(r['pts']) - 1) if (ri, i) not in gone]
    if len(segs) == len(r['pts']) - 1: out.append(r); continue
    runs, cur = [], []
    for i in segs:
        if cur and i != cur[-1] + 1: runs.append(cur); cur = []
        cur.append(i)
    if cur: runs.append(cur)
    for run in runs:
        pts = r['pts'][run[0]: run[-1] + 2]
        q = {k: v for k, v in r.items() if k not in ('pts', 'junctions')}
        q['pts'] = pts; q['junctions'] = [j - run[0] for j in r['junctions'] if run[0] <= j <= run[-1] + 1]
        out.append(q)
# 交差点の印をつけ直す(残った道路どうしで共有する点)
cnt = defaultdict(int)
for r in out:
    for p in r['pts']: cnt[K(p)] += 1
for r in out:
    r['junctions'] = sorted({j for j in r['junctions'] if cnt[K(r['pts'][j])] >= 2} | {j for j, p in enumerate(r['pts']) if cnt[K(p)] >= 2 and (j == 0 or j == len(r['pts']) - 1)})
d['roads'] = out
# 指示(8565,451 付近): 左から来る道を、右の幹線の交差点(8617,431)へまっすぐつなぐ
for r in out:
    if abs(r['pts'][0][0] - 8565) < 1.5 and abs(r['pts'][0][1] - 451) < 1.5 and r['kind'] == 'unclassified':
        r['pts'].insert(0, [8617.1, 431.0]); r['junctions'] = sorted({0} | {j + 1 for j in r['junctions']}); print('8565,451 の道を交差点へつないだ')
print('行き止まりの短い道', n, '本', round(total), 'm を消した  道路', len(R), '→', len(out))
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
