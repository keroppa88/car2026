"""赤城山: 8 回目の指示(2026-11-27 18:12)。水色の範囲だけ水平に。高さは赤線(-75.75,45.75 〜 -93.25,64.25)の地面の高さの平均(411.16、ゲームで測った値)。
まわりとの高低差は外へ 8m のなめらかな斜面でつなぐ(地形そのものを変える flattenAreas)。
python3 tools/akagi/edits/visitor_center8.py
"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
BLUE = [(-77.75,48.5),(-88.75,59.75),(-95.25,60.75),(-105.75,53.75),(-114.75,44.5),(-115,38.75),(-105.75,28.5),(-91.75,32.5),(-81,39.75)]
d = json.loads(FILE.read_text())
d.setdefault('flattenAreas', []).append({'pts': [list(p) for p in BLUE], 'y': 411.16, 'blend': 8})
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
