import * as THREE from '../lib/three.module.js';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';

// 街並み(旧NeoTokyo)の沿道。nihon-map.js(three.js r128)を r152 のモジュールへ移したもの。
//  - 幹線道路は z=0 を中心に +x へ延びる二車線。左側通行で、+x へ進む車は z<0 側の車線。
//  - 1周 = コンビニと交差点の区間(x -65〜140、205m) + 区画 40個(60m × 40 = 2400m) = 2605m。
//    区画は5種類(混在・住宅・ビル・ロードサイド・並木)。4個ずつ1区画にして、並び順と左右を
//    入れ替えながら2巡する。最後の区画の先は、次の周のコンビニ区間へつながる。
//  - 見ている位置の前後だけ区画を組み立て、遠くは消す。コンビニ区間は一番近い周へ動かす。
//  - 光源(太陽・環境光)・空・霧はゲーム側のものを使う。走る車は入れない。
//  - 歩道・駐車場・敷地は走れる。建物・塀・電柱・街路樹・駐車中の車は isBlocked でぶつかる。
export const NIHON_INTRO_START = -65;   // コンビニ区間の始まり(x)
export const NIHON_INTRO_END = 140;     // コンビニ区間の終わり = 最初の区画の始まり(x)
export const NIHON_CHUNK_LENGTH = 60;   // 区画1個の長さ(m)
export const NIHON_CHUNKS_PER_LAP = 40; // 1周の区画数(5種類 × 4個 × 2巡)
export const NIHON_LAP_LENGTH = NIHON_INTRO_END - NIHON_INTRO_START
  + NIHON_CHUNK_LENGTH * NIHON_CHUNKS_PER_LAP;

