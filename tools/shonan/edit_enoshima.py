"""江の島周辺: 黄=砂浜、赤=海、橙=コンクリート、桃=短い道路接続。
現在の形状を編集する。実行後に build_surfaces.py で地表を再生成する。
"""
from pathlib import Path
import json
from shapely.geometry import Polygon, Point, LineString, box
from shapely.ops import unary_union
ROOT=Path(__file__).resolve().parents[2]
FILE=ROOT/'map/shonan-city.json'
def shape(q):
    return Polygon(q['o'],q.get('h',[])).buffer(0)
def polygons(g):
    if g.geom_type=='Polygon':
        if g.area>.05: yield g
    elif hasattr(g,'geoms'):
        for p in g.geoms: yield from polygons(p)
def encode(g,**props):
    return [dict(o=[[float(x),float(z)] for x,z in list(p.exterior.coords)[:-1]],
                 h=[[[float(x),float(z)] for x,z in list(r.coords)[:-1]] for r in p.interiors],**props) for p in polygons(g)]
def strip(p,w):
    return LineString(p).buffer(w/2,cap_style=2,join_style=2)
def main():
    d=json.loads(FILE.read_text())
    west=Polygon([(5704,107),(5766,418),(5796,414),(5884,308)])
    east=Polygon([(6759,305),(6857,263),(6866,239),(6873,302),(6955,414),
                  (7071,456),(7140,428),(7281,395),(7472,405),(7472,760),(6600,760),(6650,470)])
    cape_box=box(6900,320,7250,550)
    parts=[shape(q).intersection(cape_box) for q in d['woods'] if shape(q).intersects(cape_box)]
    for b in d['buildings']:
        g=Polygon(b['p'],b.get('holes',[])).buffer(0)
        if cape_box.intersects(g): parts.append(g.buffer(4,join_style=2))
    cape=unary_union(parts).convex_hull
    red_mask=west.union(east)
    removed=red_mask.difference(cape)
    # 既存の砂浜の先端までつなぎ、橋東側に細い水の切れ込みを残さない。
    sand=Polygon([(6193,317),(6284,320),(6319,367),(6325,441),(6067,664),(5963,634),(6065,430)])
    paths=[
        [(5900.88,284),(5833.19,359.76),(5825.53,374.03),(5814.84,422.61),(5809.06,435.75),(5730.49,545.64),(5723.62,563.92),(5718.87,602.9)],
        [(5948.16,325.54),(5923.62,353.58),(5888.2,394.05)],
        [(5923.62,353.58),(5967.47,391.7)],
        [(6976.73,308.47),(6961.58,337.83)],
        [(6896.95,307.01),(6961.58,337.83),(6980.41,348.1),(6980.41,361.3),(6963.06,379.28),(6942.75,416.7),(6942.75,432.1)]]
    apron=Polygon([(5900,294),(5956,326),(5967,347),(6018,332),(6054,277),(6091,284),(6017,381),(5899,413),(5872,386)])
    west_concrete=unary_union([apron]+[strip(p,14) for p in paths[:3]])
    # 東側は内側を海として残す。左の開口部はふさがない。
    east_concrete=unary_union([
        strip([(6875,255),(6980,319)],18),strip([(6875,255),(6822,376)],10),
        strip([(6801,415),(6884,423)],8),
        Polygon([(6955,312),(6987,318),(6952,429),(6912,440),(6878,423),(6898,405),(6922,344)]),
        *[strip(p,14) for p in paths[3:]]]).buffer(0)
    bank=Polygon([(6192,285),(6204,271),(6224,274),(6238,294),(6228,310),(6205,301)])
    pads=[]
    for b in d['buildings']:
        g=Polygon(b['p'],b.get('holes',[])).buffer(0)
        if sand.contains(g.centroid) and g.area<1000: pads.append(g.buffer(2.5,join_style=2))
    concrete=unary_union([west_concrete,east_concrete,bank]+pads).buffer(0)
    sand=sand.difference(concrete)
    for key in ['beaches','piers','lots','parking']:
        out=[]
        for q in d[key]:
            if q.get('name','').startswith('江の島修正・'): continue
            g=shape(q)
            cut=red_mask.union(concrete) if key=='beaches' else removed
            out+=encode(g.difference(cut),**{k:v for k,v in q.items() if k not in ('o','h')}) if g.intersects(cut) else [q]
        d[key]=out
    parks=[]
    for q in d['parks']:
        g=shape(q);cut=sand.union(concrete).union(removed)
        parks+=encode(g.difference(cut),**{k:v for k,v in q.items() if k not in ('o','h')}) if g.intersects(cut) else [q]
    d['parks']=parks
    d['beaches']+=encode(sand,name='江の島修正・橋の付け根の砂浜')
    d['piers']+=encode(concrete,name='江の島修正・コンクリート')
    ends={(tuple(p[0]),tuple(p[-1])) for p in paths}
    n0=len(d['roads'])
    d['roads']=[r for r in d['roads'] if (tuple(r['pts'][0]),tuple(r['pts'][-1])) not in ends]
    a,b=[6222.42,257.03],[6217.06,265.78]
    if not any(r.get('name')=='江の島・河口東岸連絡路' for r in d['roads']):
        template=next(r for r in d['roads'] if r['pts'][-1]==b)
        d['roads'].append({**template,'name':'江の島・河口東岸連絡路','pts':[a,b],'junctions':[0,1]})
    for r in d['roads']:
        for p in (a,b):
            for i,q in enumerate(r['pts']):
                if q==p:r['junctions']=sorted(set(r['junctions'])|{i})
    road=unary_union([strip(r['pts'],(4.5 if r['lanes']==1 and not r['oneway'] else r['lanes']*3.25)+1)
        for r in d['roads'] if any(5650<x<7500 and 100<z<800 for x,z in r['pts'])])
    def clear(x,z):
        p=Point(x,z);return (sand.contains(p) or removed.contains(p)) and not road.contains(p)
    for key in ['trees','strips','medians']:
        d[key]=[p for p in d[key] if not clear(p[0],p[1])]
    main_sea=next(q for q in d['water'] if q.get('sea') and shape(q).area>100000000)
    bay=[q for q in d['water'] if q.get('sea') and 5700<shape(q).bounds[0]<5800 and 250<shape(q).bounds[1]<270 and shape(q).area>100000]
    seam=strip([(6017,412),(5907,510),(5946,594)],7)
    sea=unary_union([shape(main_sea),seam,removed]+[shape(q) for q in bay])
    fill=sand.union(concrete);water=[]
    for q in d['water']:
        if q is main_sea or any(q is p for p in bay):continue
        g=shape(q)
        water+=encode(g.difference(fill),**{k:v for k,v in q.items() if k not in ('o','h')}) if g.intersects(fill) else [q]
    d['water']=encode(sea.difference(fill),sea=True)+water
    area=Polygon(d['area']).buffer(0).union(fill)
    if area.geom_type!='Polygon':raise ValueError('追加した地面が既存の陸と接続していません')
    d['area']=[[float(x),float(z)] for x,z in list(area.exterior.coords)[:-1]]
    FILE.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':')))
    print('砂浜',round(sand.area),'m² / コンクリート',round(concrete.area),'m² / 道路',n0,'→',len(d['roads']))
if __name__=='__main__':main()
