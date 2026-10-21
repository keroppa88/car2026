# 東京駅ステージの街のデータ(map/tokyoeki-city.json)を、地図の元データ(tools/tokyoeki_src.glb)から作る。
# 使い方: python3 tools/tokyoeki_city.py tools/tokyoeki_src.glb map/tokyoeki-city.json
# 要るもの: numpy, scipy, scikit-image, shapely
#  1) 地図の面を 0.5m 角の升目に塗る(大通りの路面 M06・地面 M05・建物・線路・川・緑)
#  2) 建物をつながった面ごとに棟に分け、屋上の高さごとに床の形(柱)を取り出す。
#     道路の上にかかる低い構造物は高架として分け、三角形のまま出す。
#  3) 道路は碁盤の目: 地図の大通りの向きから碁盤の向きを決め、大通りをまっすぐな線にそろえる
#     (28m以内の平行な道は1本に)。大通りの間は55mほどおきに1車線の細い道。交差点はすべて直角。
#     車線は地図の路面の幅に 3.25m が何本入るか(2本以上は偶数、片側2車線まで)。歩道は大通り2.5m・細い道1m。
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
    pts=rdp(np.array([world(q) for q in P]),1.0)          # 地図の路面の中心線のまま
    if len(pts)<2 or np.linalg.norm(pts[-1]-pts[0])<3: continue
    mid=P[len(P)//5:max(len(P)//5+1,len(P)*4//5)]
    W=float(np.median(DTR[mid[:,0],mid[:,1]]))*2            # 地図の路面(車道)の幅
    n=max(1,lanes_of(W))
    walk=MAINWALK
    main.append(dict(pts=pts.round(2).tolist(),W=round(W,2),lanes=n,walk=round(walk,2),kind='main',a=int(a),b=int(b),ja=bool(da>=3),jb=bool(db>=3)))
# 細い道: 大通りで囲まれた街区を、縦横55mほどの碁盤目に分ける道を通す(日本橋・八重洲・京橋の路地の並び)。
from skimage.measure import find_contours as _fc
landpoly=None
for c_ in _fc(np.pad(land,1).astype(float),0.5):
    pg=Polygon([(X0+(q[1]-1)*RES, Z0+(q[0]-1)*RES) for q in c_]).buffer(0)
    if landpoly is None or pg.area>landpoly.area: landpoly=pg
railpoly=unary_union([Polygon([(X0+(q[1]-1)*RES, Z0+(q[0]-1)*RES) for q in c_]).buffer(0) for c_ in _fc(np.pad(M['rail']|M['water'],1).astype(float),0.5) if len(c_)>4]).buffer(3)
def cw_of(sg): return max(1,sg['lanes'])*LANE
# ---- 碁盤の目の道路網 ----
# 地図の大通りの向きから碁盤の向き(u と、それに直角な v)を決め、大通りを u・v どちらかの
# まっすぐな線にそろえる(ずれた交差点・斜めの合流は作らない)。大通りの間は55mほどおきに細い道。
# 交差点はすべて直角の十字路か丁字路。東京駅の構内・川には道を通さない。
segs=[(np.array(sg['pts']),sg['W']) for sg in main]
ang=[];wts=[]
for P_,W_ in segs:
    d=P_[-1]-P_[0]; L=np.linalg.norm(d)
    if L>30: ang.append(np.arctan2(d[1],d[0])%(np.pi/2)); wts.append(L)
hist,edges_=np.histogram(ang,bins=90,range=(0,np.pi/2),weights=wts)
th=(edges_[np.argmax(hist)]+edges_[np.argmax(hist)+1])/2
U=np.array([np.cos(th),np.sin(th)]); V=np.array([-np.sin(th),np.cos(th)])
fam={0:[],1:[]}                                  # 0: u向きの道(位置は v 座標)、1: v向きの道(位置は u 座標)
for P_,W_ in segs:
    d=P_[-1]-P_[0]; L=np.linalg.norm(d)
    if L<20: continue
    c=abs(np.dot(d/L,U))
    m=P_.mean(0)
    if c>0.94: fam[0].append((float(np.dot(m,V)),W_,L))
    elif c<0.34: fam[1].append((float(np.dot(m,U)),W_,L))
district=landpoly.difference(railpoly.buffer(22))
dpts=np.array(district.envelope.exterior.coords)
lines=[]                                         # (family, offset, W)
for f in (0,1):
    items=sorted(fam[f])
    clusters=[]
    for off,W_,L in items:
        if clusters and off-clusters[-1][-1][0]<28: clusters[-1].append((off,W_,L))   # 28m以内の平行な道は1本に
        else: clusters.append([(off,W_,L)])
    majors=[]
    for cl in clusters:
        tot=sum(x[2] for x in cl)
        if tot<60: continue
        off=sum(x[0]*x[2] for x in cl)/tot; W_=max(x[1] for x in cl if x[2]>=0.3*max(y[2] for y in cl))
        majors.append((off,min(W_,26)))
    for off,W_ in majors: lines.append((f,off,W_))
    # 大通りの間に細い道
    axis=V if f==0 else U
    lo=min(np.dot(dpts,axis)); hi=max(np.dot(dpts,axis))
    stops=[lo]+[m[0] for m in majors]+[hi]
    for a_,b_ in zip(stops[:-1],stops[1:]):
        k=int(round((b_-a_)/55))
        for t in range(1,k):
            o_=a_+(b_-a_)*t/k
            if all(abs(o_-m[0])>=30 for m in majors): lines.append((f,o_,0))
# 碁盤の範囲: 外側の大通り4本で囲んだ長方形。外周の道がすべて陸の上を通るまで内側の大通りへ縮める。
# 道はすべてこの長方形の中で、端から端まで通す(行き止まりを作らない)。交差点はすべて直角。
# 線路・駅と川は避ける。地図の外(切れ端の向こう)へは街を広げてよい。
area=Polygon([(-700,-600),(700,-600),(700,700),(-700,700)]).difference(railpoly.buffer(22)).buffer(3)
maj={f:sorted(off for g,off,W_ in lines if g==f and W_>0) for f in (0,1)}
def corner(o0,o1): return V*o0+U*o1        # 0族の位置 o0(v座標)と1族の位置 o1(u座標)の交点
def ok_rect(a0,b0,a1,b1):
    ring=[corner(a0,a1),corner(a0,b1),corner(b0,b1),corner(b0,a1),corner(a0,a1)]
    return all(area.contains(LineString([ring[k],ring[k+1]])) for k in range(4))
i0,j0,i1,j1=0,len(maj[0])-1,0,len(maj[1])-1
while not ok_rect(maj[0][i0],maj[0][j0],maj[1][i1],maj[1][j1]):
    # はみ出しの大きい辺を1本内側へ
    best=None
    for side in range(4):
        a0,b0,a1,b1=maj[0][i0],maj[0][j0],maj[1][i1],maj[1][j1]
        ends=[(corner(a0,a1),corner(a0,b1)),(corner(b0,a1),corner(b0,b1)),(corner(a0,a1),corner(b0,a1)),(corner(a0,b1),corner(b0,b1))][side]
        out=LineString(ends).difference(area).length
        if best is None or out>best[0]: best=(out,side)
    side=best[1]
    if side==0: i0+=1
    elif side==1: j0-=1
    elif side==2: i1+=1
    else: j1-=1
    if j0-i0<1 or j1-i1<1: raise SystemExit('grid area too small')
lo0,hi0,lo1,hi1=maj[0][i0],maj[0][j0],maj[1][i1],maj[1][j1]
rectpoly=Polygon([corner(lo0,lo1),corner(lo0,hi1),corner(hi0,hi1),corner(hi0,lo1)]).buffer(8,join_style='mitre')
landpoly=unary_union([landpoly,rectpoly]).difference(railpoly.difference(landpoly)) if False else unary_union([landpoly,rectpoly])
print('grid rect',round(hi0-lo0),'x',round(hi1-lo1))
main=[]; narrow=[]
raw=[]
for f,off,W_ in lines:
    lo,hi=(lo0,hi0) if f==0 else (lo1,hi1)
    if off<lo-0.5 or off>hi+0.5: continue
    p0=corner(off,lo1) if f==0 else corner(lo0,off); p1=corner(off,hi1) if f==0 else corner(hi0,off)
    n=max(2,lanes_of(W_)) if W_>0 else 1
    raw.append(dict(f=f,line=LineString([p0,p1]),lanes=n,major=W_>0))
# 交差点で分ける
nodes=[]; nodeid={}
def nid(pt):
    key=(round(pt[0],1),round(pt[1],1))
    for k_,q in nodeid.items():
        if abs(k_[0]-key[0])<0.5 and abs(k_[1]-key[1])<0.5: return q
    nodes.append([round(pt[0],2),round(pt[1],2)]); nodeid[key]=len(nodes); return len(nodes)
for r in raw:
    pts=[]
    for o in raw:
        if o['f']==r['f']: continue
        x=r['line'].intersection(o['line'])
        if x.geom_type=='Point': pts.append((r['line'].project(x),(x.x,x.y)))
    pts.sort()
    co=np.array(r['line'].coords)
    stops=[(0.0,tuple(co[0]),False)]+[(t,p,True) for t,p in pts]+[(r['line'].length,tuple(co[-1]),False)]
    for (t0,p0,j0),(t1,p1,j1) in zip(stops[:-1],stops[1:]):
        if t1-t0<1: continue
        a=nid(p0) if j0 else 0; b=nid(p1) if j1 else 0
        main.append(dict(pts=[list(np.round(p0,2)),list(np.round(p1,2))],W=round(r['lanes']*LANE,2),lanes=r['lanes'],
            walk=MAINWALK if r['major'] else 1.0,kind='main' if r['major'] else 'narrow',a=a,b=b,ja=bool(j0),jb=bool(j1)))
nodeW=[np.array(q) for q in nodes]
print('grid angle',round(np.degrees(th),1),'lines',len(lines),'segments',len(main))
carriage=unary_union([LineString(sg['pts']).buffer(cw_of(sg)/2,cap_style='square' if (sg['ja'] or sg['jb']) else 'flat',join_style='mitre') for sg in main])
corridors=unary_union([LineString(sg['pts']).buffer(cw_of(sg)/2+sg['walk'],cap_style='square',join_style='mitre') for sg in main])
carriage=carriage.intersection(landpoly.buffer(0.5))
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
    target=rng.uniform(150,600)
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
