# 東京駅ステージの白線・横断歩道・縁石のデータ(map/tokyoeki-markings.json)を、地図の道路の形から作る。
# 使い方: python3 tools/tokyoeki_markings.py map/map_tokyoeki.glb map/tokyoeki-markings.json
# 要るもの: numpy, scipy, scikit-image
#  1) 地図の面を 0.5m 角の升目に塗る(大通りの路面 M06・地面 M05・建物・線路・川・緑)
#  2) 大通りの路面を細線化して道筋と交差点を取り出し、道幅から片側の車線数を決める
#     (幅6.5m未満は中央線なしの1車線、9.5m未満は片側1、19m未満は片側2、25m未満は片側3、それ以上は片側4)
#  3) 中央線(黄)・車線境界(白の破線5m/5m)・外側線・交差点の横断歩道と停止線・縁石を出力する
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
import numpy as np
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
from scipy import ndimage as ndi
from skimage.morphology import skeletonize, closing, opening, disk
from skimage.measure import find_contours
RES=0.5; X0,Z0=-380,-210
road=closing(M['road'],disk(2))
H,W=road.shape
def world(p): return np.array([X0+p[1]*RES, Z0+p[0]*RES])
# 地図の外枠(地面も道路もない所)
land=road|M['ground']|M['foot']|M['rail']|M['water']|M['green']
land=closing(land,disk(3))
edge_zone=ndi.binary_dilation(~land,iterations=8)   # 地図の端から4m以内

