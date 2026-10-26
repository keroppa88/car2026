"""現在の表示形状を、重ならない Three.js 地表へ固定する。

python tools/shonan/build_surfaces.py
必要: Python 3, numpy, shapely>=2.1, Node.js。元の GLB/OSM は不要。
道路・白線は表示用 JS の生成関数を共有し、最終の面を色ごとに切り分ける。
"""
from pathlib import Path
import colorsys
import hashlib
import gzip
import json
import math
import subprocess
import pickle
import tempfile
import os
import faulthandler
import numpy as np
import shapely as sg
from shapely.geometry import Polygon, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
CITY = ROOT / 'map/shonan-city.json'
TERRAIN = ROOT / 'map/shonan-terrain.json'
KINDS = {'land': 0, 'road': 1, 'sand': 2, 'water': 3}
GRID = 0.0001  # 0.1mm。座標は最終メッシュでもタイル原点からの相対値で保持。

def clean(g):
    return sg.set_precision(sg.make_valid(g), GRID)

def polys(g):
    if g.geom_type == 'Polygon':
        if g.area > 1e-9:
            yield g
    elif hasattr(g, 'geoms'):
        for p in g.geoms:
            yield from polys(p)

def geometry(layer):
    if 'rings' in layer:
        gs = [clean(Polygon(p['o'], p.get('h', []))) for p in layer['rings'] if len(p['o']) >= 3]
    else:
        arr = np.asarray(layer.get('positions', []), dtype=float).reshape(-1, 3, 3)[:, :, [0, 2]]
        gs = sg.polygons(arr)
        gs = clean(gs[sg.area(gs) > 1e-8])
    return clean(sg.union_all(gs))

def triangles(g):
    out = []
    for p in polys(g):
        for tri in sg.get_parts(sg.constrained_delaunay_triangles(p)):
            out.append(np.asarray(tri.exterior.coords)[:3])
    return np.asarray(out).reshape(-1, 3, 2)

