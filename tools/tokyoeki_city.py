# 東京駅ステージの街のデータ(map/tokyoeki-city.json)を、地図の元データ(tools/tokyoeki_src.glb)から作る。
# 使い方: python3 tools/tokyoeki_city.py tools/tokyoeki_src.glb map/tokyoeki-city.json
# 要るもの: numpy, scipy, scikit-image, shapely
#  1) 地図の面を 0.5m 角の升目に塗る(大通りの路面 M06・地面 M05・建物・線路・川・緑)
#  2) 建物をつながった面ごとに棟に分け、屋上の高さごとに床の形(柱)を取り出す。
#     道路の上にかかる低い構造物は高架として分け、三角形のまま出す。
#  3) 道路は地図に縛られずに設計する(日本のオフィス街として自然な形):
#     大通りは元の路面の中心線を直線的に整え、広い交差点は1点にまとめる。
#     建物の間の幅から歩道(片側2.5m以上)を除いて 3.25m の車線が何本入るか(2本以上は偶数、最大8本)。
#     細い道は大通りで囲まれた大きな街区を40〜60mごとに区切る碁盤目の道。
#  4) 建物は道路の帯(車道+歩道)に食い込む所を削り、細切れは捨てる。
import sys
GLB, OUT = sys.argv[1], sys.argv[2]
import json,struct
import numpy as np
d=open(GLB,'rb').read()
clen=struct.unpack('<I',d[12:16])[0]; j=json.loads(d[20:20+clen])
bin_off=20+clen; blen=struct.unpack('<I',d[bin_off:bin_off+4])[0]; B=d[bin_off+8:bin_off+8+blen]
def acc(i):
    a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
    comp={5126:np.float32,5123:np.uint16,5125:np.uint32,5121:np.uint8}[a['componentType']]
    n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0); cnt=a['count']
    return np.frombuffer(B,dtype=comp,count=cnt*n,offset=off).reshape(cnt,n)
mats=j['materials']
def meshes():
    for ni,n in enumerate(j['nodes']):
        if 'mesh' not in n: continue
        for p in j['meshes'][n['mesh']]['primitives']:
            P=acc(p['attributes']['POSITION']).astype(np.float64); I=acc(p['indices']).ravel() if 'indices' in p else np.arange(len(P))
            yield ni, mats[p.get('material',0)]['name'], P[I].reshape(-1,3,3)
# ---- 升目に塗る ----
from skimage.draw import polygon as dpoly
RES=0.5; X0,X1,Z0,Z1=-380,360,-210,300
NX=int((X1-X0)/RES); NZ=int((Z1-Z0)/RES)
def rast(tris, mask):
    for t in tris:
        r=(t[:,2]-Z0)/RES; c=(t[:,0]-X0)/RES
        rr,cc=dpoly(r,c,shape=mask.shape); mask[rr,cc]=True
        # 細い三角形も1画素は塗る
        mask[np.clip(r.astype(int),0,NZ-1),np.clip(c.astype(int),0,NX-1)]=True
GROUNDM={'M06_Steel_Smoke','M05_Graphite_Haze','Asphalt_06_1K','F08_Forest_Shadow','H06_Ocean_Depth','H07_Deep_Teal'}
road=np.zeros((NZ,NX),bool); ground=np.zeros((NZ,NX),bool); foot=np.zeros((NZ,NX),bool); water=np.zeros((NZ,NX),bool); rail=np.zeros((NZ,NX),bool); green=np.zeros((NZ,NX),bool); elev=np.zeros((NZ,NX),bool)
for ni,name,T in meshes():
    nrm=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0]); L=np.linalg.norm(nrm,axis=1)+1e-12; ny=nrm[:,1]/L
    ym=T[:,:,1].mean(axis=1); h=np.abs(ny)>0.7
    if name=='M06_Steel_Smoke':
        rast(T[h&(np.abs(ym)<0.5)],road); rast(T[h&(ym>3)],elev)
    elif name=='M05_Graphite_Haze': rast(T[h&(np.abs(ym)<0.5)],ground)
    elif name=='Asphalt_06_1K': rast(T[h],rail)
    elif name=='F08_Forest_Shadow': rast(T[h],green)
    elif name in('H06_Ocean_Depth','H07_Deep_Teal'): rast(T[h],water)
    else: rast(T[h&(ym>0.3)],foot); rast(T[h&(np.abs(ym)<=0.3)],foot)
