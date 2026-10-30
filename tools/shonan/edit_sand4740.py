"""湘南 -4740,-452: 港の角の砂浜のかけら(三角)を消して海にする。岸壁にははみ出さない。"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, FILE
from shapely.geometry import Polygon, box
from shapely.ops import unary_union
d = json.loads(FILE.read_text())
B = box(-4770, -470, -4730, -440)
small = lambda q: Polygon(q['o']).buffer(0).area < 100 and Polygon(q['o']).buffer(0).within(B)
frag = unary_union([Polygon(q['o']).buffer(0) for q in d['beaches'] if small(q)])
d['beaches'] = [q for q in d['beaches'] if not small(q)]
solid = unary_union([Polygon(q['o'], q.get('h', [])).buffer(0) for k in ('piers', 'lots', 'parks', 'parking') for q in d[k] if Polygon(q['o']).buffer(0).intersects(B)])
fill = frag.buffer(0.6).difference(solid)
M = Map(d); M.put(fill, 'sea')
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('海にした', round(fill.area), 'm²')
