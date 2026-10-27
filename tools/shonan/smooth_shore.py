"""湘南: 砂浜の波打ち際(砂浜と海の境目)をなめらかにする。全域。
ギザギザの歯・小さな切れ込みや出っ張りを、丸みのある線にならす。砂浜以外の岸(護岸・港)は触らない。
python3 tools/shonan/smooth_shore.py → make_foam.py → build_surfaces.py
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from edit_batch2 import Map, shape, FILE, LAND_KINDS
from shapely.ops import unary_union

R = 8.0   # この半径より小さい凸凹をならす

def main():
    d = json.loads(FILE.read_text()); M = Map(d)
    land = unary_union([shape(q) for k in LAND_KINDS for q in d[k]])
    sea = M.water(sea_only=True).difference(land)          # 見えている海
    beach = unary_union([shape(q) for q in d['beaches']])
    zone = sea.boundary.intersection(beach.buffer(2)).buffer(3 * R)   # 砂浜の波打ち際の近くだけ
    smooth = sea.buffer(R).buffer(-2 * R).buffer(R)        # 閉じて開く: 両方向の小さな凸凹を取る
    grow = smooth.difference(sea).intersection(zone).intersection(beach)    # 砂浜の歯 → 海
    shrink = sea.difference(smooth).intersection(zone)                       # 海の切れ込み → 砂浜
    grow = grow.buffer(0.3).buffer(-0.3); shrink = shrink.buffer(0.3).buffer(-0.3)
    M.put(grow, 'sea')
    M.put(shrink, 'beaches')
    FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
    print('砂浜→海', round(grow.area), 'm²  海→砂浜', round(shrink.area), 'm²')

if __name__ == '__main__':
    main()