M=dict(road=road,ground=ground,foot=foot,water=water,rail=rail,green=green,elev=elev)

# ---- 道筋の取り出し ----
NB=[(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
def skel_graph(sk):
    """骨格の画素から、節(分岐・端)と、節どうしを結ぶ道筋(画素の列)を取り出す。"""
    H,W=sk.shape
    cnt=ndi.convolve(sk.astype(np.uint8),np.ones((3,3),np.uint8),mode='constant')-sk
    node=sk&(cnt!=2)
    # 節の画素はくっついた塊を1つの節にまとめる
    lab,nn=ndi.label(node,structure=np.ones((3,3)))
    cen=ndi.center_of_mass(node,lab,range(1,nn+1))
    visited=np.zeros_like(sk)
    edges=[]
    ys,xs=np.nonzero(node)
    for y,x in zip(ys,xs):
        a=lab[y,x]
        for dy,dx in NB:
            y1,x1=y+dy,x+dx
            if not(0<=y1<H and 0<=x1<W) or not sk[y1,x1] or node[y1,x1] or visited[y1,x1]: continue
            path=[(y,x),(y1,x1)]; visited[y1,x1]=True; py,px=y,x; cy,cx=y1,x1; end=None
            while True:
                nxt=None
                for ey,ex in NB:
                    y2,x2=cy+ey,cx+ex
                    if not(0<=y2<H and 0<=x2<W) or not sk[y2,x2] or (y2,x2)==(py,px): continue
                    if node[y2,x2] and lab[y2,x2]!=a or (node[y2,x2] and len(path)>2): end=(y2,x2); break
                    if not node[y2,x2] and not visited[y2,x2]: nxt=(y2,x2)
                if end: path.append(end); break
                if nxt is None: break
                visited[nxt]=True; path.append(nxt); py,px=cy,cx; cy,cx=nxt
            b=lab[end] if end else 0
            edges.append((a,b,path))
    # 節を通らない輪(交差のない環状)は今回は扱わない
    return lab,np.array(cen),edges
def rdp(pts,eps):
    if len(pts)<3: return pts
    a,b=pts[0],pts[-1]; ab=b-a; L=np.linalg.norm(ab)+1e-9
    v=pts-a; d=np.abs(ab[0]*v[:,1]-ab[1]*v[:,0])/L
    i=int(np.argmax(d))
    if d[i]>eps: return np.vstack([rdp(pts[:i+1],eps)[:-1],rdp(pts[i:],eps)])
    return np.vstack([a,b])
# ---- 建物の棟 ----
GROUND={'M06_Steel_Smoke','M05_Graphite_Haze','Asphalt_06_1K','F08_Forest_Shadow','H06_Ocean_Depth','H07_Deep_Teal'}
def comps(T):
    V=np.round(T.reshape(-1,3)*20).astype(np.int64)
    keys=V[:,0]*1000003*1000003+V[:,1]*1000003+V[:,2]
    uniq,inv=np.unique(keys,return_inverse=True)
    n=len(T); parent=np.arange(n)
    def find(a):
        while parent[a]!=a: parent[a]=parent[parent[a]]; a=parent[a]
        return a
    first={}
    for i,k in enumerate(inv):
        t=i//3
        if k in first:
            a,b=find(first[k]),find(t)
            if a!=b: parent[a]=b
        else: first[k]=t
    return np.array([find(t) for t in range(n)])
bT=[]; road_tris=[]
for ni,name,T in meshes():
    if name in GROUND:
        if name=='M06_Steel_Smoke': road_tris.append(T)
        continue
    bT.append(T)
T=np.concatenate(bT); cid=comps(T)
u,cid=np.unique(cid,return_inverse=True)
print('tris',len(T),'components',len(u))

# ---- 建物の高さと高架 ----
from skimage.measure import find_contours, label
from scipy import ndimage as ndi
nrm=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0]); L=np.linalg.norm(nrm,axis=1)+1e-12; ny=nrm[:,1]/L
ym=T[:,:,1].mean(axis=1)
hm=np.zeros((NZ,NX)); idm=-np.ones((NZ,NX),int)
order=np.argsort(ym)          # 低い面から塗り、高い面で上書き
for t in order:
    if abs(ny[t])<0.7 or ym[t]<0.3: continue
    tri=T[t]; r=(tri[:,2]-Z0)/RES; c=(tri[:,0]-X0)/RES
    rr,cc=dpoly(r,c,shape=hm.shape)
    hm[rr,cc]=np.maximum(hm[rr,cc],ym[t]); idm[rr,cc]=cid[t]
