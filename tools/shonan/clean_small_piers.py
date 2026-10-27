"""湘南: 60m² 未満のコンクリート(護岸・桟橋)の小さな破片を全域から消し、いちばん接している周りの種類(海・砂浜など)で埋める。
python3 tools/shonan/clean_small_piers.py → make_foam.py → build_surfaces.py
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, shape, FILE
from shapely.ops import unary_union

d = json.loads(FILE.read_text()); M = Map(d)
small = [shape(q) for q in d['piers'] if shape(q).area < 60]
d['piers'] = [q for q in d['piers'] if shape(q).area >= 60]
kinds = {k: unary_union([shape(q) for q in d[k]]) for k in ('beaches', 'parks', 'woods', 'lots', 'parking')}
kinds['sea'] = M.water(sea_only=True)
count = {}
for g in small:
    ring = g.buffer(1.5).difference(g)
    best = max(kinds, key=lambda k: ring.intersection(kinds[k]).area)
    if ring.intersection(kinds[best]).area < 0.5: best = 'ground'
    M.put(g, best, clear=False); count[best] = count.get(best, 0) + 1
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('小さなコンクリート片', len(small), '個 →', count)