def graph_of(mask, minw, maxw, minlen):
    sk=skeletonize(mask); dt=ndi.distance_transform_edt(mask)*RES
    lab,cen,edges=skel_graph(sk)
    nodes=[world(c) for c in cen]
    deg=np.zeros(len(cen)+1,int)
    for a,b,p in edges: deg[a]+=1; deg[b]+=1
    out=[]
    for a,b,p in edges:
        P=np.array(p); L=len(P)*RES
        mid=P[len(P)//5: max(len(P)//5+1, len(P)*4//5)]
        w=float(np.median(dt[mid[:,0],mid[:,1]]))*2
        if w<minw or w>maxw: continue
        ends_free=[ (n==0 or deg[n]==1) and not edge_zone[tuple(P[0 if k==0 else -1])] for k,n in ((0,a),(1,b)) ]
        if L<minlen and any(ends_free): continue     # 角のひげ
        pts=np.array([world(q) for q in P]); pts=rdp(pts,0.6)
        out.append(dict(a=int(a),b=int(b),pts=pts,w=w,L=L,
            ra=float(dt[tuple(P[0])]), rb=float(dt[tuple(P[-1])]),
            ja=bool(a and deg[a]>=3), jb=bool(b and deg[b]>=3)))
    return out
roads=graph_of(road,4,60,15)
print('roads',len(roads),[round(r['w'],1) for r in roads])
def lanes(w):
    # 片側の車線数。0 は中央線のない1車線の細い道。基本は片側2車線、太い道は3〜4車線。
    return 0 if w<6.5 else 1 if w<9.5 else 2 if w<19 else 3 if w<25 else 4
def resample(pts):
    seg=np.linalg.norm(np.diff(pts,axis=0),axis=1); s=np.concatenate([[0],np.cumsum(seg)])
    return pts,s
def cut(pts,s0,s1):
    """道筋の s0〜s1 の部分"""
    seg=np.linalg.norm(np.diff(pts,axis=0),axis=1); s=np.concatenate([[0],np.cumsum(seg)])
    if s1<=s0: return None
    def at(t):
        i=min(np.searchsorted(s,t,side='right')-1,len(seg)-1); f=(t-s[i])/(seg[i]+1e-9); return pts[i]+(pts[i+1]-pts[i])*f
    inner=[pts[i] for i in range(len(pts)) if s0<s[i]<s1]
    return np.array([at(s0)]+inner+[at(s1)])
def offset(pts,d):
    out=[]
    for i in range(len(pts)):
        a=pts[max(i-1,0)]; b=pts[min(i+1,len(pts)-1)]; t=b-a; t=t/(np.linalg.norm(t)+1e-9)
        nrm=np.array([t[1],-t[0]])   # 進む向きの左(x,z で (tz,-tx))
        out.append(pts[i]+nrm*d)
    return np.array(out)
def tangent_at(pts,s_):
    seg=np.linalg.norm(np.diff(pts,axis=0),axis=1); s=np.concatenate([[0],np.cumsum(seg)])
    i=min(np.searchsorted(s,s_,side='right')-1,len(seg)-1); t=pts[i+1]-pts[i]; return t/(np.linalg.norm(t)+1e-9)
lines=[]; stripes=[]
for r in roads:
    pts=r['pts']; seg=np.linalg.norm(np.diff(pts,axis=0),axis=1); Ltot=seg.sum()
    w=r['w']; n=lanes(w); half=w/2; lw=w/(2*max(n,1))
    # 交差点の中は線を引かない。交差点の端に横断歩道(幅4m)、その手前に停止線。
    ra=r['ra']*0.85+1 if r['ja'] else 0; rb=r['rb']*0.85+1 if r['jb'] else 0
    cw=4.0
    s0=ra+(cw+3.0 if r['ja'] else 0); s1=Ltot-(rb+(cw+3.0 if r['jb'] else 0))
    if s1-s0<6:
        s0=ra; s1=Ltot-rb
        if s1-s0<4: continue
        xa=xb=False
    else: xa,xb=r['ja'],r['jb']
    body=cut(pts,s0,s1)
    if n>0: lines.append(dict(pts=body.round(2).tolist(),w=0.15,c='y'))       # 中央線(黄)。細い道には無い
    for k in range(1,n):
        for sd in(-1,1): lines.append(dict(pts=offset(body,sd*k*lw).round(2).tolist(),w=0.12,c='w',dash=[5,5]))   # 車線境界(破線)
    for sd in(-1,1): lines.append(dict(pts=offset(body,sd*(half-0.5)).round(2).tolist(),w=0.15,c='w'))           # 外側線
    for end,(has,rr) in enumerate(((xa,ra),(xb,rb))):
        if not has: continue
        sc=rr+cw/2+0.5 if end==0 else Ltot-(rr+cw/2+0.5)
        c=cut(pts,sc,sc+0.01)[0]; t=tangent_at(pts,sc); nrm=np.array([t[1],-t[0]])
        ang=float(np.arctan2(t[0],t[1]))
        k=-half+1.0
        while k<half-1.0:
            p=c+nrm*k; stripes.append([round(float(p[0]),2),round(float(p[1]),2),round(ang,4),cw,0.45]); k+=0.9
        # 停止線: 交差点へ向かう車線の側(進む向きの左)。a 端なら道筋と逆向きに進んで交差点へ入る。
        ss=sc+(cw/2+1.0) if end==0 else sc-(cw/2+1.0)
        c2=cut(pts,ss,ss+0.01)[0]; dirv=-t if end==0 else t; left=np.array([dirv[1],-dirv[0]])
        p=c2+left*(half-0.5)/2
        stripes.append([round(float(p[0]),2),round(float(p[1]),2),round(float(np.arctan2(dirv[0],dirv[1])),4),0.45,half-0.6])
print('lines',len(lines),'stripes',len(stripes))
# 細い道: 地面のうち建物にはさまれた細長い所
free=M['ground']&~M['foot']&~road&~M['rail']&~M['water']
free=opening(free,disk(2))
# 細い道の骨格は、大通りから9m以上離れ(歩道の帯を除く)、線路から15m以上離れ、
# 両脇が建物の所だけにする(広場のへりを道と見なさない)。
far_road=ndi.distance_transform_edt(~road)*RES>=9
far_rail=ndi.distance_transform_edt(~M['rail'])*RES>=15
d_free=ndi.distance_transform_edt(free)*RES
d_foot=ndi.distance_transform_edt(~M['foot'])*RES
between=d_foot<=d_free+1.5
narrow_mask=free.copy()
skf=skeletonize(free)
bad=skf&~(far_road&far_rail&between)
# 骨格の悪い所で通路を切る(その周りの画素を外す)
narrow_mask&=~ndi.binary_dilation(bad,iterations=1)
narrow=graph_of(narrow_mask,3.5,11,20)
strips=[]
for r in narrow:
    if r['L']<20: continue
    pts=r['pts']; w=min(r['w'],9)
    pass
print('narrow',len(strips))
# 縁石: 大通りの路面の縁(地図の端は除く)
curbs=[]
for cnt in find_contours(road.astype(float),0.5):
    keep=[]
    for p in cnt:
        if edge_zone[int(p[0]),int(p[1])]:
            if len(keep)>4: curbs.append(rdp(np.array([world(q) for q in keep]),0.3).round(2).tolist())
            keep=[]
        else: keep.append(p)
    if len(keep)>4: curbs.append(rdp(np.array([world(q) for q in keep]),0.3).round(2).tolist())
print('curbs',len(curbs))
json.dump(dict(lines=lines,stripes=stripes,curbs=curbs),open(OUT,'w'),separators=(',',':'))
