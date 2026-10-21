# 東京駅ステージの街のデータ(map/tokyoeki-city.json)を、整えた地図(map/map_tokyoeki.glb)から作る。
# 使い方: python3 tools/tokyoeki_city.py map/map_tokyoeki.glb map/tokyoeki-city.json
# 要るもの: numpy, scipy, scikit-image
#  1) 地図の面を 0.5m 角の升目に塗る(大通りの路面 M06・地面 M05・建物・線路・川・緑)
#  2) 建物をつながった面ごとに棟に分け、屋上の高さごとに床の形(柱)を取り出す。
#     道路の上にかかる低い構造物は高架として分け、三角形のまま出す。
#  3) 道路網: 大通りは M06 の路面の中心線、細い道は建物の間の空き地のうち
#     まっすぐで長く両端がつながっている所の中心線。幅は建物から建物まで。
#     車線は 3.25m が何本入るか(2本以上は偶数、最大8本)。余りは両側の歩道。
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
# 1) 大通り: 赤い路面 M06 の中心線。幅は建物から建物まで。
road=closing(M['road'],disk(2))
cen,E=graph(road,15,None)
main=[]
for a,b,P,da,db in E:
    Lm=len(P)*RES
    mid=P[len(P)//5:max(len(P)//5+1,len(P)*4//5)]
    dead=[(d<=1) and not edge[tuple(P[0 if k==0 else -1])] for k,d in ((0,da),(1,db))]
    if any(dead) and Lm<15: continue
    W=float(np.median(d_bld[mid[:,0],mid[:,1]]))*2
    dt_road=ndi.distance_transform_edt(road)*RES if 'DTR' not in globals() else DTR
    globals()['DTR']=dt_road
    Wc=float(np.median(dt_road[mid[:,0],mid[:,1]]))*2      # 赤い路面(車道)の幅
    W=min(max(W,Wc+3.0),60)                                # 車道より狭くはしない(歩道1.5mずつは取る)
    n=lanes_of(W); pts=rdp(np.array([world(q) for q in P]),0.6)
    main.append(dict(pts=pts.round(2).tolist(),W=round(W,2),lanes=n,walk=round((W-n*LANE)/2,2),kind='main',ja=bool(da>=3),jb=bool(db>=3),
        ra=round(float(DTR[tuple(P[0])]),2),rb=round(float(DTR[tuple(P[-1])]),2),a=int(a),b=int(b)))
# 大通りの帯(車道+歩道)
corr=np.zeros_like(openm)
mainmask=np.zeros_like(openm)
for s in main:
    pass
dist_road=ndi.distance_transform_edt(~road)*RES
corr=openm&(dist_road< 14)
# 2) 細い道: 帯の外の空き地の中心線のうち、まっすぐで長く、両端がつながっているもの
rest=opening(openm&~corr,disk(3))
cen2,E2=graph(rest,0,None)
narrow=[]
for a,b,P,da,db in E2:
    Lm=len(P)*RES
    if Lm<25: continue
    mid=P[len(P)//5:max(len(P)//5+1,len(P)*4//5)]
    W=float(np.median(d_bld[mid[:,0],mid[:,1]]))*2
    if W<4 or W>14: continue
    pts=np.array([world(q) for q in P])
    chord=np.linalg.norm(pts[-1]-pts[0])
    if chord/Lm<0.8: continue
    # 端が大通りの帯か、別の道につながっていること(行き止まりの空き地を除く)
    def joined(q,d): return d>=3 or dist_road[tuple(q)]<16 or edge[tuple(q)]
    if not (joined(P[0],da) and joined(P[-1],db)): continue
    n=max(1,lanes_of(W))
    narrow.append(dict(pts=rdp(pts,1.0).round(2).tolist(),W=round(W,2),lanes=n,walk=round(max(0,(W-n*LANE)/2),2),kind='narrow'))
print('main',len(main),'narrow',len(narrow))
from collections import Counter
print('main lanes',Counter(s['lanes'] for s in main),'narrow lanes',Counter(s['lanes'] for s in narrow))
print('main W',sorted(round(s['W']) for s in main))
OUTD=dict(main=main,narrow=narrow,nodes=[world(c).round(2).tolist() for c in cen]); OUTD.update(CITY_B); json.dump(OUTD,open(OUT,'w'),separators=(',',':'))