def main():
    if os.environ.get('SHONAN_SURFACE_TRACE'):
        faulthandler.dump_traceback_later(45, repeat=True)
    layers = json.loads(subprocess.check_output(['node', 'tools/shonan/export_surfaces.mjs'], cwd=ROOT))
    city = json.loads(CITY.read_text())
    terrain = json.loads(TERRAIN.read_text())
    tx, tz, c, w, h = [terrain[k] for k in ['x0', 'z0', 'c', 'w', 'h']]
    dem = np.asarray(terrain['d']).reshape(h, w) / 10
    active = np.maximum.reduce([dem[:-1, :-1], dem[1:, :-1], dem[:-1, 1:], dem[1:, 1:]]) >= 0.05
    # 元の表示で使われている島のセルだけ。海を陸へ広げない。
    cell_triangles = []
    runs = []
    for j, row in enumerate(active):
        starts = np.flatnonzero(np.diff(np.r_[False, row, False].astype(int)) == 1)
        ends = np.flatnonzero(np.diff(np.r_[False, row, False].astype(int)) == -1)
        runs.extend(box(tx + a*c, tz + j*c, tx + b*c, tz + (j+1)*c) for a, b in zip(starts, ends))
        for i in np.flatnonzero(row):
            x, z = tx + i*c, tz + j*c
            cell_triangles.extend([Polygon([(x,z), (x+c,z), (x,z+c)]), Polygon([(x+c,z+c), (x,z+c), (x+c,z)])])
    terrain_shape = clean(unary_union(runs))
    cells = np.asarray(cell_triangles, dtype=object)
    cell_tree = sg.STRtree(cells)

    def height(points):
        fx = np.clip((points[..., 0] - tx) / c, 0, w-1-1e-7)
        fz = np.clip((points[..., 1] - tz) / c, 0, h-1-1e-7)
        i, j = np.floor(fx).astype(int), np.floor(fz).astype(int)
        u, v = fx-i, fz-j
        a, b, cc, d = dem[j,i], dem[j,i+1], dem[j+1,i], dem[j+1,i+1]
        return np.where(u+v <= 1, a+(b-a)*u+(cc-a)*v, d+(cc-d)*(1-u)+(b-d)*(1-v))

    regions = []
    cache_key = hashlib.sha256(json.dumps(layers).encode() + TERRAIN.read_bytes()).hexdigest()
    cache = Path(tempfile.gettempdir()) / ('car2026-surface-' + cache_key + '.pickle')
    if cache.exists():
        layers = pickle.loads(cache.read_bytes())
    else:
        for layer in layers:
            layer['geometry'] = terrain_shape if layer['name'] == 'terrain' else geometry(layer)
            print('source', layer['name'], round(layer['geometry'].area), flush=True)
        cache.write_bytes(pickle.dumps(layers))
    expected = clean(sg.union_all([layer['geometry'] for layer in layers]))
    covered = Polygon()
    for layer in reversed(layers):
        g = clean(layer['geometry'].difference(covered))
        if not g.is_empty:
            regions.append({**layer, 'geometry': g})
        print('region', layer['name'], round(g.area), flush=True)
        covered = clean(covered.union(layer['geometry']))
    # 下地を含めた地表が覆い尽くされ、同じ場所に2面ないことを確認。
    area_sum = sum(r['geometry'].area for r in regions)
    # 優先順の差分で区分済み。穴の多い道路を再 union せず、元の被覆と面積で検証。
    union = covered
    assert abs(area_sum-union.area) < 1, ('overlap', area_sum-union.area)
    assert expected.symmetric_difference(union).area < 1, '地表に欠落あり'

    batches = {}
    for layer in regions:
        g = layer['geometry']
        water = layer['kind'] == 'water'
        pieces = [(g, False)] if water else [(clean(g.difference(terrain_shape)), False), (clean(g.intersection(terrain_shape)), True)]
        for geom, on_terrain in pieces:
            if geom.is_empty:
                continue
            step = 1024 if water else 64 if on_terrain else 256
            x0,z0,x1,z1 = geom.bounds
            for ix in range(math.floor(x0/step), math.floor(x1/step)+1):
                for iz in range(math.floor(z0/step), math.floor(z1/step)+1):
                    if os.environ.get('SHONAN_SURFACE_TRACE'): print('tile', layer['name'],on_terrain,ix,iz,flush=True)
                    part = clean(sg.clip_by_rect(geom, ix*step, iz*step, (ix+1)*step, (iz+1)*step))
                    if part.is_empty or part.area < 1e-9:
                        continue
                    if on_terrain:
                        ids = cell_tree.query(part, predicate='intersects')
                        # 島は元の2mセルの三角形の境界でも分け、長い道路が斜面を貫通するのを防ぐ。
                        cut = sg.intersection(cells[ids], part, grid_size=GRID)
                        parts = [triangles(q) for q in cut if not q.is_empty and q.area > 1e-9]
                        pts = np.concatenate(parts) if parts else np.empty((0,3,2))
                    else:
                        pts = triangles(part)
                    if not len(pts):
                        continue
                    ys = height(pts) if on_terrain else np.full(pts.shape[:2], layer.get('y', 0))
                    xyz = np.stack([pts[:,:,0]-ix*step, ys, pts[:,:,1]-iz*step], axis=-1)
                    # Three.js の表面は上向き。
                    signed = (xyz[:,1,2]-xyz[:,0,2])*(xyz[:,2,0]-xyz[:,0,0])-(xyz[:,1,0]-xyz[:,0,0])*(xyz[:,2,2]-xyz[:,0,2])
                    xyz[signed<0] = xyz[signed<0][:,[0,2,1]]
                    if layer['name'] == 'terrain':
                        rgb = []
                        for y in xyz[:,:,1].ravel():
                            if y < 1.2:
                                rgb.append([srgb(v/255) for v in (0xd8,0xc9,0xa3)])
                            else:
                                rgb.append(colorsys.hls_to_rgb(.24+min(.06,y/900), .36-min(.08,y/600), .32))
                        rgb = np.rint(np.asarray(rgb)*255).astype('u1')
                    else:
                        col = layer['color']
                        rgb = np.tile([round(srgb((col>>s & 255)/255)*255) for s in (16,8,0)], (len(xyz)*3,1)).astype('u1')
                    key = (ix*step, iz*step, water, step)
                    batch = batches.setdefault(key, {'p': [], 'c': [], 'k': []})
                    batch['p'].append(xyz.astype('<f4').reshape(-1,3))
                    batch['c'].append(rgb)
                    batch['k'].append(np.full(len(xyz), KINDS[layer['kind']], dtype='u1'))
        print('partitioned',layer['name'],flush=True)

    blob = bytearray()
    chunks = []
    area_mesh = 0.
    def put(arr):
        while len(blob)%4: blob.append(0)
        offset=len(blob); blob.extend(arr.tobytes()); return offset
    for (x,z,water,step), b in sorted(batches.items()):
        p=np.concatenate(b['p']); colors=np.concatenate(b['c']); kinds=np.concatenate(b['k'])
        xyz=p.reshape(-1,3,3).astype(float)
        area_mesh += np.sum(np.abs((xyz[:,1,0]-xyz[:,0,0])*(xyz[:,2,2]-xyz[:,0,2])-(xyz[:,1,2]-xyz[:,0,2])*(xyz[:,2,0]-xyz[:,0,0]))/2)
        chunks.append({'x':x,'z':z,'water':water,'count':len(p),'positions':put(p),'colors':put(colors),'kinds':put(kinds)})
    # Float32 にしても面積を維持(タイル相対座標なので沿岸の細い境界も保持)。
    assert abs(area_mesh-union.area) < max(1, union.area*1e-7), ('mesh area',area_mesh,union.area)
    compressed = gzip.compress(blob, compresslevel=9, mtime=0)
    digest=hashlib.sha256(compressed).hexdigest()
    stats={'triangles':sum(q['count']//3 for q in chunks),'chunks':len(chunks),'overlapArea':round(max(0,area_sum-union.area),6),'missingArea':round(expected.symmetric_difference(union).area,6),'surfaceArea':round(union.area,3)}
    info={'version':1,'binary':'shonan-surfaces.bin.gz?v='+digest[:16],'compression':'gzip','byteLength':len(blob),'bounds':city['bounds'],'citySha256':hashlib.sha256(CITY.read_bytes()).hexdigest(),'terrainSha256':hashlib.sha256(TERRAIN.read_bytes()).hexdigest(),'binarySha256':digest,'stats':stats,'chunks':chunks}
    output = Path(os.environ.get('SHONAN_SURFACE_OUTPUT', ROOT/'map'))
    output.mkdir(parents=True,exist_ok=True)
    (output/'shonan-surfaces.bin.gz').write_bytes(compressed)
    (output/'shonan-surfaces.json').write_text(json.dumps(info,separators=(',',':'))+'\n')
    print(stats, 'bytes',len(blob),flush=True)

def srgb(x):
    return x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4

if __name__=='__main__':
    main()