# 高架(道路の上にかかる低い構造物)を見分ける
n=cid.max()+1
area=np.bincount(idm[idm>=0],minlength=n)
onroad=np.bincount(idm[(idm>=0)&road],minlength=n)
hmax=ndi.maximum(hm,idm,index=np.arange(n))
elev=(area>0)&(onroad>0.08*np.maximum(area,1))&(hmax<16)
print('elevated comps',np.nonzero(elev)[0].size,'area',area[elev].sum()*RES*RES)
# ---- 建物の柱 ----
from skimage.measure import find_contours, label
from scipy import ndimage as ndi
def world(p): return [round(X0+p[1]*RES,2), round(Z0+p[0]*RES,2)]
q=np.round(hm*2)/2           # 0.5m 刻み
key=np.where(idm>=0, idm*10000+(q*2).astype(int), -1)
key[(idm>=0)&elev[np.maximum(idm,0)]]=-1
lab,n=ndi.label(key>=0, structure=np.ones((3,3)))
# 同じ棟・同じ高さでつながった所を1つの柱にする
blds=[]
objs=ndi.find_objects(lab)
for i,sl in enumerate(objs):
    if sl is None: continue
    sub=lab[sl]==i+1
    ks=np.unique(key[sl][sub])
    for k in ks:
        m=sub&(key[sl]==k)
        if m.sum()<8: continue          # 2m²未満は捨てる
        for part,_ in [(m,0)]:
            L2,n2=ndi.label(part)
            for j in range(1,n2+1):
                pm=L2==j
                if pm.sum()<8: continue
                pad=np.pad(pm,1)
                cs=find_contours(pad.astype(float),0.5)
                if not cs: continue
                c=max(cs,key=len)-1
                c[:,0]+=sl[0].start; c[:,1]+=sl[1].start
                pts=np.array([world(p) for p in c])
                h2=len(pts)//2; pts=np.vstack([rdp(pts[:h2+1],0.35)[:-1], rdp(np.vstack([pts[h2:],pts[:1]]),0.35)[:-1]])
                if len(pts)<3: continue
                h=float((k%10000)/2)
                blds.append(dict(id=int(k//10000),h=round(h,1),p=pts.round(2).tolist()))
print('prisms',len(blds), 'pts',sum(len(b['p']) for b in blds))
# 高架の三角形
nrm=None
el=[T[t].round(2).tolist() for t in range(len(T)) if elev[cid[t]]]
print('elevated tris',len(el))
CITY_B=dict(buildings=blds,elevated=el)
# ---- 道路網 ----
from scipy import ndimage as ndi
from skimage.morphology import skeletonize, closing, opening, disk
LANE=3.25
bld=(idm>=0)&~elev[np.maximum(idm,0)]; bld=closing(bld,disk(1))
land=closing(M['road']|M['ground']|M['green'],disk(2))
openm=land&~bld&~M['rail']&~M['water']
NZ,NX=openm.shape
edge=ndi.binary_dilation(~land,iterations=6)
def world(p): return np.array([X0+p[1]*RES, Z0+p[0]*RES])
d_bld=ndi.distance_transform_edt(~(bld|M['rail']|M['water']))*RES     # 建物(と線路・川)までの距離
def lanes_of(W):
    n=int(W//LANE)
    if n>=2: n-=n%2
    return min(n,8)
def graph(mask,minlen,keep):
    sk=skeletonize(mask); lab,cen,edges=skel_graph(sk)
    deg=np.zeros(len(cen)+1,int)
    for a,b,p in edges: deg[a]+=1; deg[b]+=1
    out=[]
    for a,b,p in edges:
        P=np.array(p)
        if len(P)<3: continue
        out.append((a,b,P,deg[a] if a else 0,deg[b] if b else 0))
    return cen,out
# ---- 道路の設計(地図に縛られず、日本のオフィス街として自然な形にする) ----
#  - 大通り: 元の路面 M06 の中心線を直線的に整え、交差点ではつながる道の端を同じ点にそろえる。
#    建物から建物までの幅から、歩道(片側2.5m以上)を除いて 3.25m の車線が何本入るかを決める。
#    余りは歩道(片側8mまで)。
#  - 細い道: 1車線(路側帯0.8m)か片側1車線。
#  - 建物は道路の帯(車道+歩道)に食い込む所を削る。削って細切れになった所は捨てる。
from shapely.geometry import LineString, Polygon, Point, MultiPolygon
from shapely.ops import unary_union
road=closing(M['road'],disk(2))
DTR=ndi.distance_transform_edt(road)*RES
MAINWALK=2.5
cen,E=graph(road,15,None)
nodeW=[world(c) for c in cen]
deg=np.zeros(len(cen)+1,int)
for a,b,P,da,db in E: deg[a]+=1; deg[b]+=1
# 広い交差点は細線化で節が2つ以上に割れるので、25m以内の交差点の節は1つにまとめる。
jnodes=[k for k in range(1,len(cen)+1) if deg[k]>=3]
rep={k:k for k in range(1,len(cen)+1)}
for i_,k in enumerate(jnodes):
    for k2 in jnodes[:i_]:
        if np.linalg.norm(nodeW[k-1]-nodeW[k2-1])<25: rep[k]=rep[k2]; break
groups={}
for k in jnodes: groups.setdefault(rep[k],[]).append(k)
for r_,ks in groups.items():
    c_=np.mean([nodeW[k-1] for k in ks],axis=0)
    for k in ks: nodeW[k-1]=c_
main=[]
for a,b,P,da,db in E:
    if a and b and rep[a]==rep[b] and da>=3 and db>=3: continue   # 同じ交差点の中の短い道筋
    a=rep[a] if a else a; b=rep[b] if b else b
    Lm=len(P)*RES
    dead=[(d<=1) and not edge[tuple(P[0 if k==0 else -1])] for k,d in ((0,da),(1,db))]
    if any(dead) and Lm<15: continue
    pts=rdp(np.array([world(q) for q in P]),2.5)
    if da>=3: pts[0]=nodeW[a-1]
    if db>=3: pts[-1]=nodeW[b-1]
    if len(pts)<2 or np.linalg.norm(pts[-1]-pts[0])<3: continue
    mid=P[len(P)//5:max(len(P)//5+1,len(P)*4//5)]
    gap=float(np.median(d_bld[mid[:,0],mid[:,1]]))*2
    wc=float(np.median(DTR[mid[:,0],mid[:,1]]))*2
    W=min(max(gap,wc+2*MAINWALK),60)
    n=max(1,lanes_of(W-2*MAINWALK))
    walk=float(np.clip((W-n*LANE)/2,MAINWALK,8))
    main.append(dict(pts=pts.round(2).tolist(),W=round(W,2),lanes=n,walk=round(walk,2),kind='main',a=int(a),b=int(b),ja=bool(da>=3),jb=bool(db>=3)))
# 細い道: 大通りで囲まれた街区が大きい時、街区を40〜60mほどの区画に分ける道を通す
# (日本橋・八重洲の碁盤目の路地のように、街区の長い向きに直角、とても幅の広い街区は真ん中にも1本)。
from skimage.measure import find_contours as _fc
landpoly=None
for c_ in _fc(np.pad(land,1).astype(float),0.5):
    pg=Polygon([(X0+(q[1]-1)*RES, Z0+(q[0]-1)*RES) for q in c_]).buffer(0)
    if landpoly is None or pg.area>landpoly.area: landpoly=pg
railpoly=unary_union([Polygon([(X0+(q[1]-1)*RES, Z0+(q[0]-1)*RES) for q in c_]).buffer(0) for c_ in _fc(np.pad(M['rail']|M['water'],1).astype(float),0.5) if len(c_)>4]).buffer(3)
def cw_of(sg): return max(1,sg['lanes'])*LANE
main_corr=unary_union([LineString(sg['pts']).buffer(cw_of(sg)/2+sg['walk'],cap_style='flat') for sg in main]+
    [Point(nodeW[k-1]).buffer(max(cw_of(sg)/2+sg['walk'] for sg in main if k in (sg['a'],sg['b']))) for k in set([sg['a'] for sg in main if sg['ja']]+[sg['b'] for sg in main if sg['jb']])])
blocks=landpoly.difference(main_corr).difference(railpoly)
narrow=[]
def add_street(p0,p1,blk,n):
    ln=LineString([p0,p1]).intersection(blk.buffer(9))
    for g in (ln.geoms if hasattr(ln,'geoms') else [ln]):
        if g.length>25: narrow.append(dict(pts=np.array(g.coords).round(2).tolist(),W=0,lanes=n,walk=0.8 if n==1 else 1.0,kind='narrow'))
for blk in (blocks.geoms if hasattr(blocks,'geoms') else [blocks]):
    if blk.area<2500: continue
    rect=blk.minimum_rotated_rectangle; rc=np.array(rect.exterior.coords)[:4]
    e1=rc[1]-rc[0]; e2=rc[2]-rc[1]
    if np.linalg.norm(e1)<np.linalg.norm(e2): e1,e2=e2,e1
    Lb=np.linalg.norm(e1); Sb=np.linalg.norm(e2); u=e1/Lb; v=e2/Sb; c0=np.array(rect.centroid.coords[0])
    if blk.area/rect.area<0.55: continue        # 形のいびつな所(駅前広場など)は分けない
    k=int(round(Lb/55))
    for i_ in range(1,k):                        # 長い向きに直角な道
        t=-Lb/2+Lb*i_/k; p=c0+u*t
        add_street(p-v*(Sb/2+10),p+v*(Sb/2+10),blk,2 if i_%2==0 else 1)
    if Sb>90:                                    # とても幅の広い街区は、長い向きにも1本
        add_street(c0-u*(Lb/2+10),c0+u*(Lb/2+10),blk,1)
# 道路の帯と車道
# 交差点は円で埋める(半径はそこに来る車道の半幅の大きい方)。地図の端の道の終わりは平らに切る。
jn=set([sg['a'] for sg in main if sg['ja']]+[sg['b'] for sg in main if sg['jb']])
def jr(k,extra): return max(cw_of(sg)/2+extra(sg) for sg in main if k in (sg['a'],sg['b']))
corridors=unary_union([LineString(sg['pts']).buffer(cw_of(sg)/2+sg['walk'],cap_style='flat',join_style='mitre',mitre_limit=2) for sg in main+narrow]+
    [Point(nodeW[k-1]).buffer(jr(k,lambda sg: sg['walk'])) for k in jn])
carriage=unary_union([LineString(sg['pts']).buffer(cw_of(sg)/2,cap_style='flat',join_style='mitre',mitre_limit=2) for sg in main+narrow]+
    [Point(nodeW[k-1]).buffer(jr(k,lambda sg: 0)) for k in jn])
carriage=carriage.intersection(Polygon([(-380,-210),(360,-210),(360,300),(-380,300)]))
def rings(g):
    out=[]
    for pg in (g.geoms if hasattr(g,'geoms') else [g]):
        if pg.area<1: continue
        pg=pg.simplify(0.15)
        out.append(dict(o=np.array(pg.exterior.coords)[:-1].round(2).tolist(),h=[np.array(r.coords)[:-1].round(2).tolist() for r in pg.interiors]))
    return out
asphalt=rings(carriage)
# ---- 建物を建て直す(日本のオフィス街らしく) ----
#  - 東京駅の構内(線路のまわり)だけは元の建物の形を残す(道路の帯に食い込む所は削る)。
#  - それ以外の街区は、道路に面して並ぶ敷地に分け、敷地いっぱいにビルを建てる(隣と0.6m空ける)。
#    高さは元の地図のその場所の高さを受け継ぎ(少しばらつかせ、階の高さ3.8mでそろえる)、
#    元が低い・建物の無かった所は6〜12階のオフィスにする。高いビルは低層部(基壇)の上に塔を載せる。
from skimage.draw import polygon as _dp2
rng=np.random.default_rng(20261022)
station=railpoly.buffer(25)
blds=[]
for b_ in CITY_B['buildings']:
    pg=Polygon(b_['p'])
    if not pg.is_valid: pg=pg.buffer(0)
    if not station.contains(pg.centroid): continue
    pg=pg.difference(corridors)
    for part in (pg.geoms if hasattr(pg,'geoms') else [pg]):
        if part.is_empty or part.area<15 or part.buffer(-1.0).is_empty: continue
        part=part.simplify(0.3)
        blds.append(dict(id=int(b_['id']),h=b_['h'],p=np.array(part.exterior.coords)[:-1].round(2).tolist()))
def orig_height(pg):
    x0,z0,x1,z1=pg.bounds
    q=np.array(pg.exterior.coords)
    rr,cc=_dp2((q[:,1]-Z0)/RES,(q[:,0]-X0)/RES,shape=hm.shape)
    if len(rr)==0: return 0.0
    v=hm[rr,cc]; v=v[v>0]
    return float(np.percentile(v,90)) if len(v)>len(rr)*0.25 else 0.0
def split(pg,depth=0):
    """敷地を分ける: 外接長方形の長い向きに直角に切る。目標の広さになるまで繰り返す。"""
    target=rng.uniform(250,900)
    if pg.area<target or depth>8: return [pg]
    rect=pg.minimum_rotated_rectangle; rc=np.array(rect.exterior.coords)[:4]
    e1=rc[1]-rc[0]; e2=rc[2]-rc[1]
    if np.linalg.norm(e1)<np.linalg.norm(e2): e1,e2=e2,e1
    L=np.linalg.norm(e1); u=e1/L; v=e2/np.linalg.norm(e2); c=np.array(rect.centroid.coords[0])
    t=rng.uniform(-0.15,0.15)*L
    cut=Polygon([c+u*t+v*1000-u*0.3, c+u*t-v*1000-u*0.3, c+u*t-v*1000+u*0.3, c+u*t+v*1000+u*0.3])   # 0.6m の隙間
    parts=pg.difference(cut)
    out=[]
    for q in (parts.geoms if hasattr(parts,'geoms') else [parts]):
        if q.area>20: out+=split(q,depth+1)
    return out
FLOOR=3.8
nid=100000
blocks2=landpoly.difference(corridors).difference(station)
for blk in (blocks2.geoms if hasattr(blocks2,'geoms') else [blocks2]):
    if blk.area<60: continue
    for lot in split(blk.buffer(-0.3,join_style='mitre')):
        lot=lot.buffer(-0.3,join_style='mitre')
        for part in (lot.geoms if hasattr(lot,'geoms') else [lot]):
            if part.is_empty or part.area<60 or part.buffer(-2.5).is_empty: continue
            part=part.simplify(0.4)
            h0=orig_height(part)
            if h0<12: h=rng.uniform(6,12)*FLOOR
            else: h=max(4*FLOOR,h0*rng.uniform(0.85,1.15))
            h=max(FLOOR*3,round(h/FLOOR)*FLOOR)
            nid+=1
            ring=np.array(part.exterior.coords)[:-1].round(2).tolist()
            if h>=70 and part.area>900:
                # 基壇(4〜8階)の上に、内側へ下げた塔
                base=round(rng.uniform(4,8))*FLOOR
                tower=part.buffer(-rng.uniform(4,8),join_style='mitre')
                if not tower.is_empty and tower.area>250:
                    blds.append(dict(id=nid,h=round(base,1),p=ring))
                    tg=max(tower.geoms,key=lambda g:g.area) if hasattr(tower,'geoms') else tower
                    blds.append(dict(id=nid,h=round(h,1),p=np.array(tg.simplify(0.4).exterior.coords)[:-1].round(2).tolist()))
                    continue
            blds.append(dict(id=nid,h=round(h,1),p=ring))
print('main',len(main),'narrow',len(narrow),'buildings',len(CITY_B['buildings']),'->',len(blds))
from collections import Counter
print('main lanes',Counter(s_['lanes'] for s_ in main),'narrow lanes',Counter(s_['lanes'] for s_ in narrow))
OUTD=dict(main=main,narrow=narrow,nodes=[w.round(2).tolist() for w in nodeW],asphalt=asphalt,land=np.array(landpoly.simplify(0.5).exterior.coords)[:-1].round(2).tolist(),buildings=blds,elevated=CITY_B['elevated'])
json.dump(OUTD,open(OUT,'w'),separators=(',',':'))
