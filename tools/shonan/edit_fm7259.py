"""湘南 -7259,-541: ファミリーマート(白い壁に緑・白・青の帯、高さ 4.5m)。
-7255,-547 の隣の白いビル: グレーの3階建てアパート(高さ 10.5m、今のおよそ半分)。"""
import json
from pathlib import Path
from shapely.geometry import Polygon, Point
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text()); B = d['buildings']
def at(x, z, amin, amax):
    return next(b for b in B if Polygon(b['p']).buffer(0.5).contains(Point(x, z)) and amin < Polygon(b['p']).area < amax)
fm = at(-7259, -541, 150, 200); fm.update(h=4.5, conbini=1); fm.pop('white', None)
ap = at(-7229, -535, 380, 440); ap.update(h=10.5, grey=1); ap.pop('white', None)
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
print('ok')
