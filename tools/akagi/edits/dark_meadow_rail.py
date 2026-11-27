"""赤城山: 指示(2026-11-27 19:22)。黄緑 = この範囲は草原の明るい色をやめて、まわりと同じ濃い緑に(darkAreas)。
赤線(-1583,1752 〜 -1595,1757.75) = ガードレールをつなぐ(終点の手前、railL の 2074・2075 を 1 に)。"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; FILE = ROOT / 'map/akagi-course.json'
DARK = [(-168.5,1.75),(-230.25,22.75),(-284.75,54),(-318.5,98.75),(-341,124.75),(-357.25,170.25),(-356.5,200.5),(-369,220.5),(-406,114.25),(-436.5,74.75),(-468,15.75),(-418.75,-49.5),(-236.75,-25.75),(-162.25,-12.25)]
d = json.loads(FILE.read_text())
d.setdefault('darkAreas', []).append([list(p) for p in DARK])
for i in (2074, 2075): d['railL'][i] = 1
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
# ガードレールのすき間は駐車場の出入口として開けていた所だったので、railForce = [[2073, 2076, 1]] でつなぐ(akagi-map.js の railAt)
