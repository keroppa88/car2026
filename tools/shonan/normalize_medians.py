"""湘南: 上下線(逆向きの一方通行2本)のあいだ=中央分離帯を、全域で同じ作りにそろえる。
すき間の全幅を緑地(2m ごとの短い長方形)で埋め、その中にあった歩道の帯(strips)や形の違う緑地は消す。
建物をはさむ所・橋の上とたもと(12m)・指示で緑地を消した所は除く。
python3 tools/shonan/normalize_medians.py → build_surfaces.py
"""
import json, math
from pathlib import Path
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree
from shapely.ops import unary_union
FILE = Path(__file__).resolve().parents[2] / 'map/shonan-city.json'
d = json.loads(FILE.read_text())
for _pass in range(2):
  R = d['roads']
  W = lambda r: 4.5 if r.get('lanes') == 1 and not r.get('oneway') else r.get('lanes', 2) * 3.25
  lines = [LineString(r['pts']) for r in R]
  polys = [l.buffer(W(r) / 2, cap_style=2, join_style=2) for l, r in zip(lines, R)]
  tp = STRtree(polys)
  bl = [Polygon(b['p']).buffer(0) for b in d['buildings']]; tb = STRtree(bl)
  BR = unary_union([l for l, r in zip(lines, R) if r.get('bridge')])
  NOFILL = unary_union([LineString([(6062, 251), (6189, 321), (6408, 267)]).buffer(30),
      LineString([(-5090, -677), (-4996, -697), (-4940, -686), (-4869, -708), (-4777, -766)]).buffer(30),
      Point(8248, 483).buffer(25), Point(6450, 240).buffer(25), Point(1565, -1105).buffer(40), Point(-8690, -26).buffer(60)])
  def intervals(p, n, maxd=45):
      ray = LineString([p, (p[0] + n[0] * maxd, p[1] + n[1] * maxd)]); out = []
      for j in tp.query(ray):
          x = ray.intersection(polys[j])
          for g in getattr(x, 'geoms', [x]):
              if g.is_empty or g.geom_type != 'LineString': continue
              ds = sorted(math.hypot(c[0] - p[0], c[1] - p[1]) for c in g.coords); out.append((ds[0], ds[-1], j))
      out.sort(); return out
  pieces, quads = [], []
  for i, r in enumerate(R):
      if not r.get('oneway') or r.get('bridge'): continue
      L = lines[i]
      for k in range(int(L.length // 2)):
          s = k * 2 + 1; p = L.interpolate(s); a = L.interpolate(max(0, s - 1)); b = L.interpolate(min(L.length, s + 1))
          dx, dz = b.x - a.x, b.y - a.y; l = math.hypot(dx, dz) or 1; dx, dz = dx / l, dz / l
          nx, nz = -dz, dx   # 進む向きの右 = 中央分離帯の側(左側通行)
          if NOFILL.contains(p) or BR.distance(p) < 12: continue
          e1 = 0
          for a3, b3, j in intervals((p.x, p.y), (nx, nz)):
              if a3 <= e1 + 0.05: e1 = max(e1, b3); continue
              if R[j]['kind'] in ('service', 'residential', 'unclassified', 'track', 'living_street') and not R[j].get('oneway'): continue   # 分離帯の中の細い道は飛ばして向こうを見る
              if not R[j].get('oneway'): break
              Lj = lines[j]; sj = Lj.project(p); c1 = Lj.interpolate(max(0, sj - 1)); c2 = Lj.interpolate(min(Lj.length, sj + 1))
              ex, ez = c2.x - c1.x, c2.y - c1.y; el = math.hypot(ex, ez) or 1
              if (ex * dx + ez * dz) / el > -0.8: break
              gl = LineString([(p.x + nx * e1, p.y + nz * e1), (p.x + nx * a3, p.y + nz * a3)])
              if any(bl[q].intersects(gl) for q in tb.query(gl)): break
              w = a3 - e1
              if 0.5 < w < 38:
                  m = (a3 + e1) / 2
                  pieces.append([round(p.x + nx * m, 2), round(p.y + nz * m, 2), round(math.atan2(dx, dz), 4), 2.1, round(w - 0.1, 2), 1])
                  quads.append(gl.buffer(1.2, cap_style=2))
              break
  zone = unary_union(quads)
  # 中央分離帯の中を走る細い道(6割以上が中)は消して、もう一度
  drop = [r for r in R if r['kind'] in ('service', 'residential', 'unclassified', 'track', 'living_street') and LineString(r['pts']).intersection(zone).length > 0.6 * LineString(r['pts']).length]
  if not drop: break
  print('中央分離帯の中の細い道を消した', len(drop)); d['roads'] = [r for r in R if not any(r is x for x in drop)]
grid, uniq = {}, []
for m in pieces:
    k = (round(m[0] / 0.6), round(m[1] / 0.6))
    if any((k[0] + a, k[1] + b) in grid for a in (-1, 0, 1) for b in (-1, 0, 1)): continue
    grid[k] = 1; uniq.append(m)
keep = []   # 上下線のあいだ以外に残った古い緑地(はみ出し)は全部消す
bs = len(d['strips']); d['strips'] = [m for m in d['strips'] if not zone.contains(Point(m[0], m[1]))]
print('中央分離帯', len(d['medians']), '→', len(keep) + len(uniq), '(作り直し', len(uniq), ')  帯を消した', bs - len(d['strips']))
d['medians'] = keep + uniq
FILE.write_text(json.dumps(d, ensure_ascii=False, separators=(',', ':')))