export function createNihonTown(world, opts={}){
  const traffic=false;
  let night=false;
  // コンビニ区間はこのグループにまとめ、一番近い周の位置へ動かす。
  const scene=new THREE.Group(); scene.name='nihon-intro'; world.add(scene);
  // ---- 便利関数 ----
  const colliders=[];                                  // 車がぶつかる範囲 [x0,z0,x1,z1](コンビニ区間の座標)
  // 街の材質は簡単な光の計算(ランバート: 拡散光だけ。つや・金属感の計算をしない)で軽くする。
  // 元の地図の roughness / metalness の指定は使わないので捨てる。
  const LAM=(o)=>{ const {roughness,metalness,...rest}=o; return new THREE.MeshLambertMaterial(rest); };
  const mat=(c,o={})=>LAM({color:c,...o});
  // 木の葉: 一色で陰影なし(光の計算をしない)。夜は暗い緑にする(setNight)。
  const LEAF_DAY=0x4f7a3e, LEAF_NIGHT=0x0f1a0c;
  const leafM=new THREE.MeshBasicMaterial({color:LEAF_DAY});
  // ハリボテにしない建物(コンビニ・ファミレス・ガソリンスタンド・駐車場)を作る間だけ true。
  let keepSolid=false;
  // 色だけの材質は同じ色なら使い回す(まとめて描けるように)。
  const BM={}; const bmat=c=>BM[c]||(BM[c]=mat(c));
  function box(w,h,d,m,x,y,z,parent=scene){ // yは底の高さ
    const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),typeof m==='number'?bmat(m):m);
    b.position.set(x,y+h/2,z); if(keepSolid) b.userData.keepSolid=true; parent.add(b);
    // コンビニ区間で地面に立つ高さ0.8m以上の箱(壁・塀・建物・自販機など)は車がぶつかる。
    if(parent===scene && h>=0.8 && y<0.6) colliders.push([x-w/2,z-d/2,x+w/2,z+d/2]);
    return b;
  }
  function tex(w,h,draw){
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    draw(c.getContext('2d'),w,h); const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4;
    // 夜は模様を外して単色にするので、その色(画像の平均色)を覚えておく。
    const one=document.createElement('canvas'); one.width=one.height=1; const og=one.getContext('2d');
    og.drawImage(c,0,0,1,1); const [r,gg,b]=og.getImageData(0,0,1,1).data;
    // 模様を複製しても残るよう、ただの数の組で持つ(Color のままだと複製で数値1個に変わる)。
    const avg=new THREE.Color(`rgb(${r},${gg},${b})`); t.userData.average={r:avg.r,g:avg.g,b:avg.b}; return t;
  }
  const glowMats=[]; // 夜に光るもの

  // ---- 地面・道路 ----
  box(205,0.02,300,0x6d7a55,37.5,-0.03,0);                // 草地(コンビニ区間の分だけ)
  // 夜も路面全体は光らせない。明るいのは街灯の光だまり(加算合成の円)の所だけ。
  const roadGlowM=mat(0x3b3d40);
  box(130,0.02,12,roadGlowM,0,0,0);                        // 車道
  box(130,0.02,0.15,0xd9b23a,0,0.02,0);                  // 中央線(黄)
  [-5.6,5.6].forEach(z=>box(130,0.02,0.12,0xeeeeee,0,0.02,z)); // 外側線
  for(const z of [-6.1,6.1]) box(130,0.18,0.2,0x9d9a94,0,0,z);  // 縁石
  const walk=mat(0x5d5f62);                               // 歩道：駐車場より少し薄いアスファルト
  box(130,0.15,3,walk,0,0,7.7);   // 手前歩道
  box(130,0.15,3,walk,0,0,-7.7);  // 向かい歩道
  // 歩道と建物の間は草地ではなく薄いアスファルト（両側）
  const lightAsph=mat(0x707275);
  box(130,0.05,3.2,lightAsph,0,0.05,10.8); box(130,0.05,3.2,lightAsph,0,0.05,-10.8);

  // ---- 駐車場 ----
  box(26,0.03,15,0x4a4c4f,0,0.13,16.6);
  // 駐車枠：入口の横に5台分、入口をはさんで反対側に1台分。入口前は空ける
  const spaces=[[-9.75,-7.25],[-3.25,-0.75],[-0.75,1.75],[1.75,4.25],[4.25,6.75],[6.75,9.25]];
  new Set(spaces.flat()).forEach(x=>box(0.12,0.01,5,0xf0f0f0,x,0.16,20.6));     // 白線
  spaces.forEach(([a,b])=>box(1.4,0.15,0.22,0xc9b07a,(a+b)/2,0.16,22.3));      // 車止め
  // 歩道との境のポール
  for(const x of [-12.5,12.5]) for(let k=0;k<3;k++){
    box(0.12,0.9,0.12,0xf2f2f2,x,0.15,11+k*1.2);
  }

  // ---- コンビニ本体（架空のお店「あおばマート」）----
  keepSolid=true;
  const S=new THREE.Group(); scene.add(S);
  function solid(w,h,d,m,x,y,z){ colliders.push([x-w/2,z-d/2,x+w/2,z+d/2]); return box(w,h,d,m,x,y,z,S); }
  const wallM=mat(0xe9e5dc);
  const FY=0.15, CH=3.2, D0=-6.5, D1=-3.5;            // 床・天井の高さ、入口の左右端
  // 壁・屋根(店内は作らない)
  solid(0.2,4.4,10,wallM,-10,FY,29); solid(0.2,4.4,10,wallM,10,FY,29); solid(20,4.4,0.2,wallM,0,FY,34);
  box(20.4,0.3,10.4,0xcfcac0,0,4.55,29,S);
  box(20,4.4-CH,0.2,wallM,0,FY+CH,24,S);
  // 正面：腰壁＋ガラス（入口だけ空ける）
  solid(D0+10,0.5,0.2,0x7a6a5c,(D0-10)/2,FY,24); solid(10-D1,0.5,0.2,0x7a6a5c,(D1+10)/2,FY,24);
  // 店内は作らない。ガラスの代わりに、商品棚が透けて見える絵を貼る(夜は光る)。
  const shopT=tex(512,128,(g,w,h)=>{ g.fillStyle='#eef1ee'; g.fillRect(0,0,w,h);
    for(let r=0;r<3;r++) for(let x=6;x<w;x+=9){ g.fillStyle=['#d24a3c','#3f7cc0','#e3b23c','#5aa66a','#8a5ab8'][(x+r*3)%5]; g.fillRect(x,40+r*28,6,18); } });
  const shopM=mat(0xffffff,{map:shopT,emissiveMap:shopT,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([shopM,1]);
  const doorM=mat(0x55626a,{roughness:.2});
  function pane(x0,x1,y0,y1,z,m=shopM){ const p=new THREE.Mesh(new THREE.PlaneGeometry(x1-x0,y1-y0),m); p.position.set((x0+x1)/2,(y0+y1)/2,z); p.rotation.y=Math.PI; S.add(p); return p; }
  pane(-10,D0,FY+0.5,FY+CH,23.99); pane(D1,6,FY+0.5,FY+CH,23.99);
  box(4,CH-0.5,0.2,wallM,8,FY+0.5,24,S);                // トイレ前は壁 pane(D0,D1,FY+2.4,FY+CH,24);
  [-10,-8.25,D0,D1,-1.5,0.5,2.5,4.5,6].forEach(x=>box(0.1,CH,0.14,0x8e9296,x,FY,24,S));
  box(20,0.1,0.14,0x8e9296,0,FY+2.4,24,S);
  // 自動ドア(閉まったまま)
  pane(D0,D1,FY,FY+2.4,23.92,doorM); box(0.06,2.4,0.06,0x8e9296,-5,FY,23.9,S);

  // 帯看板
  const fasciaT=tex(1024,96,(g,w,h)=>{
    g.fillStyle='#e07a2e'; g.fillRect(0,0,w,26);
    g.fillStyle='#fbf8f2'; g.fillRect(0,26,w,52);
    g.fillStyle='#6b4a32'; g.fillRect(0,78,w,18);
    g.fillStyle='#6b4a32'; g.font='bold 40px sans-serif'; g.textBaseline='middle';
    g.fillText('あおばマート',60,53);
    g.font='bold 22px sans-serif'; g.fillText('24h OPEN',w-170,53);
  });
  const fasciaM=mat(0xffffff,{map:fasciaT,emissiveMap:fasciaT,emissive:0xffffff,emissiveIntensity:0});
  glowMats.push([fasciaM,0.9]);
  box(20.6,1.1,0.4,0xfbf8f2,0,3.35,23.8,S);
  const fascia=new THREE.Mesh(new THREE.PlaneGeometry(20.6,1.1),fasciaM);
  fascia.position.set(0,3.9,23.59); fascia.rotation.y=Math.PI; S.add(fascia);

  box(3.6,0.03,1.4,0x55595e,-5,0.15,23.2,S);   // 入口マット（外）

  // ポール看板（駐車場の角）
  {
    const signT=tex(256,256,(g,w,h)=>{
      g.fillStyle='#fbf8f2'; g.fillRect(0,0,w,h);
      g.fillStyle='#e07a2e'; g.fillRect(0,0,w,34); g.fillStyle='#6b4a32'; g.fillRect(0,h-22,w,22);
      g.fillStyle='#6b4a32'; g.beginPath(); g.arc(128,108,52,0,Math.PI*2); g.fill();
      g.fillStyle='#fbf8f2'; g.beginPath(); g.ellipse(128,108,20,38,Math.PI/5,0,Math.PI*2); g.fill(); // 葉っぱ
      g.strokeStyle='#6b4a32'; g.lineWidth=4; g.beginPath(); g.moveTo(108,136); g.lineTo(148,80); g.stroke();
      g.fillStyle='#6b4a32'; g.font='bold 40px sans-serif'; g.textAlign='center'; g.textBaseline='middle';
      g.fillText('あおばマート',128,200);
    });
    const subT=tex(256,64,(g,w,h)=>{
      [['ATM','#2f5f9e'],['酒','#6b4a32'],['たばこ','#c23b2e']].forEach(([t,c],i)=>{
        g.fillStyle=c; g.fillRect(i*w/3+3,3,w/3-6,h-6);
        g.fillStyle='#fff'; g.font='bold 28px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(t,i*w/3+w/6,h/2);
      });
    });
    const face=t=>{const m=mat(0xffffff,{map:t,emissiveMap:t,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([m,.9]); return m;};
    const sx=11, sz=12.4, sm=face(signT), bm=face(subT), edge=mat(0xd8d8d4);
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.17,.2,7.6,16),mat(0xf2f2f0)); pole.position.set(sx,0.15+3.8,sz); scene.add(pole);
    const s1=new THREE.Mesh(new THREE.BoxGeometry(2.4,2.4,0.45),[edge,edge,edge,edge,sm,sm]); s1.position.set(sx,8.9,sz); scene.add(s1);
    const s2=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.6,0.4),[edge,edge,edge,edge,bm,bm]); s2.position.set(sx,7.35,sz); scene.add(s2);
    s1.rotation.y=s2.rotation.y=Math.PI/2;   // 道路沿いの両方向から見えるように
    box(0.8,0.25,0.8,0xbdbab3,sx,0.13,sz);  // 根元
  }

  // のぼり
  function nobori(x,z,c,txt){
    box(0.06,3.2,0.06,0xdddddd,x,0.15,z);
    const t=tex(64,256,(g,w,h)=>{g.fillStyle=c;g.fillRect(0,0,w,h);g.fillStyle='#fff';
      g.font='bold 40px sans-serif';g.textAlign='center';[...txt].forEach((ch,i)=>g.fillText(ch,32,60+i*52));});
    const p=new THREE.Mesh(new THREE.PlaneGeometry(0.6,2.3),mat(0xffffff,{map:t,side:THREE.DoubleSide}));
    p.position.set(x+0.33,2.1,z); p.rotation.y=Math.PI; scene.add(p);
  }
  nobori(-9,23.2,'#c23b2e','おでん'); nobori(6,23.2,'#2f5f9e','肉まん');

  // 自販機・ゴミ箱・ポスト
  function vending(x,c){
    box(1,1.8,0.8,c,x,0.15,23.4);
    const m=mat(0xffffff,{color:0xe9eef2,emissive:0xffffff,emissiveIntensity:0});
    glowMats.push([m,.6]);
    const f=new THREE.Mesh(new THREE.PlaneGeometry(0.8,0.8),m); f.position.set(x,1.4,22.99); f.rotation.y=Math.PI; scene.add(f);
  }
  vending(11.2,0xd8dfe6); vending(12.4,0xc23b2e);
  box(1.6,0.9,0.6,0xd0d4d6,-11.2,0.15,23.4);
  box(0.45,1.2,0.4,0xc8302a,-13,0.15,22.5);

  keepSolid=false;
  // ---- 車 ----
  function car(x,z,c,ry){
    const g=new THREE.Group();
    box(1.8,0.7,4.2,c,0,0.35,0,g);
    box(1.6,0.6,2.2,c,0,1.05,-0.2,g);
    box(1.62,0.45,2.0,0x2b3440,0,1.1,-0.2,g); // 窓
    const wm=mat(0x1d1d1d);
    for(const a of [-0.9,0.9]) for(const b of [-1.3,1.3]){
      const w=new THREE.Mesh(new THREE.CylinderGeometry(.35,.35,.25,16),wm);
      w.rotation.z=Math.PI/2; w.position.set(a,.35,b); g.add(w);
    }
    g.position.set(x,0.13,z); g.rotation.y=ry; scene.add(g);
    if(Math.abs(Math.sin(ry))<0.1) colliders.push([x-0.9,z-2.1,x+0.9,z+2.1]);   // 止まっている車(縦向き)
    return g;
  }
  car(5.5,20,0xf3f3f0,0); car(3,20,0x5d6f84,0);
  const movers=[{c:car(-40,-3,0xb3392f,Math.PI/2),v:7},{c:car(40,3,0x2e2e2e,-Math.PI/2),v:-5}];

  // ---- たまに通るトラックとバス ----
  function wheels(g,zs,r=0.5,w=2.1){
    const wm=mat(0x1d1d1d);
    for(const z of zs) for(const s of [-1,1]){
      const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,0.3,16),wm); m.rotation.z=Math.PI/2; m.position.set(s*w/2,r,z); g.add(m);
    }
  }
  function truck(){
    const g=new THREE.Group();
    box(2,0.35,7,0x333333,0,0.5,0.2,g);                 // 車台
    box(2.3,2.6,5.2,0xeeeeea,0,0.85,-1,g);              // 荷台
    box(2.2,2.1,1.7,0x3d6fb0,0,0.6,2.65,g);             // 運転席
    box(2,0.8,0.05,0x2b3440,0,1.75,3.51,g);             // フロントガラス
    wheels(g,[-2.6,-1.5,2.5]); scene.add(g); return g;
  }
  function bus(){
    const g=new THREE.Group();
    box(2.4,2.6,10,0xeae6da,0,0.45,0,g);
    box(2.42,0.35,10.02,0x3a8a5a,0,0.85,0,g);           // 帯
    box(2.44,0.9,8.4,0x2b3440,0,1.85,-0.5,g);           // 側面の窓
    box(2.2,1.4,0.05,0x2b3440,0,1.45,5.01,g);           // フロントガラス
    box(1.6,0.3,0.05,0x222222,0,2.75,5.01,g);           // 行先表示
    wheels(g,[-3.4,3.4],0.55); scene.add(g); return g;
  }
  const trk=truck(); trk.rotation.y=Math.PI/2;  trk.position.set(-60,0,-3);
  const bs=bus();    bs.rotation.y=-Math.PI/2;  bs.position.set(60,0,3);
  movers.push({c:trk,v:7,start:-64,wait:6,every:[12,25],lane:movers[0].c});
  movers.push({c:bs,v:-5,start:64,wait:15,every:[15,30],lane:movers[1].c});

  // ---- 電柱と電線 ----
  const poleXs=[-36,-14,8,30], lamps=[];
  const pM=mat(0xb9b6ae);
  poleXs.forEach(x=>{
    const p=new THREE.Mesh(new THREE.CylinderGeometry(.14,.2,9.5,10),pM);
    p.position.set(x,4.9,9.4); scene.add(p);
    box(2.2,0.12,0.12,0x8a8a86,x,8.8,9.4);
    box(0.6,0.15,0.5,0x777,x+0.4,6.3,9.1); // 街灯
    const L=new THREE.PointLight(0xffe2b0,0,22,2); L.position.set(x+0.4,6.1,8.9); scene.add(L); lamps.push(L);
  });
  // 電線は線(1ピクセル)。まとめて1回で描けるよう、全部を1つの線分の集まりにする。
  const wireM=new THREE.LineBasicMaterial({color:0x2a2a2a});
  const WIRE_STEPS=6;                                    // たるみの曲線の分割数
  function wireSegments(spans,out){                      // spans: [[始点,終点,たるみ(m)], ...]
    for(const [a,b,sag] of spans){ const m=a.clone().lerp(b,.5); m.y-=sag;
      const pts=new THREE.QuadraticBezierCurve3(a,m,b).getPoints(WIRE_STEPS);
      for(let k=0;k<pts.length-1;k++) out.push(pts[k],pts[k+1]); }
    return out;
  }
  {
    const spans=[];
    for(let i=0;i<poleXs.length-1;i++) for(const dx of [-0.9,0.9])
      spans.push([new THREE.Vector3(poleXs[i]+dx,8.95,9.4),new THREE.Vector3(poleXs[i+1]+dx,8.95,9.4),0.6]);
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wireSegments(spans,[])),wireM));
  }

  // ---- 道路沿いの家とオフィスビル（映画セット式：道路側だけ作る）----
  // f = 正面の向き。-1 は手前側(道路はzが小さい方)、+1 は向かい側
  const winM=mat(0x2d3440,{emissive:0xffdca0,emissiveIntensity:0,roughness:.3});
  glowMats.push([winM,.8]);
  const darkWinM=mat(0x2d3440,{roughness:.3});                          // 夜も消灯している窓
  function frontPlane(w,h,x,y,zf,f,m){
    const p=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m);
    p.position.set(x,y,zf+f*0.02); p.rotation.y=f<0?Math.PI:0; scene.add(p); return p;
  }
  // ハリボテ: 道路に向いた面と左右の面だけ。反対側と天井・床は作らない。
  // (玄関が道路と反対を向く家もあるので、残す面は玄関の向きではなく道路の側で決める)
  function hollow(w,h,d,m,x,y,cz,f){
    const mm=typeof m==='number'?bmat(m):m, rf=cz>0?-1:1, zf=cz+rf*d/2;
    frontPlane(w,h,x,y+h/2,zf-rf*0.02,rf,mm);
    for(const s of [-1,1]){ const p=new THREE.Mesh(new THREE.PlaneGeometry(d,h),mm); p.position.set(x+s*w/2,y+h/2,cz); p.rotation.y=s*Math.PI/2; scene.add(p); }
    colliders.push([x-w/2,cz-d/2,x+w/2,cz+d/2]);
  }
  let houseNo=0;                                                         // 夜の灯り：1階だけ／2階だけ／全部 を順番に
  function house(x,zf,f,w,wall,fence=true){
    const pat=houseNo++%3, lit=fl=>(pat===2||(pat===0&&fl<2)||(pat===1&&fl>2))?winM:darkWinM;
    const d=6, cz=zf-f*d/2;
    hollow(w,5.4,d,wall,x,0,cz,f);
    // 切妻屋根（三角の断面を横に伸ばす。妻側は壁と同じ色）
    const sh=new THREE.Shape([new THREE.Vector2(-d/2-0.5,0),new THREE.Vector2(d/2+0.5,0),new THREE.Vector2(0,2.2)]);
    const rg=new THREE.ExtrudeGeometry(sh,{depth:w+0.4,bevelEnabled:false}); rg.translate(0,0,-(w+0.4)/2);
    const r=new THREE.Mesh(rg,[mat(wall),mat(0x4b5057)]);
    r.rotation.y=Math.PI/2; r.position.set(x,5.4,cz); scene.add(r);
    box(w+0.4,0.15,0.6,0x5a5f66,x,2.8,zf+f*0.3);                     // 1階の小屋根
    for(const fl of [0.9,3.4]) for(const dx of [-w/4,w/4])
      frontPlane(1.6,1.2,x+dx,fl+0.8,zf,f,lit(fl));                     // 窓
    frontPlane(1,2.1,x,1.05,zf,f,mat(0x6b5440));                        // 玄関
    if(fence) box(w,1.1,0.15,0xbab4a8,x,0.15,zf+f*1.2);                // ブロック塀
  }
  function office(x,zf,f,w,floors,wall){
    const d=7, cz=zf-f*d/2, h=floors*3.2;
    hollow(w,h,d,wall,x,0,cz,f);
    box(w+0.2,0.5,d+0.2,0x9a9690,x,h,cz);                               // 屋上の縁
    for(let i=0;i<floors;i++){
      if(i===0) continue;                                                // 1階：中央の入口だけ（両脇は壁）
      frontPlane(w-1.2,1.4,x,i*3.2+1.7,zf,f,i===3?winM:darkWinM);     // 横長の窓（夜は4階だけ点灯）
    }
    const lobbyM=mat(0x8a959c,{roughness:.2});
    frontPlane(2.4,2.5,x,1.4,zf,f,lobbyM);                               // ガラスの自動ドア
    box(0.08,2.5,0.06,0x6e7378,x,0.15,zf+f*0.04);                        // ドアの合わせ目
    box(3.4,0.18,1.4,0x8e9296,x,2.75,zf+f*0.7);                          // 入口のひさし
    box(3,0.15,0.8,0xbdbab3,x,0,zf+f*0.4);                               // 入口の段
  }
  // 木・ベンチ・街灯
  function tree(x,z,s=1){
    const t=new THREE.Mesh(new THREE.CylinderGeometry(.15*s,.22*s,2*s,8),mat(0x6b4f36));
    t.position.set(x,0.15+s,z); scene.add(t);
    const l=new THREE.Mesh(new THREE.IcosahedronGeometry(1.5*s,1),leafM);
    l.position.set(x,0.15+2.6*s,z); scene.add(l);
  }
  function bench(x,z,ry){
    const g=new THREE.Group();
    box(1.8,0.08,0.45,0x8a6440,0,0.45,0,g);
    box(1.8,0.4,0.06,0x8a6440,0,0.6,0.22,g);
    for(const dx of [-0.75,0.75]) box(0.08,0.45,0.4,0x444,dx,0,0,g);
    g.position.set(x,0.15,z); g.rotation.y=ry; scene.add(g);
  }
  function parkLamp(x,z){
    box(0.1,3.6,0.1,0x3c4046,x,0.15,z);
    const m=mat(0xf5f0e0,{emissive:0xfff0c8,emissiveIntensity:0}); glowMats.push([m,1.2]);
    const b=new THREE.Mesh(new THREE.SphereGeometry(0.25,12,8),m); b.position.set(x,3.9,z); scene.add(b);
    const L=new THREE.PointLight(0xffe8c0,0,12,2); L.position.set(x,3.7,z); scene.add(L); lamps.push(L);
  }

  // 左隣：小さな公園
  box(15,0.05,13.6,0x7f9a5c,-21.5,0.13,17.2);                        // 芝生
  box(0.25,3.2,13.6,0xa8a39a,-14,0.15,17.2);                          // コンビニ側の高い壁
  for(const [x0,z0,x1,z1] of [[-29,10.4,-23,10.4],[-20,10.4,-14,10.4],[-29,24,-15.6,24],[-29,10.4,-29,24]]){
    const w=Math.abs(x1-x0)||0.12, d=Math.abs(z1-z0)||0.12;
    box(w,0.5,d,0x9fa29c,(x0+x1)/2,0.15,(z0+z1)/2);                    // 低い柵
  }
  [[-26.5,13],[-26,19.5],[-17,21.5],[-25,23],[-16.5,12.5]].forEach(([x,z],i)=>tree(x,z,i%2?1.2:1));
  // ベンチは公園の真ん中を向ける
  [[-24.3,16.5],[-18.7,16.5],[-21.5,22.5]].forEach(([x,z])=>bench(x,z,Math.atan2(-(-21.5-x),-(17.2-z))));
  parkLamp(-20.2,13); parkLamp(-22.8,20);

  // 右隣：塀に囲まれた家（コンビニ側は高い壁）
  const blockM=mat(0xbab4a8);
  box(7,1.2,0.15,blockM,17.5,0.15,10.4); box(7,1.2,0.15,blockM,26.5,0.15,10.4); // 正面（門あり）
  box(0.15,1.2,13.6,blockM,30,0.15,17.2);                             // 右
  box(16,1.2,0.15,blockM,22,0.15,24);                                 // 奥
  box(0.25,3.2,13.6,0xa8a39a,14,0.15,17.2);                           // コンビニ側の高い壁
  for(const dx of [-1,1]) box(0.4,1.5,0.4,0x8f8a80,22+dx*1.1,0.15,10.4); // 門柱
  house(22,14.5,-1,9,0xcfc6b2,false);
  tree(27.5,12.5,0.9);

  // 左奥の家
  // 公園の左隣の家：敷地は歩道・路地・公園にぴったり
  house(-37.3,12.8,-1,9,0xd9d3c4,false);
  { const a=-42.4, b=-29.2, z0=9.3, z1=24.15;
    box(b-a,0.04,z1-z0,0x7f9a5c,(a+b)/2,0.1,(z0+z1)/2);
    box(0.15,1.2,z1-z0,blockM,a,0.15,(z0+z1)/2); box(0.15,1.2,z1-z0,blockM,b,0.15,(z0+z1)/2); box(b-a,1.2,0.15,blockM,(a+b)/2,0.15,z1);
    for(const [c0,c1] of [[a,-37.9],[-36.7,-33]]) box(c1-c0,1.2,0.15,blockM,(c0+c1)/2,0.15,z0);   // 道路ぎわ（門と車の出入口は空ける）
    box(3.6,0.04,5,0xbdbab3,-31.1,0.13,11.9); car(-31.1,12,0x4a6b5a,0); }

  // 向かい側（右斜め向かいに中型オフィスビル）
  // 塀で囲った敷地＋駐車スペース。side=-1 なら駐車場が左、+1 なら右
  // 手前に駐車場、その奥に家。side=-1 なら駐車場が左、+1 なら右
  function lot(cx,wall,side,carColor){
    const W=12, D=15, z0=-9.4, z1=z0-D, hw=W/2-0.1, a=cx-hw, b=cx+hw;
    const px=cx+side*(hw-3), gx=cx-side*(hw-2.9);                       // 駐車場・庭の中心
    box(6,0.03,5.6,0xbdbab3,px,0.14,z0-2.8);                            // コンクリート土間
    box(5.8,0.04,5.6,0x7f9a5c,gx,0.13,z0-2.8);                          // 庭
    box(5.8,1.0,0.15,blockM,gx,0.15,z0);                                // 正面の塀（庭の前だけ）
    box(0.15,1.2,D,blockM,a,0.15,(z0+z1)/2);                            // 左右
    box(0.15,1.2,D,blockM,b,0.15,(z0+z1)/2);
    box(W-0.2,1.2,0.15,blockM,cx,0.15,z1);                             // 奥
    tree(gx,z0-2.6,0.7);
    house(cx,-15.6,1,9,wall,false);
    if(carColor) car(px,z0-2.9,carColor,0);
  }
  // 向かい側（右斜め向かいに中型オフィスビル）
  lot(-36,0xe2dccd,1,0xf3f3f0);
  lot(-24,0xd6cfbe,-1,null);
  lot(-12,0xd9d3c4,1,0x8c9a7a);
  lot(0,0xcfc6b2,-1,0x9a3b33);
  office(18,-10.5,1,12,5,0xbfc5c9);
  // ビルと家の間の路地（アスファルト）と、ビル奥の駐車場
  box(5.8,0.13,21,0x46484b,9,0,-19.8);
  box(13,0.12,21,0x4a4c4f,18.5,0,-19.8);                                // オフィスビルの敷地（アスファルト）
  box(12.6,0.13,14.8,0x4a4c4f,36.5,0,16.6);                              // 古いビルの敷地（アスファルト）
  box(12.2,0.13,12.4,0x4a4c4f,18.1,0,-24.1);
  for(let i=0;i<=4;i++) box(0.12,0.01,5,0xf0f0f0,13.5+i*2.5,0.13,-26.9);
  for(let i=0;i<4;i++) box(1.4,0.15,0.22,0xc9b07a,14.75+i*2.5,0.13,-29.1);
  car(16.25,-26.8,0xe8e4da,Math.PI); car(21.25,-26.8,0x4a6b5a,Math.PI);
  lot(31,0xcac2ad,-1,0x3d4a63);

  // 公園の奥・斜め奥の家（入口は道路と反対側、庭に木）
  function backLot(x0,x1,wall,wh=1.2){                                          // 敷地はすき間なく、奥の路地にぴったり
    const z0=24.15, z1=44.55, cx=(x0+x1)/2, w=x1-x0, zc=(z0+z1)/2;
    box(w,0.04,z1-z0,0x7f9a5c,cx,0.12,zc);                               // 庭
    box(w,wh,0.15,blockM,cx,0.15,z0);                                    // 公園側
    box(0.15,wh,z1-z0,blockM,x0,0.15,zc); box(0.15,wh,z1-z0,blockM,x1,0.15,zc);
    box((w-2)/2,wh,0.15,blockM,x0+(w-2)/4,0.15,z1); box((w-2)/2,wh,0.15,blockM,x1-(w-2)/4,0.15,z1); // 門は奥側（路地）
    if(wh>1.5) colliders.push([x0,z0-0.1,x1,z0+0.1],[x0-0.1,z0,x0+0.1,z1],[x1-0.1,z0,x1+0.1,z1],[x0,z1-0.1,cx-1,z1+0.1],[cx+1,z1-0.1,x1,z1+0.1]);
    box(2,0.03,5.1,0xc8b48e,cx,0.14,41.9);                               // 玄関までの小道
    house(cx,39.3,1,9,wall,false);
    tree(cx-4,27,1.1); tree(cx+3.8,27.4,0.9); tree(cx-0.5,29.2,1.2); tree(cx-3.6,31,0.8); tree(cx+4,30.6,1);
  }
  backLot(-29,-13.2,0xe2dccd,2.3);                                     // 電波ビルの奥まで敷地を広げ、高い塀で囲む
  backLot(-42.4,-29,0xd6cfbe);

  // コンビニ隣の家のさらに隣：古いビル（4階建て、汚れた外壁、屋上に貯水タンク）
  {
    const cx=36.5, zf=10.6, W=10, D=9, floors=4, FH=3, cz=zf+D/2, H=floors*FH;
    const oldT=tex(256,256,(g,w,h)=>{
      g.fillStyle='#a8a193'; g.fillRect(0,0,w,h);
      for(let i=0;i<60;i++){ g.fillStyle=`rgba(60,55,45,${0.04+Math.random()*0.08})`;   // 雨だれの汚れ
        g.fillRect(Math.random()*w,Math.random()*h*0.6,1+Math.random()*3,30+Math.random()*120); }
      for(let i=0;i<8;i++){ g.fillStyle='rgba(80,75,62,.15)'; g.fillRect(0,i*32,w,2); }  // 目地
    });
    oldT.wrapS=oldT.wrapT=THREE.RepeatWrapping; oldT.repeat.set(2,2);
    box(W,H,D,mat(0xffffff,{map:oldT,roughness:1}),cx,0.15,cz);
    box(W+0.2,0.35,D+0.2,0x8f897c,cx,0.15+H,cz);                                    // 屋上の縁
    // 1階：中央に入口だけ（両側は壁）
    frontPlane(1.8,2.3,cx,0.15+1.15,zf,-1,mat(0x5a5248));                           // 両開きの扉
    box(0.06,2.3,0.06,0x3a342c,cx,0.15,zf-0.04);
    box(2.4,0.15,0.7,0x9a9488,cx,0.15,zf-0.35);                                      // 入口の段
    frontPlane(3,0.6,cx,0.15+3.0,zf,-1,mat(0x6e5a3e));                              // 古い看板
    // 2〜4階：小さめの窓と室外機
    for(let f=1;f<floors;f++) for(let i=0;i<3;i++){
      const x=cx-3.2+i*3.2, y=0.15+f*FH+1.4;
      frontPlane(1.6,1.2,x,y,zf,-1,f===2?winM:darkWinM);                             // 夜は3階だけ点灯
      box(1.8,0.08,0.2,0x8f897c,x,y-0.68,zf-0.1);
    }
    // 屋上の貯水タンク
    for(const dx of [-0.6,0.6]) for(const dz of [-0.6,0.6]) box(0.1,1.2,0.1,0x6a6d70,cx+2+dx,0.5+H,cz+dz);
    const tank=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1.6,16),mat(0xb9bdb8)); tank.position.set(cx+2,0.5+H+2,cz); scene.add(tank);
    box(1.6,0.9,1.6,0x9a9488,cx-2.5,0.5+H,cz+1);                                    // 階段室
  }

  // コンビニ隣の家の奥：アパート（道路側は窓だけ、入口は奥側）
  {
    const cx=22, zb=25.5, zf=33.5, W=16, floors=3, FH=2.9;
    box(W,floors*FH,zf-zb,0xd8d2c6,cx,0.15,(zb+zf)/2);
    box(W+0.3,0.4,zf-zb+0.3,0xa8a39a,cx,0.15+floors*FH,(zb+zf)/2);     // 屋上の縁
    for(let f=0;f<floors;f++) for(let i=0;i<4;i++){
      const x=cx-W/2+2+i*4, y=0.15+f*FH+1.5;
      const aptLit=[1,0,0,1, 0,1,1,0, 1,0,1,0];                          // 夜の点灯：12部屋中6部屋（ばらばらに）
      frontPlane(1.4,1.1,x,y,zb,-1,aptLit[f*4+i]?winM:darkWinM);         // 道路側の窓
      box(1.6,0.08,0.25,0xa8a39a,x,y-0.65,zb-0.12);                      // 窓の水切り
    }
    const doorM=mat(0x6e6a62);
    for(let f=0;f<floors;f++){
      const y=0.15+f*FH;
      if(f>0){ box(W,0.15,1.3,0xbab4a8,cx,y,zf+0.65); box(W,1.0,0.08,0x8e9296,cx,y+0.15,zf+1.28); } // 外廊下と手すり
      for(let i=0;i<4;i++) frontPlane(0.9,2,cx-W/2+2+i*4,y+1.05,zf,1,doorM);  // 玄関ドア
    }
    box(1.4,floors*FH,3,0xbab4a8,cx+W/2+0.7,0.15,zf-0.5);                  // 階段
  }

  // ---- 向かい側の右端：タイル張りの2階建てビル（1階は美容室、2階は横長の窓、屋上に手すり）----
  {
    const cx=43, zf=-10.5, W=10, D=9, H=7.2, cz=zf-D/2;
    const brickT=tex(128,128,(g,w,h)=>{ g.fillStyle='#4a3a32'; g.fillRect(0,0,w,h);
      for(let y=0;y<h;y+=8) for(let x=0;x<w;x+=16){ g.fillStyle=`rgb(${70+((x*7+y*3)%25)},${55+((x+y)%18)},${46+((x*3)%14)})`; g.fillRect(x+((y/8)%2)*8,y,14,6); } });
    brickT.wrapS=brickT.wrapT=THREE.RepeatWrapping; brickT.repeat.set(5,4);
    box(W,H,D,mat(0xffffff,{map:brickT}),cx,0.15,cz); colliders.push([cx-W/2,zf-D,cx+W/2,zf]);
    box(W+0.1,0.15,D+0.1,0x5a4a40,cx,0.15+H,cz);
    // 2階：白い枠の横長窓
    const fr=mat(0xe8e4da), sash=mat(0x2b2f35);
    box(7.6,2.5,0.12,fr,cx-0.6,3.8,zf+0.06);
    frontPlane(7.1,2.1,cx-0.6,5.05,zf+0.11,1,winM);
    for(let i=0;i<=4;i++) box(0.07,2.1,0.06,sash,cx-0.6-3.55+i*1.775,4.0,zf+0.16);
    box(7.1,0.07,0.06,sash,cx-0.6,4.75,zf+0.16);
    // 1階：ガラス張りの店先と、斜めの日よけ2枚
    const shop=mat(0x3a4148,{emissive:0xffe6c0,emissiveIntensity:0}); glowMats.push([shop,.8]);
    frontPlane(8.6,2.7,cx-0.5,1.5,zf,1,shop);
    for(let i=0;i<=4;i++) box(0.08,2.7,0.08,sash,cx-0.5-4.3+i*2.15,0.15,zf+0.05);
    for(const s of [-1,1]){ const a=box(4.2,0.08,1.8,0x3d4a46,cx-0.5+s*2.15,0,zf+0.8); a.position.y=3.15; a.rotation.x=0.35; }
    // 縦の看板文字
    const signT=tex(64,512,(g,w,h)=>{ g.clearRect(0,0,w,h); g.fillStyle='#f4f2ec'; g.font='bold 52px sans-serif'; g.textAlign='center';
      [...'SALONKAZE'].forEach((c,i)=>g.fillText(c,w/2,52+i*(c==='K'&&i===5?56:52)+(i>=5?20:0))); });
    frontPlane(0.55,4.6,cx+4.2,4.6,zf+0.02,1,mat(0xffffff,{map:signT,transparent:true}));
    // 屋上の周囲の柵（支柱と上下の横棒）
    const rail=mat(0x6f747a), y0=0.3+H;
    for(const [len,x,z,ax] of [[W,cx,zf-0.1,'x'],[W,cx,zf-D+0.1,'x'],[D,cx-W/2+0.1,cz,'z'],[D,cx+W/2-0.1,cz,'z']]){
      for(const yy of [y0+0.15,y0+1.05]) ax==='x'?box(len,0.05,0.05,rail,x,yy,z):box(0.05,0.05,len,rail,x,yy,z);
      for(let t=-len/2;t<=len/2+0.01;t+=1) ax==='x'?box(0.05,1.1,0.05,rail,x+t,y0,z):box(0.05,1.1,0.05,rail,x,y0,z+t);
    }
    // 店先の椅子と、さび色の街灯
    for(let i=0;i<4;i++){ const x=cx+0.6+i*0.75; box(0.45,0.06,0.45,0xc98a5a,x,0.6,zf+1.3); box(0.45,0.45,0.06,0xc98a5a,x,0.63,zf+1.08); box(0.04,0.45,0.04,0x333333,x,0.15,zf+1.3); }
    box(0.14,5.2,0.14,0x6b3a2a,cx-1.2,0.15,zf+2.2); box(1.6,0.08,0.08,0x6b3a2a,cx-1.2,5.2,zf+2.2);
    const lm=mat(0xf5f0e0,{emissive:0xfff0c8,emissiveIntensity:0}); glowMats.push([lm,1.2]);
    box(0.35,0.15,0.3,lm,cx-1.9,5.05,zf+2.2); box(0.35,0.15,0.3,lm,cx-0.5,5.05,zf+2.2);
  }

  // ---- 交差点（幹線と同じ幅の道が交わる）----
  const X0=78;                                         // 交差する道の中心 x（車道 72..84、歩道 69..72 / 84..87）
  {
    const asph=roadGlowM, wl=mat(0xeeeeee), yl=mat(0xd9b23a), cb=mat(0x9d9a94), lightAsph2=mat(0x707275);
    const segX=(a,b,fn)=>fn((a+b)/2,b-a);
    // 幹線道路を交差点の先まで延長
    box(75,0.02,12,asph,102.5,0,0);
    for(const [a,b] of [[65,72],[84,140]]){ segX(a,b,(c,l)=>{ box(l,0.15,3,walk,c,0,7.7); box(l,0.15,3,walk,c,0,-7.7);
      for(const z of [-6.1,6.1]) box(l,0.18,0.2,cb,c,0,z); box(l,0.05,3.2,lightAsph2,c,0.05,10.8); box(l,0.05,3.2,lightAsph2,c,0.05,-10.8); }); }
    for(const [a,b] of [[65,66],[90,140]]) segX(a,b,(c,l)=>{ box(l,0.02,0.15,yl,c,0.02,0); for(const z of [-5.6,5.6]) box(l,0.02,0.12,wl,c,0.02,z); });
    // 交差する道（南北）
    box(12,0.02,180,asph,X0,0,0);
    // 歩道（西側の工場裏の路地との接続部は切る）
    for(const [side,segs] of [[-1,[[9.2,58.8],[62.4,90],[-90,-9.2]]],[1,[[9.2,90],[-90,-9.2]]]])
      for(const [a,b] of segs){ const c=(a+b)/2,l=b-a; box(3,0.15,l,walk,X0+side*7.5,0,c); box(0.2,0.18,l,cb,X0+side*6.1,0,c); }
    for(const [a,b] of [[14,90],[-90,-14]]){ const c=(a+b)/2,l=b-a; box(0.15,0.02,l,yl,X0,0.02,c); for(const x of [X0-5.6,X0+5.6]) box(0.12,0.02,l,wl,x,0.02,c); }
    // 横断歩道と停止線
    for(const x of [67.5,88.5]) for(let z=-5.4;z<=5.4;z+=0.9) box(3,0.01,0.45,wl,x,0.03,z);
    for(const z of [-11.5,11.5]) for(let x=X0-5.4;x<=X0+5.4;x+=0.9) box(0.45,0.01,3,wl,x,0.03,z);
    box(0.4,0.01,6,wl,65.4,0.03,-3); box(0.4,0.01,6,wl,90.6,0.03,3);
    box(6,0.01,0.4,wl,X0+3,0.03,-13.6); box(6,0.01,0.4,wl,X0-3,0.03,13.6);
  }
  // 信号機（日本式の横型：青・黄・赤）と歩行者用信号
  const sigHeads=[];                                    // {grp:'main'|'cross', lamps:[青,黄,赤]}
  const pedHeads=[];                                    // {grp, lamps:[赤,青]}
  {
    const poleM=mat(0x8a8f96), houseM=mat(0x5a6068);
    const lampOff=c=>mat(c,{emissive:c,emissiveIntensity:0.05});
    function head(x,z,ry,grp){                          // 横型の車両用信号
      const g=new THREE.Group(); g.position.set(x,5.3,z); g.rotation.y=ry; scene.add(g);
      box(1.3,0.42,0.3,houseM,0,-0.21,0,g);
      const lamps=[0x2fd28a,0xffc23a,0xff3a2a].map((c,i)=>{ const m=lampOff(c); const l=new THREE.Mesh(new THREE.CircleGeometry(0.15,20),m); l.position.set(-0.42+i*0.42,0,-0.16); l.rotation.y=Math.PI; g.add(l); return m; });
      sigHeads.push({grp,lamps});
    }
    function ped(x,z,ry,grp){                           // 歩行者用（上が赤、下が青）
      const g=new THREE.Group(); g.position.set(x,2.6,z); g.rotation.y=ry; scene.add(g);
      box(0.4,0.75,0.2,houseM,0,-0.375,0,g);
      const lamps=[0xff3a2a,0x2fd28a].map((c,i)=>{ const m=lampOff(c); const l=new THREE.Mesh(new THREE.PlaneGeometry(0.28,0.28),m); l.position.set(0,0.17-i*0.36,-0.11); l.rotation.y=Math.PI; g.add(l); return m; });
      pedHeads.push({grp,lamps});
    }
    const corners=[[70.5,-7.7],[85.5,-7.7],[70.5,7.7],[85.5,7.7]];
    corners.forEach(([x,z])=>{ box(0.18,5.6,0.18,poleM,x,0.15,z); colliders.push([x-0.2,z-0.2,x+0.2,z+0.2]); });
    // 車両用：各方向とも交差点の向こう側に設置
    box(0.1,0.1,3.7,poleM,85.5,5.35,-5.85); head(85.5,-4.0,-Math.PI/2,'main');   // 東行き（-z 側の車線）を見る
    box(0.1,0.1,3.7,poleM,70.5,5.35,5.85);  head(70.5,4.0,Math.PI/2,'main');     // 西行き
    box(4.5,0.1,0.1,poleM,83.25,5.35,7.7);  head(81,7.7,0,'cross');              // 南向き（+z へ進む車）を見る ※-z 側から来る
    box(4.5,0.1,0.1,poleM,72.75,5.35,-7.7); head(75,-7.7,Math.PI,'cross');       // 北向き
    // 歩行者用：横断歩道の両端
    ped(70.5,-7.4,0,'xmain'); ped(70.5,7.4,Math.PI,'xmain'); ped(85.5,-7.4,0,'xmain'); ped(85.5,7.4,Math.PI,'xmain');      // 幹線を渡る
    ped(70.2,-7.7,-Math.PI/2,'xcross'); ped(85.8,-7.7,Math.PI/2,'xcross'); ped(70.2,7.7,-Math.PI/2,'xcross'); ped(85.8,7.7,Math.PI/2,'xcross'); // 交差道路を渡る
  }
  let sigPhase='';
  function updateSignals(t){
    const c=t%36;                                       // 幹線：青0-14 黄14-17 赤17-36 / 交差：赤0-18 青18-32 黄32-35
    const main=c<14?0:c<17?1:2, cross=(c>=18&&c<32)?0:(c>=32&&c<35)?1:2;
    const key=main+'_'+cross; if(key===sigPhase) return; sigPhase=key;
    sigHeads.forEach(h=>{ const s=h.grp==='main'?main:cross; h.lamps.forEach((m,i)=>m.emissiveIntensity=i===s?1.6:0.05); });
    pedHeads.forEach(h=>{ const go=h.grp==='xcross'?main===0:cross===0; h.lamps[0].emissiveIntensity=go?0.05:1.4; h.lamps[1].emissiveIntensity=go?1.4:0.05; });
  }
  updateSignals(0);
  // 交差する道を走る車（赤・黄では停止線の手前で止まる）
  const crossCars=[{c:car(X0+3,-55,0x4a6b5a,0),dir:1,stop:-14.6},{c:car(X0-3,50,0xe8e4da,Math.PI),dir:-1,stop:14.6}];
  function crossGreen(){ return sigPhase.split('_')[1]==='0'; }

  // 歩道に面していない辺を囲む塀
  const lotWallM=mat(0xbab4a8);
  function lotWall(x0,z0,x1,z1){ const h=1.8, w=Math.abs(x1-x0)||0.2, d=Math.abs(z1-z0)||0.2;
    box(w,h,d,lotWallM,(x0+x1)/2,0.15,(z0+z1)/2); box(w+0.04,0.08,d+0.04,0x9a968c,(x0+x1)/2,0.15+h,(z0+z1)/2);
    colliders.push([Math.min(x0,x1)-0.1,Math.min(z0,z1)-0.1,Math.max(x0,x1)+0.1,Math.max(z0,z1)+0.1]); }
  lotWall(49.1,-9.4,49.1,-32); lotWall(49.1,-31.9,69,-31.9);                 // ガソリンスタンド：西と南
  lotWall(124.9,9.4,124.9,40); lotWall(87,39.9,125,39.9);                    // ファミレス：東と南
  lotWall(43.1,9.4,43.1,30); lotWall(43.1,29.9,68.6,29.9);                   // 月極駐車場：西と奥

  let gsLight=null, gsPoolM=null;
  // ---- ガソリンスタンド（茶色ビルの隣、交差点の角）----
  keepSolid=true;
  {
    const x0=49, x1=69, z0=-9.2, z1=-32, cx=(x0+x1)/2, cz=(z0+z1)/2;
    box(x1-x0,0.06,z0-z1,mat(0x9c9a94),cx,0.1,cz);
    const canopyT=tex(512,64,(g,w,h)=>{ g.fillStyle='#ffffff'; g.fillRect(0,0,w,h); g.fillStyle='#1f8a4c'; g.fillRect(0,h-18,w,18); g.fillStyle='#e0402e'; g.fillRect(0,0,w,8);
      g.fillStyle='#1f8a4c'; g.font='bold 34px sans-serif'; g.textBaseline='middle'; g.fillText('あおば石油  SELF',20,26); });
    const cm=mat(0xffffff,{map:canopyT}), cw=mat(0xf4f4f2);
    const can=new THREE.Mesh(new THREE.BoxGeometry(17,0.9,12),[cm,cm,cw,cw,cm,cm]); can.position.set(cx,5.6,-19); scene.add(can);
    const under=mat(0xffffff,{emissive:0xffffff,emissiveIntensity:0}); glowMats.push([under,1]);
    const up=new THREE.Mesh(new THREE.PlaneGeometry(16,11),under); up.rotation.x=Math.PI/2; up.position.set(cx,5.14,-19); scene.add(up);
    // 夜は屋根の下をかなり明るく：照明＋床の明るい光だまり
    gsLight=new THREE.PointLight(0xffffff,0,26,1.2); gsLight.position.set(cx,4.6,-19); scene.add(gsLight);
    const gsPoolT=tex(128,128,(g,w,h)=>{ const gr=g.createRadialGradient(64,64,0,64,64,64); gr.addColorStop(0,'rgba(255,255,250,1)'); gr.addColorStop(0.6,'rgba(255,255,245,.8)'); gr.addColorStop(1,'rgba(255,255,240,0)'); g.fillStyle=gr; g.fillRect(0,0,w,h); });
    gsPoolM=new THREE.MeshBasicMaterial({map:gsPoolT,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:0});
    const gp=new THREE.Mesh(new THREE.PlaneGeometry(24,18),gsPoolM); gp.rotation.x=-Math.PI/2; gp.position.set(cx,0.22,-19); scene.add(gp);
    for(const x of [cx-5,cx+5]) for(const z of [-15,-23]){ box(0.45,5.2,0.45,0xd8d8d4,x,0.15,z); colliders.push([x-0.3,z-0.3,x+0.3,z+0.3]); }
    // 給油機の島 2列
    for(const x of [cx-3.5,cx+3.5]){
      box(1.2,0.25,6,0xcfcdc6,x,0.15,-19); colliders.push([x-0.6,-22,x+0.6,-16]);
      for(const z of [-21,-17]){ box(0.7,1.7,0.5,0xf2f2f0,x,0.4,z); box(0.72,0.5,0.52,0x1f8a4c,x,1.8,z); box(0.5,0.3,0.02,0x0d3550,x,1.45,z-0.26); box(0.5,0.3,0.02,0x0d3550,x,1.45,z+0.26); }
    }
    // 事務所・洗車機
    box(10,3.6,6,0xf0efea,cx+3,0.15,-28.5); colliders.push([cx-2,-31.5,cx+8,-25.5]);
    const shopG=mat(0xd9e6ea,{emissive:0xfff6e0,emissiveIntensity:0}); glowMats.push([shopG,.8]);
    frontPlane(8,2.2,cx+3,1.45,-25.5,1,shopG); box(10.2,0.5,6.2,0x1f8a4c,cx+3,3.75,-28.5);
    box(4,3.2,7,0xd8dcde,cx-6,0.15,-28); colliders.push([cx-8,-31.5,cx-4,-24.5]);
    // 価格の看板（角）
    const priceT=tex(128,256,(g,w,h)=>{ g.fillStyle='#1f8a4c'; g.fillRect(0,0,w,h); g.fillStyle='#fff'; g.font='bold 22px sans-serif'; g.textAlign='center'; g.fillText('あおば石油',w/2,30);
      [['レギュラー','168'],['ハイオク','179'],['軽油','148']].forEach(([n,p],i)=>{ const y=70+i*62; g.fillStyle='#0d1b14'; g.fillRect(8,y-22,w-16,52); g.fillStyle='#fff'; g.font='bold 16px sans-serif'; g.fillText(n,w/2,y-6); g.fillStyle='#ffd25a'; g.font='bold 26px monospace'; g.fillText(p,w/2,y+22); }); });
    const pm=mat(0xffffff,{map:priceT,emissiveMap:priceT,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([pm,.9]);
    box(0.25,3.2,0.25,0x777d85,67,0.15,-11); const ps=new THREE.Mesh(new THREE.BoxGeometry(1.6,3.2,0.3),[cw,cw,cw,cw,pm,pm]); ps.position.set(67,4.9,-11); ps.rotation.y=Math.PI/4; scene.add(ps);
    colliders.push([66.7,-11.3,67.3,-10.7]);
  }

  keepSolid=false;
  // ---- ガソリンスタンドの向かい（コンビニ側）：月極駐車場 ----
  {
    const x0=43.2, x1=68.6, z0=9.2, z1=30, cx=(x0+x1)/2;
    box(x1-x0,0.06,z1-z0,mat(0x4a4c4f),cx,0.1,(z0+z1)/2);
    const n=9, sx=x0+1.3;
    for(const [a,b,ry] of [[10.8,15.8,Math.PI],[24.4,29.4,0]]){
      for(let i=0;i<=n;i++) box(0.12,0.01,b-a,0xf0f0f0,sx+i*2.6,0.17,(a+b)/2);
      for(let i=0;i<n;i++){ const x=sx+(i+0.5)*2.6; box(1.4,0.12,0.2,0xc9b07a,x,0.16,ry?b-0.5:a+0.5); if((i*7+(ry?3:1))%10<7) car(x,(a+b)/2,[0xf3f3f0,0x5d6f84,0x2e2e2e,0x9aa0a6,0xb3392f][i%5],ry); }
    }
    for(const [a,b] of [[x0,cx-3],[cx+3,x1]]) box(b-a,0.9,0.06,0x9aa0a6,(a+b)/2,0.15,9.6);   // 入口は中央
    box(0.06,0.9,z1-z0,0x9aa0a6,x1-0.1,0.15,(z0+z1)/2);
    colliders.push([x0,9.3,cx-3,9.9],[cx+3,9.3,x1,9.9],[x0,z0,x0+0.2,z1],[x1-0.2,z0,x1,z1],[x0,z1-0.2,x1,z1]);
    const mT=tex(256,192,(g,w,h)=>{ g.fillStyle='#f4c21a'; g.fillRect(0,0,w,h); g.fillStyle='#1d1d1d'; g.font='bold 110px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('P',56,80);
      g.font='bold 34px sans-serif'; g.fillText('月極',170,58); g.fillText('駐車場',170,100); g.fillRect(0,140,w,52); g.fillStyle='#f4c21a'; g.font='bold 24px sans-serif'; g.fillText('契約者募集中',w/2,167); });
    const mm=mat(0xffffff,{map:mT,emissiveMap:mT,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([mm,.8]);
    box(0.12,2.2,0.12,0x444a50,x1-2,0.15,10); const sb=new THREE.Mesh(new THREE.BoxGeometry(2,1.5,0.1),[mm,mm,mm,mm,mm,mm]); sb.position.set(x1-2,3.1,10); scene.add(sb);
  }

  // ---- ガソリンスタンドのもう一方の向かい：時計塔のある白いビル ----
  let clockTex=null;
  {
    const x0=87, x1=125, cx=(x0+x1)/2, zf=-11.5, bw=34, bd=20, FL=6, FH=3.6, H=FL*FH, cz=zf-bd/2;
    box(x1-x0,0.06,40,mat(0x707275),cx,0.1,-29.2);
    const fac=tex(512,FL*64,(g,w,h)=>{ g.fillStyle='#ece7dc'; g.fillRect(0,0,w,h);
      for(let f=0;f<FL;f++){ const y=h-(f+1)*64;
        if(f===0){ g.fillStyle='#2d3440'; for(let i=0;i<8;i++) g.fillRect(8+i*63,y+10,50,52); continue; }
        for(let i=0;i<16;i++){ const x=10+i*31.5; g.fillStyle='#d9d3c6'; g.fillRect(x-4,y,4,64);                // 付け柱
          g.fillStyle='#2d3440'; if(f===FL-1){ g.beginPath(); g.moveTo(x+2,y+50); g.lineTo(x+2,y+24); g.arc(x+11,y+24,9,Math.PI,0); g.lineTo(x+20,y+50); g.fill(); }
          else g.fillRect(x+2,y+12,18,40); }
        g.fillStyle='#d4cdbd'; g.fillRect(0,y,w,4); }
    });
    const em=tex(512,FL*64,(g,w,h)=>{ g.fillStyle='#000'; g.fillRect(0,0,w,h); let s=7;
      for(let f=1;f<FL-1;f++) for(let i=0;i<16;i++){ s=(s*31+7)%101; if(s<35){ g.fillStyle='#ffe2b0'; g.fillRect(12+i*31.5,h-(f+1)*64+12,18,40); } } });   // 1階は夜も消灯
    const fm=mat(0xffffff,{map:fac,emissiveMap:em,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([fm,.9]);
    const roofM=mat(0xd8d2c6);
    const b=new THREE.Mesh(new THREE.BoxGeometry(bw,H,bd),[fm,fm,roofM,roofM,fm,fm]); b.position.set(cx,0.15+H/2,cz); scene.add(b);
    colliders.push([cx-bw/2,zf-bd,cx+bw/2,zf]);
    box(bw+0.8,0.6,bd+0.8,0xe2dccd,cx,0.15+H,cz); box(bw+0.4,0.35,bd+0.4,0xd8d2c6,cx,0.15+FH,cz);   // 軒の飾り（コーニス）と1階上の帯
    box(bw-6,1.2,bd-6,0xe2dccd,cx,0.75+H,cz);
    // 正面中央の時計塔
    const tz=zf-3.5, tw=6;
    box(tw,6,tw,0xece7dc,cx,0.75+H,tz); box(tw+0.6,0.4,tw+0.6,0xe2dccd,cx,6.75+H,tz);
    box(tw-1.2,3.2,tw-1.2,0xe8e2d6,cx,7.15+H,tz); box(tw-0.6,0.35,tw-0.6,0xe2dccd,cx,10.35+H,tz);
    const sp=new THREE.Mesh(new THREE.ConeGeometry(0.5,2.2,8),mat(0xd8d2c6)); sp.position.set(cx,11.8+H,tz); scene.add(sp);
    box(0.06,2.5,0.06,0x777777,cx,12.6+H,tz); box(1.1,0.7,0.02,0x2b3440,cx+0.55,14.3+H,tz);           // 旗
    for(const [dx,dz,ry] of [[0,tw/2+0.03,0]]){                          // 時計は道路側の1面だけ
      const pillarM=mat(0xd9d3c6);
      const cv=document.createElement('canvas'); cv.width=cv.height=256;
      if(!clockTex){ clockTex=new THREE.CanvasTexture(cv); clockTex.cv=cv; }
      const face=new THREE.Mesh(new THREE.CircleGeometry(1.8,40),mat(0xffffff,{map:clockTex,emissiveMap:clockTex,emissive:0xffffff,emissiveIntensity:0}));
      glowMats.push([face.material,.7]);
      face.position.set(cx+dx,0.75+H+3.2,tz+dz); face.rotation.y=ry; scene.add(face);
    }
    // 1階の入口
    frontPlane(4,3,cx,1.65,zf,1,mat(0x8a959c,{emissive:0xfff4dc,emissiveIntensity:0}));
    box(5,0.3,1.2,0xd8d2c6,cx,3.3,zf+0.6);
  }
  function drawClock(){
    const g=clockTex.cv.getContext('2d'), c=128, d=new Date(), h=d.getHours()%12, m=d.getMinutes();
    g.fillStyle='#f7f4ec'; g.beginPath(); g.arc(c,c,124,0,Math.PI*2); g.fill();
    g.strokeStyle='#2b2b2b'; g.lineWidth=6; g.stroke();
    g.fillStyle='#2b2b2b'; g.font='bold 26px serif'; g.textAlign='center'; g.textBaseline='middle';
    ['XII','I','II','III','IIII','V','VI','VII','VIII','IX','X','XI'].forEach((t,i)=>{ const a=i*Math.PI/6-Math.PI/2; g.fillText(t,c+96*Math.cos(a),c+96*Math.sin(a)); });
    const hand=(a,l,w)=>{ g.lineWidth=w; g.lineCap='round'; g.beginPath(); g.moveTo(c,c); g.lineTo(c+l*Math.cos(a),c+l*Math.sin(a)); g.stroke(); };
    hand((h+m/60)*Math.PI/6-Math.PI/2,58,9); hand(m*Math.PI/30-Math.PI/2,86,6);
    clockTex.needsUpdate=true;
  }
  drawClock(); setInterval(drawClock,20000);

  // ---- ガソリンスタンドの斜め向かい：1階が駐車場、2階が店のファミレス ----
  keepSolid=true;
  {
    const x0=87, x1=125, cx=(x0+x1)/2, z0=9.2, z1=40;
    box(x1-x0,0.06,z1-z0,mat(0x4a4c4f),cx,0.1,(z0+z1)/2);
    const bw=30, bd=18, zf=14, cz=zf+bd/2, y1=3.4, y2=7.6;
    // 2階の店（柱で持ち上げる）
    box(bw,0.5,bd,0xd8d2c6,cx,y1,cz);
    box(bw,y2-y1-0.5,bd,0xf1ebdf,cx,y1+0.5,cz);
    const glass=mat(0xd9e6ea,{emissive:0xffe8c4,emissiveIntensity:0}); glowMats.push([glass,.9]);
    frontPlane(bw-2,2.4,cx,y1+1.9,zf,-1,glass);
    const side=new THREE.Mesh(new THREE.PlaneGeometry(bd-3,2.4),glass); side.position.set(cx-bw/2-0.02,y1+1.9,cz); side.rotation.y=-Math.PI/2; scene.add(side);
    box(bw+1,1.2,bd+1,0xd9622b,cx,y2-0.2,cz);                                        // 屋根の帯（オレンジ）
    const fT=tex(512,64,(g,w,h)=>{ g.fillStyle='#d9622b'; g.fillRect(0,0,w,h); g.fillStyle='#fff'; g.font='bold 36px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('ファミリーレストラン こむぎ',w/2,34); });
    const fm=mat(0xffffff,{map:fT,emissiveMap:fT,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([fm,.9]);
    frontPlane(16,1.1,cx,y2+0.4,zf-0.52,-1,fm);
    for(let i=0;i<6;i++) for(let j=0;j<4;j++){ const x=cx-bw/2+1+i*(bw-2)/5, z=zf+1+j*(bd-2)/3; box(0.5,y1,0.5,0xd8d2c6,x,0.15,z); colliders.push([x-0.3,z-0.3,x+0.3,z+0.3]); }
    // 1階の駐車場（建物の下と前）
    for(let i=0;i<11;i++){ const x=cx-bw/2+1.5+i*2.7; box(0.12,0.01,5,0xf0f0f0,x,0.17,zf+4); box(0.12,0.01,5,0xf0f0f0,x,0.17,zf+bd-4);
      if(i<10&&(i*3)%4!==0) car(x+1.35,zf+4,[0x5d6f84,0xf3f3f0,0x2e2e2e,0x8c9a7a][i%4],Math.PI); if(i<10&&i%3===1) car(x+1.35,zf+bd-4,0x9aa0a6,0); }
    // 店名のある面の中央：2階の入口（風除室）と踊り場、そこへ登る階段
    const fy=y1+0.5, stM=mat(0xc9c3b6), railM=mat(0x8e9296);
    box(3.6,y2-fy-0.2,1.2,0xf1ebdf,cx,fy,zf-0.6);                                   // 風除室
    const dg=mat(0xd9e6ea,{emissive:0xfff2d8,emissiveIntensity:0}); glowMats.push([dg,.9]);
    frontPlane(2.2,2.3,cx,fy+1.15,zf-1.2,-1,dg); box(0.06,2.3,0.04,0x6e7378,cx,fy,zf-1.23);
    box(4.4,0.15,0.8,0xd9622b,cx,fy+2.6,zf-1.6);                                    // ひさし
    box(4.4,0.25,1.4,stM,cx,fy-0.25,zf-1.9);                                        // 踊り場
    for(const x of [cx-2,cx+2]) box(0.2,fy-0.25,0.2,stM,x,0.15,zf-2.4);
    box(0.05,0.05,1.4,railM,cx+2.15,fy+0.9,zf-1.9); box(4.4,0.05,0.05,railM,cx,fy+0.9,zf-2.58);
    box(0.05,0.95,0.05,railM,cx+2.15,fy,zf-2.58);
    const N=15, run=0.42, rise=(fy-0.15)/N, xs=cx-2.2;                                // 左へ下りる直線階段
    for(let i=0;i<N;i++) box(run,0.08,1.3,stM,xs-(i+0.5)*run,fy-(i+1)*rise-0.08,zf-1.95);
    const L=Math.hypot(N*run,fy-0.15), ang=Math.atan2(fy-0.15,N*run), mx=xs-N*run/2, my=0.15+(fy-0.15)/2;
    for(const z of [zf-1.28,zf-2.62]){
      const sg=box(L,0.3,0.08,stM,mx,0,z); sg.position.y=my-0.1; sg.rotation.z=ang;    // 側桁
      const rl=box(L,0.05,0.05,railM,mx,0,z); rl.position.y=my+0.9; rl.rotation.z=ang;  // 手すり
      for(let k=0;k<=3;k++){ const t=k/3, px=xs-t*N*run, py=fy-t*(fy-0.15); box(0.05,0.95,0.05,railM,px,py,z); }
    }
    colliders.push([xs-N*run,zf-2.7,cx+2.2,zf-1.2]);
    // ポール看板
    box(0.3,8,0.3,0x777d85,x0+2,0.15,11); const ps=new THREE.Mesh(new THREE.BoxGeometry(3.4,1.6,0.35),[fm,fm,fm,fm,fm,fm]); ps.position.set(x0+2,8.9,11); ps.rotation.y=Math.PI/4; scene.add(ps);
  }

  keepSolid=false;
  // ---- 裏の路地（車1台がぎりぎり通れる幅）----
  // 公園隣の家の脇から奥へ → コンビニ裏を横切る → 工場の脇を折れ曲がって交差する道へ。途中で奥へ分岐。
  {
    const alleyM=mat(0x4a4c4f,{emissive:0x8a8f9a,emissiveIntensity:0}), _ag=glowMats.push([alleyM,0.16]), ltM=mat(0x707275);
    const strip=(x0,z0,x1,z1,m=alleyM,y=0.05)=>box(x1-x0,0.06,z1-z0,m,(x0+x1)/2,y,(z0+z1)/2);
    strip(-45.6,9.2,-42.4,48.2);                     // 入口：家の脇から奥へ
    strip(-45.6,44.6,33.2,48.2);                     // コンビニ裏を横切る道
    strip(29.6,44.6,33.2,62.4);                      // 工場の脇（1回目の曲がり）
    strip(29.6,58.8,72,62.4);                        // 工場の裏（2回目の曲がり）→ 交差する道へ
    strip(13.4,48.2,16.8,72);                        // 奥への分岐
    // 黄色の区域：コンビニ裏の空き地（アスファルト）
    strip(-15.5,24,-13,34.5,ltM,0.06); strip(-15.5,34.5,13.4,44.6,ltM,0.06);
    // アパートの駐車場と出入口（アパートの玄関側）
    strip(13.4,35,29.6,44.6,ltM,0.06);
    for(let i=0;i<=5;i++) box(0.12,0.01,5,0xf0f0f0,14.4+i*2.6,0.13,40.5);
    for(let i=0;i<5;i++){ box(1.3,0.12,0.2,0xc9b07a,15.7+i*2.6,0.12,38.4); if(i!==2&&i!==4) car(15.7+i*2.6,40.5,[0xf3f3f0,0x5d6f84,0x9aa0a6,0x2e2e2e,0x8c9a7a][i],Math.PI); }
    // コンビニとの境目の塀
    // コンビニ左横のすき間：アスファルト舗装とゴミ箱3つ
    box(3.1,0.06,10.6,mat(0x707275),-11.6,0.06,29.3);
    [[26.2,0x2f5f9e],[27.5,0x6b7076],[28.8,0x3f7a4a]].forEach(([z,c])=>{
      box(0.8,1.0,0.7,c,-10.6,0.12,z); box(0.86,0.1,0.76,0x30343a,-10.6,1.12,z);
      colliders.push([-11,z-0.35,-10.2,z+0.35]); });
    lotWall(10.2,24.15,14.1,24.15);                              // 自販機（赤・白）の背後〜隣の家の高い壁まで
    // アパート横・月極駐車場の奥・工場横のすき間：木が茂る小さな森
    box(12.9,0.06,6.3,mat(0x5f7f46),36.65,0.06,27.15);
    box(2.1,0.06,14.3,mat(0x5f7f46),32.45,0.06,37.45);
    { let k=3; const r=()=>{ k=(k*9301+49297)%233280; return k/233280; };
      for(let x=31.4;x<=42.2;x+=2.1) for(let z=25;z<=29.6;z+=2.2){ const tx=x+(r()-0.5)*0.8, tz=z+(r()-0.5)*0.8; tree(tx,tz,0.8+r()*0.6); colliders.push([tx-0.3,tz-0.3,tx+0.3,tz+0.3]); }
      for(let z=31.5;z<=43.5;z+=2.3){ const tz=z+(r()-0.5)*0.6; tree(32.45,tz,0.6+r()*0.4); colliders.push([32.15,tz-0.3,32.75,tz+0.3]); } }
    box(3.9,0.06,10.8,mat(0x707275),12.05,0.06,29.7);               // アパート入口前（店の横〜アパート）をアスファルト舗装
    // アパート側面（コンビニ側）の中央に入口と屋根
    { const dm=mat(0x3a4148,{emissive:0xfff2d8,emissiveIntensity:0}); glowMats.push([dm,.8]);
      const d=new THREE.Mesh(new THREE.PlaneGeometry(1.4,2.2),dm); d.position.set(13.97,0.15+1.1,29.5); d.rotation.y=-Math.PI/2; scene.add(d);
      box(0.06,2.3,1.6,0x8e9296,13.99,0.15,29.5);
      box(0.85,0.12,2.6,0x8e9296,13.6,2.55,29.5); box(1.2,0.12,2.2,0xbdbab3,13.55,0.12,29.5); }
    // 駐車場に面した駐輪場（屋根付き、アパートの廊下側）
    { const x0=15.2, x1=25.2, z=36.2;
      const rf=box(x1-x0,0.08,1.9,0x8e9296,(x0+x1)/2,0,z); rf.position.y=2.25; rf.rotation.x=-0.08;
      for(let x=x0+0.2;x<=x1;x+=3.3) box(0.08,2.25,0.08,0x6e7378,x,0.12,z+0.85);
      const tire=new THREE.TorusGeometry(0.3,0.035,6,14), bm=mat(0x2b2b2b);
      for(let i=0;i<10;i++){ const g=new THREE.Group(), bx=x0+0.6+i*0.95;
        for(const dz of [-0.48,0.48]){ const w=new THREE.Mesh(tire,bm); w.rotation.y=Math.PI/2; w.position.set(0,0.32,dz); g.add(w); }
        box(0.05,0.05,0.95,[0xc23b2e,0xd8d8d8,0x2f5f9e,0x3a3a3a][i%4],0,0.62,0,g); box(0.25,0.05,0.18,0x222222,0,0.88,-0.2,g); box(0.4,0.04,0.04,0x9aa0a6,0,0.95,0.42,g);
        g.position.set(bx,0.12,z); scene.add(g); }
      colliders.push([x0,z-0.8,x1,z+0.9]); }
    // 路地の奥の住宅（水色の位置）：正面は路地側
    const pal=[0xe2dccd,0xd6cfbe,0xcfc6b2,0xd9d3c4];
    // 敷地はすき間なく隣り合わせ（境の塀は1枚を共有）
    const lots=[[-42.4,-23.8],[-23.8,-5.2],[-5.2,13.4],[16.8,29.6]], z0=48.2, z1=62;
    lots.forEach(([a,b],i)=>{
      const cx=(a+b)/2, w=b-a, hw=Math.min(w-5,10), side=i%2?-1:1;
      box(w,0.04,z1-z0,0x8e9a6e,cx,0.08,(z0+z1)/2);                                      // 庭
      const hx=cx-side*1.8;                                             // 駐車スペースの分だけ家を横にずらす
      house(hx,51.8,-1,hw,pal[i],false);
      colliders.push([hx-hw/2,51.8,hx+hw/2,57.8]);
      const px=side>0?b-1.75:a+1.75;                                   // 縦向き（道路に直角）の駐車スペース
      box(3.1,0.04,5.6,0xbdbab3,px,0.12,51.2);
      if(i!==1) car(px,51.4,[0xf3f3f0,0,0xb3392f,0x3d4a63][i],0);
      // 道路ぎわの塀（車の出入口と門だけ空ける）
      const cuts=[[px-1.55,px+1.55],[hx-0.6,hx+0.6]].sort((p,q)=>p[0]-q[0]); let st=a;
      cuts.forEach(([c0,c1])=>{ if(c0>st) box(c0-st,1.2,0.15,0xbab4a8,(st+c0)/2,0.12,48.3); st=Math.max(st,c1); });
      if(b>st) box(b-st,1.2,0.15,0xbab4a8,(st+b)/2,0.12,48.3);
      box(0.25,1.4,0.25,0x8f8a80,hx-0.7,0.12,48.3); box(0.25,1.4,0.25,0x8f8a80,hx+0.7,0.12,48.3);
    });
    for(const x of [-42.4,-23.8,-5.2,13.4,16.8,29.6]) box(0.15,1.2,z1-z0,0xbab4a8,x,0.12,(z0+z1)/2);   // 境の塀
    box(55.8,1.2,0.15,0xbab4a8,-14.5,0.12,z1); box(12.8,1.2,0.15,0xbab4a8,23.2,0.12,z1);
  }

  // ---- コンビニの裏：塀で囲った敷地の奥に白いレトロなビル（3階建て、屋上に謎の電波塔）＋横は駐車場 ----
  {
    // 敷地（塀で囲む。入口は路地側）
    const lx0=-13.2, lx1=-3.0, lz0=34.6, lz1=44.5, bm=0xbab4a8;
    box(0.15,1.2,lz1-lz0,bm,lx1,0.12,(lz0+lz1)/2);   // 西側は隣の家の高い塀
    box((lx1-lx0-3)/2,1.2,0.15,bm,lx0+(lx1-lx0-3)/4,0.12,lz1); box((lx1-lx0-3)/2,1.2,0.15,bm,lx1-(lx1-lx0-3)/4,0.12,lz1);
    const gc=(lx0+lx1)/2;
    for(const x of [gc-1.5,gc+1.5]) box(0.3,1.4,0.3,0x8f8a80,x,0.12,lz1);
    colliders.push([lx1-0.1,lz0,lx1+0.1,lz1],[lx0,lz1-0.1,gc-1.5,lz1+0.1],[gc+1.5,lz1-0.1,lx1,lz1+0.1]);
    box(2.2,0.03,3.8,0xbdbab3,-8.5,0.12,42.6);                                      // 門から入口へのアプローチ

    // 建物は元の寸法で作り、グループごと 2/3 に縮小して敷地の奥に置く
    const g=new THREE.Group(), S=2/3; scene.add(g);
    const B=(w,h,d,m,x,y,z)=>box(w,h,d,m,x,y,z,g);
    const FP=(w,h,x,y,z,ry,m)=>{ const p=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m); p.position.set(x,y,z); p.rotation.y=ry; g.add(p); return p; };
    const bw=11, bd=8.6, H=10, FH=H/3, zf=0, cz=-bd/2;                               // 正面中央が原点
    const wT=tex(128,128,(c,w,h)=>{ c.fillStyle='#f1efe9'; c.fillRect(0,0,w,h); c.fillStyle='rgba(120,115,100,.10)'; for(let x=0;x<w;x+=8) c.fillRect(x,0,2,h); });
    wT.wrapS=wT.wrapT=THREE.RepeatWrapping; wT.repeat.set(4,3);
    const wm=mat(0xffffff,{map:wT}), frame=mat(0x6b6f74);
    B(bw,H,bd,wm,0,0,cz); B(bw+0.2,0.3,bd+0.2,0xe2ded4,0,FH,cz);
    const win=(x,y,lit)=>{ B(2.3,1.7,0.08,frame,x,y-0.85,0.04); FP(2.0,1.4,x,y,0.09,0,lit?winM:darkWinM); B(0.06,1.4,0.06,frame,x,y-0.7,0.12); };
    win(-2.4,FH+1.7,true); win(2.2,FH+1.7,false); win(-2.4,FH*2+1.7,false); win(2.2,FH*2+1.7,true); win(-2.4,1.7,false);
    const dm=mat(0x3a4148,{emissive:0xfff2d8,emissiveIntensity:0}); glowMats.push([dm,.8]);
    FP(1.9,2.3,2.2,1.15,0.03,0,dm); B(0.06,2.3,0.06,frame,2.2,0,0.06);
    B(2.8,0.18,1.2,0xe2ded4,2.2,2.6,0.6); B(2.4,0.15,0.8,0xbdbab3,2.2,0,0.4);
    for(let f=1;f<3;f++) FP(1.6,1.4,bw/2+0.02,f*FH+1.7,cz,Math.PI/2,f===1?winM:darkWinM);
    const rm=mat(0xe2ded4);
    for(const [len,x,z,ax] of [[bw,0,-0.08,'x'],[bw,0,-bd+0.08,'x'],[bd,-bw/2+0.08,cz,'z'],[bd,bw/2-0.08,cz,'z']]){
      ax==='x'?B(len,0.35,0.15,rm,x,H,z):B(0.15,0.35,len,rm,x,H,z);
      ax==='x'?B(len,0.08,0.1,rm,x,H+1.0,z):B(0.1,0.08,len,rm,x,H+1.0,z);
      for(let t=-len/2+0.3;t<len/2;t+=0.6) ax==='x'?B(0.06,0.7,0.06,rm,x+t,H+0.3,z):B(0.06,0.7,0.06,rm,x,H+0.3,z+t);
    }
    const px=-0.6, pz=cz-0.6, ps=4.4, ph=3;
    B(ps,ph,ps,wm,px,H,pz); B(ps+0.2,0.2,ps+0.2,0xe2ded4,px,H+ph,pz);
    FP(0.9,2,px+0.8,H+1,pz+ps/2+0.02,0,mat(0x8a8f96));
    for(const dz of [-0.25,0.25]) B(0.05,ph,0.05,frame,px-ps/2-0.06,H,pz+1+dz);
    for(let y=0.3;y<ph;y+=0.35) B(0.05,0.04,0.5,frame,px-ps/2-0.06,H+y,pz+1);
    // 電波塔：さらに半分に縮小（塔屋の上が原点）
    const t=new THREE.Group(); t.position.set(px,H+ph+0.2,pz); t.scale.setScalar(0.5); g.add(t);
    const T=(w,h,d,m,x,y,z)=>box(w,h,d,m,x,y,z,t);
    const steel=mat(0x8a8f96), legH=5.6, hw=1.3;
    for(const sx of [-1,1]) for(const sz of [-1,1]) T(0.14,legH,0.14,steel,sx*hw,0,sz*hw);
    const diag=Math.hypot(hw*2,legH/2), ang=Math.atan2(legH/2,hw*2);
    for(let k=0;k<2;k++){ const yc=legH/4+k*legH/2;
      for(const sz of [-1,1]) for(const sg of [-1,1]){ const d=T(diag,0.08,0.08,steel,0,0,sz*hw); d.position.y=yc; d.rotation.z=sg*ang; }
      for(const sx of [-1,1]) for(const sg of [-1,1]){ const d=T(0.08,0.08,diag,steel,sx*hw,0,0); d.position.y=yc; d.rotation.x=sg*ang; }
      T(hw*2,0.08,0.08,steel,0,(k+1)*legH/2,-hw); T(hw*2,0.08,0.08,steel,0,(k+1)*legH/2,hw);
    }
    const pf=legH;
    T(3.8,0.35,3.8,0xe8e6e0,0,pf,0); T(3.9,0.06,3.9,steel,0,pf+0.9,0);
    const cyl=new THREE.Mesh(new THREE.CylinderGeometry(1.05,1.05,4.6,20),mat(0xf0eee8)); cyl.position.set(0,pf+0.35+2.3,0); t.add(cyl);
    for(let y=0.8;y<4.6;y+=0.75){ const r=new THREE.Mesh(new THREE.TorusGeometry(1.07,0.04,6,24),steel); r.rotation.x=Math.PI/2; r.position.set(0,pf+0.35+y,0); t.add(r); }
    T(0.04,4.6,0.04,steel,-0.18,pf+0.35,1.12); T(0.04,4.6,0.04,steel,0.18,pf+0.35,1.12);
    for(let y=0.3;y<4.6;y+=0.35) T(0.4,0.04,0.04,steel,0,pf+0.35+y,1.12);
    const dome=new THREE.Mesh(new THREE.SphereGeometry(1.3,20,14),mat(0xf6f5f1)); dome.position.set(0,pf+0.35+4.6+1.0,0); t.add(dome);
    T(0.08,2.4,0.08,steel,0,pf+0.35+4.6+2.2,0);
    const red=new THREE.Mesh(new THREE.SphereGeometry(0.15,8,6),mat(0xff3a2a,{emissive:0xff2a1a,emissiveIntensity:1})); red.position.set(0,pf+0.35+4.6+4.7,0); t.add(red);
    // 建物の正面中央を (-9.2, 40.6) に置く（門から少し歩いた奥）
    g.scale.setScalar(S); g.position.set(-9.2-2.2*S+2.2*S,0.12,40.6);
    colliders.push([-9.2-bw*S/2,40.6-bd*S,-9.2+bw*S/2,40.6]);

    // 横の空きスペースは駐車場（路地から入る）
    for(let i=0;i<=5;i++) box(0.12,0.01,5,0xf0f0f0,-1.6+i*2.6,0.13,40.6);
    for(let i=0;i<5;i++){ box(1.3,0.12,0.2,0xc9b07a,-0.3+i*2.6,0.12,38.4); if(i===1||i===2||i===4) car(-0.3+i*2.6,40.6,[0,0xf3f3f0,0x5d6f84,0,0x9aa0a6][i],Math.PI); }
  }

  // ---- 時計塔ビル：敷地を塀で囲み、ビル裏の空き地は駐車場 ----
  lotWall(124.9,-9.4,124.9,-49.2); lotWall(87,-49.1,125,-49.1);
  for(let i=0;i<14;i++){ const x=89+i*2.6; box(0.12,0.01,5,0xf0f0f0,x,0.17,-38); box(0.12,0.01,5,0xf0f0f0,x,0.17,-45.5);
    if(i<13){ box(1.4,0.12,0.2,0xc9b07a,x+1.3,0.16,-40.2); box(1.4,0.12,0.2,0xc9b07a,x+1.3,0.16,-47.7);
      if((i*5)%7<4) car(x+1.3,-38,[0xf3f3f0,0x2e2e2e,0x5d6f84,0x9aa0a6][i%4],0); if((i*3)%5<2) car(x+1.3,-45.5,[0xb3392f,0xe8e4da,0x3d4a63][i%3],Math.PI); } }

  // ---- 時計塔ビルの隣：白いタイル張りの細長いビル（茶色い太枠の窓）----
  {
    const x0=125.6, x1=140, cx=(x0+x1)/2, zf=-10.6, bw=11, bd=13, FL=4, FH=3.3, H=FL*FH, cz=zf-bd/2;
    box(x1-x0,0.06,22,mat(0x707275),cx,0.1,-20.2);
    const tileT=tex(128,128,(g,w,h)=>{ g.fillStyle='#c9ccce'; g.fillRect(0,0,w,h);
      for(let y=0;y<h;y+=8) for(let x=0;x<w;x+=8){ const v=226+((x*13+y*7)%22); g.fillStyle=`rgb(${v},${v+2},${v+4})`; g.fillRect(x+1,y+1,6,6); } });
    tileT.wrapS=tileT.wrapT=THREE.RepeatWrapping; tileT.repeat.set(6,7);
    const tileM=mat(0xffffff,{map:tileT}), sideM=mat(0xeceae4), roofM=mat(0xbdb8ae);
    const b=new THREE.Mesh(new THREE.BoxGeometry(bw,H,bd),[sideM,tileM,roofM,roofM,tileM,sideM]); b.position.set(cx,0.15+H/2,cz); scene.add(b);
    colliders.push([cx-bw/2,zf-bd,cx+bw/2,zf]);
    box(bw+0.15,0.35,bd+0.15,0xbdb8ae,cx,0.15+H,cz);
    // 屋上の名前の塔
    box(2.4,2.6,2.4,tileM,cx-bw/2+1.2,0.15+H,zf-1.2);
    const nt=tex(64,192,(g,w,h)=>{ g.fillStyle='#eef0f1'; g.fillRect(0,0,w,h); g.fillStyle='#2b3440'; g.beginPath(); g.arc(32,30,16,0,Math.PI*2); g.fill();
      g.fillStyle='#eef0f1'; g.beginPath(); g.arc(32,30,8,0,Math.PI*2); g.fill(); g.fillStyle='#2b3440'; g.font='bold 30px sans-serif'; g.textAlign='center'; ['渡','辺','ビ','ル'].forEach((c,i)=>g.fillText(c,32,78+i*30)); });
    frontPlane(1.1,2.4,cx-bw/2+1.2,0.15+H+1.3,zf,1,mat(0xffffff,{map:nt}));
    // 正面：左の列は茶色の太枠の窓、右は黒枠の横長窓
    const brownM=mat(0x5a3326), frameM=mat(0x2b2f35);
    for(let f=1;f<FL;f++){
      const y=0.15+f*FH+1.6;
      box(2.2,1.9,0.2,brownM,cx-bw/2+2.2,y-0.95,zf+0.1); frontPlane(1.5,1.3,cx-bw/2+2.2,y,zf+0.2,1,f===2?winM:darkWinM);
      box(3.6,1.6,0.08,frameM,cx+1.8,y-0.8,zf+0.04); frontPlane(3.3,1.3,cx+1.8,y,zf+0.08,1,f===1?winM:darkWinM);
    }
    // 1階：シャッター、ガラスの入口、小窓
    const shT=tex(128,128,(g,w,h)=>{ g.fillStyle='#b8bbbe'; g.fillRect(0,0,w,h); g.fillStyle='#909396'; for(let y=0;y<h;y+=6) g.fillRect(0,y,w,2); });
    frontPlane(3,2.7,cx-bw/2+2,1.5,zf,1,mat(0xffffff,{map:shT}));
    frontPlane(1.8,2.4,cx+0.8,1.35,zf,1,mat(0x3a4148,{emissive:0xfff2d8,emissiveIntensity:0}));
    frontPlane(1,1.2,cx+3.6,1.6,zf,1,darkWinM);
    box(2.4,0.12,0.9,0x8e9296,cx+0.8,2.75,zf+0.45);
    // 横の面（時計塔ビル側の反対）：小さな窓と排水管
    for(let f=0;f<FL;f++) for(let k=0;k<3;k++){ const z=zf-2.5-k*4, y=0.15+f*FH+1.7;
      const p=new THREE.Mesh(new THREE.PlaneGeometry(1.1,1),(f+k)%3===0?winM:darkWinM); p.position.set(cx+bw/2+0.02,y,z); p.rotation.y=Math.PI/2; scene.add(p); }
    box(0.12,H,0.12,0xd8d8d4,cx+bw/2+0.08,0.15,zf-0.6);
    tree(cx-bw/2-0.1,zf+1.6,0.9);
  }

  // ---- 月極駐車場の奥：トタン屋根の町工場（敷地はブロック塀、軽トラが停まっている）----
  {
    const x0=33.5, x1=68.6, z0=30.3, z1=58, cx=(x0+x1)/2;
    box(x1-x0,0.06,z1-z0,mat(0x707275),cx,0.1,(z0+z1)/2);                     // 薄いアスファルト
    // ブロック塀（入口は交差する道の側）
    lotWall(x0,z0,x0,z1); lotWall(x0,z1,x1,z1); lotWall(x0,z0,43.1,z0);
    lotWall(x1,z0,x1,32); lotWall(x1,39,x1,z1);
    // トタンの外壁（明るいグレー）と屋根（濃いグレー）
    const tin=(base,dark)=>{ const t=tex(128,128,(g,w,h)=>{ for(let x=0;x<w;x+=8){ g.fillStyle=base; g.fillRect(x,0,5,h); g.fillStyle=dark; g.fillRect(x+5,0,3,h); } }); t.wrapS=t.wrapT=THREE.RepeatWrapping; return t; };
    const wT=tin('#a9adb1','#8f9398'); wT.repeat.set(8,1);
    const rT=tin('#6c7177','#585c61'); rT.repeat.set(1,10);
    const wallG=mat(0xffffff,{map:wT}), roofG=mat(0xffffff,{map:rT});
    const bx=51, bw=28, bd=16, zf=40, H=6, cz=zf+bd/2;
    box(bw,H,bd,wallG,bx,0.15,cz); colliders.push([bx-bw/2,zf,bx+bw/2,zf+bd]);
    box(bw+0.1,0.5,bd+0.1,0x7d8287,bx,0.15,cz);                                      // 足元の腰（濃いグレー）
    const sh=new THREE.Shape([new THREE.Vector2(-bd/2-0.6,0),new THREE.Vector2(bd/2+0.6,0),new THREE.Vector2(0,2.6)]);
    const rg=new THREE.ExtrudeGeometry(sh,{depth:bw+0.6,bevelEnabled:false}); rg.translate(0,0,-(bw+0.6)/2);
    const roof=new THREE.Mesh(rg,[wallG,roofG]); roof.rotation.y=Math.PI/2; roof.position.set(bx,0.15+H,cz); scene.add(roof);
    // 正面中央のシャッターと、小さな事務所の扉・窓
    const shT=tex(128,128,(g,w,h)=>{ g.fillStyle='#b5b8bb'; g.fillRect(0,0,w,h); g.fillStyle='#8d9094'; for(let y=0;y<h;y+=6) g.fillRect(0,y,w,2); });
    frontPlane(5,4.4,bx,0.15+2.2,zf,-1,mat(0xffffff,{map:shT})); box(5.4,0.4,0.3,0x5f646a,bx,4.55,zf-0.15);
    frontPlane(0.9,2,bx-9,1.15,zf,-1,mat(0x5a5f66)); frontPlane(1.8,1,bx-6.5,1.9,zf,-1,winM); frontPlane(1.8,1,bx+8,1.9,zf,-1,darkWinM);
    const nt=tex(256,48,(g,w,h)=>{ g.fillStyle='#f2f0ea'; g.fillRect(0,0,w,h); g.fillStyle='#1d2a4a'; g.font='bold 28px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('有限会社 青葉製作所',w/2,h/2+2); });
    frontPlane(5,0.9,bx,5.2,zf,-1,mat(0xffffff,{map:nt}));
    // 軽トラ（シャッター前の左右に2台ずつ）
    function keiTruck(x,z,ry){
      const g=new THREE.Group(), wM=mat(0xf2f2f0);
      box(1.45,1.25,1.25,wM,0,0.35,1.05,g); box(1.38,0.5,0.04,0x2b3440,0,1.0,1.69,g);       // 運転席と窓
      box(1.45,0.12,2.0,0x9aa0a6,0,0.55,-0.6,g);                                           // 荷台
      for(const s of [-1,1]) box(0.05,0.35,2.0,wM,s*0.7,0.67,-0.6,g); box(1.45,0.35,0.05,wM,0,0.67,-1.58,g); box(1.45,0.5,0.05,0x777d85,0,0.67,0.4,g);
      for(const a of [-0.65,0.65]) for(const b of [-1.1,1.1]){ const w=new THREE.Mesh(new THREE.CylinderGeometry(.28,.28,.2,12),mat(0x1d1d1d)); w.rotation.z=Math.PI/2; w.position.set(a,.28,b); g.add(w); }
      g.position.set(x,0.13,z); g.rotation.y=ry; scene.add(g); colliders.push([x-1,z-1.8,x+1,z+1.8]);
    }
    keiTruck(bx-11,zf-3,Math.PI); keiTruck(bx-8,zf-3.2,Math.PI); keiTruck(bx+8,zf-3,Math.PI); keiTruck(bx+11,zf-3.3,Math.PI);
  }

  const lampPools=[];
  // ---- 2車線道路の両脇に街灯 ----
  {
    const poleM=mat(0x9aa0a6), headM=mat(0xf5f0e0,{emissive:0xfff0c8,emissiveIntensity:0}); glowMats.push([headM,2]);
    const pg=new THREE.CylinderGeometry(0.08,0.11,7,8);
    // 夜に路面を照らす光だまり（加算合成の円）
    const poolT=tex(128,128,(g,w,h)=>{ const gr=g.createRadialGradient(64,64,0,64,64,64); gr.addColorStop(0,'rgba(255,236,200,1)'); gr.addColorStop(0.45,'rgba(255,226,180,.55)'); gr.addColorStop(1,'rgba(255,220,170,0)'); g.fillStyle=gr; g.fillRect(0,0,w,h); });
    const poolM=new THREE.MeshBasicMaterial({map:poolT,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:0});
    lampPools.push(poolM);
    const poolG=new THREE.PlaneGeometry(16,16);
    function streetLamp(x,z,dx,dz){                    // (dx,dz) は車道側の向き
      const p=new THREE.Mesh(pg,poleM); p.position.set(x,0.15+3.5,z); scene.add(p);
      const ax=x+dx*0.8, az=z+dz*0.8;
      box(Math.abs(dx)*1.6+0.08,0.08,Math.abs(dz)*1.6+0.08,poleM,ax,7.05,az);
      box(Math.abs(dx)*0.5+0.3,0.15,Math.abs(dz)*0.5+0.3,headM,x+dx*1.55,6.95,z+dz*1.55);
      colliders.push([x-0.15,z-0.15,x+0.15,z+0.15]);
      const pl=new THREE.Mesh(poolG,poolM); pl.rotation.x=-Math.PI/2; pl.position.set(x+dx*4.5,0.2,z+dz*4.5);   // 灯具の斜め前（車道側）を中心に照らす scene.add(pl);
    }
    const inX=x=>x>66&&x<90;
    // 幹線道路（両側、互い違い）。片側50mおき(元の25mおきの倍)。
    for(let x=-60;x<=135;x+=50){ if(!inX(x)) streetLamp(x,-6.6,0,1); const x2=x+25; if(x2<138&&!inX(x2)) streetLamp(x2,6.6,0,-1); }
    for(const z of [15,40,65,-15,-40,-65]){ streetLamp(X0-6.6,z,1,0); const z2=z+(z>0?12.5:-12.5); streetLamp(X0+6.6,z2,-1,0); }      // 交差する道（両側、互い違い）
  }

  // =====================================================================
  // ---- ここから先：幹線道路を一直線にどこまでも延ばす（区画を自動で組み立てる）----
  // 1区画 = 240m（60m × 4）。区画の種類は5つ。順番を入れ替え、左右も入れ替えながらループする。
  // =====================================================================
  const RX0=NIHON_INTRO_END, CL=NIHON_CHUNK_LENGTH, SEC=4, IA=NIHON_INTRO_START, LAP=NIHON_LAP_LENGTH, NCH=NIHON_CHUNKS_PER_LAP;                          // 延長の始まり、1チャンクの長さ、1区画のチャンク数
  const ZONES=['mixed','houses','buildings','roadside','trees'];
  const chunkMap=new Map();
  const CGC={}, CMC={};
  const cgeo=(w,h,d)=>{ const k=w.toFixed(2)+'_'+h.toFixed(2)+'_'+d.toFixed(2); return CGC[k]||(CGC[k]=new THREE.BoxGeometry(w,h,d)); };
  const cmat=c=>CMC[c]||(CMC[c]=LAM({color:c}));
  let croot=null, cchunk=null;
  function cb(w,h,d,m,x,y,z){ const o=new THREE.Mesh(cgeo(w,h,d),typeof m==='number'?cmat(m):m); o.position.set(x,y+h/2,z); if(keepSolid) o.userData.keepSolid=true; croot.add(o); return o; }
  function cplane(w,h,x,y,z,ry,m){ const o=new THREE.Mesh(new THREE.PlaneGeometry(w,h),m); o.position.set(x,y,z); o.rotation.y=ry; croot.add(o); return o; }
  // ハリボテ(区画の座標): 正面(道路側 -z)と左右の面だけ。裏・天井・床は作らない。
  // 当たり判定は呼ぶ側で ccol する。
  function chollow(w,h,d,m,x,y,cz,fm=m,sm=m){
    const F=typeof fm==='number'?cmat(fm):fm, S2=typeof sm==='number'?cmat(sm):sm;
    cplane(w,h,x,y+h/2,cz-d/2,Math.PI,F);
    cplane(d,h,x-w/2,y+h/2,cz,-Math.PI/2,S2); cplane(d,h,x+w/2,y+h/2,cz,Math.PI/2,S2);
  }
  function cfront(w,h,x,y,zf,m){ return cplane(w,h,x,y,zf-0.02,Math.PI,m); }   // 区画の座標で道路側（-z）を向く面
  function cglow(map,v=.9,extra={}){ const m=LAM({color:0xffffff,map,emissiveMap:map,emissive:0xffffff,emissiveIntensity:night?v:0,roughness:.6,...extra}); cchunk.glows.push([m,v]); return m; }
  function ctex(w,h,draw){ const t=tex(w,h,draw); cchunk.texs.push(t); return t; }
  const _cv=new THREE.Vector3();
  function ccol(x0,z0,x1,z1){ croot.updateMatrixWorld(true); _cv.set(x0,0,z0).applyMatrix4(croot.matrixWorld); const ax=_cv.x, az=_cv.z;
    _cv.set(x1,0,z1).applyMatrix4(croot.matrixWorld); cchunk.cols.push([Math.min(ax,_cv.x),Math.min(az,_cv.z),Math.max(ax,_cv.x),Math.max(az,_cv.z)]); }
  function csub(x,z,ry,fn){ const g=new THREE.Group(); g.position.set(x,0,z); g.rotation.y=ry; croot.add(g); g.updateMatrixWorld(true); const p=croot; croot=g; fn(); croot=p; }
  function seeded(n){ let s=(n*9301+49297)%233280||7; return ()=>{ s=(s*9301+49297)%233280; return s/233280; }; }
  let RN=Math.random; const pk=a=>a[Math.floor(RN()*a.length)];
  const roadPoolM=new THREE.MeshBasicMaterial({map:tex(128,128,(g,w,h)=>{ const gr=g.createRadialGradient(64,64,0,64,64,64); gr.addColorStop(0,'rgba(255,236,200,1)'); gr.addColorStop(0.45,'rgba(255,226,180,.55)'); gr.addColorStop(1,'rgba(255,220,170,0)'); g.fillStyle=gr; g.fillRect(0,0,w,h); }),transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,opacity:0});
  lampPools.push(roadPoolM);
  const cLampHead=mat(0xf5f0e0,{emissive:0xfff0c8,emissiveIntensity:0}); glowMats.push([cLampHead,2]);
  const cWin=mat(0x2d3440,{emissive:0xffdca0,emissiveIntensity:0}); glowMats.push([cWin,.85]);
  const cDark=mat(0x2d3440);
  const cRoad=roadGlowM, cWalk=walk;
  const carColors=[0xf3f3f0,0x5d6f84,0xb3392f,0x2e2e2e,0x8c9a7a,0xe8e4da,0x3d4a63,0x9aa0a6];
  function ccar(x,z,ry){ const g=new THREE.Group(), c=pk(carColors);
    const add=(w,h,d,m,x1,y,z1)=>{ const o=new THREE.Mesh(cgeo(w,h,d),cmat(m)); o.position.set(x1,y+h/2,z1); g.add(o); };
    add(1.8,0.7,4.2,c,0,0.35,0); add(1.6,0.6,2.2,c,0,1.05,-0.2); add(1.62,0.45,2.0,0x2b3440,0,1.1,-0.2);
    for(const a of [-0.9,0.9]) for(const b of [-1.3,1.3]) add(0.25,0.7,0.7,0x1d1d1d,a,0,b);
    g.position.set(x,0.13,z); g.rotation.y=ry; croot.add(g); ccol(x-0.9,z-2.1,x+0.9,z+2.1); }

  // ---- 看板のブランド（色と名前を変える）----
  const CVS=[{n:'あおばマート',a:'#e07a2e',b:'#6b4a32'},{n:'ヨツバ24',a:'#1f9a8a',b:'#145a6e'},{n:'マルミ',a:'#d23a3a',b:'#8a1f1f'},
             {n:'すずらんマート',a:'#7a4fb0',b:'#9bc23a'},{n:'デイリーかもめ',a:'#2f6fc0',b:'#e8b21f'},{n:'ハッピーストア',a:'#e85a8a',b:'#3a3a3a'}];
  const FAMI=[{n:'ダイニング さくら',c:'#8a3b2e'},{n:'グリル ひまわり',c:'#d9a21f'},{n:'カフェレスト もみじ',c:'#3f7a4a'},
              {n:'ファミリーレストラン こむぎ',c:'#d9622b'},{n:'洋食 あおぞら',c:'#2f5f9e'},{n:'和食 ささの',c:'#3a3f46'}];
  const OIL=[{n:'あおば石油',c:'#1f8a4c'},{n:'ひかり石油',c:'#e05a1a'},{n:'みなと石油',c:'#2a5fae'},{n:'EKO OIL',c:'#c2262e'}];
  const PARK=[{n:'コインパーク',bg:'#f4c21a',fg:'#1d1d1d'},{n:'パーク24',bg:'#2a6fc0',fg:'#ffffff'},{n:'みどりパーキング',bg:'#2f8a4a',fg:'#ffffff'}];

  // ---- 区画の中身（区画の座標：道路側が z=0、奥が +z、幅は x）----
  const HWALL=[0xe2dccd,0xd6cfbe,0xd9d3c4,0xcfc6b2,0xcac2ad,0xeae6de,0xbfb7a8];
  const HROOF=[0x4b5057,0x3d4652,0x5a4a3e,0x2f3237,0x6b6f73];
  function cHouse(W,D,o={}){
    cb(W,0.05,D,0x8e9a6e,0,0.08,D/2);
    const side=RN()<0.5?-1:1, hw=Math.min(W-4.5,9.5), hd=Math.min(D-10,8.5), hx=-side*1.6, zf=6.5;
    const wm=cmat(pk(HWALL)), pat=Math.floor(RN()*4), lit=f=>(pat===2||(pat===0&&f===0)||(pat===1&&f===1))?cWin:cDark;
    chollow(hw,5.4,hd,wm,hx,0.1,zf+hd/2); ccol(hx-hw/2,zf,hx+hw/2,zf+hd);
    const sh=new THREE.Shape([new THREE.Vector2(-hd/2-0.5,0),new THREE.Vector2(hd/2+0.5,0),new THREE.Vector2(0,2.1)]);
    const rg=new THREE.ExtrudeGeometry(sh,{depth:hw+0.4,bevelEnabled:false}); rg.translate(0,0,-(hw+0.4)/2);
    const r=new THREE.Mesh(rg,[wm,cmat(pk(HROOF))]); r.rotation.y=Math.PI/2; r.position.set(hx,5.5,zf+hd/2); croot.add(r);
    for(const f of [0,1]) for(const dx of [-hw/4,hw/4]) cfront(1.5,1.15,hx+dx,1.6+f*2.7,zf,lit(f));
    cfront(0.95,2.05,hx,1.12,zf,cmat(0x6b5440)); cb(Math.min(hw,4)+0.4,0.12,0.7,0x5a5f66,hx,2.9,zf-0.35);
    // 塀は道路ぎわ・隣とすき間なく（左側と奥と正面。右側は隣の敷地の左塀を共有）
    const bm=0xbab4a8, px=side*(W/2-1.75);
    cb(0.15,1.2,D,bm,-W/2,0.1,D/2); cb(W,1.2,0.15,bm,0,0.1,D); ccol(-W/2-0.1,0,-W/2+0.1,D); ccol(-W/2,D-0.1,W/2,D+0.1);
    if(o.lastRight) cb(0.15,1.2,D,bm,W/2,0.1,D/2);
    const cuts=[[px-1.55,px+1.55],[hx-0.6,hx+0.6]].sort((a,b)=>a[0]-b[0]); let st=-W/2;
    cuts.forEach(([a,b])=>{ if(a>st){ cb(a-st,1.2,0.15,bm,(st+a)/2,0.1,0.1); ccol(st,0,a,0.2); } st=Math.max(st,b); });
    if(W/2>st){ cb(W/2-st,1.2,0.15,bm,(st+W/2)/2,0.1,0.1); ccol(st,0,W/2,0.2); }
    cb(3.1,0.04,5.6,0xbdbab3,px,0.1,3); if(RN()<0.7) ccar(px,3.1,0);
  }
  const tGeo=new THREE.CylinderGeometry(.15,.22,2,6), lGeo=new THREE.IcosahedronGeometry(1.5,1), trM=cmat(0x6b4f36), lfM=leafM;
  function ctree(x,z,s=1){ const t=new THREE.Mesh(tGeo,trM); t.scale.setScalar(s); t.position.set(x,0.1+s,z); croot.add(t);
    const l=new THREE.Mesh(lGeo,lfM); l.scale.setScalar(s); l.position.set(x,0.1+2.6*s,z); croot.add(l); }
  // ビルの壁の絵は1枚の大きな画像(4×4枚の絵)にまとめ、全部のビルで同じ材質を使う。
  // 1枚の絵は幅256px(12m分)・高さ5階分(1階64px)。低いビルは絵の下の方だけ使う。
  // 壁は12mごとに板を分けて絵を並べる(元は絵の繰り返しで並べていた)。
  const FA_COLS=4, FA_ROWS=4, FA_W=256, FA_FH=64, FA_FL=5, FA_TH=FA_FH*FA_FL;
  const FA_STYLES=['office','tenant','tenant','old'];
  const faTiles=[];                                     // [{style}] 絵の番号 = 配列の番号
  const faColor=document.createElement('canvas'), faGlow=document.createElement('canvas');
  faColor.width=faGlow.width=FA_W*FA_COLS; faColor.height=faGlow.height=FA_TH*FA_ROWS;
  {
    const R=seeded(4242), pick=a=>a[Math.floor(R()*a.length)], g=faColor.getContext('2d'), e=faGlow.getContext('2d');
    e.fillStyle='#000'; e.fillRect(0,0,faGlow.width,faGlow.height);
    for(let n=0;n<FA_COLS*FA_ROWS;n++){
      const style=FA_STYLES[n%FA_STYLES.length], ox=(n%FA_COLS)*FA_W, oy=Math.floor(n/FA_COLS)*FA_TH, W=FA_W, H=FA_TH;
      const wall=style==='old'?'#a8a193':style==='office'?pick(['#c9cfd3','#b9c0c4','#d6d2c8','#a9b0b6']):pick(['#d8d0c0','#cfc2ae','#e2dccd','#bfb6a5','#ece9e2']);
      g.fillStyle=wall; g.fillRect(ox,oy,W,H);
      for(let f=0;f<FA_FL;f++){ const y=oy+H-(f+1)*FA_FH; g.fillStyle='rgba(0,0,0,.12)'; g.fillRect(ox,y,W,2);
        if(f===0){ g.fillStyle=style==='old'?'#8d877a':'#3d4a55'; g.fillRect(ox+6,y+12,W-12,FA_FH-12); continue; }
        if(style==='office'){ g.fillStyle='#3f5566'; g.fillRect(ox+4,y+16,W-8,30); g.fillStyle='#8a949c'; for(let x=4;x<W;x+=32) g.fillRect(ox+x,y+16,3,30);
          if(R()<0.35){ e.fillStyle='#ffe6b0'; e.fillRect(ox+4,y+16,W-8,30); } }
        else for(let i=0;i<4;i++){ g.fillStyle='#2d3440'; g.fillRect(ox+8+i*64+6,y+14,44,32);
          if(R()<0.4){ e.fillStyle='#ffdca0'; e.fillRect(ox+8+i*64+6,y+14,44,32); } } }
      if(style==='old') for(let i=0;i<60;i++){ g.fillStyle='rgba(60,55,45,.08)'; g.fillRect(ox+R()*W,oy+R()*H*0.7,2,40+R()*90); }
      faTiles.push({style});
    }
  }
  const toTex=(c)=>{ const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=4; return t; };
  const faColorT=toTex(faColor), faGlowT=toTex(faGlow);
  { const one=document.createElement('canvas'); one.width=one.height=1; const og=one.getContext('2d'); og.drawImage(faColor,0,0,1,1);
    const [r,gg,b]=og.getImageData(0,0,1,1).data, avg=new THREE.Color(`rgb(${r},${gg},${b})`); faColorT.userData.average={r:avg.r,g:avg.g,b:avg.b}; }
  const facadeM=LAM({color:0xffffff,map:faColorT,emissiveMap:faGlowT,emissive:0xffffff,emissiveIntensity:0}); glowMats.push([facadeM,.9]);
  const pickTile=st=>{ const c=faTiles.map((t,n)=>t.style===st?n:-1).filter(n=>n>=0); return c[Math.floor(RN()*c.length)]; };
  // 壁1面(幅 width・高さ H・fl 階)を絵の番号 tile で貼る。中心 (cx,cy,cz)、向き ry(区画の座標)。
  function atlasWall(width,H,fl,tile,cx,cy,cz,ry){
    const n=Math.max(1,Math.round(width/12)), qw=width/n;
    const u0=(tile%FA_COLS)/FA_COLS, u1=u0+1/FA_COLS;
    const v0=1-(Math.floor(tile/FA_COLS)+1)*FA_TH/faColor.height, v1=v0+Math.min(fl,FA_FL)*FA_FH/faColor.height;
    for(let i=0;i<n;i++){
      const off=-width/2+qw*(i+0.5), geo=new THREE.PlaneGeometry(qw,H);
      geo.setAttribute('uv',new THREE.Float32BufferAttribute([u0,v1,u1,v1,u0,v0,u1,v0],2));
      const o=new THREE.Mesh(geo,facadeM); o.position.set(cx+off*Math.cos(ry),cy,cz-off*Math.sin(ry)); o.rotation.y=ry; croot.add(o);
    }
  }
  function cBuilding(W,D,o={}){                       // ビル：形5種類 × 色いろいろ
    cb(W,0.05,D,0x707275,0,0.08,D/2);
    const v=Math.floor(RN()*5), style=o.style||pk(['office','tenant','tenant','old']), floors=3+Math.floor(RN()*3);
    const bd=Math.min(D-3,15), zf=1.6, rf=cmat(0x8a8780);
    // ハリボテ: 正面と左右の壁だけ(屋根は縁の箱がふさぐ)。壁の絵はまとめた画像から選ぶ。
    const mk=(bw,fl,x,st)=>{ const H=fl*3.2, tile=pickTile(st), cy=0.1+H/2, zc=zf+bd/2;
      atlasWall(bw,H,fl,tile,x,cy,zf,Math.PI);
      atlasWall(bd,H,fl,tile,x-bw/2,cy,zc,-Math.PI/2); atlasWall(bd,H,fl,tile,x+bw/2,cy,zc,Math.PI/2);
      ccol(x-bw/2,zf,x+bw/2,zf+bd);
      cb(bw+0.2,0.45,bd+0.2,0x9a968c,x,0.1+H,zf+bd/2); return H; };
    let bw=W-1, mx=0, H;
    if(v===2){                                          // 横に階段室の塔
      bw=W-4.5; mx=1.75; H=mk(bw,floors,mx,style);
      const tw=pk([0xbdb6a8,0x8e9296,0xd9d3c4,0x6e7a86]); cb(3,H+1.6,3.6,tw,-W/2+2.2,0.1,zf+1.8); ccol(-W/2+0.7,zf,-W/2+3.7,zf+3.6);
      for(let f=1;f<floors;f++) cfront(0.5,1.2,-W/2+2.2,0.1+f*3.2+1.5,zf,cDark);
    } else if(v===4){                                   // 高い棟と低い棟の2つ
      const w1=Math.max(8,Math.round((W-1)*0.58)), w2=W-1-w1; mx=-(W-1)/2+w1/2; bw=w1;
      H=mk(w1,floors,mx,style); if(w2>3) mk(w2,2,(W-1)/2-w2/2,pk(['tenant','old']));
    } else H=mk(bw,floors,0,style);
    if(v===1) cb(bw*0.55,3,bd*0.55,pk([0xd8d2c6,0xc9cfd3,0xe2dccd,0xb5a1a1]),mx+bw*0.15,0.55+H,zf+bd*0.4);   // 上に一回り小さい階
    if(v===3){ const rc=pk([0x8e9296,0xd8d2c6,0x5a5f66]);                                                    // 正面にバルコニー
      for(let f=1;f<floors;f++){ const y=0.1+f*3.2; cb(bw-1,0.15,1.2,0xd8d2c6,mx,y,zf-0.6); cb(bw-1,0.9,0.06,rc,mx,y+0.15,zf-1.17); } }
    cfront(2.4,2.5,mx,1.35,zf,cmat(0x8a959c)); cb(3.4,0.18,1.4,0x8e9296,mx,2.75,zf-0.7);
    // ビルの名前の看板は作らない。
    // 屋上の室外機・貯水タンクは道路から見えないので作らない(ハリボテ)。
    for(let i=0;i<4;i++) RN();                         // 乱数の並びを保つ(以降の色や形を変えない)
  }
  function cConvenience(W,D){
    const B=pk(CVS);
    cb(W,0.05,D,0x4a4c4f,0,0.08,D/2);
    const bw=Math.min(W-4,20), zf=D-11, cz=zf+5;
    cb(bw,4.4,10,0xe9e5dc,0,0.1,cz); cb(bw+0.4,0.3,10.4,0xcfcac0,0,4.5,cz); ccol(-bw/2,zf,bw/2,zf+10);
    const ft=ctex(1024,96,(g,w,h)=>{ g.fillStyle=B.a; g.fillRect(0,0,w,26); g.fillStyle='#fbf8f2'; g.fillRect(0,26,w,52); g.fillStyle=B.b; g.fillRect(0,78,w,18);
      g.fillStyle=B.b; g.font='bold 40px sans-serif'; g.textBaseline='middle'; g.fillText(B.n,60,53); g.font='bold 22px sans-serif'; g.fillText('24h OPEN',w-170,53); });
    cb(bw+0.6,1.1,0.4,0xfbf8f2,0,3.3,zf-0.2); cfront(bw+0.6,1.1,0,3.85,zf-0.4,cglow(ft,.9));
    const shop=ctex(512,128,(g,w,h)=>{ g.fillStyle='#eef1ee'; g.fillRect(0,0,w,h); for(let r=0;r<3;r++) for(let x=6;x<w;x+=9){ g.fillStyle=['#d24a3c','#3f7cc0','#e3b23c','#5aa66a','#8a5ab8'][(x+r*3)%5]; g.fillRect(x,40+r*28,6,18); } });
    cfront(bw-2,2.6,0,1.5,zf,cglow(shop,1));
    for(let i=0;i<Math.floor((bw-2)/2.5);i++) cb(0.1,2.6,0.12,0x8e9296,-bw/2+1+i*2.5,0.2,zf-0.06);
    for(let i=0;i<=6;i++){ const x=-W/2+3+i*2.6; if(x>W/2-2) break; cb(0.12,0.01,5,0xf0f0f0,x,0.11,zf-4); if(i<6&&RN()<0.4) ccar(x+1.3,zf-4,0); }
    const st=ctex(256,256,(g,w,h)=>{ g.fillStyle='#fbf8f2'; g.fillRect(0,0,w,h); g.fillStyle=B.a; g.fillRect(0,0,w,40); g.fillStyle=B.b; g.fillRect(0,h-28,w,28);
      g.fillStyle=B.a; g.beginPath(); g.arc(128,110,50,0,Math.PI*2); g.fill(); g.fillStyle='#fff'; g.font='bold 54px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(B.n[0],128,112);
      g.fillStyle=B.b; g.font='bold 30px sans-serif'; g.fillText(B.n,128,198); });
    const sm=cglow(st,.9), em=cmat(0xd8d8d4);
    cb(0.3,7.6,0.3,0xf2f2f0,W/2-1.5,0.1,2); const s=new THREE.Mesh(new THREE.BoxGeometry(2.4,2.4,0.45),[em,em,em,em,sm,sm]); s.position.set(W/2-1.5,8.9,2); s.rotation.y=Math.PI/2; croot.add(s);
    ccol(W/2-1.7,1.8,W/2-1.3,2.2);
    cb(1,1.8,0.8,0xd8dfe6,bw/2-1,0.1,zf-0.6); cb(1,1.8,0.8,pk([0xc23b2e,0x2f5f9e,0xe3b23c]),bw/2-2.2,0.1,zf-0.6);
  }
  function cFamires(W,D){
    const F=pk(FAMI);
    cb(W,0.05,D,0x4a4c4f,0,0.08,D/2);
    const bw=Math.min(W-6,30), bd=12, zf=D-13, cz=zf+bd/2, H=4.6, pil=RN()<0.4;
    const t=ctex(512,64,(g,w,h)=>{ g.fillStyle=F.c; g.fillRect(0,0,w,h); g.fillStyle='#fff8ec'; g.font='bold 34px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(F.n,w/2,34); });
    const glass=cglow(ctex(64,64,(g,w,h)=>{ g.fillStyle='#d9e6ea'; g.fillRect(0,0,w,h); }),.85);
    const y0=pil?3.4:0.1;
    if(pil){ for(let i=0;i<5;i++) for(const z of [zf+1,zf+bd-1]) { const x=-bw/2+1+i*(bw-2)/4; cb(0.5,3.4,0.5,0xd8d2c6,x,0.1,z); ccol(x-0.3,z-0.3,x+0.3,z+0.3); }
      cb(bw,0.5,bd,0xd8d2c6,0,y0,cz); } else ccol(-bw/2,zf,bw/2,zf+bd);
    cb(bw,H,bd,0xf1ebdf,0,y0+(pil?0.5:0),cz);
    cfront(bw-3,2.2,0,y0+(pil?0.5:0)+1.6,zf,glass);
    cb(bw+1.2,1.3,bd+1.2,new THREE.Color(F.c).getHex(),0,y0+(pil?0.5:0)+H-0.4,cz);
    cfront(Math.min(14,bw*0.6),1.2,0,y0+(pil?0.5:0)+H+0.25,zf-0.62,cglow(t,.9));
    for(let i=0;i<14;i++){ const x=-W/2+2+i*2.6; if(x>W/2-2) break; cb(0.12,0.01,5,0xf0f0f0,x,0.11,zf-4); if(RN()<0.45) ccar(x+1.3,zf-4,0); }
    const pm=cglow(t,.9); cb(0.25,8,0.25,0x777d85,-W/2+1.5,0.1,1.5); const ps=new THREE.Mesh(new THREE.BoxGeometry(3.2,1.6,0.35),[pm,pm,pm,pm,pm,pm]); ps.position.set(-W/2+1.5,8.5,1.5); ps.rotation.y=Math.PI/2; croot.add(ps);
  }
  function cParking(W,D){
    const P=pk(PARK);
    cb(W,0.05,D,0x4a4c4f,0,0.08,D/2);
    const n=Math.floor((W-1.6)/2.5), x0=-n*2.5/2;
    for(const [a,b,ry] of [[0.6,5.6,0],[D-5.6,D-0.6,Math.PI]]){
      for(let i=0;i<=n;i++) cb(0.12,0.01,b-a,0xf0f0f0,x0+i*2.5,0.11,(a+b)/2);
      for(let i=0;i<n;i++){ const cx=x0+(i+0.5)*2.5; if(ry===0&&i===Math.floor(n/2)) continue; cb(0.9,0.07,0.45,0x2b2b2b,cx,0.11,(a+b)/2); if(RN()<0.45) ccar(cx,(a+b)/2,ry); }
    }
    cb(0.06,0.8,D,0x9aa0a6,-W/2+0.1,0.1,D/2); cb(W,0.8,0.06,0x9aa0a6,0,0.1,D-0.1);
    const pt=ctex(256,256,(g,w,h)=>{ g.fillStyle=P.bg; g.fillRect(0,0,w,h); g.fillStyle=P.fg; g.font='bold 170px sans-serif'; g.textAlign='center'; g.textBaseline='middle'; g.fillText('P',w/2,105);
      g.font='bold 28px sans-serif'; g.fillText(P.n,w/2,200); g.font='bold 22px sans-serif'; g.fillText('24H 30分¥200',w/2,234); });
    const pm=cglow(pt,.8), mm=cmat(0x444a50);
    cb(0.12,3.4,0.12,0x444a50,W/2-0.8,0.1,0.4); const s=new THREE.Mesh(cgeo(1.3,1.3,0.12),[mm,mm,mm,mm,pm,pm]); s.position.set(W/2-0.8,4.1,0.4); croot.add(s);
    cb(0.55,1.4,0.45,0x5a6068,W/2-2.1,0.1,1);
  }
  function cGas(W,D){
    const O=pk(OIL);
    cb(W,0.05,D,0x9c9a94,0,0.08,D/2);
    const ct=ctex(512,64,(g,w,h)=>{ g.fillStyle='#fff'; g.fillRect(0,0,w,h); g.fillStyle=O.c; g.fillRect(0,h-18,w,18); g.fillRect(0,0,w,8); g.font='bold 34px sans-serif'; g.textBaseline='middle'; g.fillText(O.n+'  SELF',20,30); });
    const cm=cglow(ct,.6), cw=cmat(0xf4f4f2);
    const can=new THREE.Mesh(new THREE.BoxGeometry(Math.min(W-6,18),0.9,12),[cm,cm,cw,cw,cm,cm]); can.position.set(0,5.6,9); croot.add(can);
    const under=cglow(ctex(16,16,(g,w,h)=>{ g.fillStyle='#fff'; g.fillRect(0,0,w,h); }),1);
    cplane(16,11,0,5.14,9,0,under).rotation.x=Math.PI/2;
    for(const x of [-5,5]) for(const z of [5,13]){ cb(0.45,5.2,0.45,0xd8d8d4,x,0.1,z); ccol(x-0.3,z-0.3,x+0.3,z+0.3); }
    for(const x of [-3.5,3.5]){ cb(1.2,0.25,6,0xcfcdc6,x,0.1,9); ccol(x-0.6,6,x+0.6,12);
      for(const z of [7,11]){ cb(0.7,1.7,0.5,0xf2f2f0,x,0.35,z); cb(0.72,0.5,0.52,new THREE.Color(O.c).getHex(),x,1.75,z); } }
    cb(10,3.6,6,0xf0efea,0,0.1,D-4); ccol(-5,D-7,5,D-1); cfront(8,2.2,0,1.45,D-7,cglow(ctex(16,16,(g,w,h)=>{g.fillStyle='#d9e6ea';g.fillRect(0,0,w,h);}),.8));
    const pt=ctex(128,256,(g,w,h)=>{ g.fillStyle=O.c; g.fillRect(0,0,w,h); g.fillStyle='#fff'; g.font='bold 20px sans-serif'; g.textAlign='center'; g.fillText(O.n,w/2,30);
      [['レギュラー',160+Math.floor(RN()*15)],['ハイオク',172+Math.floor(RN()*15)],['軽油',140+Math.floor(RN()*15)]].forEach(([n,p],i)=>{ const y=70+i*62; g.fillStyle='#0d1b14'; g.fillRect(8,y-22,w-16,52); g.fillStyle='#fff'; g.font='bold 16px sans-serif'; g.fillText(n,w/2,y-6); g.fillStyle='#ffd25a'; g.font='bold 26px monospace'; g.fillText(String(p),w/2,y+22); }); });
    const pm=cglow(pt,.9);
    cb(0.25,3.2,0.25,0x777d85,W/2-2,0.1,1); const ps=new THREE.Mesh(new THREE.BoxGeometry(1.6,3.2,0.3),[cw,cw,cw,cw,pm,pm]); ps.position.set(W/2-2,4.9,1); croot.add(ps);
    cb(0.15,1.8,D,0xbab4a8,-W/2+0.1,0.1,D/2); cb(W,1.8,0.15,0xbab4a8,0,0.1,D-0.1);
  }
  const APTC=[0xd8d2c6,0xe8e2d6,0xc9b9a3,0xbfc6c9,0xd9c7b0,0xf0ece4,0xb7c4b5,0xe0cfc8], APTA=[0xa8a39a,0x6e7378,0x8a5a44,0x4a5a6e,0x7a8a6a];
  function cApartment(W,D){                            // アパート：形5種類 × 色いろいろ
    cb(W,0.05,D,0x707275,0,0.08,D/2);
    const v=Math.floor(RN()*5), col=pk(APTC), acc=pk(APTA), bw=Math.min(W-5,26), bd=8, zf=5, fl=v===2?2:2+Math.floor(RN()*2), FH=2.9, H=fl*FH, n=Math.max(2,Math.floor(bw/4.2)), cz=zf+bd/2;
    chollow(bw,H,bd,col,0,0.1,cz); ccol(-bw/2,zf,bw/2,zf+bd);
    if(v===4) chollow(bw+0.06,FH,bd+0.06,0x8a5a44,0,0.1,cz);                                   // 1階だけレンガ調
    if(v===2){ const sh=new THREE.Shape([new THREE.Vector2(-bd/2-0.5,0),new THREE.Vector2(bd/2+0.5,0),new THREE.Vector2(0,1.8)]);
      const rg=new THREE.ExtrudeGeometry(sh,{depth:bw+0.4,bevelEnabled:false}); rg.translate(0,0,-(bw+0.4)/2);
      const r=new THREE.Mesh(rg,[cmat(col),cmat(pk(HROOF))]); r.rotation.y=Math.PI/2; r.position.set(0,0.1+H,cz); croot.add(r); }
    else cb(bw+0.3,0.4,bd+0.3,acc,0,0.1+H,cz);
    const doorM=cmat(pk([0x6e6a62,0x8a6a4a,0x4a5a6e]));
    for(let f=0;f<fl;f++){ const y=0.1+f*FH;
      for(let i=0;i<n;i++){ const x=-bw/2+(i+0.5)*bw/n;
        if(v===1){ cfront(2.2,2,x,y+1.1,zf,RN()<0.5?cWin:cDark); }                          // ベランダ側の掃き出し窓
        else cfront(0.9,2,x,y+1.05,zf,doorM);                                                 // 玄関
        RN(); }                                                                                // 奥側の窓は作らない(乱数の並びは保つ)
      if(f>0){ if(v===1){ cb(bw,0.15,1.2,0xd8d2c6,0,y,zf-0.6); cb(bw,1,0.06,acc,0,y+0.15,zf-1.17); for(let i=1;i<n;i++) cb(0.08,1.1,1.2,0xd8d2c6,-bw/2+i*bw/n,y+0.15,zf-0.6); }
               else { cb(bw,0.15,1.3,0xbab4a8,0,y,zf-0.65); cb(bw,1,0.08,acc,0,y+0.15,zf-1.28); } }
    }
    if(v===0||v===4){ cb(1.4,H,3,0xbab4a8,bw/2+0.7,0.1,zf+1.5); ccol(bw/2,zf,bw/2+1.4,zf+3); }           // 端の階段室
    if(v===3){ cb(2.6,H+1,2.2,acc,0,0.1,zf-1.1); ccol(-1.3,zf-2.2,1.3,zf); }                              // 正面中央の階段塔
    if(v===2){ const L=Math.hypot(5,FH), ang=Math.atan2(FH,5);                                              // 外付けの鉄骨階段
      const s=cb(L,0.12,1,0x5a5f66,bw/2-3,0,zf-1.9); s.position.y=0.1+FH/2; s.rotation.z=ang;
      cb(0.08,FH,0.08,0x5a5f66,bw/2-0.5,0.1,zf-1.4); ccol(bw/2-5.6,zf-2.5,bw/2,zf-1.3); }
    for(let i=0;i<3;i++) cb(0.06,0.7,1.6,0x2b2f35,-bw/2+1.2+i*1.1,0.12,2.5);              // 自転車
  }
  // 区画の種類ごとの敷地の選び方
  function pickLot(zone){
    const r=RN();
    if(zone==='houses'||zone==='trees') return r<0.82?['house',12+RN()*3]:['apartment',20+RN()*6];
    if(zone==='buildings') return r<0.88?['building',13+RN()*8]:['parking',18];
    if(zone==='roadside') return r<0.3?['famires',40]:r<0.55?['parking',22]:r<0.78?['gas',32]:['conv',28];
    return r<0.3?['building',14+RN()*7]:r<0.43?['conv',28]:r<0.52?['famires',40]:r<0.62?['apartment',22]:r<0.84?['house',13]:['parking',20];
  }
  const BUILD={house:cHouse,building:cBuilding,conv:cConvenience,famires:cFamires,parking:cParking,gas:cGas,apartment:cApartment};

  // 区画の並び：5種類を区画ごとに並べ替えてループ、左右は1周ごとに入れ替える
  function sectionInfo(s){
    const cyc=Math.floor(s/ZONES.length), rr=seeded(cyc*31+5), order=ZONES.slice();
    for(let i=order.length-1;i>0;i--){ const j=Math.floor(rr()*(i+1)); [order[i],order[j]]=[order[j],order[i]]; }
    return {zone:order[s%ZONES.length], mirror:(cyc+s)%2===1};
  }
  // g は周をまたいで通しの区画番号。周の中の番号 k で中身が決まるので、どの周も同じ街になる。
  function buildChunk(g){
    const lap=Math.floor(g/NCH), k=g-lap*NCH;
    const s=Math.floor(k/SEC), ci=k%SEC, {zone,mirror}=sectionInfo(s), x0=RX0+lap*LAP+k*CL;
    const ch={k:g,group:new THREE.Group(),cols:[],glows:[],texs:[]}; cchunk=ch; croot=ch.group; world.add(ch.group);
    // 地面・道路・歩道・線
    cb(CL,0.02,300,0x6d7a55,x0+CL/2,-0.03,0);
    cb(CL,0.02,12,cRoad,x0+CL/2,0,0); cb(CL,0.02,0.15,0xd9b23a,x0+CL/2,0.02,0);
    for(const z of [-5.6,5.6]) cb(CL,0.02,0.12,0xeeeeee,x0+CL/2,0.02,z);
    for(const z of [-6.1,6.1]) cb(CL,0.18,0.2,0x9d9a94,x0+CL/2,0,z);
    for(const z of [-7.7,7.7]) cb(CL,0.15,3,cWalk,x0+CL/2,0,z);
    for(const z of [-10.8,10.8]) cb(CL,0.05,3.2,0x707275,x0+CL/2,0.05,z);
    // 街灯（両側・互い違い）と光だまり
    // 片側60mおき(元の30mおきの倍)。両側で互い違い。
    for(const [x,z,d] of [[x0+10,-6.6,1],[x0+40,6.6,-1]]){
      cb(0.18,7,0.18,0x9aa0a6,x,0.15,z); cb(0.08,0.08,1.6,0x9aa0a6,x,7.05,z+d*0.8); cb(0.3,0.15,0.8,cLampHead,x,6.95,z+d*1.55);
      const pl=new THREE.Mesh(new THREE.PlaneGeometry(16,16),roadPoolM); pl.rotation.x=-Math.PI/2; pl.position.set(x,0.2,z+d*4.5); ch.group.add(pl); ch.cols.push([x-0.15,z-0.15,x+0.15,z+0.15]);
    }
    // 電柱と電線（手前側）
    for(const x of [x0+15,x0+45]){ cb(0.34,9.5,0.34,0xb9b6ae,x,0.15,9.4); cb(0.12,0.12,2.2,0x8a8a86,x,8.8,9.4); ch.cols.push([x-0.25,9.15,x+0.25,9.65]); }
    { const spans=[];                                   // 区画の電線4本をまとめて1回で描く
      for(const dz of [-0.9,0.9]){ const A=new THREE.Vector3(x0-15,8.95,9.4+dz), B=new THREE.Vector3(x0+15,8.95,9.4+dz), C=new THREE.Vector3(x0+45,8.95,9.4+dz);
        spans.push([A,B,0.7],[B,C,0.7]); }
      ch.group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wireSegments(spans,[])),wireM)); }
    // 街路樹の区画
    // 歩道の街路樹は植えない(重いので)。「並木」の区画も、敷地の家並みは住宅の区画と同じ。
    // 両側の敷地（同じ区画は毎回同じ中身。左右入れ替えは mirror）
    for(const logical of [1,-1]){
      RN=seeded(ZONES.indexOf(zone)*1000+ci*10+(logical>0?1:2));
      const side=mirror?-logical:logical, D=26;
      let x=0; const lots=[];
      while(x<CL-0.5){ let [type,w]=pickLot(zone); w=Math.round(w*2)/2; if(x+w>CL){ w=CL-x; type=w>=11?(zone==='buildings'?'building':'house'):'parking'; } lots.push([type,w,x]); x+=w; }
      lots.forEach(([type,w,lx],i)=>{
        const cx=side>0? x0+lx+w/2 : x0+CL-(lx+w/2);
        keepSolid=['conv','famires','gas','parking'].includes(type);
        csub(cx,side*12.4,side>0?0:Math.PI,()=>BUILD[type](w,D,{lastRight:i===lots.length-1}));
        keepSolid=false;
      });
    }
    RN=Math.random;
    mergeChunk(ch.group);
    if(night) simplifyGroup(ch.group,true);
    return ch;
  }
  // 部品をまとめて描く回数を減らす。
  //  - 模様も発光もない単色の部品は、色を頂点に持たせて全部まとめて1回で描く。
  //  - それ以外(模様・発光・半透明)は同じ材質ごとにまとめる。
  // このステージは影を描かない設定なので、影の有無では分けない。
  const vcMat=LAM({vertexColors:true});
  const plain=m=>m.isMeshLambertMaterial && !m.map && !m.emissiveMap && !m.transparent && !m.vertexColors
    && m.emissive.getHex()===0 && m.side===THREE.FrontSide;
  // 建物の大きさの箱(高さ3m以上・幅も奥行きも4m以上)を、道路に向いた面と左右の面だけにする。
  // 箱の面の並び: +x, -x, +y, -y, +z, -z。どちらの z 面が道路(z=0)を向くかは置き場所で決める。
  const _wp=new THREE.Vector3(), _wn=new THREE.Vector3(), _ws=new THREE.Vector3();
  function hollowBoxes(g){
    g.traverse(o=>{
      if(!o.isMesh||o.userData.keepSolid||o.geometry.type!=='BoxGeometry') return;
      for(let p=o; p; p=p.parent) if(p.userData.keepSolid) return;
      o.getWorldScale(_ws); const P=o.geometry.parameters;
      if(P.height*_ws.y<3 || Math.min(P.width*_ws.x,P.depth*_ws.z)<4) return;
      o.getWorldPosition(_wp);
      _wn.set(0,0,1).transformDirection(o.matrixWorld);
      const road=_wp.z>0?-1:1, keepZ=Math.sign(_wn.z)===road?4:5;
      const src=o.geometry, idx=src.index.array, out=[], geo=new THREE.BufferGeometry();
      for(const k of ['position','normal','uv']) geo.setAttribute(k,src.attributes[k]);
      src.groups.forEach(gr=>{ if(gr.materialIndex===0||gr.materialIndex===1||gr.materialIndex===keepZ){
        geo.addGroup(out.length,gr.count,gr.materialIndex); for(let i=gr.start;i<gr.start+gr.count;i++) out.push(idx[i]); } });
      geo.setIndex(out); o.geometry=geo;
    });
  }
  function mergeChunk(g){
    g.updateMatrixWorld(true);
    hollowBoxes(g);
    const groups=new Map(), rm=[];
    g.traverse(o=>{ if(!o.isMesh||Array.isArray(o.material)||!o.geometry.attributes.uv) return;
      const geo=o.geometry.index?o.geometry.toNonIndexed():o.geometry.clone(); geo.applyMatrix4(o.matrixWorld);
      for(const k of Object.keys(geo.attributes)) if(!['position','normal','uv'].includes(k)) geo.deleteAttribute(k);
      const m=o.material, vc=plain(m);
      if(vc){ const n=geo.attributes.position.count, c=new Float32Array(n*3);
        for(let i=0;i<n;i++){ c[i*3]=m.color.r; c[i*3+1]=m.color.g; c[i*3+2]=m.color.b; }
        geo.setAttribute('color',new THREE.BufferAttribute(c,3)); }
      const key=vc?'vc':m.uuid; if(!groups.has(key)) groups.set(key,{m:vc?vcMat:m,list:[]}); groups.get(key).list.push(geo); rm.push(o); });
    rm.forEach(o=>{ o.parent.remove(o); if(!Object.values(CGC).includes(o.geometry)&&o.geometry!==tGeo&&o.geometry!==lGeo) o.geometry.dispose(); });
    groups.forEach(({m,list})=>{ const mg=mergeGeometries(list); list.forEach(x=>x.dispose()); if(mg){ const ms=new THREE.Mesh(mg,m); ms.matrixAutoUpdate=false; g.add(ms); } });
    // ひと固まりにしたので親の変換は単位行列に
  }
  function disposeChunk(ch){
    world.remove(ch.group);
    ch.group.traverse(o=>{ if(o.geometry && !Object.values(CGC).includes(o.geometry) && o.geometry!==tGeo && o.geometry!==lGeo) o.geometry.dispose(); });
    ch.texs.forEach(t=>t.dispose()); ch.glows.forEach(([m])=>m.dispose());
  }
  function updateChunks(fx){
    const lap=Math.floor((fx-IA)/LAP), local=fx-IA-lap*LAP-(RX0-IA);
    // 前は約400m先まで(霞で見えなくなる距離)、後ろは約120m。
    const cur=lap*NCH+Math.floor(local/CL), lo=cur-2, hi=cur+7;
    for(const [k,ch] of chunkMap) if(k<lo||k>hi){ disposeChunk(ch); chunkMap.delete(k); }
    for(let k=lo;k<=hi;k++) if(!chunkMap.has(k)){ chunkMap.set(k,buildChunk(k)); break; }   // 1フレームに1つずつ作る（カクつき防止）
  }
  function chunkBlocked(x,z,r){ for(const ch of chunkMap.values()) if(ch.cols.some(c=>x>c[0]-r&&x<c[2]+r&&z>c[1]-r&&z<c[3]+r)) return true; return false; }


  // ---- 走る車は入れない（駐車中の車は残す）----
  if(!traffic){ movers.forEach(m=>scene.remove(m.c)); crossCars.forEach(k=>scene.remove(k.c)); }
  mergeChunk(scene);                                  // コンビニ区間もまとめて描く

  // ---- 書き割り(建物の隙間から奥の荒野が見えないよう、街並みの影絵を立てる) ----
  // 家の屋根やビルが連なる形のグレーの板。手前(道路中心から64m)と奥(110m)の2枚ずつ。
  // 板は車について動くが、模様の周期(200m)ごとにしか動かさないので、絵は地面に固定されて見える。
  const BD_PERIOD=200, BD_LEN=1000;
  function skylineTex(seed,maxH,tall){
    const R=seeded(seed), W=1024, H=128, ppm=W/BD_PERIOD, py=H/32;    // 横 5.12px/m、縦 4px/m(高さ32m)
    const t=tex(W,H,(g)=>{ g.clearRect(0,0,W,H); g.fillStyle='#fff';
      let x=0;
      while(x<W){
        const kind=R();
        if(kind<(tall?0.25:0.55)){                                   // 切妻屋根の家
          const w=(8+R()*5)*ppm, h=(5+R()*2)*py, rh=(2+R()*1.2)*py;
          g.fillRect(x,H-h,w,h); g.beginPath(); g.moveTo(x-2,H-h); g.lineTo(x+w/2,H-h-rh); g.lineTo(x+w+2,H-h); g.fill(); x+=w+R()*2*ppm;
        } else {                                                      // ビル・アパート(屋上に小さな出っ張り)
          const w=(10+R()*14)*ppm, h=Math.min(maxH,(8+R()*(tall?22:12)))*py;
          g.fillRect(x,H-h,w,h); if(R()<0.5) g.fillRect(x+w*(0.2+R()*0.5),H-h-1.5*py,2.5*ppm,1.5*py); x+=w+R()*1.5*ppm;
        }
      } });
    t.wrapS=THREE.RepeatWrapping; t.repeat.set(BD_LEN/BD_PERIOD,1); return t;
  }
  const backdrops=[];
  for(const [dist,seed,maxH,tall,day,nightC] of [[64,11,14,false,0x9aa1a8,0x1b1f27],[110,23,28,true,0xb4bcc4,0x141820]]){
    const map=skylineTex(seed,maxH,tall), H=32;
    const m=new THREE.MeshBasicMaterial({color:day,alphaMap:map,alphaTest:0.5,side:THREE.DoubleSide});
    m.userData.day=day; m.userData.night=nightC;
    for(const side of [-1,1]){
      const p=new THREE.Mesh(new THREE.PlaneGeometry(BD_LEN,H),m);
      p.position.set(0,H/2-0.5,side*dist); p.rotation.y=side>0?Math.PI:0; p.name='skyline'; world.add(p); backdrops.push(p);
    }
  }

  // ---- 昼夜 ----
  // 夜は模様(色の画像)を外し、その平均の単色にする。光る窓・看板(発光の画像)は残す。
  function simplify(m,on){
    if(!m||!m.isMeshLambertMaterial) return;
    if(on){ if(!m.map||m.userData.dayMap) return;
      m.userData.dayMap=m.map; m.userData.dayColor=m.color.clone();
      const a=m.map.userData.average; if(a) m.color.setRGB(a.r,a.g,a.b).multiply(m.userData.dayColor);
      m.map=null; m.needsUpdate=true; }
    else if(m.userData.dayMap){ m.map=m.userData.dayMap; m.color.copy(m.userData.dayColor);
      delete m.userData.dayMap; delete m.userData.dayColor; m.needsUpdate=true; }
  }
  function simplifyGroup(g,on){ g.traverse(o=>{ if(o.isMesh) (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>simplify(m,on)); }); }
  function setNight(n){
    night=n;
    leafM.color.setHex(n?LEAF_NIGHT:LEAF_DAY);
    backdrops.forEach(p=>p.material.color.setHex(n?p.material.userData.night:p.material.userData.day));
    simplifyGroup(scene,n); chunkMap.forEach(ch=>simplifyGroup(ch.group,n));
    glowMats.forEach(([m,v])=>m.emissiveIntensity=n?v:0);
    chunkMap.forEach(ch=>ch.glows.forEach(([m,v])=>m.emissiveIntensity=n?v:0));
    // 街灯の電球(灯具)は夜に光るが、点光源での照明計算はしない(昼も夜も外す)。
    // 道路が明るいのは光だまりの円の所だけ。
    lamps.forEach(L=>{ L.intensity=0; L.visible=false; });
    lampPools.forEach(m=>m.opacity=n?0.7:0);
    if(gsLight){ gsLight.intensity=0; gsLight.visible=false; gsPoolM.opacity=n?0.85:0; }   // スタンドの屋根下も光だまりだけ
  }
  setNight(false);
  const startX=opts.startX??0;
  for(let i=0;i<10;i++) updateChunks(startX);         // 最初の区間を先に作っておく

  // ---- 当たり判定 ----
  // x, z は周をまたいだ座標でよい。コンビニ区間の当たり判定は区間の中の座標で調べる。
  function isBlocked(x,z,R=0.3){
    if(chunkBlocked(x,z,R)) return true;
    const lx=x-scene.position.x;
    if(lx>D0-R && lx<D1+R && Math.abs(z-24)<0.1+R) return true;   // 自動ドア(車では店に入れない)
    return colliders.some(c=>lx>c[0]-R&&lx<c[2]+R&&z>c[1]-R&&z<c[3]+R);
  }

  // ---- 毎フレームの更新 ----
  // player は見ている位置(カメラ)。周をまたいだ座標でもよい。
  function update(dt,t,player){
    const px=player?player.x:0;
    updateChunks(px);
    backdrops.forEach(p=>{ p.position.x=Math.round(px/BD_PERIOD)*BD_PERIOD; });
    // コンビニ区間を一番近い周へ。
    scene.position.x=Math.round((px-(IA+RX0)/2)/LAP)*LAP;
    updateSignals(t);
    if(traffic){
      crossCars.forEach(k=>{ const z=k.c.position.z, nz=z+k.dir*7*dt;
        const atStop=!crossGreen() && (k.dir>0 ? (z<=k.stop && nz>k.stop) : (z>=k.stop && nz<k.stop));
        if(!atStop) k.c.position.z=nz;
        if(k.c.position.z>88) k.c.position.z=-88; if(k.c.position.z<-88) k.c.position.z=88; });
      movers.forEach(m=>{
        if(m.every){
          if(m.wait>0){ m.c.visible=false; m.wait-=dt;
            if(m.wait<=0 && Math.abs(m.lane.position.x-m.start)<18) m.wait=1;
            if(m.wait>0) return;
            m.c.position.x=m.start; m.c.visible=true; }
          m.c.position.x+=m.v*dt;
          if(Math.abs(m.c.position.x)>66) m.wait=m.every[0]+Math.random()*(m.every[1]-m.every[0]);
          return;
        }
        m.c.position.x+=m.v*dt; if(m.c.position.x>45)m.c.position.x=-45; if(m.c.position.x<-45)m.c.position.x=45;
      });
    }
  }

  return { update, setNight, isBlocked, group:scene, isNight:()=>night };
}
