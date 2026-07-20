/*
 * VOX DRIVE — drive a voxel Toyota 86 around a plane scattered with voxel trees,
 * while AI cars discovered from the vox folder cruise on loops.
 *
 *   A: brake  S: accel  Space: handbrake (drift)
 *   Up/Down: shift  Left/Right: steer  Mouse drag: camera
 */
import * as THREE from 'three';
import { GLTFLoader } from '../lib/GLTFLoader.js';
import { mergeGeometries } from '../lib/BufferGeometryUtils.js';
import { VOX } from './vox.js';
import { AUDIO } from './audio.js?v=20260718-5';
import { buildSuzukaMap } from './suzuka-map.js?v=20260717-15';
import { CAR2_CPU_ROUTE, CAR2_MOUNTAIN_ROUTE } from './car2-route.js?v=20260720-2';

(function () {
  'use strict';

  // スマホ判定: スマホは PC PLAY ONLY(デモ観賞のみ)。
  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  // マップ選択: デフォルトは自動生成の街 + 森 + 峠。
  //   ?map=nihonbashi.gltf … 日本橋マップを読む
  //   ?map=maps/sample.glb … 別の glTF/GLB マップを読む
  //   ?map=city            … デフォルトと同じ自動生成マップ
  const pageQuery = new URLSearchParams(location.search);
  const mapParam = pageQuery.get('map');
  const SUZUKA_MODE = (mapParam || '').toLowerCase() === 'suzuka';
  const carParam = (pageQuery.get('car') || 'toyota86').toLowerCase();
  const PLAYER_CAR_KEY = carParam === 'volvo240' ? 'volvo240' : 'toyota86';
  const MAP_GLTF = mapParam === null || ['', 'city', 'procedural', 'none', '0'].includes(mapParam)
    ? ''
    : mapParam;
  const NIHONBASHI_MODE = MAP_GLTF.toLowerCase().endsWith('nihonbashi.gltf');
  const CAR2_MODE = decodeURIComponent(MAP_GLTF).toLowerCase().endsWith('map.gltf');
  // map2.gltf: 山岳ラリーコース。map.gltf(車2/首都高)と同じ「北端南端で周回」
  // 仕組みを流用する。道路網は単一の湾曲した1本道で、手描きの経路情報の代わりに
  // CAR2_MOUNTAIN_ROUTE(実測で自動生成した道路中心線)を使い、自動運転・CPU車の
  // 走行ラインとする。プレイヤーの当たり判定自体は汎用の地形追従(坂・壁判定)。
  const CAR2_MOUNTAIN_MODE = decodeURIComponent(MAP_GLTF).toLowerCase().endsWith('map2.gltf');
  let mapRoot = null;              // set when a custom map is loaded (ground raycasts)
  let car2RoadMeshes = [];         // 高さ0の濃いグレー路面だけを保持
  let car2DrivableMeshes = [];     // 路面+白線(走行可能とみなす面)
  const car2VisualWraps = [];      // ループ地点の先に見せる前後1周分（表示専用）

  let BOUND_X_MIN = -290;          // playable area (m); extends east into the forest
  let BOUND_X_MAX = 710;
  let BOUND_Z = 290;
  const VOXEL_SCALE = 0.06;        // 1 voxel = 6 cm -> cars ~4.8 m long
  const TREE_SCALE = 0.08;

  // Cars are modeled along MagicaVoxel Y, which maps onto the three.js Z
  // axis; their nose points to -Z there, matching our forward (+Z at yaw 0)
  // without any extra yaw.
  const MODEL_YAW = 0;
  // Rest the tyres exactly on the ground; the tiny extra sink only closes
  // the light gap at glancing angles (the contact shadow does the rest).
  const CAR_SINK = 0.02;

  // デモ画面の状態。読み込み後はまずデモ(自動運転のドリフト回遊)になり、
  // ユーザーが何か操作するとゲーム開始。
  let demoActive = false;
  let startGame = function () {};   // init 内で本体を差し込む
  let gameSpawn = null;             // デモ解除時に戻る通常スポーン {x,y?,z,heading}
  let topView = false;               // 全マップ共通の真上からの全体表示
  let bonnetView = 0;                // V: 0=通常 1=ボンネット 2=視点のみ(車体非表示)
  let hudState = 0;                  // G: 0=全表示 1=操作説明なし 2=メーターもなし
  let mirrorView = false;            // F: 画面上部のバックミラー
  let pauseMode = false;             // ESC: ゲーム一時停止(操作説明を表示)

  function applyPause() {
    const helpEl = document.getElementById('help');
    if (pauseMode) {
      for (const key of Object.keys(keys)) keys[key] = false;   // 押しっぱなし解除
      if (helpEl) helpEl.style.display = '';   // 表示切替で消していても出す
    } else if (helpEl) {
      helpEl.style.display = hudState === 0 ? '' : 'none';
    }
    let overlay = document.getElementById('pause-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pause-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:7;display:none;'
        + 'align-items:center;justify-content:center;pointer-events:none;'
        + 'background:rgba(8,14,20,0.35);color:#fff;font-weight:800;font-size:56px;'
        + 'letter-spacing:12px;text-shadow:0 2px 16px rgba(0,0,0,0.6);'
        + 'font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;';
      overlay.textContent = 'PAUSE';
      document.body.appendChild(overlay);
    }
    overlay.style.display = pauseMode ? 'flex' : 'none';
    document.body.dataset.paused = String(pauseMode);
  }
  let autoDrive = false;             // Y: 自動運転(car2のみ)
  let autoIdx = -1;                  // 自動運転が追うウェイポイント
  let car2AutoRoute = null;          // 道路中央のライン(自動運転用)

  // B: 音声切替 0=エンジン音 1=車内音(mp3ループ) 2=無音
  // 車内音は 80km/h 未満= drive_on_freeway1.mp3 / 以上= drive_on_freeway2.mp3。
  // どのモードでもドリフト音(タイヤスクリーチ)は鳴らし続ける。
  let soundMode = 0;
  let interiorCurrent = 0;           // 再生中の車内音 (0=なし 1=低速 2=高速)
  const interiorLow = new Audio('sound/' + encodeURIComponent('drive_on_freeway1.mp3'));
  const interiorHigh = new Audio('sound/' + encodeURIComponent('drive_on_freeway2.mp3'));
  interiorLow.loop = interiorHigh.loop = true;
  interiorLow.volume = interiorHigh.volume = 0.85;

  function stopInterior() {
    interiorLow.pause();
    interiorHigh.pause();
    interiorCurrent = 0;
  }
  function applySoundMode() {
    AUDIO.setEngineMuted(soundMode !== 0);   // エンジンのみ消す(ドリフト音は残す)
    if (soundMode !== 1) stopInterior();
    document.body.dataset.soundMode = String(soundMode);
  }
  // 車内音の低速/高速切替。80km/h 前後でばたつかないよう±2km/hの余裕を持つ。
  function updateInteriorSound(speedKmh) {
    if (soundMode !== 1) return;
    let next = interiorCurrent;
    if (interiorCurrent !== 2 && speedKmh >= 82) next = 2;
    else if (interiorCurrent !== 1 && speedKmh <= 78) next = 1;
    else if (interiorCurrent === 0) next = speedKmh >= 80 ? 2 : 1;
    if (next === interiorCurrent) return;
    interiorCurrent = next;
    const play = next === 2 ? interiorHigh : interiorLow;
    const stop = next === 2 ? interiorLow : interiorHigh;
    stop.pause();
    play.play().catch(() => {});
  }
  let topViewFrame = null;           // 現在のマップ外形（遅延計算）
  let crimMarker = null, selfMarker = null;   // 地図表示: 犯人=赤丸 / 自車=シアン丸
  let savedFog;                      // 地図表示中に退避するフォグ

  // 緊急指令(ミッション)の状態。ワンダーランドのみ。init 内で有効化する。
  let missionScenarios = [];        // [{ car:'nissan180sx3.vox', msg:'...' }]
  let missionCpuCars = [];          // 読み込み済み CPU 車 [{url, mesh}]
  let missionRingWps = null;        // 犯人ルートのフォールバック
  let missionRoutes = null;         // 犯人が走る候補コース群(毎回ランダムに選ぶ)
  let missionEnabled = false;
  let missionHit = false;           // このフレームで犯人車に接触したか
  const mission = { phase: 'off', queue: [], active: null, nextAt: 0 };  // off/waiting/active/done

  // ------------------------------------------------------------- input ----
  const keys = {};
  let shiftUp = false, shiftDown = false;
  window.addEventListener('keydown', (e) => {
    AUDIO.unlock();
    const k = e.key;
    // car2のデモ画面: 何かのボタンでタイトルへ戻る
    if (demoActive && CAR2_MODE) {
      if (!IS_MOBILE) exitCar2Demo();   // スマホはデモを見せるだけ
      e.preventDefault();
      return;
    }
    // M: 音楽選択モード(開いている間は運転を停止し、キーはメニューが消費)
    if (!e.repeat && k.toLowerCase() === 'm') {
      if (musicMode) closeMusicMenu(); else openMusicMenu();
      e.preventDefault();
      return;
    }
    if (musicMode) {
      if (k === 'Escape') { closeMusicMenu(); return; }
      if (k.startsWith('Arrow') || k === 'Enter' || k === ' ') e.preventDefault();
      musicKeydown(k, e.repeat);
      return;
    }
    // ESC: ゲーム一時停止(操作説明パネルを表示)。もう一度押すと再開。
    if (!e.repeat && k === 'Escape') {
      pauseMode = !pauseMode;
      applyPause();
      return;
    }
    if (pauseMode) return;               // 一時停止中は運転キーを受け付けない
    if (demoActive) { startGame(); return; }   // 何かキーでゲーム開始
    if (k.startsWith('Arrow') || k === ' ') e.preventDefault();
    if (!e.repeat) {
      if (k === 'ArrowUp') shiftUp = true;
      if (k === 'ArrowDown') shiftDown = true;
      if (k.toLowerCase() === 'n') { nightMode = !nightMode; applyNight(); }
      if (k.toLowerCase() === 'b') { soundMode = (soundMode + 1) % 3; applySoundMode(); }
      // V: 通常 → ボンネットカメラ → 視点のみ(車体非表示・マウスで視点操作) → 通常
      if (k.toLowerCase() === 'v') bonnetView = (bonnetView + 1) % 3;
      // 曲操作は運転中も有効。I/O で前の曲/次の曲。
      if (k.toLowerCase() === 'j') musicSeek(-10);
      if (k.toLowerCase() === 'k') musicTogglePlay();
      if (k.toLowerCase() === 'l') musicSeek(10);
      if (k.toLowerCase() === 'i') playPrev();
      if (k.toLowerCase() === 'o') playNext(false);
      if (k.toLowerCase() === 'f') {
        mirrorView = !mirrorView;
        const frame = document.getElementById('mirror-frame');
        if (frame) frame.style.display = mirrorView ? 'block' : 'none';
      }
      if (k.toLowerCase() === 'y' && (CAR2_MODE || CAR2_MOUNTAIN_MODE)) {
        autoDrive = !autoDrive;
        autoIdx = -1;                // 次フレームで最寄り地点から追従を開始
        document.body.dataset.autoDrive = String(autoDrive);
      }
      if (k.toLowerCase() === 'g') {
        // 表示切替 5状態:
        //   0=操作表+音楽+スピード / 1=音楽+スピード / 2=スピードのみ
        //   3=音楽のみ / 4=何もなし → 0 へ戻る
        hudState = (hudState + 1) % 5;
        const helpEl = document.getElementById('help');
        const meterEl = document.getElementById('meter');
        if (helpEl) helpEl.style.display = hudState === 0 ? '' : 'none';
        if (meterEl) meterEl.style.display = hudState <= 2 ? '' : 'none';
        updateNowPlayingVisibility();   // 音楽(曲名)は 0/1/3 で表示
      }
    }
    keys[k.toLowerCase()] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

  // ------------------------------------------------------------ helpers ---
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Deterministic PRNG so trees land in the same place every run.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeGroundTexture() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#79a054';
    ctx.fillRect(0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const rnd = mulberry32(1234);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rnd() - 0.5) * 26;
      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n * 0.7;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(150, 88);         // square texels on the 2400x1400 ground
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ------------------------------------------------------------- scene ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY = 0x8ecbef;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 130, 480);

  // near=0.5 keeps enough depth precision at 300 m for the thin road layers
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 1200);

  const hemi = new THREE.HemisphereLight(0xdff3ff, 0x5a7a45, 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d8, 1.15);
  sun.castShadow = true;
  sun.shadow.mapSize.set(512, 512);
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 220;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);
  const SUN_DIR = new THREE.Vector3(28, 90, 18).normalize();

  // ------------------------------------------------------------ clouds ----
  // 昼間の青空に雲を表示する(ffffx.html の雲ドームを流用。fbmノイズの天球)。
  // ▼▼▼ ここの数値を変えるだけで雲を調整できます(ffffx の雲1相当) ▼▼▼
  const CLOUD_CFG = {
    cov: 0.40,       // 量(小さいほど多い)
    soft: 0.28,      // 縁のやわらかさ
    scale: 1.2,      // 粒の細かさ(小さいほど雲が大きい)
    stretch: 1.0,    // 横方向の引き伸ばし(1=なし)
    warp: 1.6,       // 形のうねり(大きいほど複雑)
    detail: 0.8,     // 細部の量(0〜1)
    proj: 0.06,      // 投影クランプ(小さいほど地平線方向に伸びる)
    minY: 0.18,      // 雲が出る最低の高さ
    band: 0.10,      // 出始めのフェード幅
    flowBase: 0.05,  // 停車時の流れ速度
    flowSpeed: 0.002,// 走行速度(m/s)への連動係数
    drift: 0.0,      // 左右ドリフト
    shadow: 0.8,     // 最暗部の明るさ(1=真っ白)
    litSky: 0.5,     // 白い下面に地平線色を反映(0〜1)
    shadowSky: 0.5,  // 影・グレー部に上空色を反映(0〜1)
    opacity: 0.9,    // 全体の不透明度
  };
  // ▲▲▲ ここまで ▲▲▲
  let cloudDome = null;
  let cloudTime = 0, cloudFlow = 0, cloudDriftAcc = 0;
  const cloudUniforms = {
    uTime: { value: 0 }, uFlow: { value: 0 }, uDrift: { value: 0 },
    uCov: { value: CLOUD_CFG.cov }, uSoft: { value: CLOUD_CFG.soft },
    uScale: { value: CLOUD_CFG.scale }, uStretch: { value: CLOUD_CFG.stretch },
    uWarp: { value: CLOUD_CFG.warp }, uDetail: { value: CLOUD_CFG.detail },
    uProj: { value: CLOUD_CFG.proj }, uMinY: { value: CLOUD_CFG.minY },
    uBand: { value: CLOUD_CFG.band }, uShadow: { value: CLOUD_CFG.shadow },
    uLitSky: { value: CLOUD_CFG.litSky }, uShadowSky: { value: CLOUD_CFG.shadowSky },
    uOpacity: { value: CLOUD_CFG.opacity },
    uSkyColor: { value: new THREE.Color(0x8ecbef) },   // 上空色
    uSkyHor: { value: new THREE.Color(0xeaf4fb) },     // 地平線色
  };
  {
    const cloudVert = 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
    const cloudFrag = `
      precision highp float;
      uniform float uTime,uFlow,uDrift,uCov,uSoft,uScale,uStretch,uWarp,uDetail,uProj,uMinY,uBand,uShadow,uLitSky,uShadowSky,uOpacity;
      uniform vec3 uSkyColor, uSkyHor;
      varying vec3 vDir;
      float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
      float noise(vec2 p){
        vec2 i=floor(p), f=fract(p);
        float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
        vec2 u=f*f*(3.0-2.0*f);
        return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
      }
      float fbm(vec2 p){
        float v=0.0, a=0.5;
        for(int i=0;i<6;i++){ v+=a*noise(p); p=p*2.02+vec2(1.7,9.2); a*=0.5; }
        return v;
      }
      void main(){
        vec3 dir=normalize(vDir);
        if(dir.y<=0.01) discard;
        vec2 p = dir.xz/max(dir.y,uProj);
        p *= uScale; p.x *= uStretch;
        vec2 sp = p + vec2(uDrift, -uFlow);
        vec2 q = vec2(fbm(sp), fbm(sp+vec2(3.1,6.7)));
        float base = fbm(sp + uWarp*q);
        float detail = fbm(sp*3.0 + 4.0*q);
        float d = mix(base, base*0.7+detail*0.3, uDetail);
        float dens = smoothstep(uCov, uCov+uSoft, d);
        dens *= smoothstep(uMinY, uMinY+uBand, dir.y);
        float lit = smoothstep(uCov, uCov+0.5, d);
        vec3 darkest = mix(vec3(0.5), vec3(1.0), uShadow);
        vec3 horTint = uSkyHor   / max(max(uSkyHor.r,  uSkyHor.g),  max(uSkyHor.b,  0.001));
        vec3 topTint = uSkyColor / max(max(uSkyColor.r,uSkyColor.g),max(uSkyColor.b,0.001));
        vec3 litCol  = mix(vec3(1.0), horTint, uLitSky);
        vec3 darkCol = mix(darkest, darkest*topTint, uShadowSky);
        vec3 col = mix(darkCol, litCol, lit);
        float a = dens*uOpacity;
        if(a<0.003) discard;
        gl_FragColor=vec4(col, a);
      }`;
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: cloudUniforms, vertexShader: cloudVert, fragmentShader: cloudFrag,
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, fog: false,
    });
    cloudDome = new THREE.Mesh(new THREE.SphereGeometry(460, 48, 24), cloudMat);
    cloudDome.renderOrder = -0.5;
    cloudDome.frustumCulled = false;
    cloudDome.visible = true;
    scene.add(cloudDome);
  }
  // 昼間のみ表示。カメラに追従し、走行速度に応じて奥から手前へ流れる。
  function updateClouds(dt) {
    if (!cloudDome) return;
    cloudDome.visible = !nightMode;
    if (!cloudDome.visible) return;
    cloudTime += dt;
    cloudFlow += dt * (CLOUD_CFG.flowBase + player.vel.length() * CLOUD_CFG.flowSpeed);
    cloudDriftAcc += dt * CLOUD_CFG.drift;
    cloudUniforms.uTime.value = cloudTime;
    cloudUniforms.uFlow.value = cloudFlow;
    cloudUniforms.uDrift.value = cloudDriftAcc;
    cloudDome.position.copy(camera.position);
  }

  // ------------------------------------------------------------- night ----
  // N キーで夜間モードを切り替える。空・道路・オブジェクトを暗くし、
  // 全車(自車+CPU)のヘッドライトとテールランプが控えめに発光する
  // (車体のランプが光って見えるだけで、路面や周囲は照らさない)。
  let nightMode = false;
  const NIGHT_SKY = 0x050a12;
  const nightLampGroups = [];        // 各車のライト類(夜だけ表示)
  let playerHeadlight = null;        // 自車の前方約5mだけ照らす実光源
  let playerDayMesh = null;          // 昼の自車(toyota86.vox)
  let playerNightMesh = null;        // 夜の自車(toyota86n.vox: ライト拡大版)

  // 夜仕様の自車メッシュを作る。ライト部分の面だけを照明の影響を受けない
  // マテリアルへ分離し、暗闇で発光して見えるようにする。
  // isLampFace(r,g,b,x,y,z) で車種ごとのライト判定を渡す(色はリニア×陰影後)。
  function buildPlayerNightMesh(srcMesh, isLampFace, glowColor) {
    const geo = srcMesh.geometry;
    const colorAttr = geo.attributes.color;
    const posAttr = geo.attributes.position;
    const srcIdx = geo.index.array;
    const bodyIdx = [], glowIdx = [];
    for (let i = 0; i < srcIdx.length; i += 6) {     // 1面 = 頂点4つ/添字6つ
      const v = srcIdx[i];
      const r = colorAttr.getX(v), g = colorAttr.getY(v), b = colorAttr.getZ(v);
      // 位置は面の中心(4頂点の平均)で判定する。頂点1つだと隣接ブロックと
      // 共有される角の座標を拾ってしまい、境界の判定がぶれるため。
      let x = 0, y = 0, z = 0;
      for (const corner of [srcIdx[i], srcIdx[i + 1], srcIdx[i + 2], srcIdx[i + 5]]) {
        x += posAttr.getX(corner); y += posAttr.getY(corner); z += posAttr.getZ(corner);
      }
      x /= 4; y /= 4; z /= 4;
      const dst = isLampFace(r, g, b, x, y, z) ? glowIdx : bodyIdx;
      for (let j = 0; j < 6; j++) dst.push(srcIdx[i + j]);
    }
    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setAttribute('position', posAttr);
    bodyGeo.setAttribute('normal', geo.attributes.normal);
    bodyGeo.setAttribute('color', colorAttr);
    bodyGeo.setIndex(bodyIdx);
    bodyGeo.boundingSphere = geo.boundingSphere.clone();
    const body = new THREE.Mesh(bodyGeo, srcMesh.material);
    body.castShadow = true;
    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', posAttr);
    glowGeo.setIndex(glowIdx);
    glowGeo.boundingSphere = geo.boundingSphere.clone();
    const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: glowColor }));
    body.add(glow);
    document.body.dataset.nightCarGlowFaces = String(glowIdx.length / 6);
    return body;
  }

  // toyota86n: 黄色判定。純黄(255,255,51)と淡黄(255,255,153)のライトブロックを
  // Rに対する比で拾う(面の陰影は比を変えない)。白・オレンジ・グレー・窓は除外。
  const isToyotaLampFace = (r, g, b) =>
    r > 0.05 && g > r * 0.7 && g < r * 1.3 && b < r * 0.55;

  // volvo240: フロントの白いライトパネル(左右の四角)判定。ほぼ白の色かつ
  // パネルの座標窓(前方 z>1.8・高さ0.55〜0.9・横|x|<0.73)に限定する。
  // これで前バンパーの白ナンバープレート(y<0.5)と両端の角の小片(|x|>0.73)、
  // リアの白・グリル格子は光らない。
  const isVolvoLampFace = (r, g, b, x, y, z) =>
    z > 1.8 && y > 0.55 && y < 0.9 && Math.abs(x) < 0.73
    && Math.min(r, g, b) > 0.6
    && Math.abs(r - g) < 0.1 && Math.abs(g - b) < 0.1;
  const car2GlowMats = [];           // マップ内の純白マテリアル(夜は発光=窓明かり)

  function makeGlowTexture(r, g, b) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',1)');
    grad.addColorStop(0.4, 'rgba(' + r + ',' + g + ',' + b + ',0.45)');
    grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }
  const headGlowTex = makeGlowTexture(255, 244, 200);
  const tailGlowTex = makeGlowTexture(255, 40, 30);

  // テールランプの残像(夜間のみ): 尾灯の軌跡を細長い帯(線分)でつなぎ、
  // 短時間でフェードさせて連続した赤い光の線に見せる。
  // 点スプライトだと近距離で丸の連なりに見えるため、線分方式にしている。
  const TRAIL_MAX = 2048;
  const trailPool = [];
  let trailIdx = 0;
  {
    // 幅方向に透明→赤→透明のグラデーションで、柔らかい光の線にする
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 8;
    const ctx = cv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 32, 0);
    grad.addColorStop(0, 'rgba(255,40,30,0)');
    grad.addColorStop(0.5, 'rgba(255,40,30,1)');
    grad.addColorStop(1, 'rgba(255,40,30,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 8);
    const trailTex = new THREE.CanvasTexture(cv);
    const trailGeo = new THREE.PlaneGeometry(0.5, 1);   // 長さは scale.y で伸ばす
    for (let i = 0; i < TRAIL_MAX; i++) {
      const m = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
        map: trailTex, color: 0xff2018, blending: THREE.AdditiveBlending,
        transparent: true, opacity: 0, depthWrite: false,
      }));
      m.rotation.order = 'YXZ';
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.userData = { life: 0, max: 0.75 };
      scene.add(m);
      trailPool.push(m);
    }
  }
  function emitTailTrail(car, bike, maxLife) {
    if (!nightMode) return;
    const dx = car.pos.x - (car.trailX ?? 1e9);
    const dz = car.pos.z - (car.trailZ ?? 1e9);
    const moved2 = dx * dx + dz * dz;
    if (moved2 < 0.5 * 0.5) return;              // 0.5m 進むごとに1区間
    const teleported = moved2 > 36;              // ループ端ワープ等は線を繋がない
    car.trailX = car.pos.x;
    car.trailZ = car.pos.z;
    const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
    const sides = bike ? [0] : [-0.72, 0.72];
    if (!car.trailPrev) car.trailPrev = sides.map(() => null);
    sides.forEach((lx, i) => {
      const px = car.pos.x + ch * lx - sh * 2.28;   // 尾灯のワールド位置
      const pz = car.pos.z - sh * lx - ch * 2.28;
      const prev = car.trailPrev[i];
      car.trailPrev[i] = { x: px, z: pz };
      if (!prev || teleported) return;
      const sx = px - prev.x, sz = pz - prev.z;
      const len = Math.hypot(sx, sz);
      if (len < 0.05 || len > 6) return;
      const m = trailPool[trailIdx];
      trailIdx = (trailIdx + 1) % TRAIL_MAX;
      m.position.set((px + prev.x) / 2, car.pos.y + 0.68, (pz + prev.z) / 2);
      m.rotation.y = Math.atan2(sx, sz);
      m.scale.set(1, len + 0.1, 1);               // 少し重ねて継ぎ目を消す
      m.userData.life = 0;
      m.userData.max = maxLife ?? 0.75;
      m.material.opacity = 0.65;
      m.visible = true;
    });
  }
  function updateTailTrails(dt) {
    for (const s of trailPool) {
      if (!s.visible) continue;
      const d = s.userData;
      d.life += dt;
      if (d.life >= d.max) { s.visible = false; s.material.opacity = 0; continue; }
      s.material.opacity = 0.65 * (1 - d.life / d.max);
    }
  }

  // 車の前後に控えめなランプの光球を付ける(夜だけ表示)。
  function addCarLights(group, bike) {
    const lights = new THREE.Group();
    lights.visible = nightMode;
    lights.userData.headSprites = [];   // ヘッド側の光球(車種によっては非表示にする)
    const lamp = (tex, color, x, y, z, s, opacity) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity,
      }));
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(s);
      sprite.renderOrder = 3;
      lights.add(sprite);
      if (tex === headGlowTex) lights.userData.headSprites.push(sprite);
    };
    if (bike) {
      // ヘッドはランプ部分だけが光る小さな光球(車体前端より前に置き、
      // ボンネット側へ光がかからないようにする)
      lamp(headGlowTex, 0xffffff, 0, 0.72, 1.05, 0.3, 0.85);
      lamp(tailGlowTex, 0xff2018, 0, 0.6, -0.95, 0.48, 0.95);
    } else {
      for (const side of [-0.72, 0.72]) {
        lamp(headGlowTex, 0xffffff, side, 0.6, 2.45, 0.32, 0.85);
        lamp(tailGlowTex, 0xff2018, side, 0.68, -2.28, 0.6, 0.95);
      }
    }
    group.add(lights);
    group.userData.nightLights = lights;
    nightLampGroups.push(lights);
  }

  function applyNight() {
    const skyColor = nightMode ? NIGHT_SKY : SKY;
    scene.background.set(skyColor);
    const fog = scene.fog || savedFog;   // 地図表示中(フォグ退避中)でも色を更新
    if (fog) fog.color.set(skyColor);
    hemi.intensity = nightMode ? 0.13 : 0.95;
    hemi.color.set(nightMode ? 0x707e9e : 0xdff3ff);
    hemi.groundColor.set(nightMode ? 0x14161c : 0x5a7a45);
    sun.intensity = nightMode ? 0.04 : 1.15;
    sun.color.set(nightMode ? 0xbfd0ff : 0xfff3d8);
    for (const lights of nightLampGroups) lights.visible = nightMode;
    if (playerHeadlight) playerHeadlight.visible = nightMode;
    // 街灯の先端は夜になると白く発光する。
    if (streetLampHeads) {
      streetLampHeads.material = nightMode ? streetLampHeadNightMat : streetLampHeadDayMat;
    }
    // 夜間は自車を toyota86n.vox(ライト拡大版)へ切り替える。
    if (playerDayMesh && playerNightMesh) {
      playerDayMesh.visible = !nightMode;
      playerNightMesh.visible = nightMode;
    }
    // ビルなどの純白マテリアルは夜になると発光する(窓明かりの表現)。
    for (const mat of car2GlowMats) {
      if (mat.emissive) mat.emissive.set(nightMode ? 0xfff6d8 : 0x000000);
    }
    // 地表(グレー路面)だけは夜間も昼の1/3程度の明るさを保つ。
    // 路面マテリアルへ自己発光を足す方式なので、壁や建物は暗いまま。
    for (const roadMesh of car2RoadMeshes) {
      for (const mat of (Array.isArray(roadMesh.material) ? roadMesh.material : [roadMesh.material])) {
        if (!mat || !mat.emissive) continue;
        if (nightMode) mat.emissive.copy(mat.color).multiplyScalar(0.33);
        else mat.emissive.set(0x000000);
      }
    }
    document.body.dataset.nightMode = String(nightMode);
  }

  // 分割数を持たせ、あとでドリフトコースの丘だけ頂点を持ち上げる(街の坂道)。
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 1400, 240, 140),
    new THREE.MeshLambertMaterial({ map: makeGroundTexture() })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.x = 250;           // covers the city and the forest suburb
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------------------------------------------------------------- city ---
  // Procedural street grid: vertical/horizontal roads (occasionally one
  // diagonal), Japanese-style white lines, blocks with 2 or 4 buildings.
  //
  // Two road widths:
  //   4-lane (two each way, w=14): solid center line, dashed lane dividers,
  //                                solid edge lines
  //   2-lane (one each way,  w=8): dashed center line, solid edge lines
  const ROAD_LEN = 660;               // roads span the whole map
  const CITY_EDGE = ROAD_LEN / 2;      // outer ring joins every formerly dead-ended road
  const LANE_OFF = 1.75;              // AI keeps to the left lane (Japan)

  // のちに vox の建物を使う場合はここにファイルを追加(モデルの前面 = +Z)。
  // 空の間はプレースホルダーの箱を配置する。
  const BUILDING_VOX = [];

  const obstacles = [];               // {x,z,r} buildings + trees, for collision

  // Batches all flat rectangles of one color into a single mesh.
  function QuadBatch(color) {
    this.pos = [];
    this.idx = [];
    this.color = color;
  }
  QuadBatch.prototype.add = function (cx, cz, w, l, yaw, y) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const base = this.pos.length / 3;
    for (const [x, z] of [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]) {
      this.pos.push(cx + x * c + z * s, y, cz - x * s + z * c);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  // 起伏に沿った矩形: 各コーナーの高さを hFn(worldX, worldZ)+lift で決める。
  QuadBatch.prototype.addSloped = function (cx, cz, w, l, yaw, hFn, lift) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const base = this.pos.length / 3;
    for (const [x, z] of [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]]) {
      const wx = cx + x * c + z * s, wz = cz - x * s + z * c;
      this.pos.push(wx, hFn(wx, wz) + lift, wz);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  };
  QuadBatch.prototype.build = function (receiveShadow) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: this.color }));
    mesh.receiveShadow = !!receiveShadow;
    return mesh;
  };

  const cityRnd = mulberry32(424242);
  function genRoadLine() {
    const arr = [];
    let p = -250 + cityRnd() * 30;
    while (p < 260) {
      const four = cityRnd() < 0.4;
      arr.push({ pos: p, w: four ? 14 : 8, four });
      p += 95 + cityRnd() * 55;
    }
    if (!arr.some((r) => r.four)) { arr[1].four = true; arr[1].w = 14; }
    return arr;
  }
  const V_ROADS = genRoadLine();      // roads running along z, at x = pos
  const H_ROADS = genRoadLine();      // roads running along x, at z = pos
  // たまに斜めの道路(このシードでは1本、45°)
  const DIAGS = [];
  if (cityRnd() < 0.8) {
    DIAGS.push({ cx: -40 + cityRnd() * 80, cz: -40 + cityRnd() * 80, yaw: Math.PI / 4, w: 8, four: false });
  }

  // Clip diagonal roads at the outer ring so their two ends also join the circuit.
  for (const d of DIAGS) {
    const dirx = Math.sin(d.yaw), dirz = Math.cos(d.yaw);
    const hits = [];
    for (const x of [-CITY_EDGE, CITY_EDGE]) {
      const t = (x - d.cx) / dirx, z = d.cz + t * dirz;
      if (Math.abs(z) <= CITY_EDGE + 0.01) hits.push(t);
    }
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      const t = (z - d.cz) / dirz, x = d.cx + t * dirx;
      if (Math.abs(x) <= CITY_EDGE + 0.01) hits.push(t);
    }
    hits.sort((a, b) => a - b);
    d.t0 = hits[0];
    d.t1 = hits[hits.length - 1];
  }

  const asphalt = new QuadBatch(0x3d3d42);
  const paint = new QuadBatch(0xe8e8e2);
  const patches = new QuadBatch(0x3d3d42);
  const driftShoulder = new QuadBatch(0x34363a);
  const PERIMETER_ROAD = { w: 8, four: false };

  // Lane markings for one road, in the road's local frame (length along z).
  function addMarkings(cx, cz, yaw, road, roadLength = ROAD_LEN) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const at = (off, w, l, zc) => paint.add(cx + off * c + zc * s, cz - off * s + zc * c, w, l, yaw, 0.06);
    const edge = road.four ? 6.2 : 3.5;
    at(edge, 0.15, roadLength, 0);      // 外側線(実線)
    at(-edge, 0.15, roadLength, 0);
    if (road.four) {
      at(0, 0.15, roadLength, 0);       // 中央線(実線)
      for (let z = -roadLength / 2; z < roadLength / 2; z += 8) {  // 車線境界線(破線)
        at(3.1, 0.15, 4, z + 2);
        at(-3.1, 0.15, 4, z + 2);
      }
    } else {
      for (let z = -roadLength / 2; z < roadLength / 2; z += 10) { // 中央線(破線)
        at(0, 0.15, 5, z + 2.5);
      }
    }
  }

  for (const r of V_ROADS) {
    asphalt.add(r.pos, 0, r.w, ROAD_LEN, 0, 0.03);
    addMarkings(r.pos, 0, 0, r);
  }
  for (const r of H_ROADS) {
    asphalt.add(0, r.pos, r.w, ROAD_LEN, Math.PI / 2, 0.03);
    addMarkings(0, r.pos, Math.PI / 2, r);
  }
  for (const d of DIAGS) {
    const midT = (d.t0 + d.t1) / 2, len = d.t1 - d.t0;
    const mx = d.cx + Math.sin(d.yaw) * midT;
    const mz = d.cz + Math.cos(d.yaw) * midT;
    asphalt.add(mx, mz, d.w, len, d.yaw, 0.03);
    addMarkings(mx, mz, d.yaw, d, len);
  }

  // Continuous outer ring: every grid-road endpoint now meets this circuit.
  for (const z of [-CITY_EDGE, CITY_EDGE]) {
    asphalt.add(0, z, PERIMETER_ROAD.w, ROAD_LEN + PERIMETER_ROAD.w, Math.PI / 2, 0.03);
    addMarkings(0, z, Math.PI / 2, PERIMETER_ROAD, ROAD_LEN + PERIMETER_ROAD.w);
  }
  for (const x of [-CITY_EDGE, CITY_EDGE]) {
    asphalt.add(x, 0, PERIMETER_ROAD.w, ROAD_LEN + PERIMETER_ROAD.w, 0, 0.03);
    addMarkings(x, 0, 0, PERIMETER_ROAD, ROAD_LEN + PERIMETER_ROAD.w);
  }

  // Plain asphalt patches hide the markings inside every intersection.
  const signals = [];                 // signalized grid intersections
  for (const v of V_ROADS) {
    for (const h of H_ROADS) {
      patches.add(v.pos, h.pos, v.w, h.w, 0, 0.09);
      signals.push({ x: v.pos, z: h.pos, vw: v.w, hw: h.w });
    }
  }
  // Join both ends of every vertical/horizontal road to the outer ring.
  for (const v of V_ROADS) {
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(v.pos, z, v.w, PERIMETER_ROAD.w, 0, 0.09);
      signals.push({ x: v.pos, z, vw: v.w, hw: PERIMETER_ROAD.w });
    }
  }
  for (const h of H_ROADS) {
    for (const x of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(x, h.pos, PERIMETER_ROAD.w, h.w, 0, 0.09);
      signals.push({ x, z: h.pos, vw: PERIMETER_ROAD.w, hw: h.w });
    }
  }
  for (const x of [-CITY_EDGE, CITY_EDGE]) {
    for (const z of [-CITY_EDGE, CITY_EDGE]) {
      patches.add(x, z, 10, 10, 0, 0.095);
      signals.push({ x, z, vw: PERIMETER_ROAD.w, hw: PERIMETER_ROAD.w });
    }
  }
  for (const d of DIAGS) {
    const dirx = Math.sin(d.yaw), dirz = Math.cos(d.yaw);
    for (const v of V_ROADS) {
      const t = (v.pos - d.cx) / dirx;
      const z = d.cz + t * dirz;
      if (Math.abs(z) < 320) patches.add(v.pos, z, d.w, v.w / Math.abs(dirz) + d.w, d.yaw, 0.095);
    }
    for (const h of H_ROADS) {
      const t = (h.pos - d.cz) / dirz;
      const x = d.cx + t * dirx;
      if (Math.abs(x) < 320) patches.add(x, h.pos, d.w, h.w / Math.abs(dirx) + d.w, d.yaw, 0.095);
    }
    for (const t of [d.t0, d.t1]) {
      patches.add(d.cx + dirx * t, d.cz + dirz * t, 12, 12, d.yaw, 0.095);
    }
  }

  // ----- forest course (suburb, east of the city) -----
  // A meandering 2-lane loop through dense woods, reached by a short
  // connector from the east end of a city road.
  const forestLoop = [];              // closed polyline
  const FOREST_C = { x: 480, z: 0 };
  const FOREST_N = 220;
  for (let i = 0; i < FOREST_N; i++) {
    const th = (i / FOREST_N) * Math.PI * 2;
    // Multiple harmonics create frequent linked bends without self-intersection.
    const r = 150
      + 34 * Math.sin(3 * th)
      + 24 * Math.sin(7 * th + 1.3)
      + 14 * Math.sin(13 * th + 0.45);
    forestLoop.push({ x: FOREST_C.x + Math.cos(th) * r, z: FOREST_C.z + Math.sin(th) * r });
  }
  const connector = [];               // straight link: city edge -> loop start
  {
    const a = { x: 322, z: H_ROADS[Math.floor(H_ROADS.length / 2)].pos };
    const b = forestLoop[Math.floor(FOREST_N / 2)];   // west point of the loop
    for (let i = 0; i <= 8; i++) connector.push({ x: a.x + (b.x - a.x) * i / 8, z: a.z + (b.z - a.z) * i / 8 });
  }

  function paveRoute(pts, closed) {
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const mx = (p.x + q.x) / 2, mz = (p.z + q.z) / 2;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      asphalt.add(mx, mz, 8, len + 3, yaw, 0.03);
      paint.add(mx + 3.5 * c, mz - 3.5 * s, 0.15, len + 1, yaw, 0.06);   // 外側線
      paint.add(mx - 3.5 * c, mz + 3.5 * s, 0.15, len + 1, yaw, 0.06);
      if (i % 2 === 0) paint.add(mx, mz, 0.15, len, yaw, 0.06);          // 中央線(破線)
    }
  }
  paveRoute(forestLoop, true);
  paveRoute(connector, false);
  patches.add(connector[0].x, connector[0].z, 10, 10, 0, 0.095);          // junction mouths
  patches.add(connector[8].x, connector[8].z, 11, 11, Math.PI / 4, 0.095);

  // ----- drift course (街の南): 短い直線とヘアピンが連続する峠コース -----
  // 左右2ブロックの密な蛇行レイアウト。約80mごとに180°ターンが来る。
  const DRIFT_C = { x: -30, z: 460 };
  const DRIFT_TOP_Z = 372;
  const driftConnectorCandidates = V_ROADS.map((r) => r.pos)
    .filter((px) => px >= DRIFT_C.x - 150 && px <= DRIFT_C.x + 120);
  const DRIFT_CONNECTOR_X = driftConnectorCandidates.length
    ? driftConnectorCandidates.reduce((a, b) => (Math.abs(b - DRIFT_C.x) < Math.abs(a - DRIFT_C.x) ? b : a))
    : DRIFT_C.x;

  function driftLoop() {
    const pts = [];
    const R = 12, rows = 8, gap = 2 * R;
    const zTop = DRIFT_TOP_Z, zBottom = zTop + (rows - 1) * gap;
    const leftOuter = -150, leftInner = -70;
    const rightInner = 10, rightOuter = 90;
    const arc = (ccx, ccz, a0, a1, steps = 8) => {
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (a1 - a0) * (i / steps);
        pts.push({ x: ccx + Math.cos(a) * R, z: ccz + Math.sin(a) * R });
      }
    };

    // 左ブロック: 内側上端から連続Uターンで登る。
    pts.push({ x: leftInner, z: zTop });
    for (let r = 0; r < rows; r++) {
      const z = zTop + r * gap;
      const towardOuter = r % 2 === 0;
      pts.push({ x: towardOuter ? leftOuter : leftInner, z });
      if (r < rows - 1) {
        if (towardOuter) arc(leftOuter, z + R, -Math.PI / 2, -Math.PI * 3 / 2);
        else arc(leftInner, z + R, -Math.PI / 2, Math.PI / 2);
      }
    }

    // 頂上の短い連絡区間で右ブロックへ渡る。
    pts.push({ x: rightInner, z: zBottom });

    // 右ブロック: 頂上から連続Uターンで下る。
    for (let r = 0; r < rows; r++) {
      const z = zBottom - r * gap;
      const towardOuter = r % 2 === 0;
      pts.push({ x: towardOuter ? rightOuter : rightInner, z });
      if (r < rows - 1) {
        if (towardOuter) arc(rightOuter, z - R, Math.PI / 2, -Math.PI / 2);
        else arc(rightInner, z - R, Math.PI / 2, Math.PI * 3 / 2);
      }
    }
    return pts;
  }
  const driftLoopPts = driftLoop();

  // 前半は標高24mまで登り、後半は同じ距離を下る峠型プロフィール。
  const DRIFT_PEAK_HEIGHT = 24;
  const driftProfile = (() => {
    const cumulative = [0];
    let total = 0;
    for (let i = 0; i < driftLoopPts.length; i++) {
      const p = driftLoopPts[i], q = driftLoopPts[(i + 1) % driftLoopPts.length];
      total += Math.hypot(q.x - p.x, q.z - p.z);
      cumulative.push(total);
    }
    return { cumulative, total };
  })();

  // 道路に近い区間の標高を合成して、道路と周囲の地表を同じ峠形状にする。
  // sample を渡した場合は、地表の路盤処理用に道路までの距離も返す。
  function courseHeightAt(x, z, sample) {
    if (sample) sample.roadDistance = Infinity;
    if (z <= 350 || z >= 620 || x <= -280 || x >= 215) return 0;
    let closestD2 = Infinity, weightedHeight = 0, weightSum = 0;
    for (let i = 0; i < driftLoopPts.length; i++) {
      const p = driftLoopPts[i], q = driftLoopPts[(i + 1) % driftLoopPts.length];
      const dx = q.x - p.x, dz = q.z - p.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? clamp(((x - p.x) * dx + (z - p.z) * dz) / len2, 0, 1) : 0;
      const px = p.x + dx * t, pz = p.z + dz * t;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      const progress = (driftProfile.cumulative[i] + Math.sqrt(len2) * t) / driftProfile.total;
      const height = DRIFT_PEAK_HEIGHT * Math.sin(Math.PI * progress);
      const weight = 1 / Math.pow(d2 + 9, 2);
      weightedHeight += height * weight;
      weightSum += weight;
      if (d2 < closestD2) closestD2 = d2;
    }
    if (sample) {
      const connectorZ = clamp(z, 330, DRIFT_TOP_Z);
      const connectorD2 = (x - DRIFT_CONNECTOR_X) ** 2 + (z - connectorZ) ** 2;
      sample.roadDistance = Math.sqrt(Math.min(closestD2, connectorD2));
    }
    const distance = Math.sqrt(closestD2);
    const edgeT = clamp((distance - 10) / 100, 0, 1);
    const terrainFade = 1 - edgeT * edgeT * (3 - 2 * edgeT);
    const northT = clamp((z - 350) / (DRIFT_TOP_Z - 350), 0, 1);
    const northGate = northT * northT * (3 - 2 * northT);
    const southT = clamp((620 - z) / 80, 0, 1);
    const southGate = southT * southT * (3 - 2 * southT);
    const xGate = clamp(Math.min((x + 280) / 55, (215 - x) / 55), 0, 1);
    return (weightedHeight / weightSum) * terrainFade * northGate * southGate * xGate;
  }

  // 峠の起伏に沿ってコースを舗装する。
  function paveCourse(pts) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const yaw = Math.atan2(dx, dz), c = Math.cos(yaw), s = Math.sin(yaw);
      // 長い平面を避け、曲面状の地表へ追従するよう最大4mに細分化する。
      const steps = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k < steps; k++) {
        const t0 = k / steps, t1 = (k + 1) / steps;
        const ax = p.x + dx * t0, az = p.z + dz * t0;
        const bx = p.x + dx * t1, bz = p.z + dz * t1;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, sl = len / steps;
        driftShoulder.addSloped(mx, mz, 11, sl + 0.8, yaw, courseHeightAt, 0.0);
        asphalt.addSloped(mx, mz, 9, sl + 0.6, yaw, courseHeightAt, 0.06);
        paint.addSloped(mx + 4.3 * c, mz - 4.3 * s, 0.16, sl + 0.4, yaw, courseHeightAt, 0.09);
        paint.addSloped(mx - 4.3 * c, mz + 4.3 * s, 0.16, sl + 0.4, yaw, courseHeightAt, 0.09);
        if (k % 2 === 0) paint.addSloped(mx, mz, 0.16, sl * 0.6, yaw, courseHeightAt, 0.09);  // 中央破線
      }
    }
  }

  if (!MAP_GLTF) {
    BOUND_X_MIN = -350;              // 西側の外周道路まで走行可能にする
    BOUND_Z = 620;                   // 南のドリフトコースまで走れるように拡張
    paveCourse(driftLoopPts);
    // グリッド道路とドリフトコースをつなぐ短い連絡路
    {
      const z0 = 330, z1 = DRIFT_TOP_Z, steps = 7;
      for (let k = 0; k < steps; k++) {
        const mz = z0 + (z1 - z0) * (k + 0.5) / steps;
        driftShoulder.addSloped(DRIFT_CONNECTOR_X, mz, 11, (z1 - z0) / steps + 0.8, 0, courseHeightAt, 0.0);
        asphalt.addSloped(DRIFT_CONNECTOR_X, mz, 9, (z1 - z0) / steps + 0.4, 0, courseHeightAt, 0.06);
      }
      patches.addSloped(DRIFT_CONNECTOR_X, z1, 12, 12, 0, courseHeightAt, 0.07);
    }
    scene.add(driftShoulder.build(true));
    scene.add(asphalt.build(true));
    scene.add(paint.build(false));
    scene.add(patches.build(true));

    // 地面を峠へ持ち上げ、道路付近は路盤として少し掘り下げる。
    // 粗い地表三角形が道路面を横切って突き抜けるのを防ぐ。
    const gpos = ground.geometry.attributes.position;
    const terrainSample = { roadDistance: Infinity };
    for (let i = 0; i < gpos.count; i++) {
      const wx = gpos.getX(i) + ground.position.x;   // ローカル->ワールド X
      const wz = -gpos.getY(i);                       // ローカル Y -> ワールド Z
      const height = courseHeightAt(wx, wz, terrainSample);
      const cutT = 1 - clamp((terrainSample.roadDistance - 12) / 12, 0, 1);
      const roadbedCut = 0.55 * cutT * cutT * (3 - 2 * cutT);
      gpos.setZ(i, height - roadbedCut);               // ローカル Z -> ワールド Y
    }
    gpos.needsUpdate = true;
    ground.geometry.computeVertexNormals();
  } else {
    signals.length = 0;              // カスタムマップに自動生成の信号は無い
    ground.position.y = -0.08;       // マップ自身の地面の下に敷く保険
    if (CAR2_MODE) ground.visible = false;
  }

  // ----- traffic signals -----
  // Two-phase controller shared by every grid intersection:
  //   NS (vertical roads): green 8 s -> yellow 3 s -> red 11 s
  //   EW (horizontal roads): the opposite — red while NS is green/yellow.
  const SIG_CYCLE = 22;
  function signalState(axis, timeSec) {
    const local = axis === 0 ? timeSec % SIG_CYCLE : (timeSec + 11) % SIG_CYCLE;
    if (local < 8) return 'g';
    if (local < 11) return 'y';
    return 'r';
  }

  const LAMP_BRIGHT = {
    g: new THREE.MeshBasicMaterial({ color: 0x00c878 }),
    y: new THREE.MeshBasicMaterial({ color: 0xffc400 }),
    r: new THREE.MeshBasicMaterial({ color: 0xff4438 }),
  };
  const LAMP_DIM = {};
  for (const k of ['g', 'y', 'r']) {
    LAMP_DIM[k] = new THREE.MeshBasicMaterial({
      color: new THREE.Color(LAMP_BRIGHT[k].color).multiplyScalar(0.13),
    });
  }
  const lampMeshes = [];              // {mesh, color, axis}
  {
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.09, 5.6, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555a5e });
    const boxGeo = new THREE.BoxGeometry(2.0, 0.66, 0.24);
    const boxMat = new THREE.MeshLambertMaterial({ color: 0x2c2f33 });
    const lampGeo = new THREE.CircleGeometry(0.22, 12);
    for (const s of signals) {
      const g = new THREE.Group();
      g.position.set(s.x + s.vw / 2 + 1.2, 0, s.z + s.hw / 2 + 1.2);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.y = 2.8;
      g.add(pole);
      // one horizontal 青黄赤 box per axis, lamps on both faces
      [{ axis: 0, y: 5.2, yaw: 0 }, { axis: 1, y: 4.3, yaw: Math.PI / 2 }].forEach((cfg) => {
        const holder = new THREE.Group();
        holder.position.y = cfg.y;
        holder.rotation.y = cfg.yaw;
        holder.add(new THREE.Mesh(boxGeo, boxMat));
        [['g', -0.63], ['y', 0], ['r', 0.63]].forEach(([color, lx]) => {
          for (const face of [1, -1]) {
            const lamp = new THREE.Mesh(lampGeo, LAMP_DIM[color]);
            lamp.position.set(lx, 0, 0.13 * face);
            if (face < 0) lamp.rotation.y = Math.PI;
            holder.add(lamp);
            lampMeshes.push({ mesh: lamp, color, axis: cfg.axis });
          }
        });
        g.add(holder);
      });
      scene.add(g);
    }
  }

  const sigWinEl = document.getElementById('signal');
  const sigLampEls = { g: document.getElementById('sig-g'), y: document.getElementById('sig-y'), r: document.getElementById('sig-r') };
  let lastSigStates = ['', ''];

  function updateSignals(timeSec) {
    const states = [signalState(0, timeSec), signalState(1, timeSec)];
    if (states[0] !== lastSigStates[0] || states[1] !== lastSigStates[1]) {
      lastSigStates = states;
      for (const l of lampMeshes) {
        l.mesh.material = states[l.axis] === l.color ? LAMP_BRIGHT[l.color] : LAMP_DIM[l.color];
      }
    }

    // HUD window: show the player's own signal when nearing an intersection
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    let best = null;
    for (const s of signals) {
      const dx = s.x - player.pos.x, dz = s.z - player.pos.z;
      const ahead = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 10 || ahead < -6 || ahead > 55) continue;
      if (!best || ahead < best.ahead) best = { ahead };
    }
    if (best) {
      const axis = Math.abs(fx) > Math.abs(fz) ? 1 : 0;
      const st = states[axis];
      sigWinEl.style.display = 'flex';
      for (const k of ['g', 'y', 'r']) sigLampEls[k].classList.toggle('on', st === k);
    } else {
      sigWinEl.style.display = 'none';
    }
    return states;
  }

  // Distance to the stop line of a red/yellow signal ahead of an AI car,
  // or Infinity when the way is clear.
  function aiStopDistance(ai, states) {
    const fx = Math.sin(ai.heading), fz = Math.cos(ai.heading);
    const axis = Math.abs(fx) > Math.abs(fz) ? 1 : 0;
    if (states[axis] === 'g') return Infinity;
    let stop = Infinity;
    for (const s of signals) {
      const dx = s.x - ai.pos.x, dz = s.z - ai.pos.z;
      const ahead = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > 8 || ahead < 0 || ahead > 32) continue;
      const crossHalf = axis === 0 ? s.hw / 2 : s.vw / 2;
      const line = ahead - crossHalf - 3;
      if (line < -1) continue;                        // already in the box: clear it
      if (states[axis] === 'y' && line < 3) continue; // yellow, too late to stop
      stop = Math.min(stop, line);
    }
    return stop;
  }

  function distToDiag(x, z, d) {
    return Math.abs((x - d.cx) * Math.cos(d.yaw) - (z - d.cz) * Math.sin(d.yaw));
  }
  function onAnyRoad(x, z, margin) {
    for (const r of V_ROADS) if (Math.abs(x - r.pos) < r.w / 2 + margin && Math.abs(z) < ROAD_LEN / 2) return true;
    for (const r of H_ROADS) if (Math.abs(z - r.pos) < r.w / 2 + margin && Math.abs(x) < ROAD_LEN / 2) return true;
    if (Math.abs(Math.abs(x) - CITY_EDGE) < PERIMETER_ROAD.w / 2 + margin && Math.abs(z) <= CITY_EDGE + margin) return true;
    if (Math.abs(Math.abs(z) - CITY_EDGE) < PERIMETER_ROAD.w / 2 + margin && Math.abs(x) <= CITY_EDGE + margin) return true;
    for (const d of DIAGS) {
      const t = (x - d.cx) * Math.sin(d.yaw) + (z - d.cz) * Math.cos(d.yaw);
      if (t >= d.t0 - margin && t <= d.t1 + margin && distToDiag(x, z, d) < d.w / 2 + margin) return true;
    }
    const rr = (4 + margin + 3) * (4 + margin + 3);   // route samples are ~5 m apart
    for (const p of forestLoop) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    for (const p of connector) if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < rr) return true;
    return false;
  }

  // ----- dense blocks: roughly 9–25 buildings each, fronts facing roads -----
  const BUILDING_COLORS = [0xb8b0a4, 0x9aa4ad, 0xc4b49a, 0xa8b89e, 0xbfa3a0, 0x93a0b5];
  function placeBuildings(voxMeshes) {
    // Placeholder boxes are instanced by color so hundreds of buildings stay cheap.
    const boxLists = BUILDING_COLORS.map(() => []);
    for (let i = 0; i + 1 < V_ROADS.length; i++) {
      for (let j = 0; j + 1 < H_ROADS.length; j++) {
        const x1 = V_ROADS[i].pos + V_ROADS[i].w / 2 + 2;
        const x2 = V_ROADS[i + 1].pos - V_ROADS[i + 1].w / 2 - 2;
        const z1 = H_ROADS[j].pos + H_ROADS[j].w / 2 + 2;
        const z2 = H_ROADS[j + 1].pos - H_ROADS[j + 1].w / 2 - 2;
        const bw = x2 - x1, bd = z2 - z1;
        if (bw < 24 || bd < 24) continue;

        const cols = clamp(Math.floor(bw / 22), 3, 5);
        const rows = clamp(Math.floor(bd / 22), 3, 5);
        const cellW = bw / cols, cellD = bd / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            if (cityRnd() < 0.08) continue;           // occasional courtyard / parking lot
            const w = cellW * (0.56 + cityRnd() * 0.18);
            const d2 = cellD * (0.56 + cityRnd() * 0.18);
            const h = 7 + cityRnd() * 25;
            const jx = (cityRnd() * 2 - 1) * Math.max(0, (cellW - w) * 0.16);
            const jz = (cityRnd() * 2 - 1) * Math.max(0, (cellD - d2) * 0.16);
            const x = x1 + cellW * (col + 0.5) + jx;
            const z = z1 + cellD * (row + 0.5) + jz;

            // Point each front (+Z) toward the nearest surrounding road.
            const edgeDistances = [z2 - z, z - z1, x2 - x, x - x1];
            let side = 0;
            for (let k = 1; k < 4; k++) if (edgeDistances[k] < edgeDistances[side]) side = k;
            const yaw = [0, Math.PI, Math.PI / 2, -Math.PI / 2][side];

            let bad = false;
            for (const dg of DIAGS) {
              if (distToDiag(x, z, dg) < dg.w / 2 + Math.hypot(w, d2) / 2) bad = true;
            }
            if (bad) continue;

            // vox の建物があっても箱と混ぜて配置する
            if (voxMeshes && voxMeshes.length && cityRnd() < 0.6) {
              const mesh = voxMeshes[Math.floor(cityRnd() * voxMeshes.length)].clone();
              const holder = new THREE.Group();
              holder.add(mesh);
              holder.position.set(x, 0, z);
              holder.rotation.y = yaw;
              scene.add(holder);
            } else {
              const colorIndex = Math.floor(cityRnd() * BUILDING_COLORS.length);
              boxLists[colorIndex].push({ x, z, w, h, d: d2, yaw });
            }
            obstacles.push({ x, z, r: (w + d2) / 4 });
          }
        }
      }
    }

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    boxLists.forEach((list, colorIndex) => {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(
        unitBox,
        new THREE.MeshLambertMaterial({ color: BUILDING_COLORS[colorIndex] }),
        list.length
      );
      list.forEach((b, index) => {
        rotation.setFromAxisAngle(up, b.yaw);
        matrix.compose(
          new THREE.Vector3(b.x, b.h / 2, b.z),
          rotation,
          new THREE.Vector3(b.w, b.h, b.d)
        );
        inst.setMatrixAt(index, matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      scene.add(inst);
    });
  }

  // --------------------------------------------------------------- HUD ----
  const speedEl = document.getElementById('speed');
  const rpmEl = document.getElementById('rpm-fill');
  const gearEls = Array.from(document.querySelectorAll('#gears span'));
  const driftEl = document.getElementById('drift');

  // ------------------------------------------------------- tyre effects ---
  const SKID_MAX = 460;
  const SMOKE_MAX = 150;   // CPU車のドリフトスモークとプールを共用する
  const DUST_MAX = 150;    // 山岳ラリー専用の土埃(茶色)
  const skidPool = [];
  const smokePool = [];
  const dustPool = [];
  let skidIdx = 0, smokeIdx = 0, smokeTimer = 0;
  let dustIdx = 0, dustTimer = 0;
  const lastSkid = { x: 1e9, z: 1e9 };

  function makeSmokeTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(235,235,230,0.85)');
    g.addColorStop(1, 'rgba(235,235,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  // 山岳ラリー用の土埃テクスチャ(茶色)。タイヤスモークと同じ形状だが色だけ変える。
  function makeDustTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(150,112,72,0.8)');
    g.addColorStop(1, 'rgba(150,112,72,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  }

  function initFx() {
    const skidGeo = new THREE.PlaneGeometry(0.3, 0.68);
    for (let i = 0; i < SKID_MAX; i++) {
      const m = new THREE.Mesh(skidGeo, new THREE.MeshBasicMaterial({ color: 0x181410, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.order = 'YXZ';
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      scene.add(m);
      skidPool.push(m);
    }
    const tex = makeSmokeTexture();
    for (let i = 0; i < SMOKE_MAX; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
      s.visible = false;
      s.userData = { life: 0, max: 1, vx: 0, vy: 0, vz: 0 };
      scene.add(s);
      smokePool.push(s);
    }
    if (CAR2_MOUNTAIN_MODE) {
      const dustTex = makeDustTexture();
      for (let i = 0; i < DUST_MAX; i++) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, opacity: 0, depthWrite: false }));
        s.visible = false;
        s.userData = { life: 0, max: 1, vx: 0, vy: 0, vz: 0 };
        scene.add(s);
        dustPool.push(s);
      }
    }
  }

  function emitTyreFx(fx, fz, sx, sz, dt) {
    const rx = player.pos.x - fx * 1.5;   // rear axle
    const rz = player.pos.z - fz * 1.5;

    // skid marks: one pair every ~0.5 m of travel
    const dsx = rx - lastSkid.x, dsz = rz - lastSkid.z;
    if (dsx * dsx + dsz * dsz > 0.5 * 0.5) {
      lastSkid.x = rx; lastSkid.z = rz;
      for (const side of [-0.75, 0.75]) {
        const m = skidPool[skidIdx];
        skidIdx = (skidIdx + 1) % SKID_MAX;
        m.position.set(rx + sx * side, player.pos.y + 0.11 + (skidIdx % 8) * 0.0012, rz + sz * side);
        m.rotation.y = player.heading;
        m.material.opacity = 0.5;
        m.visible = true;
      }
    }

    // smoke: a puff every ~35 ms
    smokeTimer += dt;
    while (smokeTimer > 0.035) {
      smokeTimer -= 0.035;
      const s = smokePool[smokeIdx];
      smokeIdx = (smokeIdx + 1) % SMOKE_MAX;
      const side = Math.random() < 0.5 ? -0.75 : 0.75;
      s.position.set(rx + sx * side + (Math.random() - 0.5) * 0.3, player.pos.y + 0.25, rz + sz * side + (Math.random() - 0.5) * 0.3);
      s.scale.setScalar(0.6);
      const d = s.userData;
      d.life = 0; d.max = 0.7 + Math.random() * 0.4;
      d.vx = (Math.random() - 0.5) * 1.2; d.vy = 1.0 + Math.random(); d.vz = (Math.random() - 0.5) * 1.2;
      s.visible = true;
    }
  }

  // 山岳ラリー専用の土埃: 舗装路(FF4863A5)の上では控えめに、それ以外の地面では
  // 頻繁に噴き上げることで「道路上は少し・それ以外はたくさん」を表現する。
  function emitMountainDust(fx, fz, sx, sz, dt) {
    if (!dustPool.length) return;
    const rx = player.pos.x - fx * 1.5;
    const rz = player.pos.z - fz * 1.5;
    const onRoad = mountainSurfaceIsRoad(player.pos.x, player.pos.z);
    dustTimer += dt;
    const interval = onRoad ? 0.16 : 0.03;   // 数値が大きいほど噴出は間引かれる=少ない
    while (dustTimer > interval) {
      dustTimer -= interval;
      const s = dustPool[dustIdx];
      dustIdx = (dustIdx + 1) % DUST_MAX;
      const side = Math.random() < 0.5 ? -0.75 : 0.75;
      s.position.set(rx + sx * side + (Math.random() - 0.5) * 0.4, player.pos.y + 0.2, rz + sz * side + (Math.random() - 0.5) * 0.4);
      s.scale.setScalar(0.7);
      const d = s.userData;
      d.life = 0; d.max = 0.9 + Math.random() * 0.5;
      d.vx = (Math.random() - 0.5) * 1.0; d.vy = 0.6 + Math.random() * 0.6; d.vz = (Math.random() - 0.5) * 1.0;
      s.visible = true;
    }
  }

  function updateFx(dt) {
    for (const m of skidPool) {
      if (!m.visible) continue;
      m.material.opacity -= dt * 0.075;
      if (m.material.opacity <= 0) m.visible = false;
    }
    for (const s of smokePool) {
      if (!s.visible) continue;
      const d = s.userData;
      d.life += dt;
      if (d.life >= d.max) { s.visible = false; continue; }
      s.position.x += d.vx * dt;
      s.position.y += d.vy * dt;
      s.position.z += d.vz * dt;
      s.scale.addScalar(dt * 1.7);
      s.material.opacity = 0.4 * (1 - d.life / d.max);
    }
    for (const s of dustPool) {
      if (!s.visible) continue;
      const d = s.userData;
      d.life += dt;
      if (d.life >= d.max) { s.visible = false; continue; }
      s.position.x += d.vx * dt;
      s.position.y += d.vy * dt;
      s.position.z += d.vz * dt;
      s.scale.addScalar(dt * 1.6);
      s.material.opacity = 0.5 * (1 - d.life / d.max);
    }
  }

  // ------------------------------------------------------------- player ---
  // 全マップ共通のユーザー車最高速度: 180km/h (50m/s)。
  // 5速には少し余裕を持たせ、物理更新後のハードリミッターで統一する。
  const PLAYER_TOP_SPEED = 180 / 3.6;
  const GEARS = [
    { name: 'R', vmax: -8.3, acc: 5.5 },   // ~30 km/h reverse
    { name: 'N', vmax: 0, acc: 0 },
    { name: '1', vmax: 6.1, acc: 10.0 },  // 22 km/h
    { name: '2', vmax: 11.1, acc: 8.0 },   // 40
    { name: '3', vmax: 15.3, acc: 7.0 },   // 55
    { name: '4', vmax: 27.8, acc: 7.0 },   // 100 km/h
    { name: '5', vmax: 54.0, acc: 14.0 },  // 180 km/h limiter
  ];

  const player = {
    group: null,     // yaw
    tilt: null,      // roll / pitch (visual only)
    pos: new THREE.Vector3(0, 0, 0),
    vel: new THREE.Vector3(0, 0, 0),
    heading: 0,
    steer: 0,
    gear: 2,         // start in 1st
    radius: 1.05,    // 接地影の横幅の半分 ≒ 実車幅の半分(CAR_SHADOW.w / 2)
    accSmooth: 0,
    drifting: false,
  };

  const aiCars = []; // { group, tilt, pos, heading, v, base, wps, idx, radius }

  // デモ自動運転のルートと、切り替え式デモカメラの状態
  let demoRoute = null;
  let demoIdx = 1;
  const demoCam = { nextChange: 0, until: 0, yaw: 0, pitch: 0.3, dist: 12 };

  // ------------------------------------------------------------- camera ---
  const cam = { yaw: 0, pitch: 0.34, dist: 10, dragging: false, lastDrag: 0 };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    AUDIO.unlock();
    if (demoActive) {
      if (!CAR2_MODE) { startGame(); return; }   // クリックでもゲーム開始
      demoTapMove = 0;   // car2デモ: スワイプ=カメラ移動 / タップ=タイトルへ
    }
    cam.dragging = true;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointerup', () => {
    cam.dragging = false;
    cam.lastDrag = performance.now();
    // car2デモ: ほぼ動かさずに離した(タップ)ならタイトルへ戻る
    if (demoActive && CAR2_MODE && demoTapMove < 12) {
      if (IS_MOBILE) bonnetView = (bonnetView + 1) % 3;   // スマホ: タップで視点切替
      else exitCar2Demo();
    }
    demoTapMove = 1e9;
  });
  window.addEventListener('pointermove', (e) => {
    if (!cam.dragging) return;
    demoTapMove += Math.abs(e.movementX) + Math.abs(e.movementY);
    cam.yaw -= e.movementX * 0.005;
    cam.pitch = clamp(cam.pitch + e.movementY * 0.004, 0.08, 1.25);
    cam.lastDrag = performance.now();
  });
  window.addEventListener('wheel', (e) => {
    if (musicMode) return;   // 音楽メニュー中はホイールを曲選択に使う
    cam.dist = clamp(cam.dist * (1 + e.deltaY * 0.001), 5.5, 28);
  }, { passive: true });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Follow the map's road surface: cast a ray down from above the car —
  // 車の高さ(約2.7m)×1.2 の位置から — so the car rides on top of the road
  // slab instead of sinking into it, climbs bridges/slopes, and still never
  // pops up onto rooftops (the ray starts below them). Falls back to y=0.
  const RIDE_RAY = 2.7 * 1.2;
  const groundCaster = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const rayOrigin = new THREE.Vector3();
  function groundHeightAt(x, y, z) {
    if (!mapRoot) return 0;
    rayOrigin.set(x, y + RIDE_RAY, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = rayOrigin.y + 100;   // reach the ground from any height
    const hit = groundCaster.intersectObject(mapRoot, true)[0];
    return hit ? hit.point.y : 0;
  }

  // 山岳ラリー: 足元が舗装路(材質FF4863A5、高さ0)かどうかを判定する。
  // 土埃の量を「道路上は少し・それ以外はたくさん」に変えるために使う。
  function mountainSurfaceIsRoad(x, z) {
    if (!mapRoot) return true;
    rayOrigin.set(x, player.pos.y + 3, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = 20;
    const hit = groundCaster.intersectObject(mapRoot, true)[0];
    if (!hit || !hit.object.material) return true;
    const mat = Array.isArray(hit.object.material) ? hit.object.material[0] : hit.object.material;
    return mat.name === 'FF4863A5';
  }

  // 垂直の構築物(建物・壁)との当たり判定: 車体の高さから進行方向へ短い
  // レイを3本飛ばし、ほぼ垂直な面に当たったら壁とみなして滑らせて止める。
  // 坂や橋のスロープ(面が上を向いている)は素通りするので登坂は妨げない。
  const wallCaster = new THREE.Raycaster();
  const wallDir = new THREE.Vector3();
  const wallOrigin = new THREE.Vector3();
  const wallNormal = new THREE.Vector3();
  function collideWalls(dt) {
    if (!mapRoot) return;
    const speed = player.vel.length();
    if (speed < 0.3) return;
    wallDir.copy(player.vel).multiplyScalar(1 / speed);
    const reach = 2.5 + speed * dt;
    wallCaster.far = reach;
    for (const side of [-0.85, 0, 0.85]) {
      wallOrigin.set(
        player.pos.x - wallDir.z * side,
        player.pos.y + 1.1,
        player.pos.z + wallDir.x * side
      );
      wallCaster.set(wallOrigin, wallDir);
      const hit = wallCaster.intersectObject(mapRoot, true)[0];
      if (!hit || !hit.face) continue;
      // car2 は高さ0を走行面とし、それより上へ立ち上がる形状だけを障害物にする。
      // 白線・ペイント等の低い段差(30cm以下)は壁とみなさない。
      if (CAR2_MODE && hit.point.y <= 0.3) continue;
      wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (Math.abs(wallNormal.y) > 0.55) continue;          // 坂・地面は壁ではない
      if (wallNormal.dot(wallDir) > 0) wallNormal.negate(); // 面の向きを車側へ
      const into = player.vel.x * wallNormal.x + player.vel.z * wallNormal.z;
      if (into < 0) {
        player.vel.x -= wallNormal.x * into;                // 壁沿いに滑らせる
        player.vel.z -= wallNormal.z * into;
        player.vel.multiplyScalar(0.9);
      }
      const pen = Math.min(reach - hit.distance, 0.5);
      player.pos.x += wallNormal.x * pen;
      player.pos.z += wallNormal.z * pen;
    }
  }

  // car2 の一本道は南北の地図端で同じ幅・同じ向きに開いている。
  // 車線内の横位置と速度・向きを保ったまま反対端へ送ることで連続周回にする。
  const CAR2_ROAD_CENTER_X = -128.55;
  const CAR2_LOOP_EDGE_Z = 1652.25;
  const CAR2_LOOP_ENTRY_Z = 1644;
  const car2RoadCaster = new THREE.Raycaster();
  const car2RoadOrigin = new THREE.Vector3();
  const car2LastRoadPos = new THREE.Vector3(CAR2_ROAD_CENTER_X, 0, CAR2_LOOP_ENTRY_Z);
  let car2LoopCount = 0;

  function isCar2RoadAt(x, z) {
    if (!CAR2_MODE || !car2RoadMeshes.length) return true;
    car2RoadOrigin.set(x, 6, z);
    car2RoadCaster.set(car2RoadOrigin, DOWN);
    car2RoadCaster.far = 12;
    const targets = car2DrivableMeshes.length ? car2DrivableMeshes : car2RoadMeshes;
    const hits = car2RoadCaster.intersectObjects(targets, false);
    return hits.some((hit) => {
      if (!hit.face || Math.abs(hit.point.y) > 0.25) return false;
      wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      return wallNormal.y > 0.65;
    });
  }

  function keepCar2OnRoad() {
    if (!CAR2_MODE) return;
    const outwardNorth = player.pos.z < -CAR2_LOOP_EDGE_Z && player.vel.z < 0;
    const outwardSouth = player.pos.z > CAR2_LOOP_EDGE_Z && player.vel.z > 0;
    if (outwardNorth || outwardSouth) {
      const laneOffset = clamp(player.pos.x - CAR2_ROAD_CENTER_X, -10, 10);
      player.pos.x = CAR2_ROAD_CENTER_X + laneOffset;
      player.pos.z = outwardNorth ? CAR2_LOOP_ENTRY_Z : -CAR2_LOOP_ENTRY_Z;
      player.pos.y = 0;
      car2LastRoadPos.copy(player.pos);
      car2LoopCount++;
      document.body.dataset.car2LoopCount = String(car2LoopCount);
      return;
    }
    if (isCar2RoadAt(player.pos.x, player.pos.z)) {
      car2LastRoadPos.copy(player.pos);
      return;
    }
    // 壁の隙間などからグレー路面外へ出た場合も、直前の路面位置へ戻す。
    player.pos.x = car2LastRoadPos.x;
    player.pos.z = car2LastRoadPos.z;
    player.vel.multiplyScalar(-0.12);
  }

  // map2(山岳ラリー)の南北ループ。手描きの道路中心線が無いため、地図読み込み後に
  // 実測した「南北端で地形が平坦に開けている」範囲を使い、car2と同じ考え方
  // (中心からの横オフセットを保ったまま反対端へ送る)で周回させる。
  // 専用の路面判定(isCar2RoadAt)は使わず、汎用の地形追従・壁判定に任せる。
  let MOUNTAIN_ROAD_CENTER_X = 0;
  let MOUNTAIN_LOOP_EDGE_Z = 0;      // これを超えて外向きに進んだら反対端へ
  let mountainLoopCount = 0;
  function keepMountainOnRoad() {
    if (!CAR2_MOUNTAIN_MODE || !MOUNTAIN_LOOP_EDGE_Z) return;
    const outwardNorth = player.pos.z < -MOUNTAIN_LOOP_EDGE_Z && player.vel.z < 0;
    const outwardSouth = player.pos.z > MOUNTAIN_LOOP_EDGE_Z && player.vel.z > 0;
    if (!outwardNorth && !outwardSouth) return;
    const laneOffset = clamp(player.pos.x - MOUNTAIN_ROAD_CENTER_X, -10, 10);
    player.pos.x = MOUNTAIN_ROAD_CENTER_X + laneOffset;
    player.pos.z = outwardNorth ? MOUNTAIN_LOOP_EDGE_Z - 1 : -(MOUNTAIN_LOOP_EDGE_Z - 1);
    player.pos.y = groundHeightAt(player.pos.x, 50, player.pos.z);
    mountainLoopCount++;
    document.body.dataset.mountainLoopCount = String(mountainLoopCount);
  }

  // 街灯: 道路の両側・壁の向こう側に、車7台分(約34m)間隔で設置する。
  // ポール+アームとランプヘッドを InstancedMesh にまとめ、前後の周回コピー分も
  // 同じメッシュへ含める。夜間はヘッドのマテリアルを発光へ差し替え、
  // ランプ位置に光球スプライト(ハロ)を表示する。
  const STREET_LIGHT_SPACING = 4.8 * 7;    // 車7台分
  const STREET_LIGHT_OFFSET = 8;           // 路面外を探し始める横距離(中心線から)
  let streetLampHeads = null;
  let streetLampHeadDayMat = null;
  let streetLampHeadNightMat = null;

  function buildCar2StreetLights(loopSpan) {
    const route = CAR2_CPU_ROUTE;
    const spots = [];                      // {x, z, yaw} 両側分
    let acc = 0;                           // 前回の街灯からの距離
    for (let i = 0; i + 1 < route.length; i++) {
      const [ax, az] = route[i], [bx, bz] = route[i + 1];
      const segX = bx - ax, segZ = bz - az;
      const segLen = Math.hypot(segX, segZ);
      if (segLen < 1e-6) continue;
      const tx = segX / segLen, tz = segZ / segLen;
      const nx = -tz, nz = tx;             // 左向きの法線
      let remaining = segLen, base = 0;
      while (acc + remaining >= STREET_LIGHT_SPACING) {
        const step = STREET_LIGHT_SPACING - acc;
        base += step; remaining -= step; acc = 0;
        const px = ax + tx * base, pz = az + tz * base;
        for (const side of [-1, 1]) {
          // 道路幅が広い区間では基準オフセットだと路面上(壁の内側)に立って
          // しまうため、グレー路面の外に出るまで2m刻みで外側へずらし、
          // 「壁から少しだけ離した外側」(路面端から約1.5〜3.5m)に立てる。
          let x = 0, z = 0, placed = false;
          for (let off = STREET_LIGHT_OFFSET; off <= 27; off += 2) {
            x = px + nx * side * off;
            z = pz + nz * side * off;
            if (!isCar2RoadAt(x, z)) {
              x += nx * side * 1.5;               // 壁からさらに少しだけ外へ
              z += nz * side * 1.5;
              placed = true;
              break;
            }
          }
          if (!placed) continue;                  // 外へ出られない区間は立てない
          const dx = -nx * side, dz = -nz * side; // アームを道路側へ向ける
          spots.push({ x, z, yaw: Math.atan2(-dz, dx) });
        }
      }
      acc += remaining;
    }
    if (!spots.length) return;

    // 高さは車の縦幅3台分(4.8m×3≈14.4m)。直立の棒の頂部が道路側へ折れて
    // 短い水平アームになり、その先端に地表を向いた平らなランプが付く。
    const POLE_H = 13.8;                   // 直立部分
    const ELBOW_LEN = 0.7, ELBOW_A = Math.PI / 4;
    const ARM_LEN = 0.9;
    const elbowX = Math.sin(ELBOW_A) * ELBOW_LEN;
    const elbowY = POLE_H + Math.cos(ELBOW_A) * ELBOW_LEN;   // アーム高さ ≈14.3m
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.12, POLE_H, 6).translate(0, POLE_H / 2, 0);
    const elbowGeo = new THREE.CylinderGeometry(0.06, 0.06, ELBOW_LEN, 5);
    elbowGeo.rotateZ(-ELBOW_A);
    elbowGeo.translate(elbowX / 2, POLE_H + Math.cos(ELBOW_A) * ELBOW_LEN / 2, 0);
    const armGeo = new THREE.CylinderGeometry(0.055, 0.055, ARM_LEN, 5);
    armGeo.rotateZ(Math.PI / 2);           // 水平アーム(+X=道路側)
    armGeo.translate(elbowX + ARM_LEN / 2, elbowY, 0);
    const poleMerged = mergeGeometries([poleGeo, elbowGeo, armGeo], false);
    // ランプはアーム先端に水平マウント。薄い平板で発光面が地表を向く。
    const tipX = elbowX + ARM_LEN;
    const headGeo = new THREE.BoxGeometry(0.85, 0.1, 0.4).translate(tipX - 0.2, elbowY - 0.1, 0);
    streetLampHeadDayMat = new THREE.MeshLambertMaterial({ color: 0xe8ecef });
    streetLampHeadNightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const zOffsets = [-loopSpan, 0, loopSpan];
    const total = spots.length * zOffsets.length;
    const poles = new THREE.InstancedMesh(
      poleMerged, new THREE.MeshLambertMaterial({ color: 0x3f444a }), total);
    streetLampHeads = new THREE.InstancedMesh(headGeo, streetLampHeadDayMat, total);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    let index = 0;
    for (const zOff of zOffsets) {
      for (const s of spots) {
        rotation.setFromAxisAngle(up, s.yaw);
        matrix.compose(new THREE.Vector3(s.x, 0, s.z + zOff), rotation, one);
        poles.setMatrixAt(index, matrix);
        streetLampHeads.setMatrixAt(index, matrix);
        index++;
      }
    }
    poles.instanceMatrix.needsUpdate = true;
    streetLampHeads.instanceMatrix.needsUpdate = true;
    poles.frustumCulled = false;           // インスタンスが広域に散るため
    streetLampHeads.frustumCulled = false;
    scene.add(poles);
    scene.add(streetLampHeads);

    // 夜のハロ(光球)と地表の光だまりはメイン地図分だけ。
    // nightLampGroups 経由で夜だけ表示する。
    const halos = new THREE.Group();
    halos.visible = nightMode;
    const streetPoolGeo = new THREE.PlaneGeometry(33, 33);   // 照射範囲3倍
    for (const s of spots) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: headGlowTex, color: 0xffffff, blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, opacity: 0.95,
      }));
      halo.position.set(
        s.x + Math.cos(s.yaw) * 1.2,
        14.2,
        s.z - Math.sin(s.yaw) * 1.2
      );
      halo.scale.setScalar(3.0);           // 光量4倍(面積4倍+不透明度アップ)
      halos.add(halo);

      // 街灯の真下(やや道路側)の地表に、薄い光だまりを落とす
      const pool = new THREE.Mesh(
        streetPoolGeo,
        new THREE.MeshBasicMaterial({
          map: headGlowTex, color: 0xfff2c8, blending: THREE.AdditiveBlending,
          transparent: true, opacity: 0.2, depthWrite: false,
        })
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(
        s.x + Math.cos(s.yaw) * 4.0,
        0.13,
        s.z - Math.sin(s.yaw) * 4.0
      );
      pool.renderOrder = 2;
      halos.add(pool);
    }
    scene.add(halos);
    nightLampGroups.push(halos);
    document.body.dataset.streetLightCount = String(spots.length);
  }

  // グレー路面を南端から北端へ横断走査し、一本道の中央にCPU用ラインを作る。
  // 最小幅でも対向余地を残すため、進行方向右側へ2.4m寄せる。
  function buildCar2CpuRoute() {
    const centerRoute = CAR2_CPU_ROUTE.map(([x, z]) => ({ x, z }));
    if (centerRoute.length < 2) return centerRoute;
    return centerRoute.map((point, i) => {
      const before = centerRoute[Math.max(0, i - 1)];
      const after = centerRoute[Math.min(centerRoute.length - 1, i + 1)];
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const length = Math.hypot(dx, dz) || 1;
      return {
        x: point.x + (dz / length) * 2.4,
        z: point.z - (dx / length) * 2.4,
      };
    });
  }

  // car2(首都高速)・山岳地帯共通: wps に沿ってドリフト旋回するCPU車を等間隔で
  // 配置する(car2Loop:true、100〜150km/hのランダム速度)。山岳地帯は片側1車線の
  // 単路なので buildCar2CpuRoute の右寄せは行わず、中心線をそのまま使う。
  function spawnCar2LoopCpuCars(wps, vehicles) {
    if (wps.length < 2) return;
    vehicles.forEach((vehicle, i) => {
      const start = Math.min(wps.length - 2, Math.floor(i * (wps.length - 1) / Math.max(1, vehicles.length)));
      const next = start + 1;
      const a = wps[start], b = wps[next];
      const speedKmh = 100 + Math.random() * 50;
      const base = speedKmh / 3.6;
      const bike = isKabuVoxUrl(vehicle.url);
      const g = makeCarGroup(vehicle.mesh.clone(), false, bike);
      aiCars.push({
        group: g.group, tilt: g.tilt,
        pos: new THREE.Vector3(a.x, groundHeightAt(a.x, 6, a.z), a.z),
        heading: Math.atan2(b.x - a.x, b.z - a.z),
        v: base, base,
        wps, idx: next, radius: carRadiusFor(bike), kabu: bike,
        cornerSlowdown: 0.55,
        turnRate: 3.4,
        car2Loop: true,
        roadCheckIn: Math.random() * 0.25,
        speedKmh,
      });
    });
  }

  // --------------------------------------------------------------- init ---
  // Soft contact shadow that sits directly under a car at all times —
  // the directional shadow alone lands beside the body when the sun is low.
  // 車体の実サイズにほぼ合わせた接地影。幅=横, 奥行き=縦(進行方向)。
  const CAR_SHADOW = { w: 2.1, h: 4.6 };
  // kabu(スーパーカブ)はバイク。影はタイヤ一個分くらいの小さく細いものに。
  const BIKE_SHADOW = { w: 0.75, h: 2.0 };
  let blobTex = null;
  function makeBlobShadow(size) {
    if (!blobTex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
      g.addColorStop(0, 'rgba(0,0,0,0.55)');
      g.addColorStop(0.65, 'rgba(0,0,0,0.38)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 128, 128);
      blobTex = new THREE.CanvasTexture(cv);
    }
    const s = size || CAR_SHADOW;
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(s.w, s.h),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.12;          // above the road surface + markings
    return blob;
  }

  function makeCarGroup(mesh, castShadow, bike) {
    const tilt = new THREE.Group();
    mesh.rotation.y = MODEL_YAW;
    mesh.position.y = -CAR_SINK;
    // 多数の CPU 車はシャドウマップ描画を省いて軽量化(接地影は残る)
    if (castShadow === false) mesh.castShadow = false;
    tilt.add(mesh);
    const group = new THREE.Group();
    group.add(tilt);
    group.add(makeBlobShadow(bike ? BIKE_SHADOW : CAR_SHADOW));
    addCarLights(group, bike);       // 夜間用ヘッドライト・テールランプ
    scene.add(group);
    return { group, tilt };
  }

  // 当たり判定の半径は接地影の横幅の半分に合わせる(実車幅とほぼ一致)。
  const carRadiusFor = (bike) => (bike ? BIKE_SHADOW.w : CAR_SHADOW.w) / 2;

  // タイトル画面の選択に応じてユーザー車を切り替える。
  // Volvo 240 は追加済みの vox/volvo240.vox を使用する。
  const PLAYER_CAR_FILE = PLAYER_CAR_KEY === 'volvo240' ? 'volvo240.vox' : 'toyota86.vox';
  const PLAYER_CAR_VOX = 'vox/' + encodeURIComponent(PLAYER_CAR_FILE) + '?v=20260715-1';

  // vox/ 直下の .vox はすべて車両。選択中のプレイヤー車だけ CPU 車から除外する。
  // 樹木などのコースオブジェクトは vox/object/ に分離している。
  const RESERVED_VOX_FILES = new Set([
    PLAYER_CAR_FILE.toLowerCase(),
    'toyota86n.vox',                 // 夜間用のプレイヤー車。CPUには使わない
  ]);
  const FALLBACK_CPU_VOX_FILES = [
    'nissan0.vox', 'nissan1.vox', 'volvo.vox', 'toyotaprobox.vox',
    'keitora.vox', 'vw01.vox', 'nissan180sx0.vox', 'toyotahigh00.vox', 'kabu.vox',
  ];

  function cpuVoxUrls(fileNames) {
    return [...new Set(fileNames)]
      .map((name) => String(name).split(/[\\/]/).pop())
      .filter((name) => /\.vox$/i.test(name) && !RESERVED_VOX_FILES.has(name.toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((name) => 'vox/' + encodeURIComponent(name));
  }

  function isKabuVoxUrl(url) {
    const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');
    return /^kabu\d*\.vox$/i.test(file);
  }

  // 車種の基本名(末尾の数字=色違いを除く)。例 keitora03->keitora, nissan180sx2->nissan180sx
  function voxBaseModel(url) {
    const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').replace(/\.vox$/i, '');
    return file.replace(/\d+$/, '').toLowerCase();
  }
  const shuffleArray = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  // 車種ごとに最大 perModel 台・合計 total 台まで、なるべく多様に選ぶ。Kabu は kabuMax 台まで。
  function pickDiverseCpuVox(urls, perModel, total, kabuMax) {
    const byModel = new Map();
    for (const url of urls) {
      const key = voxBaseModel(url);
      if (!byModel.has(key)) byModel.set(key, []);
      byModel.get(key).push(url);
    }
    for (const list of byModel.values()) shuffleArray(list);   // 色違いをランダムに
    const models = shuffleArray([...byModel.keys()]);          // 車種の順もランダムに
    const picked = [];
    let kabu = 0;
    for (let round = 0; round < perModel; round++) {
      for (const m of models) {
        const list = byModel.get(m);
        if (round >= list.length) continue;
        const url = list[round];
        if (isKabuVoxUrl(url)) { if (kabu >= kabuMax) continue; kabu++; }
        picked.push(url);
        if (picked.length >= total) return picked;
      }
    }
    return picked;
  }

  async function githubVoxFiles() {
    if (!location.hostname.endsWith('.github.io')) return [];
    const owner = location.hostname.slice(0, -'.github.io'.length);
    const firstPath = location.pathname.split('/').filter(Boolean)[0];
    const repo = firstPath || `${owner}.github.io`;
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/vox`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error(`GitHub contents API returned ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('GitHub contents API did not return a directory');
    return entries.filter((entry) => entry.type === 'file').map((entry) => entry.name);
  }

  async function localServerVoxFiles() {
    const response = await fetch('vox-files.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`vox-files.json returned ${response.status}`);
    const names = await response.json();
    if (!Array.isArray(names)) throw new Error('vox-files.json is not an array');
    return names;
  }

  async function directoryListingVoxFiles() {
    const response = await fetch('vox/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`vox directory returned ${response.status}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    return Array.from(doc.querySelectorAll('a[href]')).map((link) => {
      const path = new URL(link.getAttribute('href'), response.url).pathname;
      try { return decodeURIComponent(path.split('/').filter(Boolean).pop() || ''); }
      catch (_) { return ''; }
    });
  }

  async function discoverCpuCarVox() {
    const sources = location.hostname.endsWith('.github.io')
      // GitHub Pages ではローカルサーバー用エンドポイントを使わない。
      ? [githubVoxFiles]
      // ダウンロード版は PLAY_*.bat の PowerShell サーバーを優先し、
      // python -m http.server のディレクトリ一覧にも対応する。
      : [localServerVoxFiles, directoryListingVoxFiles];
    for (const getFiles of sources) {
      try {
        const urls = cpuVoxUrls(await getFiles());
        if (urls.length) return urls;
      } catch (error) {
        console.warn('Could not inspect the vox folder with this source.', error);
      }
    }
    console.warn('No CPU vehicle listing was discovered. Using the built-in non-player CPU list.');
    return cpuVoxUrls(FALLBACK_CPU_VOX_FILES);
  }

  async function loadCpuCars(urls) {
    const nonPlayerUrls = urls.filter((url) => {
      const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').toLowerCase();
      return !RESERVED_VOX_FILES.has(file);
    });
    return (await Promise.all(nonPlayerUrls.map(async (url) => {
      try {
        return { url, mesh: await VOX.load(url, { scale: VOXEL_SCALE }) };
      } catch (error) {
        console.warn(`CPU car skipped because it could not be loaded: ${url}`, error);
        return null;
      }
    }))).filter(Boolean);
  }

  function scatterTrees(meshes, rnd) {
    // Instancing keeps draw calls low, but one huge InstancedMesh defeats
    // frustum culling — so the forest is split into sectors around the loop.
    const SECTORS = 12;
    const cityLists = meshes.map(() => []);
    const sectorLists = [];
    for (let i = 0; i < SECTORS; i++) sectorLists.push(meshes.map(() => []));

    function tryPlace(lists, x, z, roadMargin, spacing) {
      if (onAnyRoad(x, z, roadMargin)) return false;
      for (const o of obstacles) {
        const rr = o.r + spacing;
        if ((o.x - x) * (o.x - x) + (o.z - z) * (o.z - z) < rr * rr) return false;
      }
      const meshIndex = Math.floor(rnd() * meshes.length);
      const s = 0.75 + rnd() * 0.6;
      lists[meshIndex].push({ x, z, s, rot: rnd() * Math.PI * 2 });
      obstacles.push({ x, z, r: 0.9 * s });
      return true;
    }

    // 建物のある四角区画は樹木を少なくし、建物から十分に離す。
    let placed = 0, attempts = 0;
    while (placed < 16 && attempts++ < 6000) {
      const x = -310 + rnd() * 620;
      const z = (rnd() * 2 - 1) * 310;
      if (tryPlace(cityLists, x, z, 4, 7)) placed++;
    }

    // 森林コース沿いは tree01 / tree02 だけを配置。
    placed = 0; attempts = 0;
    while (placed < 756 && attempts++ < 84000) {
      const pointIndex = Math.floor(rnd() * forestLoop.length);
      const p = forestLoop[pointIndex];
      const prev = forestLoop[(pointIndex + forestLoop.length - 1) % forestLoop.length];
      const next = forestLoop[(pointIndex + 1) % forestLoop.length];
      const tangentX = next.x - prev.x;
      const tangentZ = next.z - prev.z;
      const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
      const tx = tangentX / tangentLength;
      const tz = tangentZ / tangentLength;
      const nx = -tz;
      const nz = tx;
      const side = rnd() < 0.5 ? -1 : 1;
      // 道路中心から9～27m。二乗分布で道路に近い側へ集中させる。
      const roadDistance = 9 + rnd() * rnd() * 18;
      const alongRoad = (rnd() * 2 - 1) * 10;
      const x = p.x + nx * side * roadDistance + tx * alongRoad;
      const z = p.z + nz * side * roadDistance + tz * alongRoad;
      if (x < 300 || x > BOUND_X_MAX || Math.abs(z) > BOUND_Z) continue;
      const sector = Math.floor(((Math.atan2(z - FOREST_C.z, x - FOREST_C.x) + Math.PI) / (Math.PI * 2)) * SECTORS) % SECTORS;
      if (tryPlace(sectorLists[sector], x, z, 2.5, 1.25)) placed++;
    }

    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    function buildInstanced(mesh, list) {
      if (!list.length) return;
      const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m4.compose(new THREE.Vector3(p.x, 0, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        inst.setMatrixAt(i, m4);
      });
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      scene.add(inst);
    }
    meshes.forEach((mesh, t) => {
      buildInstanced(mesh, cityLists[t]);
      for (const lists of sectorLists) buildInstanced(mesh, lists[t]);
    });
  }

  // map2(山岳ラリー): 道路網の情報が無いので、緑色の地面(材質名 FF00994C)の
  // メッシュそのものから三角形を直接サンプリングしてtree01を密集配置する。
  // (地図全体へレイキャストする方式は候補点ごとにmapRoot全体と交差判定するため
  //  重く、読み込みが固まってしまった。実際の緑メッシュは76面程度しか無いので、
  //  面積に応じて重心座標でランダム抽出したほうが軽くて確実)
  function scatterMountainTrees(treeMesh, rnd) {
    if (!mapRoot) return;
    let greenMesh = null;
    mapRoot.traverse((o) => {
      if (o.isMesh) {
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mat && mat.name === 'FF00994C') greenMesh = o;
      }
    });
    if (!greenMesh) return;
    greenMesh.updateWorldMatrix(true, false);
    const geom = greenMesh.geometry;
    const pos = geom.attributes.position;
    const idx = geom.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const triVertex = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    const tris = [];
    let totalArea = 0;
    const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      vA.fromBufferAttribute(pos, triVertex(t, 0)).applyMatrix4(greenMesh.matrixWorld);
      vB.fromBufferAttribute(pos, triVertex(t, 1)).applyMatrix4(greenMesh.matrixWorld);
      vC.fromBufferAttribute(pos, triVertex(t, 2)).applyMatrix4(greenMesh.matrixWorld);
      const area = new THREE.Triangle(vA, vB, vC).getArea();
      tris.push({ a: vA.clone(), b: vB.clone(), c: vC.clone(), area });
      totalArea += area;
    }
    const TARGET = 400;
    const density = totalArea > 0 ? TARGET / totalArea : 0;
    const SECTORS = 10;
    const sectorLists = Array.from({ length: SECTORS }, () => []);
    const placedPoints = [];
    const MIN_SPACING = 3;
    for (const tri of tris) {
      const count = Math.round(tri.area * density * 1.6);   // 間引きされる分を見込んで多めに生成
      for (let i = 0; i < count; i++) {
        let r1 = rnd(), r2 = rnd();
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const x = tri.a.x + (tri.b.x - tri.a.x) * r1 + (tri.c.x - tri.a.x) * r2;
        const y = tri.a.y + (tri.b.y - tri.a.y) * r1 + (tri.c.y - tri.a.y) * r2;
        const z = tri.a.z + (tri.b.z - tri.a.z) * r1 + (tri.c.z - tri.a.z) * r2;
        let tooClose = false;
        for (const q of placedPoints) {
          const dx = q.x - x, dz = q.z - z;
          if (dx * dx + dz * dz < MIN_SPACING * MIN_SPACING) { tooClose = true; break; }
        }
        if (tooClose) continue;
        const s = 0.8 + rnd() * 0.7;
        let sector = Math.floor(((z + BOUND_Z) / (BOUND_Z * 2)) * SECTORS);
        sector = Math.max(0, Math.min(SECTORS - 1, sector));
        sectorLists[sector].push({ x, y, z, s, rot: rnd() * Math.PI * 2 });
        placedPoints.push({ x, z });
      }
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (const list of sectorLists) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(treeMesh.geometry, treeMesh.material, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(p.s, p.s, p.s));
        inst.setMatrixAt(i, m4);
      });
      inst.computeBoundingSphere();
      inst.frustumCulled = true;
      scene.add(inst);
    }
  }

  // Waypoints for a rectangular circuit over the grid, shifted into the
  // left lane of each leg (left-hand traffic).
  function rectLoop(xa, xb, za, zb, cw) {
    const cs = cw
      ? [[xa, za], [xb, za], [xb, zb], [xa, zb]]
      : [[xa, za], [xa, zb], [xb, zb], [xb, za]];
    const wps = [];
    for (let i = 0; i < 4; i++) {
      const p = cs[i], prev = cs[(i + 3) % 4], next = cs[(i + 1) % 4];
      const din = { x: Math.sign(p[0] - prev[0]), z: Math.sign(p[1] - prev[1]) };
      const dout = { x: Math.sign(next[0] - p[0]), z: Math.sign(next[1] - p[1]) };
      const leftIn = { x: din.z, z: -din.x };
      const leftOut = { x: dout.z, z: -dout.x };
      const vLeft = din.x === 0 ? leftIn : leftOut;   // left of the vertical leg
      const hLeft = din.x === 0 ? leftOut : leftIn;   // left of the horizontal leg
      wps.push({ x: p[0] + vLeft.x * LANE_OFF, z: p[1] + hLeft.z * LANE_OFF });
    }
    return wps;
  }

  // Converter exports (CAD/city scans) often arrive as thousands of tiny
  // meshes — merge them per material so the GPU sees a handful of draws.
  function mergeMapMeshes(root) {
    const groups = new Map();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
      g.applyMatrix4(o.matrixWorld);
      const key = o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',');
      if (!groups.has(key)) groups.set(key, { mat: o.material, list: [] });
      groups.get(key).list.push(g);
    });
    const merged = new THREE.Group();
    merged.name = root.name;
    for (const { mat, list } of groups.values()) {
      const geo = mergeGeometries(list, false);
      if (!geo) continue;
      mat.side = THREE.DoubleSide;      // converted models often have flipped faces
      merged.add(new THREE.Mesh(geo, mat));
    }
    return merged;
  }

  // Load a glTF/GLB world. Conventions (see README):
  //   - meshes named col_*  -> round collider from their bounding box
  //   - empty named spawn   -> player start (its +Z = initial heading)
  //   - empties wp_<loop>_<n> -> AI waypoint loops, driven in index order
  // Raw converter exports are auto-adjusted: millimetre units are scaled
  // down, Z-up models are rotated upright, and the map is centred on the
  // origin. Override with URL params: &scale= &zup=0/1 &y=
  async function loadGltfMap(url) {
    const qs = new URLSearchParams(location.search);
    const gltf = await new GLTFLoader().loadAsync(url);
    let map = gltf.scene;
    map.updateMatrixWorld(true);

    let meshCount = 0;
    map.traverse((o) => { if (o.isMesh) meshCount++; });
    // hand-made maps keep their node names; giant converter dumps get merged
    if (meshCount > 200) map = mergeMapMeshes(map);

    const size = new THREE.Box3().setFromObject(map).getSize(new THREE.Vector3());
    const wrap = new THREE.Group();
    wrap.add(map);
    const pScale = parseFloat(qs.get('scale'));
    // mm 単位の地図は実寸(1/1000)だと街路が車に対して窮屈なので10倍で読む
    // map2(山岳ラリー)は生データの長辺が約8100単位なので0.2倍を基準にしていたが、
    // ユーザー指示で75%(0.15)に縮小(全長約1200m程度)。
    const scale = pScale || (CAR2_MODE ? 0.000075 : CAR2_MOUNTAIN_MODE ? 0.15
      : (Math.max(size.x, size.y, size.z) > 4000 ? 0.01 : 1));
    wrap.scale.setScalar(scale);
    const zupParam = qs.get('zup');
    const zup = CAR2_MODE ? false : (zupParam !== null ? zupParam === '1' : size.z < size.y * 0.5);
    if (zup) wrap.rotation.x = -Math.PI / 2;
    scene.add(wrap);
    wrap.updateMatrixWorld(true);

    // centre the map on the origin (x/z). 通常マップは最下面を y=0 に置く。
    // car2 は地下側の形状を含むため、元データの「高さ0」を動かさず走行面にする。
    // Optional height tweak via &y=
    const box = new THREE.Box3().setFromObject(wrap);
    const c = box.getCenter(new THREE.Vector3());
    wrap.position.x -= c.x;
    wrap.position.z -= c.z;
    if (!CAR2_MODE) wrap.position.y -= box.min.y;
    wrap.position.y += parseFloat(qs.get('y')) || 0;
    wrap.updateMatrixWorld(true);
    mapRoot = wrap;
    if (CAR2_MODE) {
      car2RoadMeshes = [];
      const car2LineMeshes = [];   // 白線など白系マテリアルのメッシュ
      wrap.traverse((o) => {
        if (!o.isMesh) return;
        const materials = Array.isArray(o.material) ? o.material : [o.material];
        if (materials.some((m) => (m && m.name || '').toUpperCase() === 'FF565656')) {
          car2RoadMeshes.push(o);
        } else if (materials.some((m) => m && m.color
            && Math.min(m.color.r, m.color.g, m.color.b) > 0.8)) {
          car2LineMeshes.push(o);
        }
      });
      // 路面判定はグレー路面+白線を対象にする。白線の上を「路面外」と
      // 誤判定して引き戻すと、白線に引っ掛かったような挙動になるため。
      // 判定側で高さ|y|<=0.25の上向き面に絞るので、建物の白は影響しない。
      car2DrivableMeshes = car2RoadMeshes.concat(car2LineMeshes);
      document.body.dataset.car2RoadMeshCount = String(car2RoadMeshes.length);
      document.body.dataset.car2LineMeshCount = String(car2LineMeshes.length);

      // 道路(グレー)以外の純白マテリアルを集める。夜間はこれが発光する。
      // ユーザーがあとからビル等へ追加する白(SketchUpの FFFFFFFF)も、
      // 色が純白なら自動で対象になる。
      const glowSeen = new Set();
      wrap.traverse((o) => {
        if (!o.isMesh || car2RoadMeshes.includes(o)) return;
        for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (!mat || glowSeen.has(mat.uuid)) continue;
          const name = (mat.name || '').toUpperCase();
          const c = mat.color;
          const pureWhite = name === 'FFFFFFFF'
            || (c && c.r > 0.97 && c.g > 0.97 && c.b > 0.97);
          if (pureWhite) { glowSeen.add(mat.uuid); car2GlowMats.push(mat); }
        }
      });
      document.body.dataset.car2GlowMaterialCount = String(car2GlowMats.length);

      // 地図の前後に同じ地図を表示専用で並べ、端の手前から次の周回を見せる。
      // 当たり判定は mapRoot だけを使うため、複製側は走行物理に影響しない。
      const car2Box = new THREE.Box3().setFromObject(wrap);
      const loopSpan = car2Box.max.z - car2Box.min.z;
      for (const direction of [-1, 1]) {
        const visualCopy = wrap.clone(true);
        visualCopy.position.z += loopSpan * direction;
        visualCopy.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        scene.add(visualCopy);
        car2VisualWraps.push(visualCopy);
      }
      document.body.dataset.car2VisualLoopCopies = String(car2VisualWraps.length);

      // 道路両側・壁の向こう側に車7台分間隔で街灯を立てる(周回コピー分も含む)。
      buildCar2StreetLights(loopSpan);

      // 既定のフォグ(130〜480m)だと一本道の遠景が常に霞んで全体が白っぽく
      // 見えるため、car2 はフォグを遠ざけて手前の色をクリアにする。
      // far はカメラ描画限界(1200m)の手前に置き、遠景の切れ目は空色へ溶かす。
      scene.fog = new THREE.Fog(SKY, 500, 1150);
    } else if (CAR2_MOUNTAIN_MODE) {
      // map2(山岳ラリー): 手描きの経路情報が無いので、街灯・専用路面判定は
      // 使わない。地図の前後コピーで次の周回を見せる演出と、car2と同じ
      // 空(フォグを遠くへ)だけを流用する。
      const mtBox = new THREE.Box3().setFromObject(wrap);
      const mtLoopSpan = mtBox.max.z - mtBox.min.z;
      for (const direction of [-1, 1]) {
        const visualCopy = wrap.clone(true);
        visualCopy.position.z += mtLoopSpan * direction;
        visualCopy.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        scene.add(visualCopy);
        car2VisualWraps.push(visualCopy);
      }
      scene.fog = new THREE.Fog(SKY, 500, 1150);
    }

    const out = { spawn: null, loops: {} };
    wrap.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      const name = o.name || '';
      if (o.isMesh && name.startsWith('col_')) {
        const b = new THREE.Box3().setFromObject(o);
        const cc = b.getCenter(new THREE.Vector3());
        const sz = b.getSize(new THREE.Vector3());
        obstacles.push({ x: cc.x, z: cc.z, r: Math.max(0.5, (sz.x + sz.z) / 4) });
      }
      if (name === 'spawn') out.spawn = o;
      const m = name.match(/^wp_(.+)_(\d+)$/);
      if (m) {
        (out.loops[m[1]] = out.loops[m[1]] || []).push({ i: +m[2], p: o.getWorldPosition(new THREE.Vector3()) });
      }
    });

    const fin = new THREE.Box3().setFromObject(wrap);
    BOUND_X_MIN = fin.min.x - 5;
    BOUND_X_MAX = fin.max.x + 5;
    BOUND_Z = Math.max(Math.abs(fin.min.z), Math.abs(fin.max.z)) + 5;
    return out;
  }

  async function init() {
    const [playerCarMesh, tree1, tree2] = await Promise.all([
      VOX.load(PLAYER_CAR_VOX, { scale: VOXEL_SCALE }),
      VOX.load('vox/object/tree01.vox', { scale: TREE_SCALE }),
      VOX.load('vox/object/tree02.vox', { scale: TREE_SCALE }),
    ]);
    // 日本橋(手描き経路が無いためCPU車を安全に走らせられない)ではCPU車を
    // 配置しないため、車種検索とVOX読み込みも省略する。
    const SKIP_CPU_CARS = NIHONBASHI_MODE;
    const discoveredCpuVox = SKIP_CPU_CARS ? [] : await discoverCpuCarVox();
    // 鈴鹿・首都高速・山岳地帯は車種ごと最大2台の多様な10台(Kabuは1台)を選ぶ。
    // sort 済み先頭9台だと keitora/nissan の色違いばかりになってしまうため。
    const diverseCpuVox = (SUZUKA_MODE || CAR2_MODE || CAR2_MOUNTAIN_MODE)
      ? pickDiverseCpuVox(discoveredCpuVox, 2, 10, 1) : [];
    const cpuCars = await loadCpuCars(
      SKIP_CPU_CARS ? [] : ((SUZUKA_MODE || CAR2_MODE || CAR2_MOUNTAIN_MODE)
        ? diverseCpuVox
        : (MAP_GLTF ? discoveredCpuVox.slice(0, 4) : discoveredCpuVox))
    );
    const cpuMeshes = cpuCars.map((car) => car.mesh);

    const p = makeCarGroup(playerCarMesh);
    player.group = p.group;
    player.tilt = p.tilt;

    // 夜間用の自車(toyota86n.vox): フロントライトが開いた夜仕様。
    // 黄色部分(ライト)は発光させる。読み込めない場合は昼の車のまま走る。
    if (PLAYER_CAR_KEY === 'toyota86') {
      try {
        const nightCar = await VOX.load('vox/toyota86n.vox?v=20260718-1', { scale: VOXEL_SCALE });
        playerNightMesh = buildPlayerNightMesh(nightCar, isToyotaLampFace, 0xffee66);
        playerNightMesh.rotation.y = MODEL_YAW;
        playerNightMesh.position.y = -CAR_SINK;
        playerNightMesh.visible = nightMode;
        player.tilt.add(playerNightMesh);
        playerDayMesh = playerCarMesh;
        playerDayMesh.visible = !nightMode;
      } catch (error) {
        console.warn('toyota86n.vox を読み込めなかったため、夜間も昼の車を使います。', error);
      }
    } else if (PLAYER_CAR_KEY === 'volvo240') {
      // Volvo は同じモデルのまま、フロントの白いライトパネルを夜に発光させる。
      // 小さな光球スプライト(ヘッド側)は使わない。
      playerNightMesh = buildPlayerNightMesh(playerCarMesh, isVolvoLampFace, 0xfff6d8);
      playerNightMesh.rotation.y = MODEL_YAW;
      playerNightMesh.position.y = -CAR_SINK;
      playerNightMesh.visible = nightMode;
      player.tilt.add(playerNightMesh);
      playerDayMesh = playerCarMesh;
      playerDayMesh.visible = !nightMode;
      const nightLights = player.group.userData.nightLights;
      if (nightLights && nightLights.userData.headSprites) {
        for (const sprite of nightLights.userData.headSprites) sprite.visible = false;
      }
    }

    // 夜間: 自車の前方約5mの路面・オブジェクトだけをほんのり照らす実光源。
    // ボンネットが光って見えないよう、光源は車体前端より前に置いて前方だけへ
    // 向ける(発光スプライトや光だまりは使わない)。
    playerHeadlight = new THREE.SpotLight(0xffeecb, 0.7, 7, 0.65, 0.6, 1.5);
    playerHeadlight.position.set(0, 0.75, 2.55);
    playerHeadlight.visible = nightMode;
    playerHeadlight.target.position.set(0, 0, 8);
    player.group.add(playerHeadlight);
    player.group.add(playerHeadlight.target);

    if (MAP_GLTF) {
      const info = SUZUKA_MODE ? buildSuzukaMap(scene) : await loadGltfMap(MAP_GLTF);
      if (CAR2_MODE) {
        car2AutoRoute = CAR2_CPU_ROUTE.map(([x, z]) => ({ x, z }));   // 自動運転用
        const wps = buildCar2CpuRoute();
        spawnCar2LoopCpuCars(wps, cpuCars);
        document.body.dataset.car2CpuRoutePoints = String(wps.length);
      } else if (SUZUKA_MODE) {
        mapRoot = info.root;
        const fin = new THREE.Box3().setFromObject(mapRoot);
        BOUND_X_MIN = fin.min.x - 5;
        BOUND_X_MAX = fin.max.x + 5;
        BOUND_Z = Math.max(Math.abs(fin.min.z), Math.abs(fin.max.z)) + 5;
        camera.far = 2400;
        camera.updateProjectionMatrix();
        scene.fog.far = 1800;
      } else if (CAR2_MOUNTAIN_MODE) {
        // 地図の外形(バウンディングボックス)は原点中心だが、道路そのものは
        // 中心からX方向にずれた位置を通っている。スケール0.2の時に実測した
        // 道路中心X=-305.5を、現在のスケール比(0.15/0.2=75%)で換算して使う。
        // BOUND_Zの少し内側を「出口」にし、そこを超えて外向きに進んだら
        // 反対端へ送る(car2と同じ考え方)。
        MOUNTAIN_ROAD_CENTER_X = -305.5 * 0.75;
        MOUNTAIN_LOOP_EDGE_Z = BOUND_Z - 3;
        scatterMountainTrees(tree1, mulberry32(20260719));
        // CAR2_MOUNTAIN_ROUTE(実測で自動生成した道路中心線)を自動運転・CPU車の
        // 走行ラインに使う。単路(片側1車線)なので car2 のような右寄せは行わない。
        car2AutoRoute = CAR2_MOUNTAIN_ROUTE.map(([x, z]) => ({ x, z }));
        spawnCar2LoopCpuCars(car2AutoRoute, cpuCars);
      }
      // 開始位置は「道路の上」: 中心付近を放射状にレイキャストして、
      // 一番よく出てくる高さ(=道路・地表)の中で中心に近い地点を選ぶ。
      // ビルの屋上は高さがバラバラなので最頻値には選ばれない。
      function findRoadSpawn() {
        const samples = [];
        for (let r = 0; r <= 260; r += 12) {
          const n = Math.max(1, Math.round(r / 7));
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const x = Math.cos(a) * r, z = Math.sin(a) * r;
            samples.push({ x, z, y: groundHeightAt(x, 500, z), r });
          }
        }
        const counts = new Map();
        for (const s of samples) {
          const b = Math.round(s.y / 2);
          counts.set(b, (counts.get(b) || 0) + 1);
        }
        let mode = 0, best = -1;
        for (const [b, n] of counts) if (n > best) { best = n; mode = b; }
        const road = samples
          .filter((s) => Math.abs(s.y - mode * 2) <= 1.5)
          .sort((a, b) => a.r - b.r)[0];
        return road || { x: 0, z: 0, y: groundHeightAt(0, 500, 0) };
      }

      if (CAR2_MODE) {
        player.pos.set(CAR2_ROAD_CENTER_X, 0, CAR2_LOOP_ENTRY_Z);
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        player.heading = Math.PI; // 南端から北向きに一本道へ入る
        gameSpawn = {
          x: player.pos.x,
          y: player.pos.y,
          z: player.pos.z,
          heading: player.heading,
        };
        car2LastRoadPos.copy(player.pos);
        document.body.dataset.car2LoopReady = 'true';
        document.body.dataset.car2LoopCount = '0';
        document.body.dataset.car2SpawnOnRoad = String(isCar2RoadAt(player.pos.x, player.pos.z));
      } else if (CAR2_MOUNTAIN_MODE) {
        player.pos.set(MOUNTAIN_ROAD_CENTER_X, 0, MOUNTAIN_LOOP_EDGE_Z - 1);
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        player.heading = Math.PI;   // 南端から北向きにコースへ入る(car2と同じ向き)
        gameSpawn = {
          x: player.pos.x,
          y: player.pos.y,
          z: player.pos.z,
          heading: player.heading,
        };
        document.body.dataset.mountainLoopCount = '0';
      } else if (info.spawn) {
        const sp = info.spawn.getWorldPosition(new THREE.Vector3());
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(info.spawn.getWorldQuaternion(new THREE.Quaternion()));
        player.pos.set(sp.x, 0, sp.z);
        player.heading = Math.atan2(f.x, f.z);
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
      } else {
        const qs = new URLSearchParams(location.search);
        if (qs.get('sx') !== null || qs.get('sz') !== null) {
          player.pos.set(parseFloat(qs.get('sx')) || 0, 0, parseFloat(qs.get('sz')) || 0);
          player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        } else {
          const road = findRoadSpawn();
          player.pos.set(road.x, road.y, road.z);
        }
        player.heading = 0;
      }

      if (SUZUKA_MODE) {
        gameSpawn = {
          x: player.pos.x,
          y: player.pos.y,
          z: player.pos.z,
          heading: player.heading,
        };
      }

      // 日本橋だけ: 元の開始位置から車長1台分後退し、左へ90度向ける。
      if (NIHONBASHI_MODE) {
        const originalHeading = player.heading;
        const carLength = 4.8;
        player.pos.x -= Math.sin(originalHeading) * carLength;
        player.pos.z -= Math.cos(originalHeading) * carLength;
        player.heading += Math.PI / 2;
        player.pos.y = groundHeightAt(player.pos.x, 500, player.pos.z);
        gameSpawn = {
          x: player.pos.x,
          y: player.pos.y,
          z: player.pos.z,
          heading: player.heading,
        };
      }

      const sourceMeshes = cpuMeshes;
      if (SUZUKA_MODE) {
        const race = (info.loops.race || []).sort((a, b) => a.i - b.i);
        const wps = race.map((w) => ({ x: w.p.x, z: w.p.z }));
        const suzukaSpeedsKmh = [90, 92, 94, 96, 98, 100, 102, 104, 106, 110];
        const suzukaRoadCars = cpuCars.filter((car) => !isKabuVoxUrl(car.url));
        const suzukaKabu = cpuCars.find((car) => isKabuVoxUrl(car.url));
        if (wps.length >= 2 && (suzukaRoadCars.length || suzukaKabu)) {
          let roadIdx = 0;   // road 車を順番に使い切る(Kabu枠で番号が飛ばないように)
          suzukaSpeedsKmh.forEach((speedKmh, i) => {
            const useKabu = !!suzukaKabu && i === 5;
            const vehicle = useKabu
              ? suzukaKabu
              : suzukaRoadCars[roadIdx++ % suzukaRoadCars.length];
            if (!vehicle) return;
            const start = Math.floor(i * wps.length / suzukaSpeedsKmh.length);
            const next = (start + 1) % wps.length;
            const a = wps[start], b = wps[next];
            const base = speedKmh / 3.6;
            const g = makeCarGroup(vehicle.mesh.clone(), false, useKabu);
            aiCars.push({
              group: g.group, tilt: g.tilt,
              pos: new THREE.Vector3(a.x, groundHeightAt(a.x, 500, a.z), a.z),
              heading: Math.atan2(b.x - a.x, b.z - a.z),
              v: base * 0.9, base,
              wps, idx: next, radius: carRadiusFor(useKabu), kabu: useKabu,
              cornerSlowdown: 0.08,
            });
          });
        }
      } else {
        const meshPool = sourceMeshes.length
          ? Array.from({ length: 4 }, (_, i) => sourceMeshes[i % sourceMeshes.length].clone())
          : [];
        const customLoopNames = NIHONBASHI_MODE ? [] : Object.keys(info.loops).slice(0, 4);
        customLoopNames.forEach((nm, i) => {
          const wps = info.loops[nm].sort((a, b) => a.i - b.i).map((w) => ({ x: w.p.x, z: w.p.z }));
          if (wps.length < 2) return;
          if (!meshPool[i]) return;
          const g = makeCarGroup(meshPool[i]);
          aiCars.push({
            group: g.group, tilt: g.tilt,
            pos: new THREE.Vector3(wps[0].x, groundHeightAt(wps[0].x, 500, wps[0].z), wps[0].z),
            heading: 0, v: 0, base: 9 + i * 1.5,
            wps, idx: 1, radius: carRadiusFor(false),
          });
        });
      }
      initFx();

      const demoRoute = info.demoRoute || [];
      if (CAR2_MODE || CAR2_MOUNTAIN_MODE) {
        // map2(山岳ラリー)も手描きの経路が無いため、車2と同様に読み込み直後の
        // デモ(小さい円のドリフト周回)には入らない。
        demoActive = false;
        document.body.classList.remove('demo');
      } else if (demoRoute.length >= 2) {
        let demoStart = SUZUKA_MODE ? Math.floor(Math.random() * demoRoute.length) : 0;
        if (SUZUKA_MODE && aiCars.length) {
          for (let offset = 0; offset < demoRoute.length; offset++) {
            const candidate = (demoStart + offset) % demoRoute.length;
            const p = demoRoute[candidate];
            const clear = aiCars.every((ai) => Math.hypot(p.x - ai.pos.x, p.z - ai.pos.z) >= 55);
            if (clear) { demoStart = candidate; break; }
          }
        }
        const randomizedDemoRoute = demoRoute.slice(demoStart).concat(demoRoute.slice(0, demoStart));
        player.pos.set(
          randomizedDemoRoute[0].x,
          groundHeightAt(randomizedDemoRoute[0].x, 500, randomizedDemoRoute[0].z),
          randomizedDemoRoute[0].z
        );
        player.heading = Math.atan2(
          randomizedDemoRoute[1].x - randomizedDemoRoute[0].x,
          randomizedDemoRoute[1].z - randomizedDemoRoute[0].z
        );
        if (SUZUKA_MODE) {
          const demoSpeed = 100 / 3.6;
          player.vel.set(Math.sin(player.heading) * demoSpeed, 0, Math.cos(player.heading) * demoSpeed);
          const nearestCpu = aiCars.length
            ? Math.min(...aiCars.map((ai) => Math.hypot(player.pos.x - ai.pos.x, player.pos.z - ai.pos.z)))
            : Infinity;
          document.body.dataset.demoStartIndex = String(demoStart);
          document.body.dataset.demoCpuGapM = Number.isFinite(nearestCpu) ? nearestCpu.toFixed(1) : 'none';
        }
        enterDemo(randomizedDemoRoute);
      } else {
        // External maps without a route keep the original local drift demo.
        const demoDonut = [];
        const cx = player.pos.x, cz = player.pos.z, R = 24;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          demoDonut.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R });
        }
        enterDemo(demoDonut);
      }

      document.getElementById('loading').remove();
      window.__voxDrive = {
        player, aiCars, start: () => startGame(), inDemo: () => demoActive,
        soundState: () => ({
          mode: soundMode, interior: interiorCurrent,
          lowPaused: interiorLow.paused, highPaused: interiorHigh.paused,
        }),
      };
      window.__mapDebug = {
        camera, scene, mapRoot, THREE, BOUND_X_MIN, BOUND_X_MAX, BOUND_Z,
        freeze: () => { __debugFreezeCam = true; },
        unfreeze: () => { __debugFreezeCam = false; },
      };
      document.body.dataset.aiCarCount = String(aiCars.length);
      document.body.dataset.aiSpeedAverageKmh = aiCars.length
        ? (aiCars.reduce((sum, ai) => sum + ai.base * 3.6, 0) / aiCars.length).toFixed(1)
        : '0.0';
      document.body.dataset.aiSpeedMinKmh = aiCars.length
        ? Math.min(...aiCars.map((ai) => ai.base * 3.6)).toFixed(0)
        : '0';
      document.body.dataset.aiSpeedMaxKmh = aiCars.length
        ? Math.max(...aiCars.map((ai) => ai.base * 3.6)).toFixed(0)
        : '0';
      document.body.dataset.kabuCarCount = String(aiCars.filter((ai) => ai.kabu).length);
      document.body.dataset.cpuUsesPlayerCar = String(cpuCars.some((car) => {
        const file = decodeURIComponent(car.url.split('?')[0].split('/').pop() || '').toLowerCase();
        return RESERVED_VOX_FILES.has(file);
      }));
      document.body.dataset.playerTopSpeedKmh = '180';
      requestAnimationFrame(tick);
      return;
    }

    // spawn in the left lane of a central vertical road, heading +Z
    const spawnRoad = V_ROADS[Math.floor(V_ROADS.length / 2)];
    player.pos.set(spawnRoad.pos + LANE_OFF, 0, 30);
    player.heading = 0;
    // ゲーム開始時(デモ解除時)に戻す通常スポーン
    gameSpawn = { x: spawnRoad.pos + LANE_OFF, z: 30, heading: 0 };

    // waypoints along a sampled route, shifted into the left lane
    function routeWps(pts, step) {
      const wps = [];
      for (let i = 0; i < pts.length; i += step) {
        const p = pts[i], q = pts[(i + step) % pts.length];
        const dx = q.x - p.x, dz = q.z - p.z;
        const l = Math.hypot(dx, dz) || 1;
        wps.push({ x: p.x + (dz / l) * LANE_OFF, z: p.z - (dx / l) * LANE_OFF });
      }
      return wps;
    }

    // 発見した全車種を使用。ジオメトリは車種ごとに1つだけ持ち、
    // シャドウマップ描画は省く(接地影は残る)。

    // グリッドと外周環状道路に複数の周回コースを用意する。
    const vLast = V_ROADS.length - 1, hLast = H_ROADS.length - 1;
    const loopDefs = [
      rectLoop(V_ROADS[0].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[hLast].pos, false),
      rectLoop(V_ROADS[1].pos, V_ROADS[Math.min(2, vLast)].pos, H_ROADS[1].pos, H_ROADS[Math.min(2, hLast)].pos, true),
      rectLoop(V_ROADS[Math.min(2, vLast)].pos, V_ROADS[vLast].pos, H_ROADS[0].pos, H_ROADS[Math.min(2, hLast)].pos, true),
      rectLoop(V_ROADS[0].pos, V_ROADS[Math.min(2, vLast)].pos, H_ROADS[Math.min(1, hLast)].pos, H_ROADS[hLast].pos, false),
      rectLoop(-CITY_EDGE, CITY_EDGE, -CITY_EDGE, CITY_EDGE, true),
      routeWps(forestLoop, 5),
    ];

    // ルートの周長に沿って startFrac の位置へ配置(車どうしが重ならないよう分散)
    function placeOnLoop(wps, mesh, startFrac, base, bike) {
      const seg = [];
      let total = 0;
      for (let i = 0; i < wps.length; i++) {
        const a = wps[i], b = wps[(i + 1) % wps.length];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        seg.push(d); total += d;
      }
      let dist = startFrac * total, s = 0;
      while (dist > seg[s]) { dist -= seg[s]; s = (s + 1) % wps.length; }
      const a = wps[s], b = wps[(s + 1) % wps.length];
      const t = seg[s] ? dist / seg[s] : 0;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      const g = makeCarGroup(mesh, false, bike);
      aiCars.push({
        group: g.group, tilt: g.tilt,
        pos: new THREE.Vector3(px, 0, pz),
        heading: Math.atan2(b.x - a.x, b.z - a.z), v: 0, base,
        wps, idx: (s + 1) % wps.length, radius: carRadiusFor(bike),
      });
    }

    // 緊急指令のシナリオを先に読み込む。犯人と同じ車種は一般CPU車として出さない
    // (見た目が同じ車が複数走ると、どれが犯人か分からなくなるため)。
    missionScenarios = await loadScenarios();
    missionCpuCars = cpuCars;             // 犯人メッシュ参照用に全車種を保持
    missionRingWps = loopDefs[4];         // 外周環状(フォールバック)
    // 犯人は毎回いろいろなコースを走る: 外周・大ブロック区画・環状・森林(小さすぎる
    // 1ブロックの loopDefs[1] は除外)。
    missionRoutes = [loopDefs[0], loopDefs[2], loopDefs[3], loopDefs[4], loopDefs[5]]
      .filter((r) => r && r.length >= 2);
    missionEnabled = missionScenarios.length > 0 && missionCpuCars.length > 0;
    // 犯人と同じ「車種」(色違い含むベースモデル)は一般CPU車から一切除外する。
    // 例: 犯人が nissan180sx3(白の180SX)なら nissan180sx0/1/2 も出さない。
    const scenarioModels = new Set(missionScenarios.map((s) => voxBaseModel(s.car)));
    const trafficCars = cpuCars.filter((c) => !scenarioModels.has(voxBaseModel(c.url)));
    const trafficMeshes = trafficCars.map((c) => c.mesh);

    // CPU 車をグリッドの5コースへ散らす(デモは別コースなので全ループを使う)
    trafficMeshes.forEach((mesh, i) => {
      const bike = /(^|\/)kabu\d*\.vox$/i.test(trafficCars[i].url);   // スーパーカブはバイク
      const loop = loopDefs[i % loopDefs.length];
      const frac = (i * 0.37) % 1;         // ルート上に散らす
      placeOnLoop(loop, mesh, frac, 7 + (i % 5), bike);   // 25〜40 km/h でばらつき
    });

    const buildingMeshes = BUILDING_VOX.length
      ? await Promise.all(BUILDING_VOX.map((u) => VOX.load(u, { scale: VOXEL_SCALE })))
      : null;
    placeBuildings(buildingMeshes);
    scatterTrees([tree1, tree2], mulberry32(20260711));
    initFx();

    // ドリフトコースにも CPU 車を2台流す(グリッドの車を奪わないよう clone)
    // CPU アセットが少ない場合も、初期ロード済みの車を代替に使う。
    const driftCpuA = trafficMeshes[13] || trafficMeshes[0] || cpuMeshes[0];
    const driftCpuB = trafficMeshes[22] || trafficMeshes[1] || cpuMeshes[1] || cpuMeshes[0];
    if (driftCpuA) placeOnLoop(driftLoopPts, driftCpuA.clone(), 0.0, 8, false);
    if (driftCpuB) placeOnLoop(driftLoopPts, driftCpuB.clone(), 0.5, 7, false);

    // ワンダーランドのデモ場所は、街・外周・森林・峠から毎回ランダム。
    // 同じコースが選ばれても開始地点をずらす。
    const demoCandidates = [...loopDefs, driftLoopPts].filter((route) => route && route.length >= 2);
    const pickedDemoRoute = demoCandidates[Math.floor(Math.random() * demoCandidates.length)];
    const demoStartIndex = Math.floor(Math.random() * pickedDemoRoute.length);
    const randomDemoRoute = pickedDemoRoute
      .slice(demoStartIndex)
      .concat(pickedDemoRoute.slice(0, demoStartIndex));
    const ds = randomDemoRoute[0], dn = randomDemoRoute[1];
    player.pos.set(ds.x, courseHeightAt(ds.x, ds.z), ds.z);
    player.heading = Math.atan2(dn.x - ds.x, dn.z - ds.z);
    enterDemo(randomDemoRoute);
    document.getElementById('loading').remove();
    window.__voxDrive = { player, aiCars, start: () => startGame(), inDemo: () => demoActive, mission };
    document.body.dataset.aiCarCount = String(aiCars.length);
    document.body.dataset.aiSpeedAverageKmh = aiCars.length
      ? (aiCars.reduce((sum, ai) => sum + ai.base * 3.6, 0) / aiCars.length).toFixed(1)
      : '0.0';
    document.body.dataset.cpuUsesPlayerCar = String(cpuCars.some((car) => {
      const file = decodeURIComponent(car.url.split('?')[0].split('/').pop() || '').toLowerCase();
      return RESERVED_VOX_FILES.has(file);
    }));
    document.body.dataset.playerTopSpeedKmh = '180';
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------- demo -----
  // デモ開始: 自動運転ルートをセットしてデモ画面に入る。
  function enterDemo(route) {
    demoRoute = route && route.length >= 2 ? route : null;
    demoIdx = 1;
    demoActive = !!demoRoute;
    if (demoActive) {
      document.body.classList.add('demo');
      demoCam.nextChange = performance.now() + 6000;
      demoCam.until = 0;
    }
  }

  // ユーザー操作でデモを抜けてゲーム開始(startGame は先頭で let 宣言済み)。
  startGame = function () {
    if (!demoActive) return;
    demoActive = false;
    document.body.classList.remove('demo');
    player.vel.set(0, 0, 0);
    player.drifting = false;
    player.gear = 2;
    player.steer = 0;
    if (gameSpawn) {                 // デモの位置(コース上)から通常スポーンへ戻す
      const spawnY = Number.isFinite(gameSpawn.y)
        ? gameSpawn.y
        : courseHeightAt(gameSpawn.x, gameSpawn.z);
      player.pos.set(gameSpawn.x, spawnY, gameSpawn.z);
      player.heading = gameSpawn.heading;
    }
    cam.yaw = 0; cam.pitch = 0.34; cam.dist = 10; cam.lastDrag = 0;

    // 緊急指令の開始: プレイ開始1分後に1件目、以降は解決の1分後に次の1件。
    if (missionEnabled && mission.phase === 'off') {
      mission.queue = missionScenarios.map((_, i) => i);
      for (let i = mission.queue.length - 1; i > 0; i--) {   // シャッフル
        const j = Math.floor(Math.random() * (i + 1));
        [mission.queue[i], mission.queue[j]] = [mission.queue[j], mission.queue[i]];
      }
      mission.phase = 'waiting';
      mission.nextAt = performance.now() + 60000;
    }
  };

  // ------------------------------------------------- car2 demo (attract) --
  // タイトル5秒放置でデモ画面へ。道路中央ラインを自動走行で回遊し、
  // 何かボタン/タップでタイトルへ戻る。スワイプ(ドラッグ)はカメラ移動。
  // デモ中は10秒ごとに昼夜が切り替わる。
  let demoTapMove = 1e9;             // タップ/スワイプ判定(移動量合計)
  let demoDayNightAt = 0;            // 次に昼夜を切り替える時刻
  let demoPrevSoundMode = 0;         // デモ前の音声モード(戻すときに復元)
  function enterCar2Demo() {
    if (!CAR2_MODE || !car2AutoRoute || car2AutoRoute.length < 2 || demoActive) return false;
    // スポーンに最も近いルート地点からデモ走行を始める
    let best = 0, bestD2 = Infinity;
    for (let i = 0; i < car2AutoRoute.length; i++) {
      const d2 = (car2AutoRoute[i].x - player.pos.x) ** 2 + (car2AutoRoute[i].z - player.pos.z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    const route = car2AutoRoute.slice(best).concat(car2AutoRoute.slice(0, best));
    player.vel.set(0, 0, 0);
    player.drifting = false;
    const hint = document.querySelector('#demo .hint');
    if (hint) hint.textContent = '何かボタンでタイトルへ / スワイプでカメラ';
    demoDayNightAt = performance.now() + 10000;
    bonnetView = 0;                  // デモは通常カメラで車を映す
    autoIdx = -1;                    // 自動運転をデモ開始位置から再同期
    demoPrevSoundMode = soundMode;   // デモ中の音声は車内音
    soundMode = 1;
    applySoundMode();
    enterDemo(route);
    return true;
  }
  function exitCar2Demo() {
    if (!demoActive) return;
    demoActive = false;
    document.body.classList.remove('demo');
    if (nightMode) { nightMode = false; applyNight(); }   // タイトルへは昼で戻る
    soundMode = demoPrevSoundMode;   // 音声モードをデモ前の状態へ戻す
    applySoundMode();
    player.vel.set(0, 0, 0);
    player.drifting = false;
    player.gear = 2;
    player.steer = 0;
    if (gameSpawn) {
      player.pos.set(gameSpawn.x, gameSpawn.y ?? 0, gameSpawn.z);
      player.heading = gameSpawn.heading;
      car2LastRoadPos.copy(player.pos);
    }
    cam.yaw = 0; cam.pitch = 0.34; cam.dist = 10; cam.lastDrag = 0;
    if (window.__titleT) window.__titleT.show();
  }
  window.__car2Demo = { enter: enterCar2Demo };

  // ルートを追い、コーナーでは積極的にサイドブレーキでドリフトする自動運転。
  function demoAutopilot() {
    const wp = demoRoute[demoIdx];
    const dx = wp.x - player.pos.x, dz = wp.z - player.pos.z;
    // car2の一本道: ループ継ぎ目で次の目標が遠い間は直進し、ワープ後に再開
    if (CAR2_MODE && dx * dx + dz * dz > 80 * 80) {
      return { throttle: true, brake: false, handbrake: false, steer: 0 };
    }
    if (dx * dx + dz * dz < 9 * 9) demoIdx = (demoIdx + 1) % demoRoute.length;
    let diff = Math.atan2(dx, dz) - player.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const speed = player.vel.length();
    return {
      throttle: true,
      brake: false,
      handbrake: Math.abs(diff) > 0.35 && speed > 7,   // コーナーでドリフト
      steer: clamp(diff * 1.6, -1, 1),
    };
  }

  // ------------------------------------------------------------- music ----
  // M: 音楽選択モード。musiclist.txt の「」内をリスト表示し、↑↓で選択・
  // Enterで再生・Mで閉じる。開いている間は運転(シミュレーション)を停止する。
  // 行内の「」ラベルと URL 以外の文言(色コード等)は無視する。
  // YouTube は IFrame API、ネットラジオは HTMLAudio(HLS は hls.js)で再生。
  let musicMode = false;
  let musicItems = [];
  let musicSel = 0;
  let musicMenuEl = null;
  let musicListEl = null;
  let musicAudio = null;
  let musicHls = null;
  let musicVolume = 0.8;
  let engineVolume = 1.0;
  let ytPlayer = null;
  let ytHolder = null;

  async function loadMusicList() {
    try {
      const res = await fetch('musiclist.txt', { cache: 'no-store' });
      if (!res.ok) return;
      for (const raw of (await res.text()).split(/\r?\n/)) {
        const label = raw.match(/「(.+?)」/);
        if (!label) continue;
        const url = (raw.match(/https?:\/\/[^\s「」]+/) || [null])[0];
        const type = url
          ? (/youtube\.com|youtu\.be/.test(url) ? 'yt' : 'radio')
          : 'playlist';
        musicItems.push({ label: label[1], url, type });
      }
      document.body.dataset.musicItemCount = String(musicItems.length);
    } catch (_) { /* 音楽リストが無くても走行には影響しない */ }
  }

  function applyMusicVolume() {
    if (musicAudio) musicAudio.volume = musicVolume;
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(Math.round(musicVolume * 100));
  }

  // 再生中は画面最下部中央に「」の中身を青緑色で表示する(G の表示切替で消える)。
  let nowPlayingEl = null;
  let nowPlayingText = '';
  function updateNowPlayingVisibility() {
    // 音楽(曲名)表示は hudState 0/1/3 のとき(2=スピードのみ, 4=何もなし)
    const musicVisible = hudState === 0 || hudState === 1 || hudState === 3;
    if (nowPlayingEl) {
      nowPlayingEl.style.display = (nowPlayingText && musicVisible) ? 'block' : 'none';
    }
  }
  function setNowPlaying(text) {
    nowPlayingText = text || '';
    if (!nowPlayingEl) {
      // 大きめ・細字・くっきりした青緑。にじむ影ではなく締まった輪郭で読ませる。
      nowPlayingEl = document.createElement('div');
      nowPlayingEl.style.cssText = 'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);'
        + 'z-index:5;color:#00ffd5;font-weight:400;font-size:21px;letter-spacing:1.5px;'
        + 'text-shadow:0 1px 2px rgba(0,0,0,0.95),0 0 1px rgba(0,0,0,0.9);'
        + 'pointer-events:none;white-space:nowrap;'
        + 'font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;';
      document.body.appendChild(nowPlayingEl);
    }
    nowPlayingEl.textContent = nowPlayingText ? '♪ ' + nowPlayingText : '';
    updateNowPlayingVisibility();
  }

  function stopMusic() {
    if (musicHls) { musicHls.destroy(); musicHls = null; }
    if (musicAudio) { musicAudio.pause(); musicAudio = null; }
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  }

  // 再生中の項目を再生する。終了したら次の再生可能な曲へ自動で進む。
  // isAuto=true は連続再生(自動送り)による開始。エラー時の挙動が変わる:
  //   手動選択の曲のエラー → 飛ばさず「エラー」を表示して停止
  //   連続再生中のエラー   → スキップして次の曲へ
  let musicAutoAdvance = false;
  function playCurrent(isAuto) {
    const it = musicItems[musicSel];
    if (!it || !it.url) return false;
    musicAutoAdvance = !!isAuto;
    stopMusic();
    if (it.type === 'yt') playYouTube(it.url);
    else playRadio(it.url);
    setNowPlaying(it.label);
    musicMenuRefresh();
    return true;
  }
  function playNext(isAuto = true) {
    for (let step = 1; step <= musicItems.length; step++) {
      const idx = (musicSel + step) % musicItems.length;
      if (musicItems[idx].url) { musicSel = idx; playCurrent(isAuto); return; }
    }
  }
  function playPrev() {
    for (let step = 1; step <= musicItems.length; step++) {
      const idx = (musicSel - step + musicItems.length * 2) % musicItems.length;
      if (musicItems[idx].url) { musicSel = idx; playCurrent(); return; }
    }
  }
  // 再生エラー時の共通処理(YouTube・ラジオ共用)
  function handlePlaybackError() {
    const it = musicItems[musicSel];
    const label = it ? it.label : '';
    if (musicAutoAdvance) {
      musicToast('⚠ 「' + label + '」を再生できないためスキップ');
      playNext();
    } else {
      musicToast('⚠ エラー: 「' + label + '」を再生できません');
      setNowPlaying(label + '（エラー）');
    }
  }

  // スキップ等の通知を曲名表示の少し上に数秒だけ出す。
  let musicToastEl = null;
  let musicToastTimer = 0;
  function musicToast(text) {
    if (!musicToastEl) {
      musicToastEl = document.createElement('div');
      musicToastEl.style.cssText = 'position:fixed;left:50%;bottom:44px;transform:translateX(-50%);'
        + 'z-index:5;color:#ffb14a;font-size:14px;letter-spacing:1px;'
        + 'text-shadow:0 1px 2px rgba(0,0,0,0.9);pointer-events:none;white-space:nowrap;'
        + 'font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;';
      document.body.appendChild(musicToastEl);
    }
    musicToastEl.textContent = text;
    musicToastEl.style.display = 'block';
    clearTimeout(musicToastTimer);
    musicToastTimer = setTimeout(() => { musicToastEl.style.display = 'none'; }, 4000);
  }

  // J/K/L: 10秒巻き戻し / 再生・一時停止 / 10秒早送り。運転中も有効。
  function musicSeek(sec) {
    if (musicAudio) {
      try { musicAudio.currentTime = Math.max(0, musicAudio.currentTime + sec); } catch (_) {}
    } else if (ytPlayer && ytPlayer.getCurrentTime) {
      ytPlayer.seekTo(Math.max(0, ytPlayer.getCurrentTime() + sec), true);
    }
  }
  function musicTogglePlay() {
    if (musicAudio) {
      if (musicAudio.paused) musicAudio.play().catch(() => {});
      else musicAudio.pause();
    } else if (ytPlayer && ytPlayer.getPlayerState) {
      const state = ytPlayer.getPlayerState();
      if (state === 1 || state === 3) ytPlayer.pauseVideo();   // 再生/バッファ中は停止
      else ytPlayer.playVideo();
    }
  }

  function playRadio(url) {
    musicAudio = new Audio();
    musicAudio.volume = musicVolume;
    musicAudio.addEventListener('ended', playNext);   // 終了で次の曲へ
    musicAudio.addEventListener('error', handlePlaybackError);
    const start = () => musicAudio && musicAudio.play().catch((e) => console.warn('ラジオを再生できませんでした:', url, e));
    if (/\.m3u8/.test(url)) {
      // HLS ストリームはブラウザ単体で鳴らないため hls.js を遅延読み込み
      const ready = () => {
        if (window.Hls && window.Hls.isSupported()) {
          musicHls = new window.Hls();
          musicHls.loadSource(url);
          musicHls.attachMedia(musicAudio);
          start();
        } else { musicAudio.src = url; start(); }
      };
      if (window.Hls) ready();
      else {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
        script.onload = ready;
        script.onerror = () => { musicAudio.src = url; start(); };
        document.head.appendChild(script);
      }
    } else {
      musicAudio.src = url;
      start();
    }
  }

  function youtubeId(url) {
    const m = url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  let ytPendingId = null;
  let ytCurrentId = null;            // 直近に再生を要求した動画ID
  function playYouTube(url) {
    const id = youtubeId(url);
    if (!id) return;
    ytCurrentId = id;
    if (!ytHolder) {
      // 音声再生のみ: プレイヤーは縮小せずフルサイズのまま画面外に置く。
      // 1px化や opacity:0 だと「隠された埋め込み」とみなされ、音楽系動画が
      // エラー150(再生拒否)になりやすい(shuto で実績のある方式に合わせる)。
      ytHolder = document.createElement('div');
      ytHolder.style.cssText = 'position:fixed;top:-400px;left:-400px;'
        + 'width:400px;height:300px;pointer-events:none;';
      const inner = document.createElement('div');
      inner.id = 'yt-player';
      ytHolder.appendChild(inner);
      document.body.appendChild(ytHolder);
    }
    if (ytPlayer && ytPlayer.loadVideoById) {
      ytPlayer.setVolume(Math.round(musicVolume * 100));
      ytPlayer.loadVideoById(id);
      return;
    }
    ytPendingId = id;
    const create = () => {
      // ffffx.html で実績のある構成: ダミーIDで一度だけ生成し(autoplay:0)、
      // 以後は loadVideoById で曲を切り替える。
      ytPlayer = new window.YT.Player('yt-player', {
        width: 400, height: 300, videoId: '3Fy8XYr6J6s',
        playerVars: { autoplay: 0, controls: 0, fs: 0 },
        events: {
          onReady: (ev) => {
            ev.target.setVolume(Math.round(musicVolume * 100));
            if (ytPendingId) ev.target.loadVideoById(ytPendingId);
          },
          // 再生終了(state=0)で次の曲を自動再生
          onStateChange: (ev) => { if (ev.data === 0) playNext(); },
          // 再生できない動画は通知を出して次の曲へスキップ。
          // ただし初期化用ダミーや切替前の動画のエラーを、選択曲のエラーと
          // 誤認してスキップしないよう、エラー対象のIDを確認する。
          onError: (ev) => {
            let errorVideoId = null;
            try {
              errorVideoId = ytPlayer && ytPlayer.getVideoData
                ? ytPlayer.getVideoData().video_id : null;
            } catch (_) { /* 取得できない場合は選択曲のエラーとして扱う */ }
            if (errorVideoId && ytCurrentId && errorVideoId !== ytCurrentId) {
              console.warn('YouTube再生エラー(対象外の動画のため無視):', ev.data, errorVideoId);
              return;
            }
            console.warn('YouTube再生エラー:', ev.data);
            handlePlaybackError();
          },
        },
      });
    };
    if (window.YT && window.YT.Player) create();
    else if (!document.getElementById('yt-api')) {
      const script = document.createElement('script');
      script.id = 'yt-api';
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(script);
      window.onYouTubeIframeAPIReady = create;
    }
  }

  function musicMenuRefresh() {
    if (!musicListEl) return;
    const rows = musicListEl.children;
    for (let i = 0; i < rows.length; i++) {
      // 緑液晶に濃いグレーの太字。選択中は反転表示+行頭を▶に(他は■)
      rows[i].style.background = i === musicSel ? '#2e342e' : 'transparent';
      rows[i].style.color = i === musicSel ? '#33CC33' : '#2e342e';
      const item = musicItems[i];
      if (item) rows[i].textContent = (i === musicSel ? '▶ ' : '■ ') + item.label;
    }
    const row = rows[musicSel];
    // offsetTop は共通の親基準なのでリスト自身の位置を引いて中央に合わせる
    if (row) {
      musicListEl.scrollTop = (row.offsetTop - musicListEl.offsetTop) - musicListEl.clientHeight / 2 + 14;
    }
  }

  function openMusicMenu() {
    if (!musicMenuEl) {
      musicMenuEl = document.createElement('div');
      musicMenuEl.style.cssText = 'position:fixed;inset:0;z-index:8;display:flex;'
        + 'align-items:center;justify-content:center;background:rgba(8,14,20,0.22);';
      // 80年代のオーディオ機器風: 黒パネル+白の二重枠、等幅フォントの見出し、
      // オレンジ液晶の音量メーター、青緑液晶の曲リスト。
      // ゲーム画面より小さいコンパクトな窓(縦長にしない。リストは少行数+高速スクロール)
      const panel = document.createElement('div');
      panel.style.cssText = 'width:min(520px,76vw);max-height:82vh;display:flex;flex-direction:column;'
        + 'overflow:hidden;'
        + 'background:#0a0a0a;border:3px double #fff;border-radius:0;padding:10px 14px;color:#fff;'
        + 'font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;';
      const title = document.createElement('div');
      title.textContent = '♪ MUSIC SELECT';
      title.style.cssText = 'font-weight:700;margin-bottom:12px;letter-spacing:2px;'
        + 'font-family:"Courier New",monospace;color:#fff;'
        + 'border-bottom:1px solid #fff;padding-bottom:8px;';
      panel.appendChild(title);
      // 音量メーター: オレンジ液晶バックに黒(濃いグレー)のセグメントが横に連なる
      const makeSlider = (labelText, value, oninput) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;margin:0 0 8px;';
        const caption = document.createElement('span');
        caption.textContent = labelText;
        caption.style.cssText = 'width:120px;flex:none;color:#333029;font-weight:900;'
          + 'letter-spacing:1px;font-size:19px;'
          + 'font-family:"MS Gothic","ＭＳ ゴシック","Courier New",monospace;';
        const SEGS = 24;
        const meter = document.createElement('div');
        meter.style.cssText = 'flex:1;display:flex;gap:3px;align-items:center;height:28px;'
          + 'padding:5px 8px;box-sizing:border-box;cursor:pointer;'
          + 'border:1px solid rgba(0,0,0,0.35);';
        const cells = [];
        for (let i = 0; i < SEGS; i++) {
          const cell = document.createElement('div');
          cell.style.cssText = 'flex:1;height:14px;';
          meter.appendChild(cell);
          cells.push(cell);
        }
        // 音量の数値表示(%)
        const readout = document.createElement('span');
        readout.style.cssText = 'width:60px;flex:none;text-align:right;color:#333029;'
          + 'font-family:"MS Gothic","ＭＳ ゴシック","Courier New",monospace;'
          + 'font-weight:900;font-size:19px;';
        const render = (v) => {
          const lit = Math.round(v * SEGS);
          cells.forEach((cell, i) => {
            // 点灯セグメント=濃いグレー(黒) / 消灯=液晶のゴースト表示
            cell.style.background = i < lit ? '#333029' : 'rgba(0,0,0,0.12)';
          });
          readout.textContent = Math.round(v * 100) + '%';
        };
        render(value);
        const setFromEvent = (ev) => {
          const rect = meter.getBoundingClientRect();
          const v = Math.max(0, Math.min(1, (ev.clientX - rect.left - 8) / (rect.width - 16)));
          render(v);
          oninput(v);
        };
        let meterDragging = false;
        meter.addEventListener('pointerdown', (ev) => {
          meterDragging = true;
          meter.setPointerCapture(ev.pointerId);
          setFromEvent(ev);
        });
        meter.addEventListener('pointermove', (ev) => { if (meterDragging) setFromEvent(ev); });
        meter.addEventListener('pointerup', () => { meterDragging = false; });
        wrap.appendChild(caption);
        wrap.appendChild(meter);
        wrap.appendChild(readout);
        return wrap;
      };
      // 音量部分: 全体をオレンジ液晶の1パネルにまとめる
      const volPanel = document.createElement('div');
      volPanel.style.cssText = 'background:linear-gradient(180deg,#ffb62e,#f79a10);'
        + 'border:1px solid #666;padding:9px 12px 3px;margin:0 0 10px;';
      volPanel.appendChild(makeSlider('環境音量', engineVolume, (v) => {
        engineVolume = v;
        AUDIO.setVolume(v);
        interiorLow.volume = interiorHigh.volume = 0.85 * v;
      }));
      volPanel.appendChild(makeSlider('音楽音量', musicVolume, (v) => {
        musicVolume = v;
        applyMusicVolume();
      }));
      panel.appendChild(volPanel);
      musicListEl = document.createElement('div');
      // 曲リスト: 青緑液晶バックに濃いグレーの太字(液晶風の等幅ゴシック)。
      // スクロールバーは表示しない(十字キー上下の高速閲覧で移動する)。
      musicListEl.style.cssText = 'overflow-y:hidden;font-size:19px;line-height:1.55;'
        + 'height:min(314px,36vh);flex:none;margin-top:4px;padding:6px 4px;border:1px solid #666;'
        + 'font-family:"MS Gothic","ＭＳ ゴシック","Courier New",monospace;'
        + 'font-weight:900;-webkit-text-stroke:0.5px currentColor;'
        + 'background:#33CC33;';
      musicItems.forEach((it, i) => {
        const row = document.createElement('div');
        // 行頭は ■ で統一し、カーソルが合っている行だけ ▶ にする(refreshで更新)
        row.textContent = '■ ' + it.label;
        row.style.cssText = 'padding:1px 10px;border-radius:0;white-space:nowrap;'
          + 'overflow:hidden;color:#2e342e;cursor:pointer;';
        // マウス操作: クリックで選択、ダブルクリックで再生
        row.addEventListener('click', () => { musicSel = i; musicMenuRefresh(); });
        row.addEventListener('dblclick', () => {
          musicSel = i;
          if (playCurrent()) closeMusicMenu();
        });
        musicListEl.appendChild(row);
      });
      panel.appendChild(musicListEl);
      // マウスホイールで選択を上下に送る(1ノッチ=1行)
      musicMenuEl.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        if (!musicItems.length) return;
        const step = Math.sign(ev.deltaY);
        musicSel = (musicSel + step + musicItems.length) % musicItems.length;
        musicMenuRefresh();
      }, { passive: false });
      musicMenuEl.appendChild(panel);
      document.body.appendChild(musicMenuEl);
    }
    musicMode = true;
    for (const key of Object.keys(keys)) keys[key] = false;   // 押しっぱなし解除
    musicMenuEl.style.display = 'flex';
    musicMenuRefresh();
    document.body.dataset.musicMode = 'true';
  }
  function closeMusicMenu() {
    musicMode = false;
    if (musicMenuEl) musicMenuEl.style.display = 'none';
    document.body.dataset.musicMode = 'false';
  }
  // musicMode 中のキー処理。運転側へはキーを渡さない。
  // ↑↓は押しっぱなし(リピート)で3行ずつ進み、高速に閲覧できる。
  function musicKeydown(k, isRepeat) {
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      if (musicItems.length) {
        const dir = (k === 'ArrowUp' ? -1 : 1) * (isRepeat ? 3 : 1);
        musicSel = (musicSel + dir + musicItems.length * 3) % musicItems.length;
      }
      musicMenuRefresh();
    } else if (k === 'Enter') {
      if (playCurrent()) closeMusicMenu();
    }
  }
  loadMusicList();

  // Y: 自動運転。道路中央のライン(CAR2_CPU_ROUTE)を追従し、平均130km/hで
  // 走り続ける。直角に近い急カーブではサイドブレーキでドリフトする。
  function car2Autopilot() {
    const wps = car2AutoRoute;
    const n = wps.length;
    const speed = player.vel.length();
    const angleTo = (p) => {
      let a = Math.atan2(p.x - player.pos.x, p.z - player.pos.z) - player.heading;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    // 開始時・ループ端ワープ後は最寄りの少し先へ再同期する
    if (autoIdx < 0
        || Math.hypot(wps[autoIdx].x - player.pos.x, wps[autoIdx].z - player.pos.z) > 80) {
      let best = 0, bestD2 = Infinity;
      for (let i = 0; i < n; i++) {
        const d2 = (wps[i].x - player.pos.x) ** 2 + (wps[i].z - player.pos.z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      autoIdx = (best + 1) % n;
      // ループ地点の継ぎ目(次の目標が遠い)は直進で通過し、ワープ後に再同期
      if (Math.hypot(wps[autoIdx].x - player.pos.x, wps[autoIdx].z - player.pos.z) > 80) {
        return { throttle: true, brake: false, handbrake: false, steer: 0 };
      }
    }
    let wp = wps[autoIdx];
    const reach = Math.max(9, speed * 0.4);
    if (Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) < reach) {
      autoIdx = (autoIdx + 1) % n;
      wp = wps[autoIdx];
    }
    const diff = angleTo(wp);
    const diffFar = angleTo(wps[(autoIdx + 2) % n]);   // 先読みでカーブの深さを見る
    // 急カーブ(直角に近い)はドリフトで曲がる
    const sharp = Math.abs(diffFar) > 0.55 || Math.abs(diff) > 0.5;
    let target = 130 / 3.6;                            // 巡航 130km/h
    if (Math.abs(diffFar) > 0.35) target = 26;         // カーブ手前は減速
    if (Math.abs(diffFar) > 0.7) target = 19;
    return {
      throttle: speed < target,
      brake: speed > target + 3,
      handbrake: sharp && speed > 14,
      steer: clamp(diff * (player.drifting ? 2.2 : 1.6), -1, 1),
    };
  }

  // ------------------------------------------------------------ mission ---
  const missionPopupEl = document.getElementById('mission-popup');
  const missionObjEl = document.getElementById('mission-obj');
  let missionPopupTimer = 0;

  // ゲームシナリオ.txt を読む。失敗しても既定の5件で動くようにする。
  function parseScenarios(text) {
    const out = [];
    let car = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const mCar = line.match(/^車両[:：]\s*(.+)$/);
      const mMsg = line.match(/^指令[:：]\s*(.+)$/);
      if (mCar) car = mCar[1].trim();
      else if (mMsg && car) { out.push({ car, msg: mMsg[1].trim() }); car = null; }
    }
    return out;
  }
  async function loadScenarios() {
    try {
      const res = await fetch(encodeURIComponent('ゲームシナリオ') + '.txt', { cache: 'no-store' });
      if (res.ok) {
        const sc = parseScenarios(await res.text());
        if (sc.length) return sc;
      }
    } catch (_) { /* フォールバックへ */ }
    return [
      { car: 'nissan180sx3.vox', msg: '本部より緊急指令!管内で銀行強盗が発生した。逃亡中の白い日産180SXを追跡、確保せよ。' },
      { car: 'keitora03.vox', msg: '本部より緊急指令!管内で銅線ケーブルの盗難が発生した。逃亡している緑の軽トラを追跡、確保せよ。' },
      { car: 'nissan180sx2.vox', msg: '本部より緊急指令!管内で宝石店強盗が発生した。逃走中の赤い日産180SXを追跡、確保せよ。' },
      { car: 'nissan2.vox', msg: '本部より緊急指令!管内でひったくりが多発している。逃走中の青い日産セダンを追跡、確保せよ。' },
      { car: 'nissan3.vox', msg: '本部より緊急指令!管内で車上荒らしが発生した。逃走中の黄色い日産セダンを追跡、確保せよ。' },
    ];
  }

  function missionPopup(text, kind) {
    missionPopupEl.className = kind === 'caught' ? 'caught' : 'command';
    const head = kind === 'caught' ? 'CASE CLOSED' : '緊急指令 / EMERGENCY';
    missionPopupEl.innerHTML = '<span class="head"></span>';
    missionPopupEl.firstChild.textContent = head;
    missionPopupEl.appendChild(document.createTextNode(text));
    missionPopupEl.classList.add('show');
    clearTimeout(missionPopupTimer);
    missionPopupTimer = setTimeout(() => missionPopupEl.classList.remove('show'), kind === 'caught' ? 2800 : 6500);
  }
  function missionObjective(text) {
    if (text) { missionObjEl.textContent = '🚨 追跡中: ' + text; missionObjEl.classList.add('show'); }
    else missionObjEl.classList.remove('show');
  }
  function missionTargetLabel(msg) {
    const m = msg.match(/(?:逃亡中の|逃走中の|逃亡している|逃走している)(.{2,24}?)を(?:追跡|確保)/)
      || msg.match(/([^。、]{2,24}?)を(?:追跡|確保)/)
      || msg.match(/([^。、]{2,24}?)が(?:逃走|逃亡)/);
    return m ? m[1] : '犯人車両';
  }
  function missionFindMesh(carFile) {
    const enc = encodeURIComponent(carFile);
    const hit = missionCpuCars.find((c) => c.url.endsWith(enc) || c.url.endsWith('/' + carFile));
    return (hit || missionCpuCars[0] || {}).mesh || null;
  }

  function missionIssue() {
    const idx = mission.queue.shift();
    const sc = missionScenarios[idx];
    const mesh = missionFindMesh(sc.car);
    const routes = (missionRoutes && missionRoutes.length) ? missionRoutes
      : (missionRingWps ? [missionRingWps] : null);
    if (!mesh || !routes) {                      // 車両/コースが無ければスキップして次へ
      mission.phase = mission.queue.length ? 'waiting' : 'done';
      mission.nextAt = performance.now() + 60000;
      return;
    }
    const wps = routes[Math.floor(Math.random() * routes.length)];   // 毎回ランダムなコース
    const s = Math.floor(Math.random() * wps.length);
    const a = wps[s], b = wps[(s + 1) % wps.length];
    const bike = /(^|\/)kabu\d*\.vox$/i.test(sc.car);   // カブはバイク: 影・当たりを小さく
    const g = makeCarGroup(mesh.clone(), false, bike);
    const crim = {
      group: g.group, tilt: g.tilt,
      pos: new THREE.Vector3(a.x, 0, a.z),
      heading: Math.atan2(b.x - a.x, b.z - a.z), v: 0, base: 30,   // 30 m/s = 108 km/h
      wps, idx: (s + 1) % wps.length, radius: carRadiusFor(bike), criminal: true,
    };
    aiCars.push(crim);
    mission.active = crim;
    mission.phase = 'active';
    missionPopup(sc.msg, 'command');
    missionObjective(missionTargetLabel(sc.msg));
  }
  function missionCapture() {
    const c = mission.active;
    if (c) {
      scene.remove(c.group);
      const i = aiCars.indexOf(c);
      if (i >= 0) aiCars.splice(i, 1);
    }
    mission.active = null;
    missionPopup('犯人確保!', 'caught');
    missionObjective('');
    if (mission.queue.length) { mission.phase = 'waiting'; mission.nextAt = performance.now() + 60000; }
    else mission.phase = 'done';
  }
  function updateMission() {
    if (!missionEnabled || demoActive) return;
    if (mission.phase === 'waiting' && performance.now() >= mission.nextAt) missionIssue();
    else if (mission.phase === 'active' && mission.active && missionHit) missionCapture();
  }

  // ------------------------------------------------------------- update ---
  function updatePlayer(dt) {
    // car2デモは5速で130km/h巡航(自動運転モード)。鈴鹿デモは約100km/h。
    if (demoActive) player.gear = CAR2_MODE ? 6 : (SUZUKA_MODE ? 5 : 3);
    // gears
    if (shiftUp) { player.gear = Math.min(player.gear + 1, GEARS.length - 1); shiftUp = false; }
    if (shiftDown) { player.gear = Math.max(player.gear - 1, 0); shiftDown = false; }
    const gear = GEARS[player.gear];

    let throttle, brake, handbrake, input;
    if (demoActive) {
      // car2のデモは自動運転モード(Yと同じ130km/h巡航・急カーブはドリフト)
      const c = (CAR2_MODE && car2AutoRoute) ? car2Autopilot() : demoAutopilot();
      throttle = c.throttle; brake = c.brake; handbrake = c.handbrake; input = c.steer;
    } else if (autoDrive && car2AutoRoute) {
      if (player.gear < 6) player.gear = 6;   // 自動運転は5速固定で巡航
      const c = car2Autopilot();
      throttle = c.throttle; brake = c.brake; handbrake = c.handbrake; input = c.steer;
    } else {
      throttle = !!keys['s'] || gamepadState.throttle;   // S / RT = アクセル
      brake = !!keys['a'] || gamepadState.brake;         // A / LT = ブレーキ
      handbrake = !!keys[' '] || gamepadState.handbrake; // Space / ガムパッドA = ドリフト
      input = clamp((keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0) + gamepadState.steer, -1, 1);
    }

    // steering (less lock at speed, extra lock while sliding for counter-steer)
    const speedAlong = player.vel.x * Math.sin(player.heading) + player.vel.z * Math.cos(player.heading);
    const lock = 0.55 / (1 + Math.abs(speedAlong) * (player.drifting ? 0.02 : 0.055));
    player.steer += (input * lock - player.steer) * Math.min(1, dt * 7);
    if (Math.abs(speedAlong) > 0.05) {
      const yawGain = player.drifting ? 1.6 : 1.0;
      player.heading += (speedAlong / 2.8) * Math.tan(player.steer) * yawGain * dt;
    }

    // decompose momentum against the (new) heading: the mismatch is wheel slip
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    const sx = -fz, sz = fx;
    let vF = player.vel.x * fx + player.vel.z * fz;   // along the car
    let vS = player.vel.x * sx + player.vel.z * sz;   // sideways slip
    const vBefore = vF;

    // drift state: handbrake at speed kicks the tail out, momentum keeps it out
    player.drifting = (handbrake && Math.abs(vF) > 4) || (player.drifting && Math.abs(vS) > 1.4);

    if (throttle && gear.acc > 0) {
      // torque tapers off as the gear approaches its top speed
      const t = vF / gear.vmax;                       // >0 when moving with the gear
      const factor = clamp(1 - Math.max(t, 0), 0, 1);
      vF += Math.sign(gear.vmax) * gear.acc * factor * dt;
    }
    if (brake) {
      const dec = 11 * dt;
      vF -= clamp(vF, -dec, dec);
    }
    if (handbrake) {
      const dec = 6 * dt;                             // locked rear wheels scrub speed
      vF -= clamp(vF, -dec, dec);
    }
    // rolling resistance + aero drag + engine braking when off throttle
    const drag = 0.25 + Math.abs(vF) * 0.012 + (throttle ? 0 : 0.9);
    vF -= clamp(vF, -drag * dt, drag * dt);
    // over-rev after a downshift: engine drags the car toward the gear's max
    if (gear.acc > 0 && Math.abs(vF) > Math.abs(gear.vmax) && Math.sign(vF) === Math.sign(gear.vmax)) {
      vF += (gear.vmax - vF) * Math.min(1, dt * 1.2);
    }
    if (vF > PLAYER_TOP_SPEED) vF = PLAYER_TOP_SPEED;

    // lateral tyre grip: strong normally, nearly gone while drifting
    vS *= Math.exp(-(player.drifting ? 1.1 : 7.0) * dt);
    vS -= clamp(vS, -2 * dt, 2 * dt);

    player.vel.set(fx * vF + sx * vS, 0, fz * vF + sz * vS);
    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;

    // world bounds
    if (player.pos.x < BOUND_X_MIN || player.pos.x > BOUND_X_MAX) {
      player.pos.x = clamp(player.pos.x, BOUND_X_MIN, BOUND_X_MAX);
      player.vel.x *= -0.3;
    }
    if (Math.abs(player.pos.z) > BOUND_Z) { player.pos.z = clamp(player.pos.z, -BOUND_Z, BOUND_Z); player.vel.z *= -0.3; }

    // collisions: push out of the obstacle and reflect the velocity off it
    function collideCircle(cx, cz, r) {
      const dx = player.pos.x - cx, dz = player.pos.z - cz;
      const min = player.radius + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min || d2 < 1e-6) return;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      player.pos.x = cx + nx * min;
      player.pos.z = cz + nz * min;
      const dot = player.vel.x * nx + player.vel.z * nz;
      if (dot < 0) {
        player.vel.x -= 1.6 * dot * nx;
        player.vel.z -= 1.6 * dot * nz;
        player.vel.multiplyScalar(0.5);
      }
    }
    for (const o of obstacles) collideCircle(o.x, o.z, o.r);
    for (const ai of aiCars) collideCircle(ai.group.position.x, ai.group.position.z, ai.radius);

    // 犯人車への接触判定は、犯人が updateAI で動く前(=衝突を解決したこの時点)で行う。
    // 高速で毎フレーム約1.6m進むため、動いた後だと射程から外れて取り逃がしてしまう。
    missionHit = false;
    if (mission.active) {
      const c = mission.active;
      const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
      const reach = player.radius + c.radius + 1.6;   // 体当たりで確保
      if (dx * dx + dz * dz < reach * reach) missionHit = true;
    }

    // custom maps: collide with vertical structures, ride on the surface
    let slopePitch = 0;
    if (mapRoot) {
      collideWalls(dt);
      keepCar2OnRoad();
      keepMountainOnRoad();
      const gy = groundHeightAt(player.pos.x, player.pos.y, player.pos.z);
      player.pos.y += (gy - player.pos.y) * Math.min(1, dt * 9);
    } else {
      // 街モード: ドリフトコースの坂に乗る(平地では高さ 0 で従来どおり)
      const gy = courseHeightAt(player.pos.x, player.pos.z);
      player.pos.y += (gy - player.pos.y) * Math.min(1, dt * 9);
      const hx = Math.sin(player.heading) * 3, hz = Math.cos(player.heading) * 3;
      const hF = courseHeightAt(player.pos.x + hx, player.pos.z + hz);
      const hB = courseHeightAt(player.pos.x - hx, player.pos.z - hz);
      slopePitch = Math.atan2(hF - hB, 6);   // 登りで + / 下りで -
    }

    // visuals
    player.group.position.copy(player.pos);
    player.group.rotation.y = player.heading;   // テールランプ残像はCPU車のみ
    const acc = (vF - vBefore) / Math.max(dt, 1e-4);
    player.accSmooth += (acc - player.accSmooth) * Math.min(1, dt * 5);
    // 車体は外側へロール(右に曲がると左へ, 左に曲がると右へ傾く)
    player.tilt.rotation.z = clamp(player.steer * vF * 0.010 + vS * 0.008, -0.09, 0.09);
    // 加速ピッチ + 坂の傾き(登りは車首上げ)
    player.tilt.rotation.x = clamp(player.accSmooth * 0.006 - slopePitch, -0.28, 0.28);

    // tyre effects while sliding
    if (player.drifting && Math.abs(vS) > 1.6) {
      emitTyreFx(fx, fz, sx, sz, dt);
      if (CAR2_MOUNTAIN_MODE) emitMountainDust(fx, fz, sx, sz, dt);
    }

    // sound
    AUDIO.update(dt, {
      gear: player.gear,
      rpm: gear.vmax !== 0 ? clamp(Math.abs(vF / gear.vmax), 0, 1) : 0,
      throttle,
      slip: Math.abs(vS),
      drifting: player.drifting,
      brakeSkid: brake && Math.abs(vF) > 6,
      speed: Math.abs(vF),
    });

    updateInteriorSound(player.vel.length() * 3.6);

    // HUD
    speedEl.textContent = Math.round(player.vel.length() * 3.6);
    gearEls.forEach((el, i) => el.classList.toggle('on', i === player.gear));
    driftEl.classList.toggle('on', player.drifting);
    let rpm = 0.12;
    if (player.gear !== 1) rpm = clamp(Math.abs(vF / gear.vmax), 0, 1);
    if (throttle && player.gear !== 1) rpm = Math.max(rpm, 0.3);
    rpmEl.style.width = (rpm * 100).toFixed(1) + '%';
    rpmEl.classList.toggle('red', rpm > 0.93);
  }

  function updateAI(dt, sigStates) {
    for (const ai of aiCars) {
      if (ai.car2Loop) {
        const targetWp = ai.wps[ai.idx];
        const previousWp = ai.wps[Math.max(0, ai.idx - 1)];
        const segX = targetWp.x - previousWp.x;
        const segZ = targetWp.z - previousWp.z;
        const passed = (ai.pos.x - targetWp.x) * segX + (ai.pos.z - targetWp.z) * segZ > 0;
        const reached = Math.hypot(targetWp.x - ai.pos.x, targetWp.z - ai.pos.z) < 11;
        if ((passed || reached) && ai.idx >= ai.wps.length - 1) {
          const start = ai.wps[0], next = ai.wps[1];
          ai.pos.set(start.x, groundHeightAt(start.x, 6, start.z), start.z);
          ai.heading = Math.atan2(next.x - start.x, next.z - start.z);
          ai.idx = 1;
        } else if (passed || reached) {
          ai.idx++;
        }
      }
      const wp = ai.wps[ai.idx];
      const dx = wp.x - ai.pos.x, dz = wp.z - ai.pos.z;
      if (!ai.car2Loop && dx * dx + dz * dz < 6 * 6) ai.idx = (ai.idx + 1) % ai.wps.length;

      let diff = Math.atan2(dx, dz) - ai.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turn = ai.turnRate ?? (ai.criminal ? 2.2 : 1.7);   // 犯人はキビキビ曲がる
      ai.heading += clamp(diff, -turn * dt, turn * dt);

      // slow down for corners(犯人は減速控えめ)
      const cornerSlowdown = ai.cornerSlowdown ?? (ai.criminal ? 0.45 : 0.72);
      let target = ai.base * (1 - cornerSlowdown * Math.min(1, Math.abs(diff) * 1.4));
      if (ai.criminal) {
        // 逃走車は信号無視。加速はユーザー車の約1.5倍(≈18 m/s^2)に制限。
        const dv = target - ai.v;
        ai.v += clamp(dv, -40 * dt, 18 * dt);
      } else {
        // obey the signals: brake to a halt at the stop line on red/yellow
        const stop = aiStopDistance(ai, sigStates);
        let rate = 1.6;
        if (stop < 22) {
          target = Math.min(target, Math.max(0, (stop - 1.5) * 0.7));
          rate = 3.5;
        }
        ai.v += (target - ai.v) * Math.min(1, dt * rate);
      }
      // car2 のCPU車はドリフトで曲がる: 車体(heading)が先に向きを変え、
      // 進行方向(dir)はグリップ分だけ遅れて追従する。コーナーではグリップを
      // 落として横滑り角がつき、直線で素早く収束する。
      let moveDir = ai.heading;
      if (ai.car2Loop) {
        if (ai.dir === undefined) ai.dir = ai.heading;
        let slip = ai.heading - ai.dir;
        while (slip > Math.PI) slip -= Math.PI * 2;
        while (slip < -Math.PI) slip += Math.PI * 2;
        const grip = Math.abs(diff) > 0.12 ? 2.0 : 5.5;
        slip = clamp(slip * Math.exp(-grip * dt), -0.55, 0.55);
        ai.dir = ai.heading - slip;
        ai.slip = slip;
        moveDir = ai.dir;
      }
      ai.pos.x += Math.sin(moveDir) * ai.v * dt;
      ai.pos.z += Math.cos(moveDir) * ai.v * dt;
      if (ai.car2Loop) {
        // 道路外へ出ないよう、毎フレーム走行ラインから横±2.5mに位置を制限。
        // ドリフトで膨らんでも壁の外へは絶対に出ない。
        const lo = Math.max(0, ai.idx - 3);
        const hi = Math.min(ai.wps.length - 2, ai.idx);
        let bestD2 = Infinity, bestX = 0, bestZ = 0, tanA = ai.heading;
        for (let s = lo; s <= hi; s++) {
          const a = ai.wps[s], b = ai.wps[s + 1];
          const ex = b.x - a.x, ez = b.z - a.z;
          const len2 = ex * ex + ez * ez || 1;
          const t = clamp(((ai.pos.x - a.x) * ex + (ai.pos.z - a.z) * ez) / len2, 0, 1);
          const px = a.x + ex * t, pz = a.z + ez * t;
          const d2 = (ai.pos.x - px) ** 2 + (ai.pos.z - pz) ** 2;
          if (d2 < bestD2) { bestD2 = d2; bestX = px; bestZ = pz; tanA = Math.atan2(ex, ez); }
        }
        const MAX_OFF = 2.5;
        if (bestD2 > MAX_OFF * MAX_OFF) {
          const d = Math.sqrt(bestD2);
          ai.pos.x = bestX + (ai.pos.x - bestX) * (MAX_OFF / d);
          ai.pos.z = bestZ + (ai.pos.z - bestZ) * (MAX_OFF / d);
          ai.dir = tanA;                                // 端に達したら道なりへ戻す
          ai.v = Math.min(ai.v, ai.base * 0.85);
        }
        ai.roadCheckIn -= dt;
        if (ai.roadCheckIn <= 0) {
          ai.roadCheckIn = 0.25;
          if (!isCar2RoadAt(ai.pos.x, ai.pos.z)) {
            let nearest = 0;
            let nearestD2 = Infinity;
            for (let i = 0; i < ai.wps.length; i++) {
              const rx = ai.wps[i].x - ai.pos.x;
              const rz = ai.wps[i].z - ai.pos.z;
              const d2 = rx * rx + rz * rz;
              if (d2 < nearestD2) { nearestD2 = d2; nearest = i; }
            }
            const at = ai.wps[nearest];
            const nextIndex = Math.min(ai.wps.length - 1, nearest + 1);
            const next = ai.wps[nextIndex];
            ai.pos.set(at.x, groundHeightAt(at.x, 6, at.z), at.z);
            ai.heading = Math.atan2(next.x - at.x, next.z - at.z);
            ai.idx = nextIndex;
            ai.v = Math.min(ai.v, ai.base * 0.55);
            const recovered = Number(document.body.dataset.car2CpuRecoveries || 0) + 1;
            document.body.dataset.car2CpuRecoveries = String(recovered);
          }
        }
      }
      if (mapRoot) {
        const gy = groundHeightAt(ai.pos.x, ai.pos.y, ai.pos.z);
        ai.pos.y += (gy - ai.pos.y) * Math.min(1, dt * 9);
      } else {
        const gy = courseHeightAt(ai.pos.x, ai.pos.z);   // 街の坂に乗る
        ai.pos.y += (gy - ai.pos.y) * Math.min(1, dt * 9);
      }

      ai.group.position.copy(ai.pos);
      ai.group.rotation.y = ai.heading;
      // 夜間のテールランプ残像(遠くからも視認できるよう320m以内で出す)。
      // 近く・並走時は長い残像が不自然なため、距離に応じて残る時間を縮める:
      // 30m以内=半分(0.375秒) 〜 120m以上=フル(0.75秒) を線形補間。
      if (nightMode) {
        const tpx = ai.pos.x - player.pos.x, tpz = ai.pos.z - player.pos.z;
        const distSq = tpx * tpx + tpz * tpz;
        if (distSq < 320 * 320) {
          const dist = Math.sqrt(distSq);
          const lifeScale = 0.5 + 0.5 * clamp((dist - 30) / 90, 0, 1);
          emitTailTrail(ai, ai.kabu, 0.75 * lifeScale);
        }
      }
      // 外側へロール(car2 はドリフトの横滑り分も傾きに足す)
      const aiSlip = ai.car2Loop ? (ai.slip || 0) : 0;
      ai.tilt.rotation.z = clamp(diff * ai.v * 0.006 + aiSlip * 0.18, -0.1, 0.1);

      // ドリフト中はリアからタイヤスモーク(近くの車だけ・プールを共用)
      if (ai.car2Loop && Math.abs(aiSlip) > 0.15 && smokePool.length) {
        ai.smokeIn = (ai.smokeIn ?? 0) - dt;
        const dpx = ai.pos.x - player.pos.x, dpz = ai.pos.z - player.pos.z;
        if (ai.smokeIn <= 0 && dpx * dpx + dpz * dpz < 130 * 130) {
          ai.smokeIn = 0.09;
          const s = smokePool[smokeIdx];
          smokeIdx = (smokeIdx + 1) % SMOKE_MAX;
          const rearX = ai.pos.x - Math.sin(ai.heading) * 1.5;
          const rearZ = ai.pos.z - Math.cos(ai.heading) * 1.5;
          s.position.set(
            rearX + (Math.random() - 0.5) * 0.6,
            ai.pos.y + 0.25,
            rearZ + (Math.random() - 0.5) * 0.6
          );
          s.scale.setScalar(0.6);
          const d = s.userData;
          d.life = 0; d.max = 0.6 + Math.random() * 0.3;
          d.vx = (Math.random() - 0.5) * 1.2; d.vy = 1.0 + Math.random(); d.vz = (Math.random() - 0.5) * 1.2;
          s.visible = true;
        }
      }
    }
  }

  // 地図表示用のマーカー(塗り丸＋白縁。常に最前面に描く)。
  function makeMapMarker(color) {
    const group = new THREE.Group();
    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 28),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
      })
    );
    const outline = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.14, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.98,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
      })
    );
    fill.rotation.x = outline.rotation.x = -Math.PI / 2;
    fill.renderOrder = outline.renderOrder = 999;
    group.add(fill, outline);
    group.visible = false;
    return group;
  }

  // ボンネットカメラ時は映画のレターボックス(上下の黒帯)を表示する。
  // 車体のピッチで画面最下部に路面が見えてしまう隙間もこの帯で隠れる。
  let bonnetBarsEl = null;
  function updateBonnetCover() {
    if (!bonnetBarsEl) {
      bonnetBarsEl = document.createElement('div');
      bonnetBarsEl.style.cssText = 'position:fixed;inset:0;z-index:3;pointer-events:none;display:none;';
      const barTop = document.createElement('div');
      barTop.style.cssText = 'position:absolute;top:0;left:0;right:0;height:9vh;background:#000;';
      const barBottom = document.createElement('div');
      barBottom.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:9vh;background:#000;';
      bonnetBarsEl.appendChild(barTop);
      bonnetBarsEl.appendChild(barBottom);
      document.body.appendChild(bonnetBarsEl);
    }
    bonnetBarsEl.style.display = bonnetView === 1 ? 'block' : 'none';
    document.body.dataset.bonnetView = String(bonnetView);
  }

  let __debugFreezeCam = false;   // 一時デバッグ: trueの間はupdateCameraが視点を上書きしない
  function updateCamera(dt) {
    if (__debugFreezeCam) return;
    // 視点のみモード(V 2回目)では自車(影・ランプ含む)を一切映さない
    if (player.group) player.group.visible = bonnetView !== 2;
    updateBonnetCover();
    if (!crimMarker) { crimMarker = makeMapMarker(0xff2020); scene.add(crimMarker); }
    if (!selfMarker) { selfMarker = makeMapMarker(0x00d9ff); scene.add(selfMarker); }
    crimMarker.visible = false;
    selfMarker.visible = false;
    for (const visualCopy of car2VisualWraps) visualCopy.visible = !topView;

    if (topView) {
      if (!topViewFrame) {
        if (mapRoot) {
          const box = new THREE.Box3().setFromObject(mapRoot);
          topViewFrame = {
            center: box.getCenter(new THREE.Vector3()),
            size: box.getSize(new THREE.Vector3())
          };
        } else {
          topViewFrame = {
            center: new THREE.Vector3((BOUND_X_MIN + BOUND_X_MAX) * 0.5, 0, 0),
            size: new THREE.Vector3(BOUND_X_MAX - BOUND_X_MIN, 0, BOUND_Z * 2)
          };
        }
      }
      const center = topViewFrame.center;
      const size = topViewFrame.size;
      const span = Math.max(size.z, size.x / camera.aspect);
      const height = span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.12;
      if (camera.far < height * 1.5) {
        camera.far = height * 1.5;
        camera.updateProjectionMatrix();
      }
      camera.up.set(0, 0, -1);
      camera.position.set(center.x, center.y + height, center.z);
      camera.lookAt(center);
      sun.position.copy(center).addScaledVector(SUN_DIR, 120);
      sun.target.position.copy(center);
      sun.castShadow = false;

      // 道路幅より少し大きい固定直径: 鈴鹿14m、その他16m。
      const mScale = CAR2_MODE ? 16 : (SUZUKA_MODE ? 7 : 8);
      selfMarker.position.set(player.pos.x, 60, player.pos.z);
      selfMarker.scale.setScalar(mScale);
      selfMarker.visible = true;
      if (mission.active) {
        crimMarker.position.set(mission.active.pos.x, 60, mission.active.pos.z);
        crimMarker.scale.setScalar(mScale);
        crimMarker.visible = true;
      }
      document.body.dataset.playerMapMarkerVisible = 'true';
      document.body.dataset.criminalMapMarkerVisible = String(crimMarker.visible);
      return;
    }
    sun.castShadow = true;
    document.body.dataset.playerMapMarkerVisible = 'false';
    document.body.dataset.criminalMapMarkerVisible = 'false';
    camera.up.set(0, 1, 0);
    if (demoActive && bonnetView === 0) {
      // スワイプ(ドラッグ)中とその直後はユーザーのカメラ操作を優先する
      const t = performance.now();
      if (cam.dragging || t - cam.lastDrag < 2500) {
        // 何もしない(ユーザーの視点を保持)
      } else {
      if (t > demoCam.nextChange) {
        demoCam.until = t + 5000;
        demoCam.nextChange = t + 20000;
        demoCam.yaw = (Math.random() * 2 - 1) * Math.PI;
        demoCam.pitch = 0.14 + Math.random() * 0.85;
        demoCam.dist = 8 + Math.random() * 15;
      }
      const g = Math.min(1, dt * 2.5);
      if (t < demoCam.until) {
        cam.yaw += (demoCam.yaw - cam.yaw) * g;
        cam.pitch += (demoCam.pitch - cam.pitch) * g;
        cam.dist += (demoCam.dist - cam.dist) * g;
      } else {                       // 通常時は後方追従
        cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.5);
        cam.pitch += (0.34 - cam.pitch) * Math.min(1, dt * 1.5);
        cam.dist += (11 - cam.dist) * Math.min(1, dt * 1.5);
      }
      }
    } else if (bonnetView === 1) {
      // V(1回目): ボンネットカメラ。ボンネット先端付近から進行方向を見る一人称視点。
      const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
      camera.position.set(
        player.pos.x + fx * 1.2,
        player.pos.y + 1.18,
        player.pos.z + fz * 1.2
      );
      camera.lookAt(
        player.pos.x + fx * 50,
        player.pos.y + 0.9,
        player.pos.z + fz * 50
      );
      sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
      sun.target.position.copy(player.pos);
      return;
    } else if (bonnetView === 2) {
      // V(2回目): 視点のみ。車体は映さず、マウスドラッグで視点を自由に動かす。
      // ドラッグの角度系は追従カメラと同じ cam.yaw / cam.pitch を使う
      // (cam.pitch=0.34 を正面として上下に振る)。
      const lookYaw = player.heading + cam.yaw;
      const lookPitch = 0.34 - cam.pitch;   // 上ドラッグで上を向く
      const cp = Math.cos(lookPitch);
      camera.position.set(player.pos.x, player.pos.y + 1.2, player.pos.z);
      camera.lookAt(
        player.pos.x + Math.sin(lookYaw) * cp * 50,
        player.pos.y + 1.2 + Math.sin(lookPitch) * 50,
        player.pos.z + Math.cos(lookYaw) * cp * 50
      );
      sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
      sun.target.position.copy(player.pos);
      return;
    } else if (!cam.dragging && performance.now() - cam.lastDrag > 1800) {
      // ease back behind the car when the mouse is idle
      cam.yaw += (0 - cam.yaw) * Math.min(1, dt * 1.2);
    }
    const target = new THREE.Vector3(player.pos.x, player.pos.y + 1.4, player.pos.z);
    const a = player.heading + Math.PI + cam.yaw;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    camera.position.set(
      target.x + Math.sin(a) * cp * cam.dist,
      Math.max(0.7, target.y + sp * cam.dist),
      target.z + Math.cos(a) * cp * cam.dist
    );
    camera.lookAt(target);

    // keep the shadow camera centered on the player
    sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
    sun.target.position.copy(player.pos);
  }

  // F: 画面上部のバックミラー。メイン描画の後に後方視点を小窓へ描く。
  const mirrorCam = new THREE.PerspectiveCamera(55, 3.4, 0.5, 1200);
  function renderMirror() {
    if (!mirrorView || topView) return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = Math.round(W * 0.34), h = Math.round(w * 0.26);
    const x = Math.round((W - w) / 2), y = H - h - 12;   // WebGLのYは下から
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
    mirrorCam.aspect = w / h;
    mirrorCam.updateProjectionMatrix();
    mirrorCam.position.set(player.pos.x, player.pos.y + 1.35, player.pos.z);
    mirrorCam.lookAt(player.pos.x - fx * 60, player.pos.y + 1.0, player.pos.z - fz * 60);
    const playerVisible = player.group.visible;
    player.group.visible = false;    // 自車で後方視界が塞がらないように
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, w, h);
    renderer.setScissor(x, y, w, h);
    renderer.render(scene, mirrorCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    player.group.visible = playerVisible;
  }

  // ------------------------------------------------------- gamepad (PC) ----
  // 左stick=ハンドル / RT=アクセル / LT=ブレーキ / A=ドリフト(サイドブレーキ)
  // Y=シフトダウン / B=シフトアップ / X=カメラ視点切替(V) / LB=自動運転(Y) / RB=夜間(N)
  const gamepadState = { steer: 0, throttle: false, brake: false, handbrake: false };
  const gpPrev = { y: false, b: false, x: false, lb: false, rb: false };
  function pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
    if (!gp) {
      gamepadState.steer = 0; gamepadState.throttle = false;
      gamepadState.brake = false; gamepadState.handbrake = false;
      return;
    }
    AUDIO.unlock();
    const deadzone = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    gamepadState.steer = -deadzone(gp.axes[0] || 0);       // 左に倒す=ArrowLeftと同じ+側
    const rt = gp.buttons[7] ? gp.buttons[7].value : 0;
    const lt = gp.buttons[6] ? gp.buttons[6].value : 0;
    gamepadState.throttle = rt > 0.12;
    gamepadState.brake = lt > 0.12;
    gamepadState.handbrake = !!(gp.buttons[0] && gp.buttons[0].pressed);   // A

    const yBtn = !!(gp.buttons[3] && gp.buttons[3].pressed);   // Y
    const bBtn = !!(gp.buttons[1] && gp.buttons[1].pressed);   // B
    const xBtn = !!(gp.buttons[2] && gp.buttons[2].pressed);   // X
    const lbBtn = !!(gp.buttons[4] && gp.buttons[4].pressed);  // LB
    const rbBtn = !!(gp.buttons[5] && gp.buttons[5].pressed);  // RB
    // メニュー表示中・一時停止中・car2デモ中はキーボードと同様にボタン操作を無効化
    if (!musicMode && !pauseMode && !(demoActive && CAR2_MODE)) {
      if (yBtn && !gpPrev.y) shiftDown = true;
      if (bBtn && !gpPrev.b) shiftUp = true;
      if (xBtn && !gpPrev.x) bonnetView = (bonnetView + 1) % 3;
      if (lbBtn && !gpPrev.lb && (CAR2_MODE || CAR2_MOUNTAIN_MODE)) {
        autoDrive = !autoDrive;
        autoIdx = -1;
        document.body.dataset.autoDrive = String(autoDrive);
      }
      if (rbBtn && !gpPrev.rb) { nightMode = !nightMode; applyNight(); }
    }
    gpPrev.y = yBtn; gpPrev.b = bBtn; gpPrev.x = xBtn; gpPrev.lb = lbBtn; gpPrev.rb = rbBtn;
  }

  // --------------------------------------------------------------- loop ---
  let last = performance.now();
  function tick(now) {
    try {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      pollGamepad();
      const sigStates = updateSignals(now / 1000);
      // car2デモ: 10秒ごとに昼夜をチェンジ
      if (demoActive && CAR2_MODE && now >= demoDayNightAt) {
        nightMode = !nightMode;
        applyNight();
        demoDayNightAt = now + 10000;
      }
      if (musicMode || pauseMode) {
        // 音楽選択・一時停止中は運転(シミュレーション)を停止。音はアイドルへ。
        AUDIO.update(dt, { gear: 1, rpm: 0, throttle: false, slip: 0, drifting: false, brakeSkid: false, speed: 0 });
      } else {
        updatePlayer(dt);
        updateAI(dt, sigStates);
        updateMission();
      }
      updateFx(dt);
      updateTailTrails(dt);
      updateCamera(dt);
      updateClouds(dt);
      renderer.render(scene, camera);
      renderMirror();
    } catch (err) {
      // 1フレームの例外でrequestAnimationFrameの連鎖が止まって完全フリーズする
      // 事態を避けるため、ログに残しつつ次フレームへ継続する。
      console.error(err);
    }
    requestAnimationFrame(tick);
  }

  init().catch((err) => {
    const el = document.getElementById('loading');
    if (el) {
      const localHint = location.protocol === 'file:'
        ? '<br>ダウンロード版は <code>PLAY_VOX_DRIVE.bat</code> から起動してください。'
        : '';
      el.innerHTML = '<div class="err">読み込みに失敗しました。' + localHint
        + '<br><small>' + err.message + '</small></div>';
    }
    console.error(err);
  });
})();
