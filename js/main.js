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
import { AUDIO } from './audio.js?v=20260730-interior-equal-power-xfade-1';
import { buildSuzukaMap } from './suzuka-map.js?v=20260717-15';
import { CAR_CONFIGS, MAP_CONFIGS } from './game-config.js?v=20260730-ascii-asset-paths-1';
import { CAR2_CPU_ROUTE } from './car2-route.js';

(function () {
  'use strict';

  // スマホ判定: スマホは PC PLAY ONLY(デモ観賞のみ)。
  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  const pageQuery = new URLSearchParams(location.search);
  // 同名のGLBを差し替えた場合も、連結コースの全区間を必ず同じ版で読み直す。
  const DEFAULT_SEQUENCE_MAP_ASSET_REVISION = '20260801-searoad01-06-lite';
  const COURSE_KEY = pageQuery.get('course') || 'tokyo';
  const MAP_CONFIG = MAP_CONFIGS[COURSE_KEY] || MAP_CONFIGS.tokyo;
  const DEBUG_MAP = pageQuery.get('debugMap') === '1';
  const DEMO_SEQUENCE = ['tokyo', 'sea', 'forest', 'indy'];
  const DEMO_SEQUENCE_ACTIVE = pageQuery.get('demo') === '1';
  // デモシェル(?demoShell=1)のiframeとして動いているか。曲名など、コース切替の
  // ページ再読込をまたいで出し続けるものはシェル側が受け持つ。
  const DEMO_EMBEDDED = pageQuery.get('demoEmbedded') === '1';
  const requestedDemoStage = Number.parseInt(pageQuery.get('demoStage') || '', 10);
  const courseDemoStage = DEMO_SEQUENCE.indexOf(COURSE_KEY);
  const DEMO_SEQUENCE_STAGE = Number.isInteger(requestedDemoStage)
    && requestedDemoStage >= 0
    && requestedDemoStage < DEMO_SEQUENCE.length
    && DEMO_SEQUENCE[requestedDemoStage] === COURSE_KEY
      ? requestedDemoStage
      : Math.max(0, courseDemoStage);
  // デモ1コースあたりの表示時間。首都高は+10秒、他の3コースは+6秒（ユーザー指定）。
  const DEMO_SEQUENCE_STAGE_MS = COURSE_KEY === 'tokyo' ? 25000 : 21000;
  const carParam = (pageQuery.get('car') || 'toyota86').toLowerCase();
  const PLAYER_CAR_KEY = Object.hasOwn(CAR_CONFIGS, carParam) ? carParam : 'toyota86';
  const MAP_GLTF = MAP_CONFIG.file;
  const CAR2_MODE = COURSE_KEY === 'tokyo';
  const SUZUKA_MODE = false;
  const NIHONBASHI_MODE = false;
  let mapRoot = null;              // set when a custom map is loaded (ground raycasts)
  let roadMeshes = [];
  let wallMeshes = [];             // 地図ごとに明示された垂直壁材質
  let nonWallMeshes = [];          // 緑地・砂地など壁判定から除外する地表
  let sandMeshes = [];             // ドリフト時に濃い砂煙を発生させる地表
  let blockedSurfaceMeshes = [];   // 海面など進入禁止の地表
  let mapSurfaceMeshes = [];       // 色を問わないプレイヤー走行面候補
  let treeSurfaceMeshes = [];
  let mapSpawn = null;
  let mapBounds = null;
  let mapRoadBounds = null;
  let mapSequenceSeamZs = [];
  let mapSequenceLoopSeamZs = [];
  let mapLoopPortal = null;
  let mapLoopCount = 0;
  let seaSideCrossDebug = null;
  let seaGrassClimbDebug = null;
  let seaRoadGrassDebug = null;
  let indyBankCrossDebug = null;
  let seaSurfaceBridge = null;
  let mapWallCollisionCount = 0;
  // 首都高のすれ違い頻度を測るための積算（ユーザー車の走行距離と遭遇回数）。
  let car2CpuEncounterTotal = 0;
  let cpuOvertakeStartTotal = 0;
  // 出番待ちを含む首都高CPUの一覧と、次の出現までの残り秒数。
  const car2CpuPool = [];
  let car2CpuAppearIn = 0;
  let car2CpuAppearTotal = 0;
  let car2PlayerAvgSpeedKmh = 130;
  // ワープ検出: CPUが1フレームで進める距離を大きく超えて動いた最大値。
  let cpuWorstJumpMeters = 0;
  // インディCPUで観測された最大加速度(m/s^2)。ユーザー車上限の監視用。
  let indyCpuMaxAccelNow = 0;
  let car2RoadWidthMeasured = false;
  let car2CpuRoute = null;
  let car2RouteDistances = null;
  let car2RouteLengthMeters = 0;
  let car2PlayerTravelMeters = 0;
  let car2PlayerTravelFromX;
  let car2PlayerTravelFromZ;
  let playerOnSand = false;
  let mapRayTop = 1000;
  let mapRayBottom = -1000;
  const mapDebugStats = { treesPlaced: 0, treeCandidatesExcluded: 0, treesExcludedByRoad: 0 };
  let car2RoadMeshes = roadMeshes; // 既存の首都高路外判定との互換参照
  let car2DrivableMeshes = [];     // 路面+白線(走行可能とみなす面)
  const car2VisualWraps = [];      // ループ地点の先に見せる前後1周分（表示専用）
  const sequenceLoopPreviewSurfaceMeshes = []; // ループ継ぎ目生成時だけ参照する表示面

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
  let autoDrive = false;             // Y: コース別の自動運転
  let autoIdx = -1;                  // 自動運転が追うウェイポイント
  let car2AutoRoute = null;          // 道路中央のライン(自動運転用)

  // B: 音声切替 0=エンジン音 1=車内音(mp3ループ) 2=無音
  // 車内音は 80km/h 未満= drive_on_freeway1.mp3 / 以上= drive_on_freeway2.mp3。
  // どのモードでもドリフト音(タイヤスクリーチ)は鳴らし続ける。
  let soundMode = 0;
  let interiorCurrent = 0;           // 再生中の車内音 (0=なし 1=低速 2=高速)
  // ループの継ぎ目を切らないため、車内音は Web Audio 側(AUDIO)で回す。
  // Audio要素の loop だと MP3 先頭の無音(約23ms)が毎周入って途切れる。
  const INTERIOR_LOW_URL = 'sound/' + encodeURIComponent('drive_on_freeway1.mp3');
  const INTERIOR_HIGH_URL = 'sound/' + encodeURIComponent('drive_on_freeway2.mp3');
  const controlPanelOpenSound = new Audio('sound/decision33.mp3');
  const controlPanelTabSound = new Audio('sound/decision44.mp3');
  AUDIO.setInteriorVolume(0.85);
  controlPanelOpenSound.preload = 'auto';
  controlPanelOpenSound.volume = 0.7;
  controlPanelTabSound.preload = 'auto';

  function playControlPanelSound(sound, type) {
    sound.pause();
    sound.currentTime = 0;
    document.body.dataset.controlPanelSound = type;
    sound.play().catch(() => {});
  }

  function stopInterior() {
    AUDIO.stopInterior();
    interiorCurrent = 0;
  }
  function applySoundMode() {
    AUDIO.setEngineMuted(soundMode !== 0);   // エンジンのみ消す(ドリフト音は残す)
    if (soundMode !== 1) stopInterior();
    // 80km/hの乗り換えで待たされないよう、低速・高速の両方を先にデコードしておく。
    else AUDIO.preloadInterior([INTERIOR_LOW_URL, INTERIOR_HIGH_URL]);
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
    AUDIO.playInterior(next === 2 ? INTERIOR_HIGH_URL : INTERIOR_LOW_URL);
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
    // 4コースデモは何かキーを押すとタイトルへ戻る。
    // スマホは従来どおり鑑賞専用とし、端末由来のキーでは終了させない。
    if (demoActive && DEMO_SEQUENCE_ACTIVE) {
      if (!IS_MOBILE) exitDemoSequenceToTitle();
      e.preventDefault();
      return;
    }
    // car2のデモ画面: 何かのボタンでタイトルへ戻る
    if (demoActive && CAR2_MODE) {
      if (!IS_MOBILE) exitCar2Demo();   // スマホはデモを見せるだけ
      e.preventDefault();
      return;
    }
    // M: 音楽選択モード(開いている間は運転を停止し、キーはメニューが消費)
    if (!e.repeat && k.toLowerCase() === 'm') {
      if (musicMode) {
        closeMusicMenu();
      } else {
        playControlPanelSound(controlPanelOpenSound, 'open');
        openMusicMenu();
      }
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
      if (k.toLowerCase() === 'p') {
        manualLampMode = !manualLampMode;
        refreshLampVisibility();
      }
      if (k.toLowerCase() === 'b') { soundMode = (soundMode + 1) % 3; applySoundMode(); }
      // V: 通常 → ボンネットカメラ → 視点のみ(車体非表示・マウスで視点操作) → 通常
      if (k.toLowerCase() === 'v') switchBonnetView();
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
      if (k.toLowerCase() === 'y' && car2AutoRoute?.length >= 2) {
        autoDrive = !autoDrive;
        autoIdx = -1;                // 次フレームで最寄り地点から追従を開始
        if (autoDrive && MAP_CONFIG.autoDriveMode === 'indyBankDrift') {
          snapPlayerToIndyAutoRoute();
        }
        document.body.dataset.autoDrive = String(autoDrive);
        document.body.dataset.autoDriveMode =
          MAP_CONFIG.autoDriveMode ?? (CAR2_MODE ? 'tokyoCruise130' : 'none');
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
  renderer.shadowMap.enabled = MAP_CONFIG.renderShadows !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.dataset.mapShadows = renderer.shadowMap.enabled ? 'enabled' : 'disabled';
  document.body.dataset.mapFallOutsideRoad = String(Boolean(MAP_CONFIG.fallOutsideRoad));
  document.body.dataset.playerFallingOutsideRoad = 'false';
  document.body.dataset.cpuPlayerCollision =
    COURSE_KEY === 'sea' ? 'disabled' : 'enabled';
  document.body.dataset.mapWallCollisions =
    MAP_CONFIG.ignoreMapWallCollisions ? 'disabled' : 'enabled';
  document.body.dataset.mapDrivableSeamAssistRatio =
    Number.isFinite(MAP_CONFIG.drivableSeamAssistRatio)
      ? String(MAP_CONFIG.drivableSeamAssistRatio)
      : 'road-only';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY = 0x8ecbef;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 130, 480);

  // near=0.5 keeps enough depth precision at 300 m for the thin road layers
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 1200);

  // 色付きの強い環境光はマテリアル色を青白く飽和させるため、昼は中立色で抑える。
  const hemi = new THREE.HemisphereLight(0xffffff, 0x6f7168, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.castShadow = MAP_CONFIG.renderShadows !== false;
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

  // ------------------------------------------------------------ weather ---
  // コントロールパネルから変更する上空色・地平線色。昼夜照明とは独立して保持し、
  // 夜へ切り替えたときは同じ色相を暗くして反映する。
  const weatherTopColor = new THREE.Color(SKY);
  const weatherHorizonColor = new THREE.Color(0xeaf4fb);
  const weatherTopHsl = { h: 0, s: 0, l: 0 };
  const weatherHorizonHsl = { h: 0, s: 0, l: 0 };
  weatherTopColor.getHSL(weatherTopHsl);
  weatherHorizonColor.getHSL(weatherHorizonHsl);
  // 既定の明るさ。デモで曲ごとに暗くした後、通常の曲へ戻す時に使う。
  const WEATHER_DEFAULT_TOP_L = weatherTopHsl.l;
  const WEATHER_DEFAULT_HORIZON_L = weatherHorizonHsl.l;
  let weatherColorTarget = 'sky';       // sky / horizon
  // 単色指定の曲だけtrue。空をグラデーションではなくベタ塗り2色にする。
  let weatherFlatSky = false;
  let weatherRain = false;
  let weatherStars = false;
  let weatherCloudMode = 0;             // 0=なし、1=雲1、2=雲2
  let weatherDimVehicleLights = false;
  let weatherRainSystem = null;
  let weatherStarSystem = null;
  let weatherSmallStarSystem = null;
  const WEATHER_RAIN_LENGTH = 1.1;

  function writeWeatherRainDrop(positions, offset, x, y, z) {
    positions.set([
      x, y, z,
      x - 0.15, y - WEATHER_RAIN_LENGTH, z + 0.25,
    ], offset);
  }

  const weatherSkyUniforms = {
    topColor: { value: weatherTopColor.clone() },
    horizonColor: { value: weatherHorizonColor.clone() },
    horizonBandColor: { value: weatherHorizonColor.clone() },
    // 1で空のグラデーションをやめ、地平線色と上空色のベタ塗り2色に分ける。
    flatSky: { value: 0 },
  };
  const weatherSkyDome = new THREE.Mesh(
    new THREE.SphereGeometry(900, 40, 20),
    new THREE.ShaderMaterial({
      uniforms: weatherSkyUniforms,
      vertexShader: 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 topColor,horizonColor,horizonBandColor;
        uniform float flatSky;
        varying vec3 vDir;
        void main(){
          float h=clamp(normalize(vDir).y,0.0,1.0);
          // 地平線が占める範囲も、上空色へ混ざる範囲も、それぞれ半分にする。
          // 上空色へ到達するのはh=0.11。境目の高さは従来の半分。
          float bandBlend=smoothstep(0.0,0.04,h);
          float topBlend=smoothstep(0.00625,0.11,h);
          // 単色はグラデーションをやめ、地平線色と上空色をベタ塗りで分離する。
          bandBlend=mix(bandBlend,1.0,flatSky);
          topBlend=mix(topBlend,step(0.055,h),flatSky);
          vec3 lowColor=mix(horizonBandColor,horizonColor,bandBlend);
          gl_FragColor=vec4(mix(lowColor,topColor,topBlend),1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    })
  );
  weatherSkyDome.renderOrder = -2;
  weatherSkyDome.frustumCulled = false;
  scene.add(weatherSkyDome);

  function currentWeatherHsl() {
    return weatherColorTarget === 'horizon' ? weatherHorizonHsl : weatherTopHsl;
  }
  function applyWeatherSky() {
    weatherTopColor.setHSL(weatherTopHsl.h, weatherTopHsl.s, weatherTopHsl.l);
    weatherHorizonColor.setHSL(
      weatherHorizonHsl.h,
      weatherHorizonHsl.s,
      weatherHorizonHsl.l
    );
    const top = weatherTopColor.clone();
    const horizon = weatherHorizonColor.clone();
    if (nightMode) {
      top.multiplyScalar(0.075);
      horizon.multiplyScalar(0.12);
    }
    weatherSkyUniforms.topColor.value.copy(top);
    weatherSkyUniforms.horizonColor.value.copy(horizon);
    weatherSkyUniforms.horizonBandColor.value.copy(horizon);
    weatherSkyUniforms.flatSky.value = weatherFlatSky ? 1 : 0;
    // 選んでいる側(空/地平線)の色をそのまま16進で見せる。夜の減光は反映しない。
    const pickedColor = weatherColorTarget === 'horizon'
      ? weatherHorizonColor
      : weatherTopColor;
    const colorCode = `#${pickedColor.getHexString()}`;
    if (weatherColorCodeEl) weatherColorCodeEl.textContent = colorCode;
    document.body.dataset.weatherColorCode = colorCode;
    scene.background.copy(top);
    const fog = scene.fog || savedFog;
    if (fog) fog.color.copy(horizon);
    cloudUniforms.uSkyColor.value.copy(top);
    cloudUniforms.uSkyHor.value.copy(horizon);
    document.body.dataset.weatherSkyTarget = weatherColorTarget;
    document.body.dataset.weatherSkyHsl =
      `${weatherTopHsl.h.toFixed(3)},${weatherTopHsl.s.toFixed(3)},${weatherTopHsl.l.toFixed(3)}`;
    document.body.dataset.weatherHorizonHsl =
      `${weatherHorizonHsl.h.toFixed(3)},${weatherHorizonHsl.s.toFixed(3)},${weatherHorizonHsl.l.toFixed(3)}`;
    updateWeatherVehicleLights();
  }

  // ------------------------------------------------------------ clouds ----
  // 昼間の青空に雲を表示する(ffffx.html の雲ドームを流用。fbmノイズの天球)。
  const CLOUD_CFGS = [
    {
      cov: 0.40, soft: 0.28, scale: 1.2, stretch: 1.0, warp: 1.6,
      detail: 0.8, proj: 0.06, minY: 0.18, band: 0.10,
      flowBase: 0.05, flowSpeed: 0.002, drift: 0,
      shadow: 0.8, litSky: 0.5, shadowSky: 0.5, opacity: 0.9,
    },
    {
      cov: 0.45, soft: 0.22, scale: 1.8, stretch: 0.4, warp: 2,
      detail: 0.5, proj: 0.06, minY: 0.30, band: 0.10,
      flowBase: 0, flowSpeed: 0.001, drift: 0.025,
      shadow: 0.85, litSky: 0.5, shadowSky: 0.5, opacity: 0.85,
    },
  ];
  const initialCloudConfig = CLOUD_CFGS[0];
  let cloudDome = null;
  let cloudTime = 0, cloudFlow = 0, cloudDriftAcc = 0;
  const cloudUniforms = {
    uTime: { value: 0 }, uFlow: { value: 0 }, uDrift: { value: 0 },
    uCov: { value: initialCloudConfig.cov }, uSoft: { value: initialCloudConfig.soft },
    uScale: { value: initialCloudConfig.scale }, uStretch: { value: initialCloudConfig.stretch },
    uWarp: { value: initialCloudConfig.warp }, uDetail: { value: initialCloudConfig.detail },
    uProj: { value: initialCloudConfig.proj }, uMinY: { value: initialCloudConfig.minY },
    uBand: { value: initialCloudConfig.band }, uShadow: { value: initialCloudConfig.shadow },
    uLitSky: { value: initialCloudConfig.litSky }, uShadowSky: { value: initialCloudConfig.shadowSky },
    uOpacity: { value: initialCloudConfig.opacity }, uDarken: { value: 1 },
    uSkyColor: { value: new THREE.Color(0x8ecbef) },   // 上空色
    uSkyHor: { value: new THREE.Color(0xeaf4fb) },     // 地平線色
  };
  {
    const cloudVert = 'varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
    const cloudFrag = `
      precision highp float;
      uniform float uTime,uFlow,uDrift,uCov,uSoft,uScale,uStretch,uWarp,uDetail,uProj,uMinY,uBand,uShadow,uLitSky,uShadowSky,uOpacity,uDarken;
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
        gl_FragColor=vec4(col*uDarken, a);
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

  // 雨粒。車両を中心とした範囲だけを更新し、マップの大きさに依存させない。
  {
    const count = 6500;
    const spread = 62;
    const top = 42;
    const positions = new Float32Array(count * 6);
    for (let index = 0; index < count; index++) {
      const offset = index * 6;
      const x = (Math.random() - 0.5) * spread;
      const y = Math.random() * top;
      const z = (Math.random() - 0.5) * spread;
      writeWeatherRainDrop(positions, offset, x, y, z);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    weatherRainSystem = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: 0xa9d7ff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        linewidth: 1.2,
      })
    );
    weatherRainSystem.userData.dropCount = count;
    weatherRainSystem.userData.visualWidth = 1.2;
    weatherRainSystem.frustumCulled = false;
    weatherRainSystem.visible = false;
    scene.add(weatherRainSystem);
  }

  // 星空。天球上半分へ点を散らし、カメラへ追従させる。
  {
    const count = 4000;
    const radius = 820;
    const makeStarSystem = (size) => {
      const positions = new Float32Array(count * 3);
      for (let index = 0; index < count; index++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.random() * Math.PI * 0.5;
        positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
        positions[index * 3 + 1] = radius * Math.cos(phi);
        positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const system = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color: 0xffffff,
          size,
          sizeAttenuation: false,
          depthWrite: false,
          fog: false,
        })
      );
      system.renderOrder = -1;
      system.frustumCulled = false;
      system.visible = false;
      system.userData.starCount = count;
      scene.add(system);
      return system;
    };
    // 粒は同数の2系統。半分を小さくして、大小の混在で奥行きを出す。
    weatherStarSystem = makeStarSystem(1.65);
    weatherSmallStarSystem = makeStarSystem(1.0);
  }

  function updateWeatherEffects(dt) {
    weatherSkyDome.position.copy(camera.position);
    if (cloudDome) {
      cloudDome.visible = weatherCloudMode > 0;
      if (cloudDome.visible) {
        const config = CLOUD_CFGS[weatherCloudMode - 1] ?? CLOUD_CFGS[0];
        cloudTime += dt;
        cloudFlow += dt * (config.flowBase + player.vel.length() * config.flowSpeed);
        cloudDriftAcc += dt * config.drift;
        cloudUniforms.uTime.value = cloudTime;
        cloudUniforms.uFlow.value = cloudFlow;
        cloudUniforms.uDrift.value = cloudDriftAcc;
        cloudUniforms.uCov.value = config.cov;
        cloudUniforms.uSoft.value = config.soft;
        cloudUniforms.uScale.value = config.scale;
        cloudUniforms.uStretch.value = config.stretch;
        cloudUniforms.uWarp.value = config.warp;
        cloudUniforms.uDetail.value = config.detail;
        cloudUniforms.uProj.value = config.proj;
        cloudUniforms.uMinY.value = config.minY;
        cloudUniforms.uBand.value = config.band;
        cloudUniforms.uShadow.value = config.shadow;
        cloudUniforms.uLitSky.value = config.litSky;
        cloudUniforms.uShadowSky.value = config.shadowSky;
        cloudUniforms.uOpacity.value = config.opacity;
        const darkenTarget = nightMode ? 0.2 : weatherRain ? 0.5 : 1;
        cloudUniforms.uDarken.value +=
          (darkenTarget - cloudUniforms.uDarken.value) * Math.min(1, dt * 3);
        cloudDome.position.copy(camera.position);
      }
    }
    // 夜間モード(N)では星を必ず出す。パネルの星スイッチとは独立に点ける。
    const starsVisible = weatherStars || nightMode;
    document.body.dataset.weatherStarsVisible = String(starsVisible);
    if (weatherStarSystem) {
      weatherStarSystem.visible = starsVisible;
      weatherStarSystem.position.copy(camera.position);
    }
    if (weatherSmallStarSystem) {
      weatherSmallStarSystem.visible = starsVisible;
      weatherSmallStarSystem.position.copy(camera.position);
    }
    if (weatherRainSystem) {
      weatherRainSystem.visible = weatherRain;
      if (weatherRain) {
        const positions = weatherRainSystem.geometry.attributes.position.array;
        for (let offset = 0; offset < positions.length; offset += 6) {
          positions[offset + 1] -= 32 * dt;
          positions[offset + 4] -= 32 * dt;
          if (positions[offset + 4] < -2) {
            const y = 42 + Math.random() * 10;
            const x = (Math.random() - 0.5) * 62;
            const z = (Math.random() - 0.5) * 62;
            writeWeatherRainDrop(positions, offset, x, y, z);
          }
        }
        weatherRainSystem.geometry.attributes.position.needsUpdate = true;
        weatherRainSystem.position.set(camera.position.x, camera.position.y, camera.position.z);
      }
    }
  }

  // ------------------------------------------------------------- night ----
  // N キーで夜間モードを切り替える。空・道路・オブジェクトを暗くし、
  // 全車(自車+CPU)のヘッドライトとテールランプが控えめに発光する
  // (車体のランプが光って見えるだけで、路面や周囲は照らさない)。
  let nightMode = false;
  let manualLampMode = false;
  const NIGHT_SKY = 0x050a12;
  const nightLampGroups = [];        // 車両・街灯を含む完全夜間用の灯火
  const vehicleLampGroups = [];      // 薄暗い天候でも点灯する車両灯火だけ
  let playerHeadlight = null;        // 自車の前方約5mだけ照らす実光源
  let playerDayMesh = null;          // 昼の自車(toyota86.vox)
  let playerNightMesh = null;        // 夜の自車(toyota86n.vox: ライト拡大版)

  function vehicleLightsShouldBeVisible() {
    return nightMode || manualLampMode || weatherDimVehicleLights;
  }

  function refreshVehicleLightsVisibility() {
    const visible = vehicleLightsShouldBeVisible();
    for (const lights of vehicleLampGroups) lights.visible = visible;
    if (playerHeadlight) playerHeadlight.visible = visible;
    if (playerDayMesh && playerNightMesh) {
      playerDayMesh.visible = !visible;
      playerNightMesh.visible = visible;
    }
    document.body.dataset.weatherDimVehicleLights =
      String(weatherDimVehicleLights);
    document.body.dataset.vehicleLightsVisible = String(visible);
  }

  function refreshLampVisibility() {
    const allLampsVisible = nightMode || manualLampMode;
    for (const lights of nightLampGroups) lights.visible = allLampsVisible;
    refreshVehicleLightsVisibility();
    if (streetLampHeads) {
      streetLampHeads.material =
        allLampsVisible ? streetLampHeadNightMat : streetLampHeadDayMat;
    }
    document.body.dataset.manualLampMode = String(manualLampMode);
    document.body.dataset.streetLightsVisible = String(allLampsVisible);
  }

  function updateWeatherVehicleLights() {
    const topBrightness = clamp(
      (weatherTopHsl.l - 0.1) / 0.88,
      0,
      1
    );
    const horizonBrightness = clamp(
      (weatherHorizonHsl.l - 0.1) / 0.88,
      0,
      1
    );
    weatherDimVehicleLights =
      Math.max(topBrightness, horizonBrightness) <= 0.4;
    refreshVehicleLightsVisibility();
  }

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
  const mapWhiteGlowMeshes = [];     // 地表以外の白面(窓・トンネル照明)の夜間発光

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
  const tailTrailLocal = new THREE.Vector3();

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
    if (!vehicleLightsShouldBeVisible()) return;
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
      // 車体ローカルの尾灯位置へバンク・ピッチを先に適用してから、
      // 車両のヨー角をワールドへ変換する。
      tailTrailLocal.set(lx, 0.68, -2.28);
      if (car.tilt) tailTrailLocal.applyQuaternion(car.tilt.quaternion);
      const px = car.pos.x + ch * tailTrailLocal.x + sh * tailTrailLocal.z;
      const py = car.pos.y + tailTrailLocal.y;
      const pz = car.pos.z - sh * tailTrailLocal.x + ch * tailTrailLocal.z;
      const prev = car.trailPrev[i];
      car.trailPrev[i] = { x: px, y: py, z: pz };
      if (!prev || teleported) return;
      const sx = px - prev.x, sz = pz - prev.z;
      const len = Math.hypot(sx, sz);
      if (len < 0.05 || len > 6) return;
      const m = trailPool[trailIdx];
      trailIdx = (trailIdx + 1) % TRAIL_MAX;
      m.position.set((px + prev.x) / 2, (py + prev.y) / 2, (pz + prev.z) / 2);
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

  // 車の前後にランプの光球を付ける(夜だけ表示)。
  // 海岸線CPUは対向車を早く認識できるよう、前照灯だけ二層の遠距離仕様にする。
  // トラック(track.vox)の灯火位置。モデルの黄色・赤のランプに合わせた座標で、
  // 拡大後のメートル。VOX_MODEL_TWEAKS の scale とセットで実測している。
  // z は他のCPU車と同じく車体の面より外側へ出す。面と同じ位置に置くと
  // 光球の手前半分が車体に隠れ、ランプではなく背後がにじんで見えるため。
  // 低いランプの高さでは車体前端が3.99、高いランプの高さでは3.07、
  // テールの高さでは後端が-4.07（実測）。そこから0.2m外へ出す。
  const TRUCK_LAMPS = {
    // 前面の黄色。低い位置に2つ、高い位置に3つ。
    low: { y: 0.84, z: 4.19, xs: [-1.18, 1.18], size: 0.42, opacity: 0.9 },
    high: { y: 2.44, z: 3.27, xs: [-0.59, 0, 0.59], size: 0.3, opacity: 0.85 },
    // 背面の赤テールランプ2つ。
    tail: { y: 0.76, z: -4.27, xs: [-0.71, 0.71], size: 0.6, opacity: 0.95 },
  };
  // 黄色は光っていると分かるよう、彩度を落として明るめの黄にする。
  // 光球テクスチャ(255,244,200)に乗算されるので、指定色より暖色寄りに出る。
  const TRUCK_LAMP_COLOR = 0xffe86a;
  // 灯火の発光量。淡い外光を広げ、明るい芯を重ねて3倍ほどの光量にする。
  const TRUCK_LAMP_HALO_SIZE = 3.2;
  const TRUCK_LAMP_HALO_OPACITY = 0.5;
  const TRUCK_LAMP_CORE_SIZE = 1.45;

  function addCarLights(group, bike, lightProfile = 'default', lampLayout = 'car') {
    const lights = new THREE.Group();
    lights.visible = vehicleLightsShouldBeVisible();
    const seaCpuBoost = lightProfile === 'seaCpuBoost';
    lights.userData.lightProfile = lightProfile;
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
      return sprite;
    };
    const headLamp = (x, y, z, s, opacity) => {
      if (seaCpuBoost) {
        // 淡い外光を3倍サイズにし、遠距離で先に見えるようにする。
        const halo = lamp(headGlowTex, 0xfff7da, x, y, z, s * 3, 0.42);
        halo.userData.seaCpuHeadlightHalo = true;
        // 明るい芯も少し拡大し、総発光感を従来のおよそ2.5倍へ上げる。
        const core = lamp(headGlowTex, 0xffffff, x, y, z, s * 1.35, 1);
        core.userData.seaCpuHeadlightCore = true;
      } else {
        lamp(headGlowTex, 0xffffff, x, y, z, s, opacity);
      }
    };
    if (bike) {
      // ヘッドはランプ部分だけが光る小さな光球(車体前端より前に置き、
      // ボンネット側へ光がかからないようにする)
      headLamp(0, 0.72, 1.05, 0.3, 0.85);
      lamp(tailGlowTex, 0xff2018, 0, 0.6, -0.95, 0.48, 0.95);
    } else if (lampLayout === 'truck') {
      // 前面のマーカーランプを黄色で灯す(下段2つ・上段3つ)。
      // 淡い外光と明るい芯の二層で、光っていると分かる明るさにする。
      for (const row of [TRUCK_LAMPS.low, TRUCK_LAMPS.high]) {
        for (const x of row.xs) {
          lamp(headGlowTex, TRUCK_LAMP_COLOR, x, row.y, row.z,
            row.size * TRUCK_LAMP_HALO_SIZE, row.opacity * TRUCK_LAMP_HALO_OPACITY);
          lamp(headGlowTex, TRUCK_LAMP_COLOR, x, row.y, row.z,
            row.size * TRUCK_LAMP_CORE_SIZE, 1);
        }
      }
      // テールランプは他のCPU車と同じ光量(一層・0.6/0.95)にする。
      const tail = TRUCK_LAMPS.tail;
      for (const x of tail.xs) {
        lamp(tailGlowTex, 0xff2018, x, tail.y, tail.z, tail.size, tail.opacity);
      }
    } else {
      for (const side of [-0.72, 0.72]) {
        headLamp(side, 0.6, 2.45, 0.32, 0.85);
        lamp(tailGlowTex, 0xff2018, side, 0.68, -2.28, 0.6, 0.95);
      }
    }
    group.add(lights);
    group.userData.nightLights = lights;
    nightLampGroups.push(lights);
    vehicleLampGroups.push(lights);
  }

  // 地表の暗さ（0=昼のまま / 1=夜間モードと同じ）。
  // コントロールパネルの horizon color の明度が50%を切ったら暗くしていく。
  //   50%〜25% 薄暗い / 25%〜10% もっと薄暗い / 10%以下 夜間モードと同じ
  // 境界(0.5→0, 0.25→0.5, 0.10→1)を通る折れ線で、段差なくつなぐ。
  const DAY_HEMI_SKY = new THREE.Color(0xffffff);
  const NIGHT_HEMI_SKY = new THREE.Color(0x707e9e);
  const DAY_HEMI_GROUND = new THREE.Color(0x6f7168);
  const NIGHT_HEMI_GROUND = new THREE.Color(0x14161c);
  const DAY_SUN = new THREE.Color(0xffffff);
  const NIGHT_SUN = new THREE.Color(0xbfd0ff);
  // 薄暗い段階の色。薄暗さは一段強くして、夜の一歩手前まで落とす（ユーザー指定）。
  // 明度10%以下では下の nightLike 分岐で夜間モードと完全に同じ暗さになる。
  const DUSK_HEMI_SKY = new THREE.Color(0x4a5468);
  const DUSK_HEMI_GROUND = new THREE.Color(0x2a2c32);
  const DUSK_SUN = new THREE.Color(0xa8b4cc);
  function weatherDuskLevel() {
    if (nightMode) return 1;
    // パネルの「明暗」メーターの表示値(0〜1)で判定する。HSLのlは0.10〜0.98へ
    // 割り当てられているので、生のlで比べるとメーターの%とずれる。
    const meter = clamp((weatherHorizonHsl.l - 0.1) / 0.88, 0, 1);
    if (meter >= 0.5) return 0;      // 50%以上は通常どおり
    if (meter <= 0.1) return 1;      // 10%以下は夜間モードと同じ暗さ
    return (0.5 - meter) / 0.4;      // 50%→10%は%に連動して暗くなる
  }

  function applyNight() {
    applyWeatherSky();
    // 空(horizon)の明るさに合わせて地表も暗くする。空だけ暗く地面が昼のままだと
    // 夕暮れや曇天に見えないため。0=昼のまま / 1=夜間モードと同じ暗さ。
    const dusk = weatherDuskLevel();
    const nightLike = dusk >= 1;
    if (nightLike) {
      hemi.intensity = 0.13;
      hemi.color.copy(NIGHT_HEMI_SKY);
      hemi.groundColor.copy(NIGHT_HEMI_GROUND);
      sun.intensity = 0.04;
      sun.color.copy(NIGHT_SUN);
    } else {
      hemi.intensity = 0.55 + (0.20 - 0.55) * dusk;
      hemi.color.copy(DAY_HEMI_SKY).lerp(DUSK_HEMI_SKY, dusk);
      hemi.groundColor.copy(DAY_HEMI_GROUND).lerp(DUSK_HEMI_GROUND, dusk);
      sun.intensity = 0.85 + (0.18 - 0.85) * dusk;
      sun.color.copy(DAY_SUN).lerp(DUSK_SUN, dusk);
    }
    document.body.dataset.weatherDuskLevel = dusk.toFixed(2);
    refreshLampVisibility();
    // 夜間は自車を toyota86n.vox(ライト拡大版)へ切り替える。
    // 地図側の発光を許可したコースだけ、白面を夜間発光させる。
    for (const glowMesh of mapWhiteGlowMeshes) glowMesh.visible = nightLike;
    document.body.dataset.mapWhiteGlowVisible = nightLike
      ? String(mapWhiteGlowMeshes.length)
      : '0';
    // 海岸線・インディアナポリスは地表を一切自己発光させない。
    // 許可されたコースだけ、グレー路面を弱く自己発光させる。
    for (const roadMesh of car2RoadMeshes) {
      for (const mat of (Array.isArray(roadMesh.material) ? roadMesh.material : [roadMesh.material])) {
        if (!mat || !mat.emissive) continue;
        if (nightLike && MAP_CONFIG.roadNightEmissive !== false) {
          mat.emissive.copy(mat.color).multiplyScalar(0.33);
        }
        else mat.emissive.set(0x000000);
      }
    }
    document.body.dataset.nightMode = String(nightMode);
    if (typeof refreshWeatherControls === 'function') refreshWeatherControls();
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
    if (MAP_GLTF) ground.visible = false;
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
  const DUST_MAX = 260;    // D02砂地のドリフト用。通常煙より多量に出す。
  const skidPool = [];
  const smokePool = [];
  const dustPool = [];
  let skidIdx = 0, smokeIdx = 0, smokeTimer = 0;
  let dustIdx = 0, dustTimer = 0;
  const lastSkid = { x: 1e9, z: 1e9 };
  const skidSurfaceNormal = new THREE.Vector3();
  const skidForward = new THREE.Vector3();
  const skidAcross = new THREE.Vector3();
  const skidBasis = new THREE.Matrix4();

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

  // 砂地・ウッドチップ路面用の砂煙/土埃テクスチャ。
  function makeDustTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    const [red, green, blue] = MAP_CONFIG.dustColor ?? [205, 178, 118];
    g.addColorStop(0, `rgba(${red},${green},${blue},0.9)`);
    g.addColorStop(1, `rgba(${red},${green},${blue},0)`);
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
    const dustTexture = makeDustTexture();
    for (let i = 0; i < DUST_MAX; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dustTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }));
      s.visible = false;
      s.userData = { life: 0, max: 1, vx: 0, vy: 0, vz: 0 };
      scene.add(s);
      dustPool.push(s);
    }
    document.body.dataset.sandDustPoolSize = String(dustPool.length);
    document.body.dataset.seaSandDustPuffs = '0';
  }

  function emitSandDust(fx, fz, sx, sz, dt, heavy = false) {
    const rx = player.pos.x - fx * 1.5;
    const rz = player.pos.z - fz * 1.5;
    // 通常走行でも薄く出し、ドリフト時は高密度にする。森林地帯は設定値で
    // ウッドチップらしい土埃の量へ調整する。
    const interval = heavy
      ? (MAP_CONFIG.dustHeavyInterval ?? 0.012)
      : (MAP_CONFIG.dustNormalInterval ?? 0.028);
    dustTimer += dt;
    while (dustTimer > interval) {
      dustTimer -= interval;
      const s = dustPool[dustIdx];
      dustIdx = (dustIdx + 1) % dustPool.length;
      const side = Math.random() < 0.5 ? -0.82 : 0.82;
      s.position.set(
        rx + sx * side + (Math.random() - 0.5) * 0.55,
        player.pos.y + 0.22,
        rz + sz * side + (Math.random() - 0.5) * 0.55
      );
      const dustScale = MAP_CONFIG.dustScale ?? 1;
      s.scale.setScalar((0.8 + Math.random() * 0.45) * dustScale);
      const d = s.userData;
      d.life = 0;
      d.max = 1.0 + Math.random() * 0.65;
      d.vx = (Math.random() - 0.5) * 2.2;
      d.vy = 0.8 + Math.random() * 1.3;
      d.vz = (Math.random() - 0.5) * 2.2;
      s.visible = true;
      document.body.dataset.seaSandDustPuffs = String(
        Number(document.body.dataset.seaSandDustPuffs || 0) + 1
      );
      document.body.dataset.mapSurfaceDustPuffs = String(
        Number(document.body.dataset.mapSurfaceDustPuffs || 0) + 1
      );
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
        const markX = rx + sx * side;
        const markZ = rz + sz * side;
        const surface = mapRoot
          ? getMapSurfaceAt(markX, markZ, player.pos.y)
          : null;
        let markY = player.pos.y + 0.11;
        skidSurfaceNormal.set(0, 1, 0);
        if (surface) {
          markY = surface.point.y + 0.028;
          if (surface.face) {
            skidSurfaceNormal.copy(surface.face.normal)
              .transformDirection(surface.object.matrixWorld)
              .normalize();
            if (skidSurfaceNormal.y < 0) skidSurfaceNormal.negate();
          }
        }
        // 左右それぞれの直下路面へ独立して貼る。バンクでは車体中央高を
        // 共用しないため、上側のタイヤ痕も路面内部へ埋まらない。
        skidForward.set(fx, 0, fz)
          .addScaledVector(
            skidSurfaceNormal,
            -skidForward.dot(skidSurfaceNormal)
          )
          .normalize();
        if (skidForward.lengthSq() < 0.01) skidForward.set(fx, 0, fz);
        skidAcross.crossVectors(skidForward, skidSurfaceNormal).normalize();
        skidBasis.makeBasis(skidAcross, skidForward, skidSurfaceNormal);
        m.quaternion.setFromRotationMatrix(skidBasis);
        m.position.set(
          markX,
          markY + (skidIdx % 8) * 0.0012,
          markZ
        );
        m.material.opacity = 0.5;
        m.visible = true;
        if (COURSE_KEY === 'indy') {
          const key = side < 0 ? 'indySkidMarksRight' : 'indySkidMarksLeft';
          document.body.dataset[key] = String(
            Number(document.body.dataset[key] || 0) + 1
          );
        }
      }
    }

    // ドリフト煙: インディアナポリスも左右のタイヤ痕と同時に出す。
    // 痕だけ／煙だけへ分かれず、全車で同じ「タイヤ痕＋煙」の演出になる。
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
      if (COURSE_KEY === 'indy') {
        document.body.dataset.indyPlayerSmokePuffs = String(
          Number(document.body.dataset.indyPlayerSmokePuffs || 0) + 1
        );
      }
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
      s.scale.addScalar(dt * 2.1);
      s.material.opacity = 0.65 * (1 - d.life / d.max);
    }
  }

  // ------------------------------------------------------------- player ---
  // インディアナポリスだけユーザー車を250km/h・加速力1.5倍にする。
  // CPU車の速度は個別のAI設定を使うため、この値の影響を受けない。
  const PLAYER_TOP_SPEED_KMH = COURSE_KEY === 'indy' ? 250 : 180;
  const PLAYER_TOP_SPEED = PLAYER_TOP_SPEED_KMH / 3.6;
  const PLAYER_ACCEL_MULTIPLIER = COURSE_KEY === 'indy' ? 1.5 : 1;
  const GEARS = [
    { name: 'R', vmax: -8.3, acc: 5.5 },   // ~30 km/h reverse
    { name: 'N', vmax: 0, acc: 0 },
    { name: '1', vmax: 6.1, acc: 10.0 },  // 22 km/h
    { name: '2', vmax: 11.1, acc: 8.0 },   // 40
    { name: '3', vmax: 15.3, acc: 7.0 },   // 55
    { name: '4', vmax: 27.8, acc: 7.0 },   // 100 km/h
    // インディアナポリスでは250km/h手前でも駆動力が残るよう5速比だけ延長する。
    { name: '5', vmax: COURSE_KEY === 'indy' ? 75.0 : 54.0, acc: 14.0 },
  ];
  document.body.dataset.playerTopSpeedKmh = String(PLAYER_TOP_SPEED_KMH);
  document.body.dataset.playerAccelerationMultiplier = String(PLAYER_ACCEL_MULTIPLIER);

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
  // 実車モデルの高さから求める乗越え限界。init() で読み込んだモデルを実測して更新する。
  let playerVehicleHeight = 2.7;
  let playerClimbHeight = playerVehicleHeight * 0.25;
  const PLAYER_AXLE_HALF = 1.7;
  const PLAYER_TRACK_HALF = 0.78;

  const aiCars = []; // { group, tilt, pos, heading, v, base, wps, idx, radius }

  // デモ自動運転のルートと、切り替え式デモカメラの状態
  let demoRoute = null;
  let demoIdx = 1;
  const demoCam = { nextChange: 0, until: 0, yaw: 0, pitch: 0.3, dist: 12 };
  let demoCamUserHeld = false;       // ドラッグでユーザーがカメラを握っているか
  let demoSequenceStartedAt = 0;
  let demoSequenceActionCount = 0;
  let demoSequenceWeatherCount = 0;
  let demoSequenceLeaving = false;

  // ------------------------------------------------------------- camera ---
  const cam = { yaw: 0, pitch: 0.34, dist: 10, dragging: false, lastDrag: 0 };
  // 追従カメラの振れる範囲。下げすぎると地面へ潜るので 0.08 で止める。
  const CAM_PITCH_MIN = 0.08;
  const CAM_PITCH_MAX = 1.25;
  // 主観視点(bonnetView 2)は車体を映さないので、真上まで見上げられるようにする。
  // 見上げる角度は lookPitch = 0.34 - cam.pitch なので、真上(π/2)には
  // cam.pitch が負まで必要になる。真上ちょうどは lookAt の上方向と重なって
  // 向きが定まらないため、わずかに手前(約89度)で止める。
  const CAM_LOOK_BASE_PITCH = 0.34;
  const CAM_PITCH_MIN_FIRST_PERSON = CAM_LOOK_BASE_PITCH - (Math.PI / 2 - 0.02);
  // V相当の視点切替。ドラッグで振った向きはそのまま残し、
  // 一周して通常カメラへ戻った時だけ既定の位置へ戻す。
  function switchBonnetView() {
    bonnetView = (bonnetView + 1) % 3;
    if (bonnetView !== 0) return;
    cam.yaw = 0;
    cam.pitch = 0.34;
    cam.dist = 10;
    cam.lastDrag = 0;
  }
  renderer.domElement.addEventListener('pointerdown', (e) => {
    AUDIO.unlock();
    if (demoActive) {
      if (DEMO_SEQUENCE_ACTIVE || CAR2_MODE) {
        // 4コースデモ/首都高デモ: ドラッグ=カメラ移動、タップ=視点切替。
        demoTapMove = 0;
      } else {
        startGame();
        return;
      }
    }
    cam.dragging = true;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointerup', () => {
    cam.dragging = false;
    cam.lastDrag = performance.now();
    // デモ中、ほぼ動かさずに離した(クリック/タップ)なら視点を切り替える。
    // ドラッグした場合はデモを継続し、カメラだけ動かす。
    // 4コースデモを終わるのは左上の「戻る」ボタンだけ(PC・スマホ共通)。
    if (demoActive && (DEMO_SEQUENCE_ACTIVE || CAR2_MODE) && demoTapMove < 12) {
      if (DEMO_SEQUENCE_ACTIVE || IS_MOBILE) switchBonnetView();
      else exitCar2Demo();
    }
    demoTapMove = 1e9;
  });
  window.addEventListener('pointermove', (e) => {
    if (!cam.dragging) return;
    demoTapMove += Math.abs(e.movementX) + Math.abs(e.movementY);
    cam.yaw -= e.movementX * 0.005;
    const pitchMin = bonnetView === 2 ? CAM_PITCH_MIN_FIRST_PERSON : CAM_PITCH_MIN;
    cam.pitch = clamp(cam.pitch + e.movementY * 0.004, pitchMin, CAM_PITCH_MAX);
    cam.lastDrag = performance.now();
  });

  // デモは画面に触れるとカメラを振れるが、それだけでは終われない。
  // 触れている間と離してから3.5秒だけ、左上に「戻る」を出して逃げ道にする。
  // ボタンはcanvasの外なのでdemoTapMoveが0にならず、押しても視点は切り替わらない。
  const DEMO_BACK_BUTTON_LINGER_MS = 3500;
  let demoBackButton = null;
  let demoBackButtonHideTimer = 0;
  function ensureDemoBackButton() {
    if (demoBackButton) return demoBackButton;
    const button = document.createElement('button');
    button.id = 'demo-back-btn';
    button.type = 'button';
    button.textContent = '戻る';
    button.style.cssText =
      'position:fixed;left:14px;top:14px;z-index:80;'
      + 'padding:10px 22px;border:2px solid #fff;border-radius:6px;'
      + 'background:transparent;color:#fff;'
      + 'font:800 16px/1 "Arial Black","Yu Gothic",Meiryo,sans-serif;'
      + 'letter-spacing:0.18em;cursor:pointer;'
      + 'opacity:0;pointer-events:none;transition:opacity 160ms ease;'
      + 'touch-action:manipulation;-webkit-tap-highlight-color:transparent;';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      exitDemoSequenceToTitle();
    });
    document.body.append(button);
    demoBackButton = button;
    return button;
  }
  function showDemoBackButton() {
    if (!DEMO_SEQUENCE_ACTIVE || !demoActive) return;
    const button = ensureDemoBackButton();
    clearTimeout(demoBackButtonHideTimer);
    demoBackButtonHideTimer = 0;
    button.style.opacity = '1';
    button.style.pointerEvents = 'auto';
    document.body.dataset.demoBackButtonVisible = 'true';
  }
  function scheduleHideDemoBackButton() {
    if (!demoBackButton) return;
    clearTimeout(demoBackButtonHideTimer);
    demoBackButtonHideTimer = setTimeout(() => {
      demoBackButton.style.opacity = '0';
      demoBackButton.style.pointerEvents = 'none';
      document.body.dataset.demoBackButtonVisible = 'false';
    }, DEMO_BACK_BUTTON_LINGER_MS);
  }
  window.addEventListener('pointerdown', showDemoBackButton, { capture: true });
  window.addEventListener('pointerup', scheduleHideDemoBackButton);
  window.addEventListener('pointercancel', scheduleHideDemoBackButton);
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
  const UP = new THREE.Vector3(0, 1, 0);
  const rayOrigin = new THREE.Vector3();
  const roadSurfaceNormal = new THREE.Vector3();
  const roadSurfaceLocalUp = new THREE.Vector3();
  const roadTiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  const roadTiltTarget = new THREE.Quaternion();
  const aiRoadNormal = new THREE.Vector3();
  const aiRoadLocalUp = new THREE.Vector3();
  const aiRoadTiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  const aiRoadTiltTarget = new THREE.Quaternion();
  const driveTiltEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  const driveTiltTarget = new THREE.Quaternion();
  const smoothedRoadTilt = new THREE.Quaternion();
  const combinedTiltTarget = new THREE.Quaternion();
  const seaBridgeInverse = new THREE.Matrix4();
  const seaBridgeWorldNormal = new THREE.Vector3();
  const seaBridgeLocalNormal = new THREE.Vector3();
  function ignoresRoadTriangleWalls(object) {
    return (
      Boolean(MAP_CONFIG.ignoreRoadTriangleWalls)
        && roadMeshes.includes(object)
    ) || (
      COURSE_KEY === 'sea'
        && car2DrivableMeshes.includes(object)
    );
  }
  function minimumGroundNormalY(object) {
    // インディアナポリスのM06/M07バンクは、ほぼ垂直に近い分割面も走行面として
    // 扱う。道路以外の壁材質には適用しない。
    if (COURSE_KEY === 'indy' && roadMeshes.includes(object)) return 0.02;
    return ignoresRoadTriangleWalls(object) ? 0.2 : 0.55;
  }
  function raycastHeightAt(x, z, targets, startY = null) {
    if (!targets || !targets.length) return null;
    const y = startY ?? mapRayTop;
    rayOrigin.set(x, y, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = Math.max(20, y - mapRayBottom + 20);
    const hit = groundCaster.intersectObjects(targets, true).find((candidate) => {
      if (!candidate.face) return true;
      wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
      // glTF 変換時に面の表裏が反転していても、水平に近い面なら地表として扱う。
      // ぐんまーのバンク道路は三角形ごとの傾斜が大きいため、道路材質だけ
      // より急な面まで支持面として認識する。
      const minGroundNormalY = minimumGroundNormalY(candidate.object);
      return Math.abs(wallNormal.y) > minGroundNormalY;
    });
    return hit ? hit.point.y : null;
  }
  function getRoadHeightAt(x, z) {
    return raycastHeightAt(x, z, roadMeshes);
  }
  function getRoadHeightNear(x, z, referenceY) {
    if (!roadMeshes.length) return null;
    rayOrigin.set(x, mapRayTop, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = Math.max(20, mapRayTop - mapRayBottom + 20);
    const candidates = groundCaster.intersectObjects(roadMeshes, true)
      .filter((candidate) => {
        if (!candidate.face) return false;
        wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
        const minGroundNormalY = minimumGroundNormalY(candidate.object);
        return Math.abs(wallNormal.y) > minGroundNormalY;
      })
      .sort((left, right) =>
        Math.abs(left.point.y - referenceY) - Math.abs(right.point.y - referenceY));
    return candidates[0]?.point.y ?? null;
  }
  function getRoadSurfaceAt(x, z, referenceY) {
    if (!roadMeshes.length) return null;
    rayOrigin.set(x, mapRayTop, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = Math.max(20, mapRayTop - mapRayBottom + 20);
    const candidates = groundCaster.intersectObjects(roadMeshes, true)
      .filter((candidate) => {
        if (!candidate.face) return false;
        wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
        const minGroundNormalY = minimumGroundNormalY(candidate.object);
        return Math.abs(wallNormal.y) > minGroundNormalY;
      })
      .sort((left, right) =>
        Math.abs(left.point.y - referenceY) - Math.abs(right.point.y - referenceY));
    return candidates[0] ?? null;
  }
  function getDrivableSurfacesAt(x, z) {
    if (!car2DrivableMeshes.length) return null;
    rayOrigin.set(x, mapRayTop, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = Math.max(20, mapRayTop - mapRayBottom + 20);
    return groundCaster.intersectObjects(car2DrivableMeshes, true)
      .filter((candidate) => {
        if (!candidate.face) return false;
        wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
        const minGroundNormalY = minimumGroundNormalY(candidate.object);
        return Math.abs(wallNormal.y) > minGroundNormalY;
      });
  }
  function getDrivableSurfaceAt(x, z, referenceY) {
    const candidates = getDrivableSurfacesAt(x, z);
    if (!candidates?.length) return null;
    candidates.sort((left, right) =>
      Math.abs(left.point.y - referenceY) - Math.abs(right.point.y - referenceY));
    const hit = candidates[0];
    return hit && Math.abs(hit.point.y - referenceY) < 3 ? hit : null;
  }
  function getTopDrivableHeightAt(x, z) {
    return getDrivableSurfacesAt(x, z)?.[0]?.point.y ?? null;
  }
  function getDrivableHeightAt(x, z, referenceY) {
    return getDrivableSurfaceAt(x, z, referenceY)?.point.y ?? null;
  }
  function getMapSurfacesAt(x, z) {
    const supportMeshes = MAP_CONFIG.fallOutsideRoad
      ? roadMeshes
      : MAP_CONFIG.supportSurfaceMode === 'drivable'
        ? car2DrivableMeshes
        : mapSurfaceMeshes;
    if (!supportMeshes.length) return [];
    rayOrigin.set(x, mapRayTop, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = Math.max(20, mapRayTop - mapRayBottom + 20);
    return groundCaster.intersectObjects(supportMeshes, true)
      .filter((candidate) => {
        if (!candidate.face) return false;
        wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
        const minGroundNormalY = minimumGroundNormalY(candidate.object);
        return Math.abs(wallNormal.y) > minGroundNormalY;
      });
  }
  function roadSeamAssistHeight(object) {
    const baseHeight = playerClimbHeight;
    if (
      Number.isFinite(MAP_CONFIG.drivableSeamAssistRatio)
      && car2DrivableMeshes.includes(object)
    ) {
      return Math.max(
        baseHeight,
        playerVehicleHeight * MAP_CONFIG.drivableSeamAssistRatio
      );
    }
    // 強いアシストは道路として指定されたメッシュだけ。緑地・建物・側壁など
    // その他の材質は従来どおり車高の1/4を越えると通過できない。
    if (!roadMeshes.includes(object)) return baseHeight;
    return Math.max(
      baseHeight,
      playerVehicleHeight * (MAP_CONFIG.roadSeamAssistRatio ?? 0.25)
    );
  }
  function getMapSurfaceAt(x, z, referenceY, allowLayerJump = false) {
    // 橋・トンネル・山道が上下に重なる場所で、レイが一瞬だけ現在の面を
    // 外しても数m下の別レイヤーへ落ちないようにする。
    const maxLayerDrop = Math.max(1.2, playerVehicleHeight * 1.25);
    const candidates = getMapSurfacesAt(x, z).filter((candidate) => {
      const rise = candidate.point.y - referenceY;
      const maxStep = Math.max(0.05, roadSeamAssistHeight(candidate.object) - 0.01);
      const maxDrop = Math.max(maxLayerDrop, roadSeamAssistHeight(candidate.object));
      wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
      // 平らな段差は車高の1/4未満だけ許可する。連続した坂面は高さ差では
      // 拒否しないが、遠い上層・屋根へ一度に飛ばない高さ内に限定する。
      const isContinuousLayer = allowLayerJump || rise > -maxDrop;
      const maxSlopeRise = Math.max(maxStep, playerVehicleHeight * 1.25);
      const isSlope = Math.abs(wallNormal.y) < 0.995;
      return isContinuousLayer && (rise < maxStep || (isSlope && rise < maxSlopeRise));
    });
    candidates.sort((left, right) =>
      Math.abs(left.point.y - referenceY) - Math.abs(right.point.y - referenceY));
    return candidates[0] ?? null;
  }
  function seaBridgeHeightAt(bridge, x, z) {
    const along = (x - bridge.startX) * bridge.directionX
      + (z - bridge.startZ) * bridge.directionZ;
    const linearT = clamp(along / bridge.length, 0, 1);
    const smoothT = linearT * linearT * (3 - 2 * linearT);
    return bridge.startY + (bridge.targetY - bridge.startY) * smoothT;
  }
  function getSeaForwardBridgeSurface(referenceY) {
    if (COURSE_KEY !== 'sea') return null;
    const speed = player.vel.length();
    if (speed <= 0.3) return null;
    const directionX = player.vel.x / speed;
    const directionZ = player.vel.z / speed;

    if (
      seaSurfaceBridge
      && directionX * seaSurfaceBridge.directionX
        + directionZ * seaSurfaceBridge.directionZ < 0.35
    ) {
      seaSurfaceBridge = null;
    }
    if (!seaSurfaceBridge) {
      // 砂浜・草地・道路の境界にできた無面区間の先を探す。見つけた面へ
      // 即座にワープせず、現在高から次の面まで仮想スロープを作る。
      const lookAheadDistances = [0.6, 1.2, 1.8, 2.5, 3.3, 4.2, 5.2];
      for (const distance of lookAheadDistances) {
        const surface = getMapSurfaceAt(
          player.pos.x + directionX * distance,
          player.pos.z + directionZ * distance,
          referenceY,
          true
        );
        if (!surface) continue;
        seaSurfaceBridge = {
          startX: player.pos.x,
          startZ: player.pos.z,
          startY: player.pos.y
            - CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset - 0.012,
          targetY: surface.point.y,
          directionX,
          directionZ,
          // 高さ差が大きい境界ほど長い仮想坂にして、1フレームでの上下量と
          // 車体角度の急変を抑える。実メッシュが始まっても終点まではこの坂を使う。
          length: Math.max(
            distance,
            Math.min(7.5, 3 + Math.abs(surface.point.y - (
              player.pos.y - CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset - 0.012
            )) * 1.5)
          ),
          surface,
        };
        break;
      }
    }
    const bridge = seaSurfaceBridge;
    if (!bridge) return null;
    const along = (player.pos.x - bridge.startX) * bridge.directionX
      + (player.pos.z - bridge.startZ) * bridge.directionZ;
    if (along < -0.5 || along > bridge.length + 0.75) {
      seaSurfaceBridge = null;
      return null;
    }
    const linearT = clamp(along / bridge.length, 0, 1);
    const height = seaBridgeHeightAt(bridge, player.pos.x, player.pos.z);
    const derivative = (bridge.targetY - bridge.startY)
      * 6 * linearT * (1 - linearT) / bridge.length;
    seaBridgeWorldNormal.set(
      -bridge.directionX * derivative,
      1,
      -bridge.directionZ * derivative
    ).normalize();
    seaBridgeInverse.copy(bridge.surface.object.matrixWorld).invert();
    seaBridgeLocalNormal.copy(seaBridgeWorldNormal)
      .transformDirection(seaBridgeInverse)
      .normalize();
    return {
      ...bridge.surface,
      point: new THREE.Vector3(player.pos.x, height, player.pos.z),
      face: {
        ...bridge.surface.face,
        normal: seaBridgeLocalNormal.clone(),
      },
      seaBridgeInfo: bridge,
    };
  }
  function groundHeightAt(x, y, z) {
    if (!mapRoot) return 0;
    rayOrigin.set(x, y + RIDE_RAY, z);
    groundCaster.set(rayOrigin, DOWN);
    groundCaster.far = rayOrigin.y + 100;   // reach the ground from any height
    const hit = groundCaster.intersectObject(mapRoot, true)[0];
    return hit ? hit.point.y : y;
  }

  // 垂直の構築物(建物・壁)との当たり判定: 乗越え限界の少し上から進行方向へ短い
  // レイを3本飛ばし、ほぼ垂直な面に当たったら壁とみなして滑らせて止める。
  // 車高の1/4以下の白線・小段差はレイより下になるため壁扱いされず、
  // 坂や橋のスロープ(面が上を向いている)も素通りするので登坂を妨げない。
  const wallCaster = new THREE.Raycaster();
  const wallDir = new THREE.Vector3();
  const wallOrigin = new THREE.Vector3();
  const wallNormal = new THREE.Vector3();
  const wallFaceVertex = new THREE.Vector3();
  function wallFaceHeight(hit) {
    const position = hit.object?.geometry?.attributes?.position;
    if (!position || !hit.face) return Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
      const y = wallFaceVertex
        .fromBufferAttribute(position, index)
        .applyMatrix4(hit.object.matrixWorld).y;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return maxY - minY;
  }
  function indyRoadContinuesPastWall(distance) {
    if (COURSE_KEY !== 'indy') return false;
    const maxHeightDifference = playerVehicleHeight * 10;
    return [0.6, 2.0].every((extraDistance) => {
      const roadAhead = getRoadSurfaceAt(
        player.pos.x + wallDir.x * (distance + extraDistance),
        player.pos.z + wallDir.z * (distance + extraDistance),
        player.pos.y
      );
      return roadAhead
        && Math.abs(roadAhead.point.y - player.pos.y) < maxHeightDifference;
    });
  }
  function collideWalls(dt) {
    if (!mapRoot || MAP_CONFIG.ignoreMapWallCollisions) return false;
    const speed = player.vel.length();
    if (speed < 0.3) return false;
    wallDir.copy(player.vel).multiplyScalar(1 / speed);
    const reach = 2.5 + speed * dt;
    wallCaster.far = reach;
    let collided = false;
    for (const side of [-0.85, 0, 0.85]) {
      wallOrigin.set(
        player.pos.x - wallDir.z * side,
        player.pos.y + Math.max(0.05, playerClimbHeight + 0.005),
        player.pos.z + wallDir.x * side
      );
      wallCaster.set(wallOrigin, wallDir);
      const hit = wallCaster.intersectObject(mapRoot, true).find((candidate) => {
        if (!candidate.face) return false;
        // このマップ群では道路と壁の材質色が必ず異なる。道路色として登録した
        // メッシュは、垂直に見える三角面も坂・バンクの継ぎ目なので壁にしない。
        if (
          roadMeshes.includes(candidate.object)
          || nonWallMeshes.includes(candidate.object)
          || (COURSE_KEY === 'indy' && car2DrivableMeshes.includes(candidate.object))
        ) {
          return false;
        }
        wallNormal.copy(candidate.face.normal).transformDirection(candidate.object.matrixWorld);
        // 道路色以外のうち「明らかに垂直」な面だけを壁にする。85度未満の
        // 地形斜面・粗い三角面はここで止めず、路面追従へ渡す。
        if (Math.abs(wallNormal.y) > 0.08) return false;
        // 森林マップ同士の接続位置に残った横断方向の終端片は壁ではない。
        // 道路沿いの外壁（主にX法線）は維持し、接続面（主にZ法線）だけ通す。
        if (
          COURSE_KEY === 'forest'
          && Math.abs(wallNormal.z) > 0.7
          && [...mapSequenceSeamZs, ...mapSequenceLoopSeamZs]
            .some((seamZ) => Math.abs(candidate.point.z - seamZ) <= 5)
        ) {
          document.body.dataset.forestSeamWallPasses = String(
            Number(document.body.dataset.forestSeamWallPasses || 0) + 1
          );
          return false;
        }
        // 森林地帯の道路脇には変換時に細い縦リップが混ざる。車高の約1/3以下は
        // 路面の微細な凹凸として通過させ、木や明確な壁だけを衝突対象に残す。
        if (
          COURSE_KEY === 'forest'
          && wallFaceHeight(candidate) <= playerVehicleHeight * 0.35
        ) {
          document.body.dataset.forestMicroBumpPasses = String(
            Number(document.body.dataset.forestMicroBumpPasses || 0) + 1
          );
          return false;
        }
        if (indyRoadContinuesPastWall(candidate.distance)) {
          // 道路が壁面のさらに先まで続いているなら、それは外周壁ではなく
          // バンク内部の立った継ぎ目。上り・下り・横滑りを問わず通過させる。
          document.body.dataset.indyBankSeamPasses = String(
            Number(document.body.dataset.indyBankSeamPasses || 0) + 1
          );
          return false;
        }
        // 地図設定で壁色と明示された面は、細かな三角分割で1面の高さが低くても
        // 垂直である限り必ず壁として止める。
        if (wallMeshes.includes(candidate.object)) return true;
        // 垂直面の乗越え限界は常に車高1/4。急坂追従用の roadSeamAssistRatio は
        // 高さ・姿勢計算だけに使い、垂直壁の通過許可には使わない。
        return wallFaceHeight(candidate) > playerClimbHeight + 0.005;
      });
      if (!hit || !hit.face) continue;
      collided = true;
      wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
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
    if (collided) {
      mapWallCollisionCount++;
      document.body.dataset.mapWallCollisionCount = String(mapWallCollisionCount);
    }
    return collided;
  }

  const TOKYO_LOOP_CENTER_X = -128.55;
  const TOKYO_LOOP_EDGE_Z = 1652.25;
  const TOKYO_LOOP_ENTRY_Z = 1644;
  const car2LastRoadPos = new THREE.Vector3();

  function setupMapLoopPortal() {
    mapLoopPortal = null;
    mapLoopCount = 0;
    document.body.dataset.mapLoopCount = '0';
    document.body.dataset.mapLoopReady = 'false';
    if (!['vertical', 'sequence'].includes(MAP_CONFIG.loopMode)) return;
    if (!mapRoot || !mapSpawn || !mapBounds || mapBounds.isEmpty()) return;

    if (CAR2_MODE) {
      mapLoopPortal = {
        minZ: -TOKYO_LOOP_EDGE_Z,
        maxZ: TOKYO_LOOP_EDGE_Z,
        entryMinZ: -TOKYO_LOOP_ENTRY_Z,
        entryMaxZ: TOKYO_LOOP_ENTRY_Z,
      };
    } else {
      const inset = Math.max(0.5, Math.min(2, (mapBounds.max.z - mapBounds.min.z) * 0.002));
      mapLoopPortal = {
        minZ: mapBounds.min.z,
        maxZ: mapBounds.max.z,
        entryMinZ: mapBounds.min.z + inset,
        entryMaxZ: mapBounds.max.z - inset,
      };
    }
    document.body.dataset.mapLoopReady = 'true';
    document.body.dataset.mapLoopMinZ = mapLoopPortal.minZ.toFixed(3);
    document.body.dataset.mapLoopMaxZ = mapLoopPortal.maxZ.toFixed(3);
    document.body.dataset.mapLoopEntryMinZ = mapLoopPortal.entryMinZ.toFixed(3);
    document.body.dataset.mapLoopEntryMaxZ = mapLoopPortal.entryMaxZ.toFixed(3);
  }

  function wrapMapAtRoadEnds() {
    if (!mapLoopPortal) return false;
    const outwardMin = player.pos.z < mapLoopPortal.minZ && player.vel.z < 0;
    const outwardMax = player.pos.z > mapLoopPortal.maxZ && player.vel.z > 0;
    if (!outwardMin && !outwardMax) return false;

    // 縦に同じ地図をつないだだけのループ。X・向き・速度は変えない。
    player.pos.z = outwardMin
      ? mapLoopPortal.entryMaxZ
      : mapLoopPortal.entryMinZ;
    // ループ先だけは反対端との標高差を許可し、着地点の最寄り面へ移す。
    const loopSurface = getMapSurfaceAt(player.pos.x, player.pos.z, player.pos.y, true);
    player.pos.y = loopSurface?.point.y ?? mapSpawn?.y ?? player.pos.y;
    car2LastRoadPos.copy(player.pos);
    mapLoopCount++;
    document.body.dataset.mapLoopCount = String(mapLoopCount);
    if (CAR2_MODE) document.body.dataset.car2LoopCount = String(mapLoopCount);
    return true;
  }

  function isCar2RoadAt(x, z) {
    if (!car2DrivableMeshes.length) return true;
    return getDrivableHeightAt(x, z, player.pos.y) !== null;
  }

  function keepCar2OnRoad() {
    if (!mapRoot || !mapSurfaceMeshes.length) return null;
    if (wrapMapAtRoadEnds()) {
      return getMapSurfaceAt(player.pos.x, player.pos.z, player.pos.y);
    }
    if (COURSE_KEY === 'sea' && seaSurfaceBridge) {
      const onBlockedSurface =
        raycastHeightAt(player.pos.x, player.pos.z, blockedSurfaceMeshes) !== null;
      if (!onBlockedSurface) {
        const bridgeSurface = getSeaForwardBridgeSurface(player.pos.y);
        if (bridgeSurface) return bridgeSurface;
      }
      seaSurfaceBridge = null;
    }
    const surface = getMapSurfaceAt(player.pos.x, player.pos.z, player.pos.y);
    if (surface) {
      seaSurfaceBridge = null;
      car2LastRoadPos.copy(player.pos);
      return surface;
    }
    if (MAP_CONFIG.blockOutsideDrivableSurface) {
      if (COURSE_KEY === 'sea') {
        const onBlockedSurface =
          raycastHeightAt(player.pos.x, player.pos.z, blockedSurfaceMeshes) !== null;
        const insideMapX = mapBounds
          && player.pos.x > mapBounds.min.x + 0.2
          && player.pos.x < mapBounds.max.x - 0.2;
        if (!onBlockedSurface && insideMapX) {
          const bridgeSurface = getSeaForwardBridgeSurface(player.pos.y);
          if (bridgeSurface) {
            // 高い草地斜面を少し先で検出した時点で車体を路面高へ持ち上げる。
            // 砂浜側の低い高さを保持したまま斜面へ刺さる現象を防止する。
            car2LastRoadPos.copy(player.pos);
            document.body.dataset.mapSeaForwardBridgeUses = String(
              Number(document.body.dataset.mapSeaForwardBridgeUses || 0) + 1
            );
            return bridgeSurface;
          }
          // 海岸線内の道路・草地・路肩の境界には、変換時に生じた細い無面区間が
          // ある。海H07とX端以外では直前位置へ戻さず、そのまま通過させる。
          // 高さは次の支持面を拾うまで維持するので段差へ車体が刺さらない。
          car2LastRoadPos.copy(player.pos);
          document.body.dataset.mapUnsupportedSeamPasses = String(
            Number(document.body.dataset.mapUnsupportedSeamPasses || 0) + 1
          );
          document.body.dataset.mapSeaGapPassPolicy = 'pass-except-h07-and-x-edge';
          return null;
        }
      }
      // 海面・地図外・X方向端では、空中へ進ませず直前の砂地/草地/道路へ戻す。
      // Z方向の外端はこの前にwrapMapAtRoadEnds()が処理するため、縦ループは維持される。
      player.pos.copy(car2LastRoadPos);
      player.vel.multiplyScalar(0.15);
      document.body.dataset.mapBlockedSurfaceStops = String(
        Number(document.body.dataset.mapBlockedSurfaceStops || 0) + 1
      );
      return getMapSurfaceAt(player.pos.x, player.pos.z, player.pos.y);
    }
    // 色による路外制限は行わない。面が無い場所では位置を戻さず、
    // 壁判定と地図端ループだけに任せる。
    return null;
  }

  let mapMotionSweepSteps = 1;
  let mapFallVelocity = 0;
  let mapMissingSurfaceTime = 0;
  function advancePlayerAcrossMap(moveX, moveZ) {
    const maxStep = MAP_CONFIG.roadMotionStep ?? 0;
    const distance = Math.hypot(moveX, moveZ);
    if (!mapRoot || maxStep <= 0 || distance <= maxStep) {
      player.pos.x += moveX;
      player.pos.z += moveZ;
      mapMotionSweepSteps = 1;
      return;
    }

    // 高速時も前フレーム位置から移動先までを小刻みに追う。各点で得た路面高を
    // 次点の基準高にするため、急坂の入口を一気に飛び越えて地中へ入らない。
    const steps = Math.min(16, Math.ceil(distance / maxStep));
    const stepX = moveX / steps;
    const stepZ = moveZ / steps;
    let referenceY = player.pos.y;
    for (let i = 0; i < steps; i++) {
      player.pos.x += stepX;
      player.pos.z += stepZ;
      const surface = getMapSurfaceAt(player.pos.x, player.pos.z, referenceY);
      if (!surface) continue;
      referenceY = surface.point.y
        + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012;
      player.pos.y = referenceY;
    }
    mapMotionSweepSteps = steps;
  }

  // 街灯: 道路の両側・壁の向こう側に、車7台分(約34m)間隔で設置する。
  // ポール+アームとランプヘッドを InstancedMesh にまとめ、前後の周回コピー分も
  // 同じメッシュへ含める。夜間はヘッドのマテリアルを発光へ差し替え、
  // ランプ位置に光球スプライト(ハロ)を表示する。
  const STREET_LIGHT_SPACING = 4.8 * 7;    // 車7台分
  const STREET_LIGHT_WALL_SEARCH = 80;
  const STREET_LIGHT_WALL_CLEARANCE = 1.5;
  const streetWallCaster = new THREE.Raycaster();
  const streetWallOrigin = new THREE.Vector3();
  const streetWallDirection = new THREE.Vector3();
  const streetWallReverseDirection = new THREE.Vector3();
  let streetLampHeads = null;
  let streetLampHeadDayMat = null;
  let streetLampHeadNightMat = null;

  function findStreetLightOutsideWall(x, y, z, directionX, directionZ) {
    if (!wallMeshes.length) return null;
    streetWallDirection.set(directionX, 0, directionZ).normalize();
    streetWallOrigin.set(
      x,
      y + Math.max(0.35, playerClimbHeight + 0.02),
      z
    );
    streetWallCaster.set(streetWallOrigin, streetWallDirection);
    streetWallCaster.far = STREET_LIGHT_WALL_SEARCH;
    let verticalHits = streetWallCaster.intersectObjects(wallMeshes, true)
      .filter((hit) => {
        if (!hit.face) return false;
        wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
        return Math.abs(wallNormal.y) <= 0.08;
      });
    let reverseDetected = false;
    let wallDistances = verticalHits.map((hit) => hit.distance);
    if (!wallDistances.length) {
      // SketchUp由来の片面壁が道路側からレイを受けない場合は、外側から逆向きに
      // 探し、道路中心から見た距離へ戻す。
      streetWallOrigin.set(
        x + streetWallDirection.x * STREET_LIGHT_WALL_SEARCH,
        y + Math.max(0.35, playerClimbHeight + 0.02),
        z + streetWallDirection.z * STREET_LIGHT_WALL_SEARCH
      );
      streetWallReverseDirection.copy(streetWallDirection).negate();
      streetWallCaster.set(streetWallOrigin, streetWallReverseDirection);
      streetWallCaster.far = STREET_LIGHT_WALL_SEARCH;
      verticalHits = streetWallCaster.intersectObjects(wallMeshes, true)
        .filter((hit) => {
          if (!hit.face) return false;
          wallNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
          return Math.abs(wallNormal.y) <= 0.08;
        });
      wallDistances = verticalHits
        .map((hit) => STREET_LIGHT_WALL_SEARCH - hit.distance)
        .filter((distance) => distance >= 0)
        .sort((left, right) => left - right);
      reverseDetected = wallDistances.length > 0;
    }
    if (!wallDistances.length) return null;
    const firstDistance = wallDistances[0];
    let outerDistance = firstDistance;
    // 厚みのある壁では入口面だけでなく出口面も越えてから街灯を置く。
    for (const distance of wallDistances) {
      if (distance > firstDistance + 4) break;
      outerDistance = Math.max(outerDistance, distance);
    }
    return {
      x: x + streetWallDirection.x * (outerDistance + STREET_LIGHT_WALL_CLEARANCE),
      z: z + streetWallDirection.z * (outerDistance + STREET_LIGHT_WALL_CLEARANCE),
      reverseDetected,
    };
  }

  function buildCar2StreetLights(loopSpan) {
    const route = CAR2_CPU_ROUTE;
    // 街灯位置は旧版と同じ「道路本体の外側」を基準にする。
    // 白線・薄灰色面まで含む共通走行判定を使うと、外側探索が遠くなり配置数が変わる。
    const isPrimaryRoadAt = (x, z) => {
      const height = getRoadHeightAt(x, z);
      return height !== null && Math.abs(height - player.pos.y) < 3;
    };
    const spots = [];                      // {x, z, yaw} 両側分
    let wallAnchoredCount = 0;
    let wallReverseAnchoredCount = 0;
    let fallbackCount = 0;
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
        const roadY = getRoadHeightAt(px, pz) ?? player.pos.y;
        for (const side of [-1, 1]) {
          const outsideWall = findStreetLightOutsideWall(
            px, roadY, pz, nx * side, nz * side
          );
          let x = outsideWall?.x ?? 0;
          let z = outsideWall?.z ?? 0;
          let placed = Boolean(outsideWall);
          if (outsideWall) {
            wallAnchoredCount++;
            if (outsideWall.reverseDetected) wallReverseAnchoredCount++;
          } else {
            // M05壁が取れない地点へ推測配置すると道路内に立つ恐れがあるため省略する。
            continue;
          }
          if (!placed) continue;                  // 外へ出られない区間は立てない
          const dx = -nx * side, dz = -nz * side; // アームを道路側へ向ける
          spots.push({ x, z, yaw: Math.atan2(-dz, dx) });
        }
      }
      acc += remaining;
    }
    document.body.dataset.streetLightWallAnchoredCount = String(wallAnchoredCount);
    document.body.dataset.streetLightWallReverseAnchoredCount =
      String(wallReverseAnchoredCount);
    document.body.dataset.streetLightFallbackCount = String(fallbackCount);
    document.body.dataset.streetLightWallClearance = STREET_LIGHT_WALL_CLEARANCE.toFixed(2);
    document.body.dataset.streetLightInsideRoadCount = String(
      spots.filter((spot) => isPrimaryRoadAt(spot.x, spot.z)).length
    );
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
    streetLampHeads = new THREE.InstancedMesh(
      headGeo,
      (nightMode || manualLampMode) ? streetLampHeadNightMat : streetLampHeadDayMat,
      total
    );
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
    halos.visible = nightMode || manualLampMode;
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

  // インディアナポリス: 道路外周の「直線2本＋上下半円」を追跡し、外周壁より
  // さらに外側へだけ街灯を配置する。内周・道路内・建物周辺には置かない。
  function buildIndyOuterWallStreetLights() {
    if (!mapRoadBounds || mapRoadBounds.isEmpty()) return;
    const centerX = (mapRoadBounds.min.x + mapRoadBounds.max.x) * 0.5;
    const centerZ = (mapRoadBounds.min.z + mapRoadBounds.max.z) * 0.5;
    const wallRadius = (mapRoadBounds.max.x - mapRoadBounds.min.x) * 0.5;
    const halfSpanZ = (mapRoadBounds.max.z - mapRoadBounds.min.z) * 0.5;
    const straightHalf = Math.max(0, halfSpanZ - wallRadius);
    const topCenterZ = centerZ + straightHalf;
    const bottomCenterZ = centerZ - straightHalf;
    const dense = [];
    const arcSteps = Math.max(24, Math.ceil(Math.PI * wallRadius / 4));
    const straightSteps = Math.max(2, Math.ceil(straightHalf * 2 / 4));
    for (let i = 0; i <= arcSteps; i++) {
      const angle = i / arcSteps * Math.PI;
      dense.push({
        x: centerX + Math.cos(angle) * wallRadius,
        z: topCenterZ + Math.sin(angle) * wallRadius,
      });
    }
    for (let i = 1; i <= straightSteps; i++) {
      dense.push({
        x: centerX - wallRadius,
        z: topCenterZ + (bottomCenterZ - topCenterZ) * i / straightSteps,
      });
    }
    for (let i = 1; i <= arcSteps; i++) {
      const angle = Math.PI + i / arcSteps * Math.PI;
      dense.push({
        x: centerX + Math.cos(angle) * wallRadius,
        z: bottomCenterZ + Math.sin(angle) * wallRadius,
      });
    }
    for (let i = 1; i <= straightSteps; i++) {
      dense.push({
        x: centerX + wallRadius,
        z: bottomCenterZ + (topCenterZ - bottomCenterZ) * i / straightSteps,
      });
    }

    const spots = [];
    let accumulated = 0;
    for (let i = 0; i < dense.length; i++) {
      const a = dense[i];
      const b = dense[(i + 1) % dense.length];
      const segX = b.x - a.x;
      const segZ = b.z - a.z;
      const length = Math.hypot(segX, segZ);
      if (length < 1e-6) continue;
      const tx = segX / length;
      const tz = segZ / length;
      let base = 0;
      let remaining = length;
      while (accumulated + remaining >= STREET_LIGHT_SPACING) {
        const step = STREET_LIGHT_SPACING - accumulated;
        base += step;
        remaining -= step;
        accumulated = 0;
        const wallX = a.x + tx * base;
        const wallZ = a.z + tz * base;
        let outwardX = -tz;
        let outwardZ = tx;
        if (outwardX * (wallX - centerX) + outwardZ * (wallZ - centerZ) < 0) {
          outwardX = -outwardX;
          outwardZ = -outwardZ;
        }
        const x = wallX + outwardX * STREET_LIGHT_WALL_CLEARANCE;
        const z = wallZ + outwardZ * STREET_LIGHT_WALL_CLEARANCE;
        // アーム(+Xローカル)を外側から道路中心へ向ける。
        const inwardX = -outwardX;
        const inwardZ = -outwardZ;
        spots.push({ x, z, yaw: Math.atan2(-inwardZ, inwardX) });
      }
      accumulated += remaining;
    }
    if (!spots.length) return;

    const POLE_H = 13.8;
    const ELBOW_LEN = 0.7;
    const ELBOW_A = Math.PI / 4;
    const ARM_LEN = 0.9;
    const elbowX = Math.sin(ELBOW_A) * ELBOW_LEN;
    const elbowY = POLE_H + Math.cos(ELBOW_A) * ELBOW_LEN;
    const poleGeo = new THREE.CylinderGeometry(0.07, 0.12, POLE_H, 6)
      .translate(0, POLE_H / 2, 0);
    const elbowGeo = new THREE.CylinderGeometry(0.06, 0.06, ELBOW_LEN, 5);
    elbowGeo.rotateZ(-ELBOW_A);
    elbowGeo.translate(
      elbowX / 2,
      POLE_H + Math.cos(ELBOW_A) * ELBOW_LEN / 2,
      0
    );
    const armGeo = new THREE.CylinderGeometry(0.055, 0.055, ARM_LEN, 5);
    armGeo.rotateZ(Math.PI / 2);
    armGeo.translate(elbowX + ARM_LEN / 2, elbowY, 0);
    const poleMerged = mergeGeometries([poleGeo, elbowGeo, armGeo], false);
    const tipX = elbowX + ARM_LEN;
    const headGeo = new THREE.BoxGeometry(0.85, 0.1, 0.4)
      .translate(tipX - 0.2, elbowY - 0.1, 0);
    streetLampHeadDayMat = new THREE.MeshLambertMaterial({ color: 0xe8ecef });
    streetLampHeadNightMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const poles = new THREE.InstancedMesh(
      poleMerged,
      new THREE.MeshLambertMaterial({ color: 0x3f444a }),
      spots.length
    );
    streetLampHeads = new THREE.InstancedMesh(
      headGeo,
      (nightMode || manualLampMode) ? streetLampHeadNightMat : streetLampHeadDayMat,
      spots.length
    );
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    spots.forEach((spot, index) => {
      rotation.setFromAxisAngle(up, spot.yaw);
      matrix.compose(new THREE.Vector3(spot.x, 0, spot.z), rotation, one);
      poles.setMatrixAt(index, matrix);
      streetLampHeads.setMatrixAt(index, matrix);
    });
    poles.instanceMatrix.needsUpdate = true;
    streetLampHeads.instanceMatrix.needsUpdate = true;
    scene.add(poles);
    scene.add(streetLampHeads);

    const halos = new THREE.Group();
    halos.visible = nightMode || manualLampMode;
    const streetPoolGeo = new THREE.PlaneGeometry(33, 33);
    for (const spot of spots) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: headGlowTex,
        color: 0xffffff,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0.95,
      }));
      halo.position.set(
        spot.x + Math.cos(spot.yaw) * 1.2,
        14.2,
        spot.z - Math.sin(spot.yaw) * 1.2
      );
      halo.scale.setScalar(3);
      halos.add(halo);
      const pool = new THREE.Mesh(
        streetPoolGeo,
        new THREE.MeshBasicMaterial({
          map: headGlowTex,
          color: 0xfff2c8,
          blending: THREE.AdditiveBlending,
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
        })
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(
        spot.x + Math.cos(spot.yaw) * 4,
        0.13,
        spot.z - Math.sin(spot.yaw) * 4
      );
      pool.renderOrder = 2;
      halos.add(pool);
    }
    scene.add(halos);
    nightLampGroups.push(halos);
    document.body.dataset.streetLightCount = String(spots.length);
    document.body.dataset.indyOuterStreetLightCount = String(spots.length);
    document.body.dataset.indyOuterStreetLightClearance =
      STREET_LIGHT_WALL_CLEARANCE.toFixed(2);
    document.body.dataset.indyStreetLightInsideRoadCount = String(
      spots.filter((spot) => getRoadHeightAt(spot.x, spot.z) !== null).length
    );
    document.body.dataset.indyStreetLightBounds = [
      Math.min(...spots.map((spot) => spot.x)).toFixed(3),
      Math.max(...spots.map((spot) => spot.x)).toFixed(3),
      Math.min(...spots.map((spot) => spot.z)).toFixed(3),
      Math.max(...spots.map((spot) => spot.z)).toFixed(3),
    ].join(',');
  }

  // インディアナポリスの外周バンクから、右回り専用の走行中心線を生成する。
  // 外周形状（直線2本＋上下半円）から道路内側へ横断レイを送り、最初に
  // 見つかる道路帯の中央を採用するので、バンク角や道路幅が変わっても追従する。
  function buildIndyBankedRoute() {
    if (!mapRoadBounds || mapRoadBounds.isEmpty() || !roadMeshes.length) return [];
    const centerX = (mapRoadBounds.min.x + mapRoadBounds.max.x) * 0.5;
    const centerZ = (mapRoadBounds.min.z + mapRoadBounds.max.z) * 0.5;
    const outerRadius = (mapRoadBounds.max.x - mapRoadBounds.min.x) * 0.5;
    const halfSpanZ = (mapRoadBounds.max.z - mapRoadBounds.min.z) * 0.5;
    const straightHalf = Math.max(0, halfSpanZ - outerRadius);
    const topCenterZ = centerZ + straightHalf;
    const bottomCenterZ = centerZ - straightHalf;
    const outer = [];
    const routeStep = 6;
    const arcSteps = Math.max(28, Math.ceil(Math.PI * outerRadius / routeStep));
    const straightSteps = Math.max(2, Math.ceil(straightHalf * 2 / routeStep));

    // 上半円右端→左端、左直線を-Z、下半円左端→右端、右直線を+Z。
    // インディの開始方向（左側を-Zへ進む）と同じ右回りになる並び。
    for (let i = 0; i <= arcSteps; i++) {
      const angle = i / arcSteps * Math.PI;
      outer.push({
        x: centerX + Math.cos(angle) * outerRadius,
        z: topCenterZ + Math.sin(angle) * outerRadius,
      });
    }
    for (let i = 1; i <= straightSteps; i++) {
      outer.push({
        x: centerX - outerRadius,
        z: topCenterZ + (bottomCenterZ - topCenterZ) * i / straightSteps,
      });
    }
    for (let i = 1; i <= arcSteps; i++) {
      const angle = Math.PI + i / arcSteps * Math.PI;
      outer.push({
        x: centerX + Math.cos(angle) * outerRadius,
        z: bottomCenterZ + Math.sin(angle) * outerRadius,
      });
    }
    for (let i = 1; i < straightSteps; i++) {
      outer.push({
        x: centerX + outerRadius,
        z: bottomCenterZ + (topCenterZ - bottomCenterZ) * i / straightSteps,
      });
    }

    const route = [];
    const roadWidths = [];
    const scanLimit = Math.min(80, outerRadius * 0.95);
    const scanStep = 1.5;
    for (let i = 0; i < outer.length; i++) {
      const point = outer[i];
      const before = outer[(i - 1 + outer.length) % outer.length];
      const after = outer[(i + 1) % outer.length];
      const length = Math.hypot(after.x - before.x, after.z - before.z) || 1;
      const tx = (after.x - before.x) / length;
      const tz = (after.z - before.z) / length;
      let inwardX = -tz;
      let inwardZ = tx;
      if (inwardX * (centerX - point.x) + inwardZ * (centerZ - point.z) < 0) {
        inwardX = -inwardX;
        inwardZ = -inwardZ;
      }

      let runStart = null;
      let runEnd = null;
      let chosen = null;
      for (let offset = -3; offset <= scanLimit; offset += scanStep) {
        const x = point.x + inwardX * offset;
        const z = point.z + inwardZ * offset;
        const y = getRoadHeightAt(x, z);
        if (y !== null) {
          if (runStart === null) runStart = offset;
          runEnd = offset;
        } else if (runStart !== null) {
          if (runEnd - runStart >= 4.5) {
            chosen = { start: runStart, end: runEnd };
            break;
          }
          runStart = null;
          runEnd = null;
        }
      }
      if (!chosen && runStart !== null && runEnd - runStart >= 4.5) {
        chosen = { start: runStart, end: runEnd };
      }
      // CPUは道路中央ではなく外側寄り34%のバンクラインを基本走行する。
      // start側が外周、end側が内周なので比率を小さくするとバンク上へ寄る。
      const centerOffset = chosen
        ? chosen.start + (chosen.end - chosen.start) * 0.34
        : outerRadius * 0.28;
      const x = point.x + inwardX * centerOffset;
      const z = point.z + inwardZ * centerOffset;
      const y = getRoadHeightAt(x, z);
      if (y === null) continue;
      route.push({ x, y, z });
      if (chosen) roadWidths.push(chosen.end - chosen.start + scanStep);
    }
    if (route.length < 12) return [];

    // 最寄り地点で自車の開始方向と照合し、必ず同方向（右回り）へ揃える。
    let nearest = 0;
    let nearestD2 = Infinity;
    for (let i = 0; i < route.length; i++) {
      const d2 = (route[i].x - player.pos.x) ** 2 + (route[i].z - player.pos.z) ** 2;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = i;
      }
    }
    const routeNext = route[(nearest + 1) % route.length];
    const routePrev = route[(nearest - 1 + route.length) % route.length];
    const tangentX = routeNext.x - routePrev.x;
    const tangentZ = routeNext.z - routePrev.z;
    const headingDot =
      tangentX * Math.sin(player.heading) + tangentZ * Math.cos(player.heading);
    if (headingDot < 0) route.reverse();

    document.body.dataset.indyCpuRoutePoints = String(route.length);
    document.body.dataset.indyCpuDirection = 'right-clockwise';
    document.body.dataset.indyCpuBankLineRatio = '0.34';
    document.body.dataset.indyCpuRouteHeadingAligned = String(headingDot >= 0);
    if (roadWidths.length) {
      document.body.dataset.indyCpuRoadWidthRange = [
        Math.min(...roadWidths).toFixed(1),
        (roadWidths.reduce((sum, width) => sum + width, 0) / roadWidths.length).toFixed(1),
        Math.max(...roadWidths).toFixed(1),
      ].join(',');
    }
    return route;
  }

  // インディのレーン。バンク幅は33〜45m(平均39m)と広く、基準線は外側34%＝
  // ユーザー車が走る「中央より外」の位置。CPUはそこから内側へ寄せてバンク中央を基本にする。
  //   通常＝中央 / 前が詰まる＝外側 / 後ろから速い車＝もっと外側 / 外が混む＝内側
  // インディは出現タイマーを使わず、常に10台がコース上を周回する。
  const INDY_CPU_COUNT = 10;
  const INDY_CPU_CENTER_OFFSET = -6.3;   // 基準線(34%)からバンク中央(50%)まで
  const INDY_LANE_SPACING = 2.2;
  const INDY_CROWD_LOOK_M = 55;              // 隣のラインの混み具合を見る距離
  // レーンを決めたら最低この秒数は保つ（毎フレーム決め直すとフラつく）。
  const CPU_LANE_HOLD_S = 1.5;
  // 車線変更の速さ。大きいほど素早く寄る（3だと横へワープしたように見えた）。
  const CPU_LANE_CHANGE_RATE = 1.2;
  // バンクのコーナーをドリフトで回る確率。1=全車が必ずドリフト（ユーザー指定。
  // ドリフトしないのは直線のみ）。グリップ走行の分岐は将来の調整用に残してある。
  const INDY_DRIFT_CHANCE = 1;
  // コーナー上限速度（ユーザー車と同じ旋回性能の絶対値）。グリップなら200km/h超の
  // まま曲がれるが、ドリフトは150km/h近辺まで減速する。ランク差は最高速(直線)にだけ
  // 現れ、コーナーはどの車も同じ物理に従う。上限より遅い車はコーナーで減速しない。
  const INDY_CORNER_GRIP_KMH = 205;
  // ドリフト時のコーナー速度。152km/hから一律15%削減（ユーザー指定）。
  const INDY_CORNER_DRIFT_KMH = 129;
  // インディのSは最高速を10%・Aは5%落とす（ユーザー指定。直線でも速すぎたため。
  // Aを10%落とすとBより遅くなり順位が逆転するため5%）。
  const INDY_RANK_SPEED_ADJUST = { S: 0.9, A: 0.95 };
  // ユーザー車と同じ加速度カーブ（最高段ギア基準）。CPUの加速はこれを上限とし、
  // ユーザー車を超える加速は絶対にさせない。トルクは速度が伸びるほど細る。
  function playerLikeMaxAccel(speed) {
    const gear = GEARS[GEARS.length - 1];
    const factor = clamp(1 - Math.max(speed / gear.vmax, 0), 0, 1);
    return gear.acc * PLAYER_ACCEL_MULTIPLIER * factor;
  }
  // ドリフトの横滑りが速度を削る強さ（m/s^2 / rad）。横滑り角0.45radで約13.5m/s^2。
  // 205km/h→152km/hをコーナー前半の約1秒で削り切る＝ユーザー車のドリフト減速感。
  const CPU_DRIFT_SCRUB_DECEL = 30;
  // レースらしく見せるため「抜く側が空いているラインへ動く」形にする。
  // 譲る動きは入れない（抜かれる側は自分のラインを守る）。
  function indyLaneShiftFor(blocked, outerBusy, innerBusy) {
    if (!blocked) return 0;                        // 通常はバンク中央
    if (!outerBusy) return INDY_LANE_SPACING;      // 外が空いていれば外から抜く
    if (!innerBusy) return -INDY_LANE_SPACING;     // 外が塞がっていれば内から
    return 2 * INDY_LANE_SPACING;                  // どちらも詰まればさらに外へ
  }
  function buildIndyCpuLane(route, offsetMeters = 4.5) {
    if (route.length < 3) return route;
    return route.map((point, index) => {
      const before = route[(index - 1 + route.length) % route.length];
      const after = route[(index + 1) % route.length];
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const length = Math.hypot(dx, dz) || 1;
      // 右回りルートの進行方向右側＝バンク外側へ分離する。
      const x = point.x + (dz / length) * offsetMeters;
      const z = point.z - (dx / length) * offsetMeters;
      const y = getRoadHeightAt(x, z);
      return {
        x,
        y: y ?? point.y,
        z,
      };
    });
  }

  function findIndyBankCrossSection() {
    if (COURSE_KEY !== 'indy' || !mapRoadBounds || mapRoadBounds.isEmpty()) return null;
    const centerX = (mapRoadBounds.min.x + mapRoadBounds.max.x) * 0.5;
    const centerZ = (mapRoadBounds.min.z + mapRoadBounds.max.z) * 0.5;
    const halfZ = (mapRoadBounds.max.z - mapRoadBounds.min.z) * 0.5;
    const halfX = (mapRoadBounds.max.x - mapRoadBounds.min.x) * 0.5;
    let best = null;
    for (const zOffset of [0, -halfZ * 0.2, halfZ * 0.2]) {
      const z = centerZ + zOffset;
      for (const side of [-1, 1]) {
        const samples = [];
        for (let distance = 0; distance <= halfX; distance += 0.5) {
          const x = centerX + side * distance;
          const y = getRoadHeightAt(x, z);
          if (y === null) {
            if (samples.length >= 10) break;
            samples.length = 0;
            continue;
          }
          samples.push({ x, y, z });
        }
        if (samples.length < 10) continue;
        let lowIndex = 0;
        let highIndex = 0;
        for (let i = 1; i < samples.length; i++) {
          if (samples[i].y < samples[lowIndex].y) lowIndex = i;
          if (samples[i].y > samples[highIndex].y) highIndex = i;
        }
        if (highIndex <= lowIndex + 6) continue;
        const targetIndex = Math.max(
          lowIndex + 4,
          Math.round(lowIndex + (highIndex - lowIndex) * 0.85)
        );
        const start = samples[lowIndex];
        const target = samples[Math.min(targetIndex, samples.length - 1)];
        const rise = target.y - start.y;
        if (rise < 0.5 || Math.abs(target.x - start.x) < 3) continue;
        if (!best || rise > best.rise) best = { start, target, rise };
      }
    }
    return best;
  }

  function nearestRouteIndexTo(wps, x, z) {
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < wps.length; i++) {
      const d2 = (wps[i].x - x) ** 2 + (wps[i].z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  // 走行ライン一周の距離。ループ端の座標ジャンプは
  // routeIndexAheadByDistance と同じ基準で距離に数えない。
  function routeTotalLength(wps) {
    let total = 0;
    for (let i = 0; i + 1 < wps.length; i++) {
      const gap = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].z - wps[i].z);
      if (gap > 0.001 && gap < 80) total += gap;
    }
    return total;
  }

  // 各ウェイポイントまでの累積距離。ユーザー車とCPUの道なり距離を求めるのに使う。
  function buildRouteDistanceTable(wps) {
    const table = new Float64Array(wps.length);
    for (let i = 1; i < wps.length; i++) {
      const gap = Math.hypot(wps[i].x - wps[i - 1].x, wps[i].z - wps[i - 1].z);
      table[i] = table[i - 1] + (gap > 0.001 && gap < 80 ? gap : 0);
    }
    return table;
  }

  // anchor から道なりに distance 進んだ点。負の値は後方（一周ぶん回り込む）。
  function routeIndexAlongFrom(wps, anchorIndex, distance) {
    const total = car2RouteLengthMeters || routeTotalLength(wps);
    const forward = distance >= 0 ? distance : Math.max(0, total + distance);
    return routeIndexAheadByDistance(wps, anchorIndex, forward);
  }

  // ユーザー車から見たCPUの道なり位置。前方が正で、±半周に収める。
  function car2AlongFromPlayer(aiIndex, playerIndex) {
    const total = car2RouteLengthMeters;
    let along = car2RouteDistances[aiIndex] - car2RouteDistances[playerIndex];
    if (along > total / 2) along -= total;
    if (along < -total / 2) along += total;
    return along;
  }

  function routeIndexAheadByDistance(wps, anchorIndex, distance) {
    if (wps.length < 2) return 0;
    let index = clamp(anchorIndex, 0, wps.length - 1);
    let travelled = 0;
    // ループ端の座標ジャンプは距離に数えず、次周の先頭へ継続する。
    for (let step = 0; step < wps.length * 2; step++) {
      const next = (index + 1) % wps.length;
      const gap = Math.hypot(
        wps[next].x - wps[index].x,
        wps[next].z - wps[index].z
      );
      if (gap > 0.001 && gap < 80) travelled += gap;
      index = next;
      if (travelled >= distance) break;
    }
    // car2Loopの終端処理は最終点を通過後に行うため、初期配置点として
    // 最終点そのものは使わず先頭へ戻す。
    return index >= wps.length - 1 ? 0 : index;
  }

  function closedRouteLength(wps) {
    if (wps.length < 2) return 0;
    let total = 0;
    for (let i = 0; i < wps.length; i++) {
      const next = (i + 1) % wps.length;
      const gap = Math.hypot(
        wps[next].x - wps[i].x,
        wps[next].z - wps[i].z
      );
      // ルート生成上の欠損を結ぶ長い座標ジャンプは周回距離へ含めない。
      if (gap > 0.001 && gap < 80) total += gap;
    }
    return total;
  }

  function spawnIndyCpuCars(route, vehicles) {
    if (route.length < 12 || !vehicles.length) return;
    const carVehicles = vehicles.filter((vehicle) => !isKabuVoxUrl(vehicle.url));
    const pool = carVehicles.length ? carVehicles : vehicles;
    // コース全体が見渡せるので、最初から一周へ均等に散らして置く。
    // 車種は cpu_car_list.txt の上から順に10台。
    const count = Math.min(INDY_CPU_COUNT, pool.length);
    const lapDistance = closedRouteLength(route);
    const speeds = [];
    const anchor = nearestRouteIndexTo(route, player.pos.x, player.pos.z);
    for (let index = 0; index < count; index++) {
      const start = routeIndexAheadByDistance(
        route,
        anchor,
        lapDistance * ((index + 1) / (count + 1))
      );
      const next = (start + 1) % route.length;
      const a = route[start];
      const b = route[next];
      const vehicle = pool[index];
      // 速度はランク基準（インディのユーザー車は250km/h）。同ランクは
      // リストの上の行ほど少し速くして、並んだまま抜けなくなるのを防ぐ。
      const listBonus = 1 + (count - 1 - index) * CAR2_CPU_LIST_SPEED_STEP;
      const rankAdjust = INDY_RANK_SPEED_ADJUST[cpuRankFor(vehicle.url)] ?? 1;
      const speedKmh = Math.round(
        cpuTopSpeedKmhFor(vehicle.url) * listBonus * rankAdjust
      );
      speeds.push(speedKmh);
      const group = makeCarGroup(vehicle.mesh.clone(), false, false);
      const base = speedKmh / 3.6;
      aiCars.push({
        group: group.group,
        tilt: group.tilt,
        pos: new THREE.Vector3(a.x, a.y, a.z),
        heading: Math.atan2(b.x - a.x, b.z - a.z),
        v: base,
        base,
        wps: route,
        idx: next,
        radius: carRadiusFor(false, group.group),
        kabu: false,
        cornerSlowdown: 0.25,
        turnRate: 3.2,
        car2Loop: true,
        roadCheckIn: 0,
        speedKmh,
        indyBanked: true,
        // インディはコース全体が見渡せるので、CPUをユーザー車の前方へ
        // 跳ばすと移動が見えてしまう。素直に周回させる。
        maxRouteOffset: 2.2,
        // バンク中央を基本に、空いているラインへ出て抜く。
        indyLane: true,
        // 周回コース。ルート終端で座標を書き換えず、目標だけ先頭へ戻す。
        closedLoop: true,
        // バンク上では道路判定の瞬間的なレイ抜けによる復帰・減速を禁止する。
        skipRoadRecovery: true,
      });
    }
    // インディは出現・退場を使わず、常に全車がコース上を周回する。
    document.body.dataset.indyCpuCount = String(speeds.length);
    document.body.dataset.indyCpuSpeedsKmh = speeds.join(',');
    document.body.dataset.indyCpuRanks = pool.slice(0, count)
      .map((vehicle) => cpuRankFor(vehicle.url)).join(',');
    document.body.dataset.indyCpuLapDistanceMeters = lapDistance.toFixed(1);
    document.body.dataset.indyCpuSpacingMeters = (lapDistance / (count + 1)).toFixed(1);
    document.body.dataset.indyCpuCollisionMode = 'fantasy-road-lock-no-stall';
  }

  // 走行ライン上で今まさに通過中／これから入るカーブのうち、最も急な曲がり角を返す。
  // 30度以下なら0（ドリフトしない）。符号は曲がる向き。
  const CAR2_CPU_DRIFT_TURN = Math.PI / 6;  // 30度
  const CAR2_CPU_DRIFT_LOOKAHEAD = 2;       // 何点先まで見てドリフトを構えるか
  function car2SharpTurnAhead(ai) {
    if (!ai.wps || !ai.wps.length) return 0;
    let sharpest = 0;
    const from = Math.max(0, ai.idx - 1);
    const to = Math.min(ai.wps.length - 1, ai.idx + CAR2_CPU_DRIFT_LOOKAHEAD);
    for (let s = from; s <= to; s++) {
      const turn = ai.wps[s]?.turn;
      if (Number.isFinite(turn) && Math.abs(turn) > Math.abs(sharpest)) sharpest = turn;
    }
    return Math.abs(sharpest) > CAR2_CPU_DRIFT_TURN ? sharpest : 0;
  }

  // 首都高のコーナー上限速度（ユーザー車と同じ旋回性能・絶対値）。
  // 先の数点の曲がり角を合計してカーブの種類を判定する。
  //   U字(合計約137度以上)    : ドリフトで100km/h以下
  //   垂直(合計約69度以上)    : グリップ150km/h・ドリフト130km/h以下
  //   単発の45度など(約29度以上): グリップ170・ドリフト150
  // 上限より遅い車（B・C等）はそのカーブでは減速しない。
  function car2CornerCapKmh(ai) {
    // 近い窓(+4)で垂直/単発を、広い窓(+7)でU字（90度2連の複合区間）を判定する。
    // 実経路ではU字は窓+7でだけ検出できる（idx33-35, 209-223などの合計180度区間）。
    let nearTotal = 0;
    let farTotal = 0;
    const from = Math.max(0, ai.idx - 1);
    const nearTo = Math.min(ai.wps.length - 1, ai.idx + 4);
    const farTo = Math.min(ai.wps.length - 1, ai.idx + 7);
    for (let s = from; s <= farTo; s++) {
      const turn = ai.wps[s]?.turn;
      if (!Number.isFinite(turn)) continue;
      farTotal += Math.abs(turn);
      if (s <= nearTo) nearTotal += Math.abs(turn);
    }
    if (nearTotal < 0.5 && farTotal < 2.4) return null;
    const drifting = car2SharpTurnAhead(ai) !== 0;
    if (farTotal >= 2.4) return drifting ? 100 : 110;
    if (nearTotal >= 1.2) return drifting ? 130 : 150;
    return drifting ? 150 : 170;
  }

  // 首都高速のCPU専用ライン。
  // 直線ではユーザー車の自動運転ライン（＝中心線そのもの）から横へ寄せて追突を防ぎ、
  // カーブでは寄せ量を0に戻して中心線をなぞる。
  // 寄せたままカーブへ入ると、曲がりの内外どちらかで壁側へはみ出すため。
  const CAR2_CPU_LANE_OFFSET = 2.4;     // 直線での横寄せ量
  const CAR2_CPU_STRAIGHT_TURN = 0.06;  // これ以下の曲がり角は直線扱い（約3.4度）
  const CAR2_CPU_CURVE_TURN = 0.20;     // これ以上はカーブ扱い（約11.5度）。間は線形に補間
  const CAR2_CPU_CURVE_MARGIN = 2;      // カーブの何点手前から中心線へ戻し始めるか
  function buildCar2CpuRoute() {
    const centerRoute = CAR2_CPU_ROUTE.map(([x, z]) => ({ x, z }));
    const last = centerRoute.length - 1;
    if (last < 2) return centerRoute;

    // 各点の曲がり角（ラジアン）。ドリフト判定にもそのまま使う。
    const turns = centerRoute.map((point, i) => {
      // 南北の端点は前後の片方が取れない。ループの継ぎ目はどちらも直線なので0にする。
      if (i === 0 || i === last) return 0;
      const before = centerRoute[i - 1];
      const after = centerRoute[i + 1];
      const inAngle = Math.atan2(point.x - before.x, point.z - before.z);
      const outAngle = Math.atan2(after.x - point.x, after.z - point.z);
      let turn = outAngle - inAngle;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;
      return turn;
    });

    // 直線らしさ（1=直線・寄せる / 0=カーブ・中心線）。
    const straightness = turns.map((turn) => {
      const amount = Math.abs(turn);
      if (amount <= CAR2_CPU_STRAIGHT_TURN) return 1;
      if (amount >= CAR2_CPU_CURVE_TURN) return 0;
      return 1 - (amount - CAR2_CPU_STRAIGHT_TURN)
        / (CAR2_CPU_CURVE_TURN - CAR2_CPU_STRAIGHT_TURN);
    });
    // カーブの手前と直後も中心線へ戻す（寄せたまま進入・脱出しない）。
    const gated = straightness.map((_, i) => {
      let value = 1;
      for (let s = Math.max(0, i - CAR2_CPU_CURVE_MARGIN);
        s <= Math.min(last, i + CAR2_CPU_CURVE_MARGIN); s++) {
        value = Math.min(value, straightness[s]);
      }
      return value;
    });
    // 横移動が階段状にならないよう平滑化する。
    const weights = gated.map((_, i) => {
      let sum = 0, count = 0;
      for (let s = Math.max(0, i - CAR2_CPU_CURVE_MARGIN);
        s <= Math.min(last, i + CAR2_CPU_CURVE_MARGIN); s++) {
        sum += gated[s];
        count++;
      }
      return sum / count;
    });

    // CPUの基準は中心線そのもの。直線でどのレーンへ寄るかはランクごとに
    // laneShift で与える（car2LaneShiftFor）。straightness が1なら直線、0ならカーブ。
    return centerRoute.map((point, i) => ({
      x: point.x,
      z: point.z,
      turn: turns[i],
      straightness: weights[i],
    }));
  }

  // ランクごとの直線レーン。中心線を0として、左が負・右が正。道路幅は車5台分なので
  // 1.8m刻みの5本（-3.6 / -1.8 / 0 / +1.8 / +3.6）に割り当てる。
  //   C = 最も左 / B = 中央 / ユーザー車 = 中央 / A = 中央 / S = 最も右
  // 前が詰まったら B は中央の左、A は中央の右へ出て抜く。
  // C・S は中央へ出て抜くが、ユーザー車が近いときは中央を空けて1本内側に留める。
  // カーブでは全員が中心線へ戻る（レーンは直線だけ）。
  function car2LaneShiftFor(ai, blocked, playerNearby) {
    const straightness = ai.wps[ai.idx]?.straightness ?? 0;
    if (straightness < 0.5) return 0;
    const spacing = CAR2_LANE_SPACING;
    const home = { C: -2 * spacing, B: 0, A: 0, S: 2 * spacing }[ai.rank] ?? 0;
    if (!blocked) return home;
    switch (ai.rank) {
      case 'B': return -spacing;
      case 'A': return spacing;
      case 'C': return playerNearby ? -spacing : 0;
      case 'S': return playerNearby ? spacing : 0;
      default: return spacing;
    }
  }

  // 海岸線・森林地帯: 道路面をZ方向へ一定間隔で輪切りにし、
  // 直線・曲線の両方に追従する道路中央ラインを作る。
  function buildSequenceRoadCenterline(sampleStep = 3) {
    if (!mapBounds || mapBounds.isEmpty()) return [];
    if (COURSE_KEY === 'sea') {
      const startZ = mapBounds.max.z - 3;
      const endZ = mapBounds.min.z + 3;
      const spanZ = startZ - endZ;
      if (!(spanZ > sampleStep)) return [];
      const centerX = Number(MAP_CONFIG.cpuCenterLineEntryX);
      if (!Number.isFinite(centerX)) return [];
      const sampleCount = Math.ceil(spanZ / sampleStep) + 1;
      const route = Array.from({ length: sampleCount }, (_, index) => ({
        x: centerX,
        y: 0,
        z: Math.max(endZ, startZ - index * sampleStep),
        width: MAP_CONFIG.cpuLaneOffset * 2 + 0.8,
      }));
      document.body.dataset.seaCpuCenterLineMode = 'fixed-straight-x';
      document.body.dataset.seaCpuCenterLineX = centerX.toFixed(3);
      document.body.dataset.seaCpuCenterLineSamples = String(route.length);
      document.body.dataset.seaCpuInterpolatedSamples = '0';
      return route;
    }
    const useWholeRoadSurface = COURSE_KEY === 'forest';
    const routeMeshes = useWholeRoadSurface
      ? roadMeshes
      : mapSurfaceMeshes.filter((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return materials.some((material) => Boolean(material?.userData?.sequenceCenterLine));
      });
    if (!routeMeshes.length) return [];
    const startZ = mapBounds.max.z - 3;
    const endZ = mapBounds.min.z + 3;
    const spanZ = startZ - endZ;
    if (!(spanZ > sampleStep)) return [];
    const sampleCount = Math.ceil(spanZ / sampleStep) + 1;
    const samples = Array.from({ length: sampleCount }, (_, index) => ({
      z: Math.max(endZ, startZ - index * sampleStep),
      hits: [],
    }));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const intersections = [];
    const addEdgeIntersection = (left, right, targetZ) => {
      const dz = right.z - left.z;
      if (Math.abs(dz) < 1e-8) {
        if (Math.abs(targetZ - left.z) < 1e-5) {
          intersections.push({ x: left.x, y: left.y }, { x: right.x, y: right.y });
        }
        return;
      }
      const t = (targetZ - left.z) / dz;
      if (t < -1e-5 || t > 1.00001) return;
      intersections.push({
        x: left.x + (right.x - left.x) * t,
        y: left.y + (right.y - left.y) * t,
      });
    };

    for (const mesh of routeMeshes) {
      mesh.updateWorldMatrix(true, false);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const isCenterLineMesh = useWholeRoadSurface || materials.some((material) =>
        Boolean(material?.userData?.sequenceCenterLine));
      const geometry = mesh.geometry;
      const position = geometry?.attributes?.position;
      if (!position) continue;
      const index = geometry.index;
      const elementCount = index ? index.count : position.count;
      const vertexIndex = (offset) => index ? index.getX(offset) : offset;
      for (let offset = 0; offset + 2 < elementCount; offset += 3) {
        a.fromBufferAttribute(position, vertexIndex(offset)).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(position, vertexIndex(offset + 1)).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(position, vertexIndex(offset + 2)).applyMatrix4(mesh.matrixWorld);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        if (Math.abs(ab.cross(ac).normalize().y) < 0.55) continue;
        // 最白色は白線専用なので高さ上限を設けない。
        // 坂・バンク上の白線もそのままCPU基準線として追跡する。
        const surfaceY = (a.y + b.y + c.y) / 3;
        if (surfaceY < -0.1) continue;
        const triangleMinZ = Math.min(a.z, b.z, c.z);
        const triangleMaxZ = Math.max(a.z, b.z, c.z);
        let first = Math.ceil((startZ - triangleMaxZ) / sampleStep - 1e-6);
        let last = Math.floor((startZ - triangleMinZ) / sampleStep + 1e-6);
        first = clamp(first, 0, sampleCount - 1);
        last = clamp(last, 0, sampleCount - 1);
        for (let sampleIndex = first; sampleIndex <= last; sampleIndex++) {
          const sample = samples[sampleIndex];
          intersections.length = 0;
          addEdgeIntersection(a, b, sample.z);
          addEdgeIntersection(b, c, sample.z);
          addEdgeIntersection(c, a, sample.z);
          if (intersections.length < 2) continue;
          sample.hits.push({
            minX: Math.min(...intersections.map((point) => point.x)),
            maxX: Math.max(...intersections.map((point) => point.x)),
            minY: Math.min(...intersections.map((point) => point.y)),
            maxY: Math.max(...intersections.map((point) => point.y)),
            centerLine: isCenterLineMesh,
          });
        }
      }
    }

    const configuredCenterX = Number(MAP_CONFIG.cpuCenterLineEntryX);
    const desiredEntryCenterX = useWholeRoadSurface
      ? player.pos.x
      : Number.isFinite(configuredCenterX)
      ? configuredCenterX
      : mapRoadBounds && !mapRoadBounds.isEmpty()
        ? (mapRoadBounds.min.x + mapRoadBounds.max.x) * 0.5
        : MAP_CONFIG.spawnReferenceX;
    let previousCenterX = desiredEntryCenterX;
    let centerLineSampleCount = 0;
    const selected = samples.map((sample) => {
      const mergeIntervals = (hits, joinGap) => {
        const merged = [];
        for (const hit of [...hits].sort((left, right) => left.minX - right.minX)) {
          const current = merged[merged.length - 1];
          if (current && hit.minX <= current.maxX + joinGap) {
            current.maxX = Math.max(current.maxX, hit.maxX);
            current.minY = Math.min(current.minY, hit.minY);
            current.maxY = Math.max(current.maxY, hit.maxY);
          } else {
            merged.push({ ...hit });
          }
        }
        return merged;
      };
      const centerLineCandidates = mergeIntervals(
        sample.hits.filter((hit) => hit.centerLine),
        0.08
      ).filter((interval) => {
        const width = interval.maxX - interval.minX;
        return width > 0.03;
      });
      if (centerLineCandidates.length) {
        centerLineCandidates.sort((left, right) => {
          const leftCenter = (left.minX + left.maxX) / 2;
          const rightCenter = (right.minX + right.maxX) / 2;
          return Math.abs(leftCenter - previousCenterX) - Math.abs(rightCenter - previousCenterX);
        });
        const centerLine = centerLineCandidates[0];
        centerLineSampleCount++;
        previousCenterX = (centerLine.minX + centerLine.maxX) / 2;
        return {
          x: previousCenterX,
          y: Math.max(-0.02, centerLine.minY),
          z: sample.z,
          width: useWholeRoadSurface
            ? Math.max(0.5, centerLine.maxX - centerLine.minX)
            : 4.5,
        };
      }
      return null;
    });
    document.body.dataset.seaCpuCenterLineSamples = String(centerLineSampleCount);
    document.body.dataset.seaCpuInterpolatedSamples =
      String(sampleCount - centerLineSampleCount);
    // 三角面の端とサンプル線が数値上重ならない点だけ、前後の道路中心を補間する。
    for (let index = 0; index < selected.length; index++) {
      if (selected[index]) continue;
      let before = index - 1;
      let after = index + 1;
      while (before >= 0 && !selected[before]) before--;
      while (after < selected.length && !selected[after]) after++;
      if (before < 0 && after >= selected.length) continue;
      if (before < 0) selected[index] = { ...selected[after], z: samples[index].z };
      else if (after >= selected.length) selected[index] = { ...selected[before], z: samples[index].z };
      else {
        const t = (index - before) / (after - before);
        selected[index] = {
          x: THREE.MathUtils.lerp(selected[before].x, selected[after].x, t),
          y: THREE.MathUtils.lerp(selected[before].y, selected[after].y, t),
          z: samples[index].z,
          width: THREE.MathUtils.lerp(selected[before].width, selected[after].width, t),
        };
      }
    }
    const rawRoute = selected.filter(Boolean);
    if (!rawRoute.length) return [];
    const entryCenterBiasX = desiredEntryCenterX - rawRoute[0].x;
    const exitCenterBiasX = desiredEntryCenterX - rawRoute[rawRoute.length - 1].x;
    // SketchUpの細かな三角分割による左右ブレだけを平均化し、カーブ形状は残す。
    return rawRoute.map((point, index) => {
      const from = Math.max(0, index - 2);
      const to = Math.min(rawRoute.length - 1, index + 2);
      let x = 0;
      let width = 0;
      for (let i = from; i <= to; i++) {
        x += rawRoute[i].x;
        width += rawRoute[i].width;
      }
      const count = to - from + 1;
      // 指定開始車線への位置合わせは入口・出口の40mだけで滑らかに適用する。
      // コース途中へ固定X補正を持ち込まず、曲線では抽出した道路中心を保つ。
      const entryBlend = 1 - clamp((point.z - rawRoute[0].z) / -40, 0, 1);
      const exitBlend = 1 - clamp((rawRoute[rawRoute.length - 1].z - point.z) / -40, 0, 1);
      return {
        ...point,
        x: x / count + entryCenterBiasX * entryBlend + exitCenterBiasX * exitBlend,
        width: width / count,
      };
    });
  }

  function offsetSequenceLane(centerRoute) {
    return centerRoute.map((point, index) => {
      const before = centerRoute[Math.max(0, index - 1)];
      const after = centerRoute[Math.min(centerRoute.length - 1, index + 1)];
      const dx = after.x - before.x;
      const dz = after.z - before.z;
      const length = Math.hypot(dx, dz) || 1;
      const laneOffset = MAP_CONFIG.cpuLaneOffset
        ?? clamp(point.width * 0.25, 1.2, 2.1);
      return {
        x: point.x + (dz / length) * laneOffset,
        y: point.y,
        z: point.z - (dx / length) * laneOffset,
      };
    });
  }

  // 海岸線の交通量と内訳。対向7:同方向3、対向車だけランク速度から50%落とす。
  const SEA_TRAFFIC_TOTAL = 20;
  const SEA_ONCOMING_RATIO = 0.7;
  const SEA_ONCOMING_SPEED_SCALE = 0.5;
  function spawnSequenceTrafficCpuCars(centerRoute, vehicles) {
    if (centerRoute.length < 2 || !vehicles.length) return;
    const carVehicles = vehicles.filter((vehicle) => !isKabuVoxUrl(vehicle.url));
    const pool = carVehicles.length ? carVehicles : vehicles;
    const sameDirectionRoute = offsetSequenceLane(centerRoute);
    const oncomingRoute = offsetSequenceLane([...centerRoute].reverse());
    // 海岸線は 対向7 : 同方向3 の割合。総交通量20台は従来どおり維持する。
    const total = SEA_TRAFFIC_TOTAL;
    const oncomingTarget = Math.round(total * SEA_ONCOMING_RATIO);
    const sameDirectionTarget = total - oncomingTarget;
    let sameDirectionCount = 0;
    let oncomingCount = 0;
    for (let i = 0; i < total; i++) {
      const oncoming = i < oncomingTarget;
      const wps = oncoming ? oncomingRoute : sameDirectionRoute;
      const laneRange = oncoming
        ? MAP_CONFIG.cpuOncomingLaneRangeX
        : MAP_CONFIG.cpuSameDirectionLaneRangeX;
      // 対向・同方向それぞれで道なりに等間隔へ散らす。
      const laneIndex = oncoming ? i : i - oncomingTarget;
      const carsInLane = oncoming ? oncomingTarget : sameDirectionTarget;
      const start = Math.min(
        wps.length - 2,
        Math.max(0, Math.floor((laneIndex + 1) * (wps.length - 1) / (carsInLane + 1)))
      );
      const next = start + 1;
      const a = wps[start];
      const b = wps[next];
      const vehicle = pool[i % pool.length];
      // 速度は cpu_car_list.txt のランク(S/A/B/C)基準。対向車だけそこから50%落とす。
      const rankSpeedKmh = cpuTopSpeedKmhFor(vehicle.url);
      const speedKmh = oncoming
        ? Math.round(rankSpeedKmh * SEA_ONCOMING_SPEED_SCALE)
        : rankSpeedKmh;
      const base = speedKmh / 3.6;
      const bike = isKabuVoxUrl(vehicle.url);
      const group = makeCarGroup(vehicle.mesh.clone(), false, bike, 'seaCpuBoost');
      aiCars.push({
        group: group.group,
        tilt: group.tilt,
        pos: new THREE.Vector3(a.x, a.y, a.z),
        heading: Math.atan2(b.x - a.x, b.z - a.z),
        v: base,
        base,
        wps,
        idx: next,
        radius: carRadiusFor(bike, group.group),
        kabu: bike,
        cornerSlowdown: 0.45,
        turnRate: 2.8,
        car2Loop: true,
        roadCheckIn: Math.random() * 0.25,
        speedKmh,
        sequenceTraffic: oncoming ? 'oncoming' : 'same',
        fixedRouteX: a.x,
        laneMinX: laneRange?.[0] ?? a.x,
        laneMaxX: laneRange?.[1] ?? a.x,
        maxRouteOffset: 0.05,
        // 白線基準の密な経路へ常時拘束するため、三角面継ぎ目で誤作動する
        // 低頻度レイ復帰は海岸線CPUには使わない。
        skipRoadRecovery: true,
      });
      if (oncoming) oncomingCount++;
      else sameDirectionCount++;
    }
    document.body.dataset.seaCpuRoutePoints = String(centerRoute.length);
    document.body.dataset.seaCpuSameDirection = String(sameDirectionCount);
    document.body.dataset.seaCpuOncoming = String(oncomingCount);
    document.body.dataset.seaCpuSameDirectionSpeedsKmh =
      [...new Set(aiCars
        .filter((ai) => ai.sequenceTraffic === 'same')
        .map((ai) => ai.speedKmh))].join(',');
    document.body.dataset.seaCpuOncomingSpeedsKmh =
      [...new Set(aiCars
        .filter((ai) => ai.sequenceTraffic === 'oncoming')
        .map((ai) => ai.speedKmh))].join(',');
    document.body.dataset.seaCpuSameDirectionLaneRangeX =
      (MAP_CONFIG.cpuSameDirectionLaneRangeX ?? []).join(',');
    document.body.dataset.seaCpuOncomingLaneRangeX =
      (MAP_CONFIG.cpuOncomingLaneRangeX ?? []).join(',');
    document.body.dataset.seaCpuHeadlightVisibilityMultiplier = '3';
    document.body.dataset.seaCpuHeadlightGlowMultiplier = '2.5';
    document.body.dataset.seaCpuBoostedHeadlightCars = String(total);
    document.body.dataset.seaCpuBoostedHeadlightSprites = String(total * 4);
    document.body.dataset.seaRoadEntryY = centerRoute[0].y.toFixed(3);
    document.body.dataset.seaRoadExitY = centerRoute[centerRoute.length - 1].y.toFixed(3);
    const largestGap = centerRoute.slice(1).reduce((largest, point, index) => {
      const previous = centerRoute[index];
      const distance = Math.hypot(point.x - previous.x, point.z - previous.z);
      return distance > largest.distance
        ? { distance, previous, point, index: index + 1 }
        : largest;
    }, { distance: 0, previous: centerRoute[0], point: centerRoute[0], index: 0 });
    document.body.dataset.seaCpuRouteMaxGap = largestGap.distance.toFixed(3);
    document.body.dataset.seaCpuRouteMaxGapDetail = [
      largestGap.index,
      largestGap.previous.x.toFixed(3),
      largestGap.previous.z.toFixed(3),
      largestGap.point.x.toFixed(3),
      largestGap.point.z.toFixed(3),
    ].join(',');
    document.body.dataset.seaCpuRouteLargeGaps = centerRoute.slice(1)
      .map((point, index) => {
        const previous = centerRoute[index];
        return {
          distance: Math.hypot(point.x - previous.x, point.z - previous.z),
          previous,
          point,
        };
      })
      .filter((gap) => gap.distance > 10)
      .map((gap) => [
        gap.distance.toFixed(3),
        gap.previous.x.toFixed(3),
        gap.previous.z.toFixed(3),
        gap.point.x.toFixed(3),
        gap.point.z.toFixed(3),
      ].join(','))
      .join('|');
  }

  // 首都高速の交通量。車種は cpu_car_list.txt から順に巡回して割り当てるので、
  // リストの行数とは独立に台数を決められる。
  // 交通量は「時間」で決める。速度差と密度から間接的に作ると頻度が読めず、
  // 同速の車が並んで数珠つなぎにもなるため、出現そのものをタイマーで管理する。
  // 最大15台をつくり置きし、平均10秒(5〜25秒)ごとに1台ずつ順不同で走らせる。
  const CAR2_CPU_POOL_MAX = 15;
  const CAR2_CPU_APPEAR_MIN_S = 5;
  const CAR2_CPU_APPEAR_MAX_S = 25;
  const CAR2_CPU_APPEAR_MEAN_S = 10;
  // 出現位置（ユーザー車からの道なり距離）。前方はフォグ(near500)で霞む距離に置き、
  // いきなり現れたように見えないようにする。後方は速い車が抜きに来る距離。
  const CAR2_CPU_APPEAR_AHEAD_M = [520, 820];
  const CAR2_CPU_APPEAR_BEHIND_M = [160, 320];
  // ここまで離れたら引き上げて、次の出番を待たせる。
  const CAR2_CPU_RETIRE_AHEAD_M = 1150;
  const CAR2_CPU_RETIRE_BEHIND_M = 700;
  // スタート時に置いておく3台の位置。1台目にすぐ追いつける距離から並べる。
  const CAR2_CPU_HEAD_START_M = [90, 220, 380];
  // デモの首都高だけは、後ろに速い1台を足して追い抜かれるところを見せる。
  // 前の車は通常プレイと同じ CAR2_CPU_HEAD_START_M の配置のまま。
  const CAR2_CPU_DEMO_START = [
    { rank: 'S', along: -120 },           // 後方: 速い車が追い抜いていく
  ];
  // 同ランクでもリストの上の行ほど速くする量（1行あたり）。
  const CAR2_CPU_LIST_SPEED_STEP = 0.005;
  const CAR2_CPU_TRAFFIC_MAX = CAR2_CPU_POOL_MAX;
  const CAR2_CPU_TRAFFIC_OVERRIDE = Math.max(0, Math.min(
    CAR2_CPU_TRAFFIC_MAX, Math.round(Number(pageQuery.get('cpuCars'))) || 0
  ));
  // すれ違い判定の距離。ここへ入ってから離れるまでを1回と数える。
  const CAR2_CPU_ENCOUNTER_M = 45;
  // 追い越し車線。前方に自分より遅いCPUがいると、基準ラインから横へ寄って抜く。
  // これがないとCPU同士が同じ線上で重なり、団子になって溜まっていく。
  const CAR2_CPU_OVERTAKE_LOOK_M = 38;   // 何m前まで見て詰まりと判断するか
  const CAR2_CPU_OVERTAKE_LATERAL_M = 2.4; // 同じ車線とみなす横のずれ
  // CPU同士はすり抜ける（衝突判定も減速もしない）。抜けない場面で速度を合わせると
  // 抜けない車が後ろへ連なって数珠つなぎになるため、詰まってもそのまま通す＝ユーザー指定。
  // 首都高の直線レーン間隔。道路幅は車5台分＝約9mなので、中心線から±3.6mまで使う。
  const CAR2_LANE_SPACING = Number(pageQuery.get('laneSpacing')) || 1.8;
  // ユーザー車がこの距離にいる間は、CPUは中央レーンを空ける。
  const CAR2_PLAYER_LANE_CLEAR_M = 70;
  // 中心線から左右へ何mまで路面が続くかを測る。直線のレーンを置ける幅の確認用。
  // 路面メッシュが揃ってから呼ぶこと（生成時点ではまだ何も拾えない）。
  function measureCar2RoadHalfWidths() {
    const route = CAR2_CPU_ROUTE;
    let left = Infinity, right = Infinity;
    const step = Math.max(1, Math.floor(route.length / 60));
    for (let i = 0; i + 1 < route.length; i += step) {
      const [ax, az] = route[i], [bx, bz] = route[i + 1];
      const ex = bx - ax, ez = bz - az;
      const length = Math.hypot(ex, ez) || 1;
      const nx = ez / length, nz = -ex / length;   // 進行方向の右手法線
      for (const side of [1, -1]) {
        let reach = 0;
        for (let d = 0.5; d <= 10; d += 0.5) {
          // car2DrivableMeshes へのレイは首都高では当たらない（中心線上でも null）。
          // 街灯配置と同じく roadMeshes 側で路面の有無を見る。
          if (getRoadHeightAt(ax + nx * side * d, az + nz * side * d) === null) break;
          reach = d;
        }
        if (side > 0) right = Math.min(right, reach);
        else left = Math.min(left, reach);
      }
    }
    return { left, right };
  }

  // CPU車は最初に全台つくっておき、走らせるのは出番が来たものだけにする。
  // 出番はタイマーで管理し、ユーザー車の視界へ順に現れさせる（下の updateCar2CpuTraffic）。
  function spawnCar2LoopCpuCars(wps, vehicles) {
    if (wps.length < 2 || !vehicles.length) return;
    car2RouteLengthMeters = routeTotalLength(wps);
    car2CpuRoute = wps;
    car2RouteDistances = buildRouteDistanceTable(wps);
    const poolSize = Math.min(
      CAR2_CPU_POOL_MAX, CAR2_CPU_TRAFFIC_OVERRIDE || CAR2_CPU_POOL_MAX
    );
    for (let i = 0; i < poolSize; i++) {
      const listIndex = i % vehicles.length;
      const vehicle = vehicles[listIndex];
      // ランクはあくまで目安。同じランクでもリストの上の行ほど少し速くする。
      // 完全に同速だと追い越し条件を満たせず、並んだまま数珠つなぎになるため。
      const listBonus = 1 + (vehicles.length - 1 - listIndex) * CAR2_CPU_LIST_SPEED_STEP;
      const speedKmh = Math.round(cpuTopSpeedKmhFor(vehicle.url) * listBonus);
      const base = speedKmh / 3.6;
      const bike = isKabuVoxUrl(vehicle.url);
      const g = makeCarGroup(vehicle.mesh.clone(), false, bike);
      g.group.visible = false;
      const ai = {
        group: g.group, tilt: g.tilt,
        pos: new THREE.Vector3(wps[0].x, wps[0].y ?? 0, wps[0].z),
        heading: 0,
        v: base, base,
        wps, idx: 1, radius: carRadiusFor(bike, g.group), kabu: bike,
        cornerSlowdown: 0.55,
        turnRate: 3.4,
        car2Loop: true,
        roadCheckIn: Math.random() * 0.25,
        speedKmh,
        rank: cpuRankFor(vehicle.url),
        // 30度より大きい曲がり角はドリフトで回る。
        driftOnSharpCurve: true,
        // ドリフトで膨らむ分の余裕。カーブでは専用ラインが中心線へ戻るため、
        // 中心線からの最大距離は従来（右2.4m＋膨らみ2.5m）より小さくなる。
        maxRouteOffset: 2.8,
        // 専用ラインは常に道路内を通るので、レイ復帰は使わない。
        // 三角面の継ぎ目でレイが抜けると復帰と逸脱を毎フレーム繰り返し、
        // カーブ手前で震えて止まったように見えるため（海岸線・インディと同じ扱い）。
        skipRoadRecovery: true,
        // 直線ではランクごとのレーンを走り、前が詰まったら隣へ出て抜く。
        rankLane: true,
        // レーンに乗っている間は膨らみ代を絞る（端のレーンで道路外へ出さない）。
        overtakeMaxRouteOffset: 0.9,
        // 出番待ち。走るのは出現してから。
        appearManaged: true,
        active: false,
      };
      aiCars.push(ai);
      car2CpuPool.push(ai);
    }
    // 走り出してすぐ1台目に出会えるよう、近いところから順に3台置いておく。
    // スタート時点で置く車なので、近くても湧いたようには見えない。
    // 追いつけない車を前に置いても離れていくだけなので、遅めのB・Cから選ぶ。
    // ただしCばかりに偏らせず、B・Cの中からランダムに取る。
    // BとCを交互に取る。まとめてシャッフルするとCばかりの回ができるため。
    const bCars = shuffleArray(car2CpuPool.filter((ai) => ai.rank === 'B'));
    const cCars = shuffleArray(car2CpuPool.filter((ai) => ai.rank === 'C'));
    const fallback = [...car2CpuPool].sort((left, right) => left.base - right.base);
    const headStartPool = [];
    while (headStartPool.length < CAR2_CPU_HEAD_START_M.length) {
      const next = (headStartPool.length % 2 === 0 ? bCars : cCars).shift()
        ?? bCars.shift() ?? cCars.shift() ?? fallback.shift();
      if (!next) break;
      if (!headStartPool.includes(next)) headStartPool.push(next);
    }
    CAR2_CPU_HEAD_START_M.forEach((distance, i) => {
      if (headStartPool[i]) activateCar2Cpu(headStartPool[i], distance + Math.random() * 40);
    });
    if (DEMO_SEQUENCE_ACTIVE) {
      // デモだけの追加分。前の車はそのままに、指定のランクを決まった位置へ足す。
      const byRank = {
        B: bCars,
        C: cCars,
        S: shuffleArray(car2CpuPool.filter((ai) => ai.rank === 'S')),
      };
      const takeUnused = (list) => {
        while (list.length) {
          const next = list.shift();
          if (!next.active) return next;
        }
        return null;
      };
      for (const { rank, along, kmh } of CAR2_CPU_DEMO_START) {
        const ai = takeUnused(byRank[rank] ?? []) ?? takeUnused(fallback);
        if (!ai) continue;
        if (kmh) {
          ai.speedKmh = kmh;
          ai.base = kmh / 3.6;
        }
        activateCar2Cpu(ai, along);   // v は base から入るので速度指定はこの前に
      }
    }
    car2CpuAppearIn = nextCar2CpuAppearInterval();
    document.body.dataset.tokyoCpuPoolSize = String(car2CpuPool.length);
    document.body.dataset.tokyoCpuSpeedsKmh =
      car2CpuPool.map((ai) => ai.speedKmh).join(',');
    document.body.dataset.tokyoCpuRanks =
      car2CpuPool.map((ai) => ai.rank).join(',');
  }

  // ユーザー車の平均速度で出現間隔を案分する。距離あたりの遭遇数をそろえる考え方で、
  // 速く走るほど次々に車へ追いつき、ゆっくりなら出会う回数も減る。
  // 150km/hで平均10秒（＝約420mに1台）を基準に、150・130・110km/hの3段階で案分する。
  function car2AppearSpeedScale() {
    if (car2PlayerAvgSpeedKmh >= 140) return 1;           // 150km/h帯: 平均10.0秒
    if (car2PlayerAvgSpeedKmh >= 120) return 150 / 130;   // 130km/h帯: 平均11.5秒
    return 150 / 110;                                     // 110km/h帯: 平均13.6秒
  }

  // 次に車が現れるまでの秒数。5〜25秒・平均10秒になるよう指数分布から引く。
  function nextCar2CpuAppearInterval() {
    const spread = -Math.log(1 - Math.random())
      * (CAR2_CPU_APPEAR_MEAN_S - CAR2_CPU_APPEAR_MIN_S);
    const seconds = (CAR2_CPU_APPEAR_MIN_S + spread) * car2AppearSpeedScale();
    return clamp(seconds, CAR2_CPU_APPEAR_MIN_S, CAR2_CPU_APPEAR_MAX_S);
  }

  // 1台を走行ライン上へ出す。距離を渡さない場合は速度差から前後を決める。
  // ユーザー車より遅い車は前方（追いつかせる）、速い車は後方（抜かせる）へ置く。
  function activateCar2Cpu(ai, alongMeters = null) {
    if (!car2CpuRoute) return;
    const playerSpeed = Math.hypot(player.vel.x, player.vel.z);
    const along = alongMeters ?? (ai.base <= Math.max(playerSpeed, 22)
      ? CAR2_CPU_APPEAR_AHEAD_M[0]
        + Math.random() * (CAR2_CPU_APPEAR_AHEAD_M[1] - CAR2_CPU_APPEAR_AHEAD_M[0])
      : -(CAR2_CPU_APPEAR_BEHIND_M[0]
        + Math.random() * (CAR2_CPU_APPEAR_BEHIND_M[1] - CAR2_CPU_APPEAR_BEHIND_M[0])));
    const anchor = nearestRouteIndexTo(car2CpuRoute, player.pos.x, player.pos.z);
    const index = routeIndexAlongFrom(car2CpuRoute, anchor, along);
    const nextIndex = Math.min(car2CpuRoute.length - 1, index + 1);
    const at = car2CpuRoute[index], after = car2CpuRoute[nextIndex];
    ai.pos.set(
      at.x,
      Number.isFinite(at.y) ? at.y : groundHeightAt(at.x, 6, at.z),
      at.z
    );
    ai.heading = Math.atan2(after.x - at.x, after.z - at.z);
    ai.dir = ai.heading;
    ai.idx = nextIndex;
    ai.v = ai.base;
    ai.laneShift = 0;
    ai.playerNear = false;
    ai.travelFromX = undefined;
    ai.travelFromZ = undefined;
    ai.stepPrevX = undefined;   // 出現の瞬間移動はワープ検出に数えない
    ai.active = true;
    ai.group.visible = true;
    car2CpuAppearTotal++;
  }

  function retireCar2Cpu(ai) {
    ai.active = false;
    ai.group.visible = false;
  }

  // 出現タイマーと、離れすぎた車の引き上げ。
  function updateCar2CpuTraffic(dt) {
    if (!car2CpuPool.length || !car2RouteDistances) return;
    if (!car2RoadWidthMeasured && car2DrivableMeshes.length) {
      car2RoadWidthMeasured = true;
      const widths = measureCar2RoadHalfWidths();
      document.body.dataset.tokyoRoadHalfWidthLeft = widths.left.toFixed(1);
      document.body.dataset.tokyoRoadHalfWidthRight = widths.right.toFixed(1);
      const [px, pz] = CAR2_CPU_ROUTE[60];
      document.body.dataset.tokyoWidthProbe = [
        `meshes=${car2DrivableMeshes.length}`,
        `rayTop=${mapRayTop}`, `rayBottom=${mapRayBottom}`,
        `center=${getTopDrivableHeightAt(px, pz)}`,
        `x+2=${getTopDrivableHeightAt(px + 2, pz)}`,
        `x-2=${getTopDrivableHeightAt(px - 2, pz)}`,
        `z+2=${getTopDrivableHeightAt(px, pz + 2)}`,
        `playerY=${player.pos.y.toFixed(2)}`,
      ].join(' ');
    }
    // 出現間隔の案分に使う平均速度。時定数10秒でならす。
    const speedKmh = Math.hypot(player.vel.x, player.vel.z) * 3.6;
    car2PlayerAvgSpeedKmh += (speedKmh - car2PlayerAvgSpeedKmh) * Math.min(1, dt * 0.1);
    const anchor = nearestRouteIndexTo(car2CpuRoute, player.pos.x, player.pos.z);
    for (const ai of car2CpuPool) {
      if (!ai.active) continue;
      const along = car2AlongFromPlayer(ai.idx, anchor);
      if (along > CAR2_CPU_RETIRE_AHEAD_M || along < -CAR2_CPU_RETIRE_BEHIND_M) {
        retireCar2Cpu(ai);
      }
    }
    car2CpuAppearIn -= dt;
    if (car2CpuAppearIn > 0) return;
    car2CpuAppearIn = nextCar2CpuAppearInterval();
    // 出す車は毎回ランダムに選ぶ（同じ順番で並ばせない）。
    const waiting = car2CpuPool.filter((ai) => !ai.active);
    if (!waiting.length) return;
    activateCar2Cpu(waiting[Math.floor(Math.random() * waiting.length)]);
  }

  // --------------------------------------------------------------- init ---
  // Soft contact shadow that sits directly under a car at all times —
  // the directional shadow alone lands beside the body when the sun is low.
  // 車体の実サイズにほぼ合わせた接地影。幅=横, 奥行き=縦(進行方向)。
  const CAR_SHADOW = { w: 2.1, h: 4.6 };
  // kabu(スーパーカブ)はバイク。影はタイヤ一個分くらいの小さく細いものに。
  const BIKE_SHADOW = { w: 0.75, h: 2.0 };
  // 普通車の vox は縦80ボクセル。track.vox のように縦100の車もあるので、
  // 影と当たり判定の長さは決め打ちにせず、この80との比で伸ばす。
  // 比べるのは編集グリッドの大きさ。車体は枠いっぱいには詰まっていないため、
  // 実際に置かれたボクセルで測ると車種ごとに数十cmずれてしまう。
  const CAR_VOX_LENGTH = 80;
  const CAR_VOX_WIDTH = 36;
  // 当たり判定の長方形の半分の長さ・幅
  //（普通車2.1×0.95 = 実車4.8×2.16mよりやや小さい4.2×1.9m）。
  const CAR_COLLIDE_HALF_LENGTH = 2.1;
  const CAR_COLLIDE_HALF_WIDTH = 0.95;
  const BIKE_COLLIDE_HALF_LENGTH = 0.9;
  const BIKE_COLLIDE_HALF_WIDTH = 0.32;
  // vox の縦(=前後)・横のボクセル数を普通車と比べた倍率。分からない車は1倍。
  const voxRatio = (mesh, axis, standard) => {
    const size = mesh?.userData?.voxSize?.[axis];
    return size > 0 ? size / standard : 1;
  };
  const bodyLengthRatio = (mesh) => voxRatio(mesh, 'y', CAR_VOX_LENGTH);
  const bodyWidthRatio = (mesh) => voxRatio(mesh, 'x', CAR_VOX_WIDTH);
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

  function makeCarGroup(mesh, castShadow, bike, lightProfile = 'default') {
    const tilt = new THREE.Group();
    mesh.rotation.y = MODEL_YAW;
    mesh.position.y = -CAR_SINK;
    // 多数の CPU 車はシャドウマップ描画を省いて軽量化(接地影は残る)
    if (castShadow === false) mesh.castShadow = false;
    tilt.add(mesh);
    const group = new THREE.Group();
    group.add(tilt);
    // 影と当たり判定は車体の実寸に合わせる。長い車・広い車で足りなくならない。
    // バイクは車と形が違うので、専用の値をそのまま使う。
    const lengthRatio = bike ? 1 : bodyLengthRatio(mesh);
    const widthRatio = bike ? 1 : bodyWidthRatio(mesh);
    group.userData.collideHalfLength =
      (bike ? BIKE_COLLIDE_HALF_LENGTH : CAR_COLLIDE_HALF_LENGTH) * lengthRatio;
    group.userData.collideHalfWidth =
      (bike ? BIKE_COLLIDE_HALF_WIDTH : CAR_COLLIDE_HALF_WIDTH) * widthRatio;
    const shadow = bike ? BIKE_SHADOW : CAR_SHADOW;
    const shadowSize = { w: shadow.w * widthRatio, h: shadow.h * lengthRatio };
    group.userData.bodyRadius = shadowSize.w / 2;
    group.add(makeBlobShadow(shadowSize));
    // 灯火を車体傾斜グループへ入れ、坂・バンク・荷重移動へ追随させる。
    addCarLights(tilt, bike, lightProfile, mesh.userData.lampLayout);
    group.userData.nightLights = tilt.userData.nightLights;
    scene.add(group);
    return { group, tilt };
  }

  // 当たり判定の半径は接地影の横幅の半分に合わせる(実車幅とほぼ一致)。
  // makeCarGroup が車体の幅から出した値を使い、無い時だけ普通車の値へ落とす。
  const carRadiusFor = (bike, group) =>
    group?.userData.bodyRadius ?? (bike ? BIKE_SHADOW.w : CAR_SHADOW.w) / 2;

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

  // cpu_car_list.txt は「ファイル名 ランク」を1行ずつ並べたもの。
  // ランクはCPU車の最高速度をユーザー車比で決める（S=-10% / A=-30% / B=-35% / C=-45%）。
  // Sはユーザー車を抜いていく強豪。Aは自動運転の巡航130km/hより遅くして
  // 追いつけるようにしつつ、Bよりは速い位置に置く。
  const CPU_RANK_SPEED_RATIO = { S: 0.9, A: 0.7, B: 0.65, C: 0.55 };
  const CPU_RANK_DEFAULT = 'B';
  // 読み込む車種数の上限。cpu_car_list.txt は随時書き換わるので、行数にそのまま追従する。
  const CPU_VOX_LIMIT = 30;
  const cpuRankByFile = new Map();

  async function listedCpuVoxFiles() {
    const response = await fetch('cpu_car_list.txt', { cache: 'no-store' });
    if (!response.ok) throw new Error(`cpu_car_list.txt returned ${response.status}`);
    const names = [];
    for (const rawLine of (await response.text()).split(/\r?\n/)) {
      // 先頭のBOM・行頭行末の空白を落とす。区切りは半角/全角スペースの両方を許す。
      const line = rawLine.replace(/^﻿/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const [name, rank] = line.split(/[\s　]+/);
      if (!/\.vox$/i.test(name)) continue;
      names.push(name);
      const upper = String(rank || '').toUpperCase();
      cpuRankByFile.set(
        name.toLowerCase(),
        CPU_RANK_SPEED_RATIO[upper] ? upper : CPU_RANK_DEFAULT
      );
    }
    if (!names.length) throw new Error('cpu_car_list.txt had no vehicle lines');
    return names;
  }

  function cpuRankFor(url) {
    const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').toLowerCase();
    return cpuRankByFile.get(file) ?? CPU_RANK_DEFAULT;
  }
  // ランクから決まるCPU車の最高速度(km/h)。
  function cpuTopSpeedKmhFor(url) {
    return Math.round(PLAYER_TOP_SPEED_KMH * CPU_RANK_SPEED_RATIO[cpuRankFor(url)]);
  }

  function cpuVoxUrls(fileNames, keepOrder = false) {
    const names = [...new Set(fileNames)]
      .map((name) => String(name).split(/[\\/]/).pop())
      .filter((name) => /\.vox$/i.test(name) && !RESERVED_VOX_FILES.has(name.toLowerCase()));
    // cpu_car_list.txt に書かれた順がそのまま配置順になるので、その時だけ並べ替えない。
    // フォルダ探索など順序が環境依存になるソースは、従来どおり名前順に揃える。
    if (!keepOrder) names.sort((a, b) => a.localeCompare(b, 'en'));
    return names.map((name) => 'vox/' + encodeURIComponent(name));
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
    const response = await fetch('js/vox-files.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`js/vox-files.json returned ${response.status}`);
    const names = await response.json();
    if (!Array.isArray(names)) throw new Error('js/vox-files.json is not an array');
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
    // 登場車種とその速度ランクは cpu_car_list.txt が正。読めない時だけ従来の探索へ落ちる。
    const sources = location.hostname.endsWith('.github.io')
      // GitHub Pages ではローカルサーバー用エンドポイントを使わない。
      ? [listedCpuVoxFiles, githubVoxFiles]
      // ダウンロード版は PLAY_*.bat の PowerShell サーバーを優先し、
      // python -m http.server のディレクトリ一覧にも対応する。
      : [listedCpuVoxFiles, localServerVoxFiles, directoryListingVoxFiles];
    for (const getFiles of sources) {
      try {
        const urls = cpuVoxUrls(await getFiles(), getFiles === listedCpuVoxFiles);
        if (urls.length) return urls;
      } catch (error) {
        console.warn('Could not inspect the vox folder with this source.', error);
      }
    }
    console.warn('No CPU vehicle listing was discovered. Using the built-in non-player CPU list.');
    return cpuVoxUrls(FALLBACK_CPU_VOX_FILES);
  }

  // 車種ごとの見た目の調整。track.vox は車体が小さいので丸ごと拡大する（ユーザー指定）。
  // scale は縦・横・高さを同じ倍率で広げる。広げた分は voxSize にも反映するので、
  // 接地影も当たり判定も一緒に追随する。
  // lamps は灯火の並び。TRUCK_LAMPS の座標は scale 適用後のモデルで実測している。
  const VOX_MODEL_TWEAKS = new Map([
    ['track.vox', { scale: 1.4, lamps: 'truck' }],
  ]);
  function applyVoxModelTweaks(url, mesh) {
    const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').toLowerCase();
    const tweak = VOX_MODEL_TWEAKS.get(file);
    // clone される前の1体だけを直す。以降の clone はこの形を受け継ぐ。
    if (!tweak || !mesh?.geometry) return mesh;
    if (tweak.lamps) mesh.userData.lampLayout = tweak.lamps;
    if (tweak.scale) {
      // 原点(車体の底面・中心)を基準に拡大するので、接地したまま大きくなる。
      mesh.geometry.scale(tweak.scale, tweak.scale, tweak.scale);
      const vox = mesh.userData.voxSize;
      if (vox) { vox.x *= tweak.scale; vox.y *= tweak.scale; vox.z *= tweak.scale; }
    }
    return mesh;
  }

  async function loadCpuCars(urls) {
    const nonPlayerUrls = urls.filter((url) => {
      const file = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '').toLowerCase();
      return !RESERVED_VOX_FILES.has(file);
    });
    return (await Promise.all(nonPlayerUrls.map(async (url) => {
      try {
        return { url, mesh: applyVoxModelTweaks(url, await VOX.load(url, { scale: VOXEL_SCALE })) };
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

  function placeTreesOnSurface(treeMesh, config, rnd) {
    if (!config.enabled) return 0;
    if (!treeSurfaceMeshes.length) {
      console.warn(`[Map Warning] ${MAP_CONFIG.treeSurfaceMaterial} tree surface was not found in ${MAP_GLTF}.`);
      return 0;
    }
    const triangles = [];
    let totalArea = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
    for (const mesh of treeSurfaceMeshes) {
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const index = geometry.index;
      const count = index ? index.count / 3 : position.count / 3;
      const vertex = (triangle, corner) => index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
      for (let i = 0; i < count; i++) {
        a.fromBufferAttribute(position, vertex(i, 0)).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(position, vertex(i, 1)).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(position, vertex(i, 2)).applyMatrix4(mesh.matrixWorld);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac).normalize();
        const slope = THREE.MathUtils.radToDeg(Math.acos(clamp(Math.abs(normal.y), 0, 1)));
        const area = new THREE.Triangle(a, b, c).getArea();
        if (area < 0.02 || slope > config.maxSlopeDegrees) continue;
        totalArea += area;
        triangles.push({ a: a.clone(), b: b.clone(), c: c.clone(), end: totalArea });
      }
    }
    if (!triangles.length || !totalArea) return 0;

    const target = Math.min(config.maxCount, Math.max(0, Math.round(totalArea * config.density)));
    document.body.dataset.mapTreeSurfaceArea = totalArea.toFixed(3);
    document.body.dataset.mapTreeTarget = String(target);
    document.body.dataset.mapTreeTriangleCount = String(triangles.length);
    const points = [];
    const buckets = new Map();
    const cellSize = config.minDistance;
    const bucketKey = (x, z) => `${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`;
    const isNearTree = (x, z) => {
      const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const point of buckets.get(`${cx + dx},${cz + dz}`) || []) {
          if ((point.x - x) ** 2 + (point.z - z) ** 2 < config.minDistance ** 2) return true;
        }
      }
      return false;
    };
    const roadTooClose = (x, y, z) => {
      if (config.roadClearance <= 0) return false;
      const samples = [[0, 0]];
      for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4;
        samples.push([Math.cos(angle) * config.roadClearance, Math.sin(angle) * config.roadClearance]);
      }
      return samples.some(([dx, dz]) => {
        const roadY = getRoadHeightAt(x + dx, z + dz);
        return roadY !== null && Math.abs(roadY - y) < 2.5;
      });
    };
    for (let attempt = 0; points.length < target && attempt < target * 30 + 100; attempt++) {
      const areaPick = rnd() * totalArea;
      let low = 0, high = triangles.length - 1;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (triangles[mid].end < areaPick) low = mid + 1; else high = mid;
      }
      const triangle = triangles[low];
      let r1 = rnd(), r2 = rnd();
      if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
      const x = triangle.a.x + (triangle.b.x - triangle.a.x) * r1 + (triangle.c.x - triangle.a.x) * r2;
      const y = triangle.a.y + (triangle.b.y - triangle.a.y) * r1 + (triangle.c.y - triangle.a.y) * r2;
      const z = triangle.a.z + (triangle.b.z - triangle.a.z) * r1 + (triangle.c.z - triangle.a.z) * r2;
      if (mapSpawn && Math.hypot(x - mapSpawn.x, z - mapSpawn.z) < config.spawnExclusionRadius) {
        mapDebugStats.treeCandidatesExcluded++; continue;
      }
      if (roadTooClose(x, y, z)) {
        mapDebugStats.treesExcludedByRoad++; continue;
      }
      if (isNearTree(x, z)) { mapDebugStats.treeCandidatesExcluded++; continue; }
      const point = {
        x, y, z,
        scale: config.scaleMin + rnd() * (config.scaleMax - config.scaleMin),
        rotation: rnd() * Math.PI * 2,
      };
      points.push(point);
      const key = bucketKey(x, z);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(point);
    }
    document.body.dataset.mapTreeCandidatesExcluded = String(mapDebugStats.treeCandidatesExcluded);
    document.body.dataset.mapTreesExcludedByRoad = String(mapDebugStats.treesExcludedByRoad);
    if (!points.length) return 0;
    const instances = new THREE.InstancedMesh(treeMesh.geometry, treeMesh.material, points.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    points.forEach((point, i) => {
      quaternion.setFromAxisAngle(up, point.rotation);
      matrix.compose(
        new THREE.Vector3(point.x, point.y, point.z),
        quaternion,
        new THREE.Vector3(point.scale, point.scale, point.scale)
      );
      instances.setMatrixAt(i, matrix);
    });
    instances.instanceMatrix.needsUpdate = true;
    instances.computeBoundingSphere();
    instances.castShadow = true;
    scene.add(instances);
    mapDebugStats.treesPlaced = points.length;
    return points.length;
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
  function markBrightestSequenceMaterial(root) {
    const materials = new Set();
    root.traverse((object) => {
      if (!object.isMesh) return;
      const list = Array.isArray(object.material) ? object.material : [object.material];
      list.forEach((material) => {
        if (material?.color && material.name) materials.add(material);
      });
    });
    const grayscale = [...materials].filter((material) => {
      const { r, g, b } = material.color;
      return Math.max(r, g, b) - Math.min(r, g, b) < 0.035;
    });
    if (!grayscale.length) return [];
    const brightness = (material) =>
      (material.color.r + material.color.g + material.color.b) / 3;
    const maximum = Math.max(...grayscale.map(brightness));
    const centerLineMaterials = grayscale.filter((material) =>
      Math.abs(brightness(material) - maximum) < 1e-5);
    centerLineMaterials.forEach((material) => {
      material.userData = material.userData || {};
      material.userData.sequenceCenterLine = true;
    });
    return centerLineMaterials.map((material) => material.name || '(unnamed)');
  }

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

  // 連結GLBの内部端に残る、Z方向へ直交した薄い垂直な終端面だけを除去する。
  // 上向きの道路・草地面は残るため、重ねた区間の見た目と走行支持は途切れない。
  function removeSequenceEndCaps(root, capPlanesZ, bandMeters = 0.12) {
    if (!capPlanesZ.length || !(MAP_CONFIG.scale > 0)) return 0;
    const bandLocal = bandMeters / MAP_CONFIG.scale;
    // 終端の板だけを選ぶための実寸条件。木の幹などの細い垂直面は残す。
    const maximumEndCapDepthLocal = 0.45 / MAP_CONFIG.scale;
    const minimumEndCapWidthLocal = 1.25 / MAP_CONFIG.scale;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const normal = new THREE.Vector3();
    let removedTriangles = 0;
    root.traverse((object) => {
      if (!object.isMesh) return;
      const geometry = object.geometry;
      const position = geometry?.attributes?.position;
      if (!position) return;
      const sourceIndex = geometry.index;
      const elementCount = sourceIndex ? sourceIndex.count : position.count;
      const vertexIndex = (offset) => sourceIndex ? sourceIndex.getX(offset) : offset;
      const keptIndices = [];
      let removedFromMesh = 0;
      for (let offset = 0; offset + 2 < elementCount; offset += 3) {
        const indexA = vertexIndex(offset);
        const indexB = vertexIndex(offset + 1);
        const indexC = vertexIndex(offset + 2);
        a.fromBufferAttribute(position, indexA);
        b.fromBufferAttribute(position, indexB);
        c.fromBufferAttribute(position, indexC);
        const minZ = Math.min(a.z, b.z, c.z);
        const maxZ = Math.max(a.z, b.z, c.z);
        const minX = Math.min(a.x, b.x, c.x);
        const maxX = Math.max(a.x, b.x, c.x);
        const centerZ = (a.z + b.z + c.z) / 3;
        const closeToCap = capPlanesZ.some((capZ) =>
          Math.abs(centerZ - capZ) <= bandLocal
        );
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac).normalize();
        const transverseVerticalFace =
          maxZ - minZ <= maximumEndCapDepthLocal
          && maxX - minX >= minimumEndCapWidthLocal
          && Math.abs(normal.y) <= 0.35;
        if (closeToCap && transverseVerticalFace) {
          removedTriangles++;
          removedFromMesh++;
          continue;
        }
        keptIndices.push(indexA, indexB, indexC);
      }
      if (!removedFromMesh) return;
      geometry.setIndex(keptIndices);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    });
    document.body.dataset.mapSequenceEndCapTrianglesRemoved =
      String(removedTriangles);
    return removedTriangles;
  }

  // 森林区間の接合線を、前後の実地表から採取した材質・高さで細かく橋渡しする。
  // GLB端のサブピクセル空隙を隠すと同時に、車輪レイが必ず支持面を拾えるようにする。
  function buildForestSeamBridges() {
    if (COURSE_KEY !== 'forest' || !mapSequenceSeamZs.length || !mapBounds) return 0;
    const sampleStepX = 1;
    // GLBの地表端は外形端から僅かに内側なので、継ぎ目を中心に広めに支持する。
    const internalHalfBridgeZ = 1.6;
    const loopHalfBridgeZ = 4;
    const groups = new Map();
    const surfaceAt = (x, z) => getMapSurfacesAt(x, z)[0] ?? null;
    const previewSurfaceAt = (x, z) => {
      if (!sequenceLoopPreviewSurfaceMeshes.length) return null;
      rayOrigin.set(x, mapRayTop, z);
      groundCaster.set(rayOrigin, DOWN);
      groundCaster.far = Math.max(20, mapRayTop - mapRayBottom + 20);
      return groundCaster.intersectObjects(sequenceLoopPreviewSurfaceMeshes, true)
        .find((candidate) => {
          if (!candidate.face) return false;
          wallNormal.copy(candidate.face.normal)
            .transformDirection(candidate.object.matrixWorld);
          return Math.abs(wallNormal.y) > 0.55;
        }) ?? null;
    };
    const groupFor = (hit) => {
      const sourceMaterial = Array.isArray(hit.object.material)
        ? hit.object.material[0]
        : hit.object.material;
      if (!sourceMaterial) return null;
      const flags = {
        road: roadMeshes.includes(hit.object),
        nonWall: nonWallMeshes.includes(hit.object),
        sand: sandMeshes.includes(hit.object),
      };
      const key = `${sourceMaterial.uuid}|${flags.road}|${flags.nonWall}|${flags.sand}`;
      if (!groups.has(key)) {
        groups.set(key, {
          material: sourceMaterial,
          flags,
          positions: [],
          uvs: [],
          indices: [],
        });
      }
      return groups.get(key);
    };
    const seamEntries = [
      ...mapSequenceSeamZs.map((z) => ({ z, loop: false, mainOnHighZ: true })),
      ...mapSequenceLoopSeamZs.map((z, index) => ({
        z,
        loop: true,
        // 配列先頭はコース終端（低Z）、末尾はコース始端（高Z）。
        mainOnHighZ: index === 0,
      })),
    ];
    for (const seam of seamEntries) {
      const seamZ = seam.z;
      const halfBridgeZ = seam.loop ? loopHalfBridgeZ : internalHalfBridgeZ;
      const zBefore = seamZ + halfBridgeZ;
      const zAfter = seamZ - halfBridgeZ;
      const highSurfaceAt = seam.loop && !seam.mainOnHighZ
        ? previewSurfaceAt
        : surfaceAt;
      const lowSurfaceAt = seam.loop && seam.mainOnHighZ
        ? previewSurfaceAt
        : surfaceAt;
      for (let x0 = mapBounds.min.x; x0 < mapBounds.max.x; x0 += sampleStepX) {
        const x1 = Math.min(mapBounds.max.x, x0 + sampleStepX);
        const centerX = (x0 + x1) * 0.5;
        const beforeCenter = highSurfaceAt(centerX, zBefore);
        const afterCenter = lowSurfaceAt(centerX, zAfter);
        if (!beforeCenter && !afterCenter) continue;
        // ループ用プレビューではなく、本体側のマテリアルを補助面へ使う。
        const source = seam.loop
          ? (seam.mainOnHighZ ? beforeCenter : afterCenter)
            ?? beforeCenter ?? afterCenter
          : beforeCenter ?? afterCenter;
        const group = groupFor(source);
        if (!group) continue;
        const before0 = highSurfaceAt(x0, zBefore) ?? beforeCenter ?? afterCenter;
        const before1 = highSurfaceAt(x1, zBefore) ?? beforeCenter ?? afterCenter;
        const after0 = lowSurfaceAt(x0, zAfter) ?? afterCenter ?? beforeCenter;
        const after1 = lowSurfaceAt(x1, zAfter) ?? afterCenter ?? beforeCenter;
        if (Math.abs(
          (beforeCenter ?? afterCenter).point.y
          - (afterCenter ?? beforeCenter).point.y
        ) > 3) continue;
        const uvAt = (hit, x, z) => hit?.uv
          ? [hit.uv.x, hit.uv.y]
          : [x * 0.08, z * 0.08];
        const uvBefore0 = uvAt(before0, x0, zBefore);
        const uvBefore1 = uvAt(before1, x1, zBefore);
        const uvAfter1 = uvAt(after1, x1, zAfter);
        const uvAfter0 = uvAt(after0, x0, zAfter);
        const base = group.positions.length / 3;
        group.positions.push(
          x0, before0.point.y, zBefore,
          x1, before1.point.y, zBefore,
          x1, after1.point.y, zAfter,
          x0, after0.point.y, zAfter
        );
        group.uvs.push(
          ...uvBefore0,
          ...uvBefore1,
          ...uvAfter1,
          ...uvAfter0
        );
        group.indices.push(
          base, base + 1, base + 2,
          base, base + 2, base + 3
        );
      }
    }
    let bridgeMeshCount = 0;
    let bridgeTriangleCount = 0;
    for (const group of groups.values()) {
      if (!group.indices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.Float32BufferAttribute(group.positions, 3)
      );
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(group.uvs, 2));
      geometry.setIndex(group.indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const material = group.material.clone();
      material.vertexColors = false;
      material.side = THREE.DoubleSide;
      // 元地表と同じUVを使い、僅かに手前へ描画して残った空色の隙間を覆う。
      material.polygonOffset = true;
      material.polygonOffsetFactor = -0.35;
      material.polygonOffsetUnits = -0.35;
      const bridge = new THREE.Mesh(geometry, material);
      bridge.name = 'forest_seam_bridge';
      bridge.castShadow = false;
      bridge.receiveShadow = false;
      scene.add(bridge);
      mapSurfaceMeshes.push(bridge);
      car2DrivableMeshes.push(bridge);
      if (group.flags.road) roadMeshes.push(bridge);
      if (group.flags.nonWall) nonWallMeshes.push(bridge);
      if (group.flags.sand) sandMeshes.push(bridge);
      bridgeMeshCount++;
      bridgeTriangleCount += group.indices.length / 3;
    }
    document.body.dataset.mapForestSeamBridgeMeshCount = String(bridgeMeshCount);
    document.body.dataset.mapForestSeamBridgeTriangleCount =
      String(bridgeTriangleCount);
    document.body.dataset.mapForestSeamBridgeRenderMode =
      'wide-textured-support';
    document.body.dataset.mapForestLoopSeamBridgeCount =
      String(mapSequenceLoopSeamZs.length);
    return bridgeMeshCount;
  }

  function addMapEdgeOutlines(root, excludedMaterialNames) {
    if (!MAP_CONFIG.edgeOutlines) return 0;
    const targets = [];
    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const names = materials.map((material) => (material?.name || '').trim().toUpperCase());
      if (names.some((name) => excludedMaterialNames.has(name))) return;
      targets.push(object);
    });
    const outlineMaterial = new THREE.LineBasicMaterial({
      color: MAP_CONFIG.edgeOutlineColor,
      transparent: true,
      opacity: MAP_CONFIG.edgeOutlineOpacity,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    let segmentCount = 0;
    for (const mesh of targets) {
      const geometry = new THREE.EdgesGeometry(
        mesh.geometry,
        MAP_CONFIG.edgeOutlineThresholdDegrees
      );
      segmentCount += geometry.attributes.position?.count / 2 || 0;
      const outline = new THREE.LineSegments(geometry, outlineMaterial);
      outline.name = `${mesh.name || 'map'}_outline`;
      outline.renderOrder = 2;
      outline.frustumCulled = mesh.frustumCulled;
      outline.raycast = () => {}; // 描画線を路面・壁の物理判定へ混ぜない。
      mesh.add(outline);
    }
    return segmentCount;
  }

  function addNonGroundWhiteGlow(root) {
    root.updateMatrixWorld(true);
    const sourceMeshes = [];
    root.traverse((object) => {
      if (object.isMesh && !object.userData.mapWhiteGlow) sourceMeshes.push(object);
    });
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    let glowFaces = 0;

    for (const mesh of sourceMeshes) {
      const geometry = mesh.geometry;
      const position = geometry?.attributes?.position;
      if (!position) continue;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const whiteMaterial = materials.map((material) => {
        const color = material?.color;
        return Boolean(color
          && Math.min(color.r, color.g, color.b) > 0.88
          && Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) < 0.08);
      });
      if (!whiteMaterial.some(Boolean)) continue;

      const index = geometry.index;
      const elementCount = index ? index.count : position.count;
      const groups = geometry.groups.length
        ? geometry.groups
        : [{ start: 0, count: elementCount, materialIndex: 0 }];
      const glowIndices = [];
      const vertexIndex = (offset) => index ? index.getX(offset) : offset;

      for (const group of groups) {
        if (!whiteMaterial[group.materialIndex ?? 0]) continue;
        const end = Math.min(group.start + group.count, elementCount);
        for (let offset = group.start; offset + 2 < end; offset += 3) {
          const ia = vertexIndex(offset);
          const ib = vertexIndex(offset + 1);
          const ic = vertexIndex(offset + 2);
          a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
          b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
          c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          const normalY = ab.cross(ac).normalize().y;
          // 上向きの白面=白線・白い路面・屋上は発光させない。
          // 垂直面=ビル窓、下向き面=トンネル照明だけを発光対象にする。
          if (normalY >= 0.55) continue;
          glowIndices.push(ia, ib, ic);
        }
      }
      if (!glowIndices.length) continue;

      const glowGeometry = geometry.clone();
      glowGeometry.clearGroups();
      glowGeometry.setIndex(glowIndices);
      const glow = new THREE.Mesh(
        glowGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xfff6d8,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          side: THREE.DoubleSide,
        })
      );
      glow.name = `${mesh.name || 'map'}_night_white_glow`;
      glow.visible = nightMode;
      glow.renderOrder = 3;
      glow.userData.mapWhiteGlow = true;
      glow.raycast = () => {};
      mesh.add(glow);
      mapWhiteGlowMeshes.push(glow);
      glowFaces += glowIndices.length / 3;
    }
    document.body.dataset.mapWhiteGlowFaces = String(glowFaces);
    document.body.dataset.mapWhiteGlowMeshes = String(mapWhiteGlowMeshes.length);
  }

  function addVerticalMapLoopCopies(root, bounds) {
    document.body.dataset.mapVisualLoopCopies = '0';
    if (MAP_CONFIG.loopMode !== 'vertical') return;
    const spanZ = bounds.max.z - bounds.min.z;
    if (!(spanZ > 0)) return;
    for (const direction of [-1, 1]) {
      const visualCopy = root.clone(true);
      visualCopy.position.z += spanZ * direction;
      visualCopy.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = false;
        if (object.userData.mapWhiteGlow) mapWhiteGlowMeshes.push(object);
      });
      scene.add(visualCopy);
      car2VisualWraps.push(visualCopy);
    }
    document.body.dataset.mapVisualLoopCopies = String(car2VisualWraps.length);
  }

  function addSequenceLoopPreviews(layout) {
    if (!layout) return;
    sequenceLoopPreviewSurfaceMeshes.length = 0;
    const previewSurfaceNames = new Set([
      MAP_CONFIG.roadMaterial,
      ...(MAP_CONFIG.roadMaterialAliases ?? []),
      ...(MAP_CONFIG.drivableMaterialAliases ?? []),
      ...(MAP_CONFIG.nonWallMaterialAliases ?? []),
      ...(MAP_CONFIG.sandMaterialAliases ?? []),
    ].filter(Boolean).map((name) => name.trim().toUpperCase()));
    const addPreview = (template, localZ, name) => {
      const previewMap = template.clone(true);
      previewMap.position.z += localZ;
      const previewWrap = new THREE.Group();
      previewWrap.name = name;
      previewWrap.add(previewMap);
      previewWrap.scale.setScalar(MAP_CONFIG.scale);
      previewWrap.rotation.y = MAP_CONFIG.rotationY;
      previewWrap.position.set(
        MAP_CONFIG.positionOffsetX,
        MAP_CONFIG.positionOffsetY,
        MAP_CONFIG.positionOffsetZ
      );
      previewWrap.traverse((object) => {
        if (!object.isMesh) return;
        object.castShadow = false;
        object.receiveShadow = true;
        const materials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        const isPreviewSurface = materials.some((material) =>
          previewSurfaceNames.has((material?.name ?? '').trim().toUpperCase())
        );
        if (isPreviewSurface) {
          // 通常衝突配列には加えず、ループ接続面の生成時だけ実高さ・UVを読む。
          sequenceLoopPreviewSurfaceMeshes.push(object);
        } else {
          object.raycast = () => {};
        }
      });
      scene.add(previewWrap);
      car2VisualWraps.push(previewWrap);
    };

    // 最終区間の先へ先頭区間、先頭区間の手前へ最終区間を表示して、
    // 一周境界でも道路が視覚的に途切れないようにする。
    addPreview(
      layout.firstTemplate,
      layout.sequenceEndZ - layout.firstBounds.max.z,
      'sea_sequence_next_preview'
    );
    addPreview(
      layout.lastTemplate,
      -layout.lastBounds.min.z,
      'sea_sequence_previous_preview'
    );
    document.body.dataset.mapVisualLoopCopies = String(car2VisualWraps.length);
  }

  async function loadGltfMap(url) {
    // 読込式マップの接続軸は元モデルY（ゲーム内Z）のみ。
    // X方向の左右には複製マップを一切生成しない。
    document.body.dataset.mapConnectionAxis = 'source-y/game-z-only';
    document.body.dataset.mapHorizontalCopyCount = '0';
    const sourceUrls = Array.isArray(MAP_CONFIG.segmentFiles) && MAP_CONFIG.segmentFiles.length
      ? MAP_CONFIG.segmentFiles
      : [url];
    let map;
    let originalBox;
    let sequenceLayout = null;
    try {
      if (sourceUrls.length === 1) {
        const revision = MAP_CONFIG.assetRevision;
        const separator = url.includes('?') ? '&' : '?';
        const loadUrl = revision ? `${url}${separator}v=${revision}` : url;
        const gltf = await new GLTFLoader().loadAsync(loadUrl);
        map = gltf.scene;
        map.updateMatrixWorld(true);
        originalBox = new THREE.Box3().setFromObject(map);
      } else {
        // 同じ素材マップが順番内で複数回使われるため、ファイルは一度だけ読み込み、
        // シーンを複製して配置する。
        const uniqueUrls = [...new Set(sourceUrls)];
        const sequenceAssetRevision =
          MAP_CONFIG.assetRevision ?? DEFAULT_SEQUENCE_MAP_ASSET_REVISION;
        const loaded = await Promise.all(uniqueUrls.map(async (sourceUrl) => {
          const separator = sourceUrl.includes('?') ? '&' : '?';
          const gltf = await new GLTFLoader().loadAsync(
            `${sourceUrl}${separator}v=${sequenceAssetRevision}`
          );
          let template = gltf.scene;
          template.updateMatrixWorld(true);
          const centerLineMaterials = MAP_CONFIG.cpuCenterLineMode === 'brightestGrayPerSegment'
            ? markBrightestSequenceMaterial(template)
            : [];
          let count = 0;
          template.traverse((object) => { if (object.isMesh) count++; });
          if (count > 200) template = mergeMapMeshes(template);
          template.userData.sequenceCenterLineMaterials = centerLineMaterials;
          const sourceScale = MAP_CONFIG.segmentScaleOverrides?.[sourceUrl] ?? 1;
          template.scale.multiplyScalar(sourceScale);
          const planarScale = MAP_CONFIG.segmentPlanarScaleOverrides?.[sourceUrl] ?? 1;
          template.scale.x *= planarScale;
          template.scale.z *= planarScale;
          template.userData.sequenceScaleX = sourceScale * planarScale;
          template.userData.sequenceScaleY = sourceScale;
          template.userData.sequenceScaleZ = sourceScale * planarScale;
          template.updateMatrixWorld(true);
          return [sourceUrl, template];
        }));
        for (const [sourceUrl, referenceUrl] of Object.entries(
          MAP_CONFIG.segmentSizeReferences ?? {}
        )) {
          const sourceTemplate = loaded.find(([url]) => url === sourceUrl)?.[1];
          const referenceTemplate = loaded.find(([url]) => url === referenceUrl)?.[1];
          if (!sourceTemplate || !referenceTemplate) continue;
          const sourceSize = new THREE.Box3()
            .setFromObject(sourceTemplate)
            .getSize(new THREE.Vector3());
          const referenceSize = new THREE.Box3()
            .setFromObject(referenceTemplate)
            .getSize(new THREE.Vector3());
          const factorX = referenceSize.x / sourceSize.x;
          const factorY = referenceSize.y / sourceSize.y;
          const factorZ = referenceSize.z / sourceSize.z;
          sourceTemplate.scale.x *= factorX;
          sourceTemplate.scale.y *= factorY;
          sourceTemplate.scale.z *= factorZ;
          sourceTemplate.userData.sequenceScaleX *= factorX;
          sourceTemplate.userData.sequenceScaleY *= factorY;
          sourceTemplate.userData.sequenceScaleZ *= factorZ;
          sourceTemplate.updateMatrixWorld(true);
        }
        if (MAP_CONFIG.sequenceAnchorX === 'min' && loaded.length) {
          const referenceBounds = new THREE.Box3().setFromObject(loaded[0][1]);
          const referenceSeaEdgeX = referenceBounds.min.x;
          for (const [, template] of loaded) {
            const bounds = new THREE.Box3().setFromObject(template);
            template.position.x += referenceSeaEdgeX - bounds.min.x;
            template.updateMatrixWorld(true);
          }
          document.body.dataset.mapSequenceAnchorSide = `${COURSE_KEY}-min-x`;
          document.body.dataset.mapSequenceAnchorX = referenceSeaEdgeX.toFixed(3);
          document.body.dataset.mapSegmentAnchorsX = loaded.map(([sourceUrl, template]) => {
            const bounds = new THREE.Box3().setFromObject(template);
            return `${sourceUrl}:${bounds.min.x.toFixed(3)}`;
          }).join('|');
        }
        document.body.dataset.mapSegmentSourceSizes = loaded.map(([sourceUrl, template]) => {
          const bounds = new THREE.Box3().setFromObject(template);
          const size = bounds.getSize(new THREE.Vector3());
          return `${sourceUrl}:${size.x.toFixed(3)},${size.y.toFixed(3)},${size.z.toFixed(3)}`;
        }).join('|');
        const sourceRoadNames = new Set([
          MAP_CONFIG.roadMaterial,
          ...MAP_CONFIG.roadMaterialAliases,
        ].map((name) => name.trim().toUpperCase()));
        const boundsForMaterials = (root, materialNames) => {
          const bounds = new THREE.Box3();
          root.updateMatrixWorld(true);
          root.traverse((object) => {
            if (!object.isMesh) return;
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            if (materials.some((material) =>
              materialNames.has((material?.name ?? '').trim().toUpperCase())
            )) {
              bounds.expandByObject(object);
            }
          });
          return bounds;
        };
        document.body.dataset.mapSegmentSourceRoadSizes = loaded.map(([sourceUrl, template]) => {
          const bounds = boundsForMaterials(template, sourceRoadNames);
          const size = bounds.isEmpty() ? new THREE.Vector3() : bounds.getSize(new THREE.Vector3());
          return `${sourceUrl}:${size.x.toFixed(3)},${size.y.toFixed(3)},${size.z.toFixed(3)}`;
        }).join('|');
        const templates = new Map(loaded);
        const sequenceGroup = new THREE.Group();
        sequenceGroup.name = `${COURSE_KEY}_sequence`;
        const placements = [];
        let cursorZ = 0;
        const connectByRoad = MAP_CONFIG.sequenceConnectByRoad === true;
        const sequenceOverlapLocal =
          connectByRoad
            ? 0
            : (MAP_CONFIG.sequenceOverlapMeters ?? 0) / MAP_CONFIG.scale;

        sourceUrls.forEach((sourceUrl, index) => {
          const segment = templates.get(sourceUrl).clone(true);
          segment.name = `${COURSE_KEY}_segment_${String(index).padStart(2, '0')}_${sourceUrl}`;
          segment.updateMatrixWorld(true);
          const sourceBounds = new THREE.Box3().setFromObject(segment);
          const sourceConnectionBounds = connectByRoad
            ? boundsForMaterials(segment, sourceRoadNames)
            : sourceBounds;
          // SketchUpの元Y最小端はゲームZ最大端、元Y最大端はゲームZ最小端。
          // 森林地帯は木の枝を含む外形ではなく、道路材質の端同士を直接合わせる。
          const targetStartZ = index === 0 ? cursorZ : cursorZ + sequenceOverlapLocal;
          segment.position.z += targetStartZ - sourceConnectionBounds.max.z;
          sequenceGroup.add(segment);
          sequenceGroup.updateMatrixWorld(true);
          const placedBounds = new THREE.Box3().setFromObject(segment);
          const placedConnectionBounds = connectByRoad
            ? boundsForMaterials(segment, sourceRoadNames)
            : placedBounds;
          placements.push({
            index,
            file: sourceUrl,
            startZ: placedConnectionBounds.max.z,
            endZ: placedConnectionBounds.min.z,
            spanZ: placedConnectionBounds.max.z - placedConnectionBounds.min.z,
            scaleX: segment.userData.sequenceScaleX ?? 1,
            scaleY: segment.userData.sequenceScaleY ?? 1,
            scaleZ: segment.userData.sequenceScaleZ ?? 1,
          });
          cursorZ = placedConnectionBounds.min.z;
        });

        map = sequenceGroup;
        map.updateMatrixWorld(true);
        originalBox = new THREE.Box3().setFromObject(map);
        const firstTemplate = templates.get(sourceUrls[0]).clone(true);
        const lastTemplate = templates.get(sourceUrls[sourceUrls.length - 1]).clone(true);
        firstTemplate.updateMatrixWorld(true);
        lastTemplate.updateMatrixWorld(true);
        const firstBounds = connectByRoad
          ? boundsForMaterials(firstTemplate, sourceRoadNames)
          : new THREE.Box3().setFromObject(firstTemplate);
        const lastBounds = connectByRoad
          ? boundsForMaterials(lastTemplate, sourceRoadNames)
          : new THREE.Box3().setFromObject(lastTemplate);
        sequenceLayout = {
          placements,
          sequenceEndZ: cursorZ,
          centerLineMaterials: uniqueUrls.map((sourceUrl) => ({
            file: sourceUrl,
            materials: templates.get(sourceUrl).userData.sequenceCenterLineMaterials ?? [],
          })),
          firstTemplate,
          lastTemplate,
          firstBounds,
          lastBounds,
          overlapLocal: sequenceOverlapLocal,
          connectByRoad,
        };
        document.body.dataset.mapSequenceConnection =
          connectByRoad
            ? 'road-max-z-to-next-road-min-z'
            : 'source-y-max-to-next-source-y-min';
      }
    } catch (error) {
      console.error(`[Map Warning] Map file could not be loaded: ${sourceUrls.join(', ')}`, error);
      throw error;
    }
    map.updateMatrixWorld(true);

    const normalizeMaterialName = (material) => (material && material.name || '').trim().toUpperCase();
    const roadNames = new Set([
      MAP_CONFIG.roadMaterial,
      ...MAP_CONFIG.roadMaterialAliases,
    ].map((name) => name.trim().toUpperCase()));
    const drivableNames = new Set([
      ...roadNames,
      ...MAP_CONFIG.drivableMaterialAliases,
    ].map((name) => name.trim().toUpperCase()));
    const wallNames = new Set(
      (MAP_CONFIG.wallMaterialAliases ?? []).map((name) => name.trim().toUpperCase())
    );
    const nonWallNames = new Set(
      (MAP_CONFIG.nonWallMaterialAliases ?? []).map((name) => name.trim().toUpperCase())
    );
    const sandNames = new Set(
      (MAP_CONFIG.sandMaterialAliases ?? []).map((name) => name.trim().toUpperCase())
    );
    const blockedSurfaceNames = new Set(
      (MAP_CONFIG.blockedSurfaceMaterialAliases ?? [])
        .map((name) => name.trim().toUpperCase())
    );
    const treeNames = new Set([
      MAP_CONFIG.treeSurfaceMaterial,
      ...MAP_CONFIG.treeSurfaceMaterialAliases,
    ].map((name) => name.trim().toUpperCase()));
    let meshCount = 0;
    map.traverse((object) => {
      if (!object.isMesh) return;
      meshCount++;
      if (!DEBUG_MAP || sourceUrls.length > 1) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const bounds = new THREE.Box3().setFromObject(object);
      for (const material of materials) {
        const name = normalizeMaterialName(material);
        const usage = name === MAP_CONFIG.roadMaterial ? 'ROAD'
          : name === MAP_CONFIG.treeSurfaceMaterial ? 'TREE_SURFACE'
            : roadNames.has(name) ? 'ROAD_ALIAS'
              : wallNames.has(name) ? 'WALL'
                : nonWallNames.has(name) ? 'NON_WALL_SURFACE'
                  : sandNames.has(name) ? 'SAND_SURFACE'
                    : blockedSurfaceNames.has(name) ? 'BLOCKED_SURFACE'
                  : treeNames.has(name) ? 'TREE_SURFACE_ALIAS' : 'OTHER';
        console.info('[Map Material]', {
          map: url,
          mesh: object.name || '(unnamed)',
          material: material && material.name || '(none)',
          materialCount: materials.length,
          baseColor: material && material.color ? `#${material.color.getHexString()}` : null,
          vertexColors: Boolean(material && material.vertexColors),
          boundingBox: { min: bounds.min.toArray(), max: bounds.max.toArray() },
          isM08: roadNames.has(name),
          isF08: treeNames.has(name),
          usage,
        });
      }
    });
    if (meshCount > 200 || sourceUrls.length > 1) map = mergeMapMeshes(map);
    if (COURSE_KEY === 'forest' && sequenceLayout) {
      const internalCapPlanes = [];
      for (let index = 0; index + 1 < sequenceLayout.placements.length; index++) {
        const previousEndZ = sequenceLayout.placements[index].endZ;
        const nextStartZ = sequenceLayout.placements[index + 1].startZ;
        internalCapPlanes.push(
          previousEndZ,
          nextStartZ,
          (previousEndZ + nextStartZ) * 0.5
        );
      }
      internalCapPlanes.push(
        sequenceLayout.placements[0].startZ,
        sequenceLayout.placements[sequenceLayout.placements.length - 1].endZ
      );
      removeSequenceEndCaps(map, internalCapPlanes, 5.0);
    }

    const wrap = new THREE.Group();
    wrap.add(map);
    wrap.scale.setScalar(MAP_CONFIG.scale);
    wrap.rotation.y = MAP_CONFIG.rotationY;
    wrap.position.set(
      MAP_CONFIG.positionOffsetX,
      MAP_CONFIG.positionOffsetY,
      MAP_CONFIG.positionOffsetZ
    );
    scene.add(wrap);
    wrap.updateMatrixWorld(true);
    if (MAP_CONFIG.centerMapXZ) {
      const centeredBox = new THREE.Box3().setFromObject(wrap);
      const centeredAt = centeredBox.getCenter(new THREE.Vector3());
      wrap.position.x -= centeredAt.x;
      wrap.position.z -= centeredAt.z;
      wrap.updateMatrixWorld(true);
    }
    mapRoot = wrap;
    roadMeshes = [];
    wallMeshes = [];
    nonWallMeshes = [];
    sandMeshes = [];
    blockedSurfaceMeshes = [];
    mapWallCollisionCount = 0;
    document.body.dataset.mapWallCollisionCount = '0';
    mapSurfaceMeshes = [];
    car2DrivableMeshes = [];
    treeSurfaceMeshes = [];

    const out = { spawn: null, loops: {} };
    wrap.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = MAP_CONFIG.renderShadows !== false;
        object.receiveShadow = MAP_CONFIG.renderShadows !== false;
        mapSurfaceMeshes.push(object);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const names = materials.map(normalizeMaterialName);
        if (names.some((name) => roadNames.has(name))) roadMeshes.push(object);
        if (names.some((name) => wallNames.has(name))) wallMeshes.push(object);
        if (names.some((name) => nonWallNames.has(name))) nonWallMeshes.push(object);
        if (names.some((name) => sandNames.has(name))) sandMeshes.push(object);
        if (names.some((name) => blockedSurfaceNames.has(name))) {
          blockedSurfaceMeshes.push(object);
        }
        if (names.some((name) => drivableNames.has(name))) car2DrivableMeshes.push(object);
        if (names.some((name) => treeNames.has(name))) treeSurfaceMeshes.push(object);
      }
      const name = object.name || '';
      if (object.isMesh && name.startsWith('col_')) {
        const b = new THREE.Box3().setFromObject(object);
        const cc = b.getCenter(new THREE.Vector3());
        const sz = b.getSize(new THREE.Vector3());
        obstacles.push({ x: cc.x, z: cc.z, r: Math.max(0.5, (sz.x + sz.z) / 4) });
      }
      if (name === 'spawn') out.spawn = object;
      const m = name.match(/^wp_(.+)_(\d+)$/);
      if (m) {
        (out.loops[m[1]] = out.loops[m[1]] || []).push({ i: +m[2], p: object.getWorldPosition(new THREE.Vector3()) });
      }
    });
    const wallA = new THREE.Vector3();
    const wallB = new THREE.Vector3();
    const wallC = new THREE.Vector3();
    const wallAB = new THREE.Vector3();
    const wallAC = new THREE.Vector3();
    const countVerticalFaces = (meshes) => {
      let count = 0;
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        const position = mesh.geometry?.attributes?.position;
        if (!position) continue;
        const index = mesh.geometry.index;
        const elementCount = index ? index.count : position.count;
        const vertexIndex = (offset) => index ? index.getX(offset) : offset;
        for (let offset = 0; offset + 2 < elementCount; offset += 3) {
          wallA.fromBufferAttribute(position, vertexIndex(offset)).applyMatrix4(mesh.matrixWorld);
          wallB.fromBufferAttribute(position, vertexIndex(offset + 1)).applyMatrix4(mesh.matrixWorld);
          wallC.fromBufferAttribute(position, vertexIndex(offset + 2)).applyMatrix4(mesh.matrixWorld);
          wallAB.subVectors(wallB, wallA);
          wallAC.subVectors(wallC, wallA);
          if (Math.abs(wallAB.cross(wallAC).normalize().y) <= 0.08) count++;
        }
      }
      return count;
    };
    const wallVerticalFaceCount = countVerticalFaces(wallMeshes);
    const collisionMeshes = mapSurfaceMeshes.filter((mesh) =>
      !roadMeshes.includes(mesh) && !nonWallMeshes.includes(mesh));
    const collisionVerticalFaceCount = countVerticalFaces(collisionMeshes);
    car2RoadMeshes = roadMeshes;
    const edgeSegmentCount = addMapEdgeOutlines(wrap, roadNames);
    if (MAP_CONFIG.mapWhiteGlow !== false) {
      addNonGroundWhiteGlow(wrap);
    } else {
      document.body.dataset.mapWhiteGlowFaces = '0';
      document.body.dataset.mapWhiteGlowMeshes = '0';
    }
    document.body.dataset.mapEdgeSegments = String(edgeSegmentCount);
    document.body.dataset.mapDrivableMeshCount = String(car2DrivableMeshes.length);
    document.body.dataset.mapWallMeshCount = String(wallMeshes.length);
    document.body.dataset.mapNonWallMeshCount = String(nonWallMeshes.length);
    document.body.dataset.mapWallVerticalFaceCount = String(wallVerticalFaceCount);
    document.body.dataset.mapCollisionMeshCount = String(collisionMeshes.length);
    document.body.dataset.mapCollisionVerticalFaceCount =
      String(collisionVerticalFaceCount);
    const materialSummary = (meshes) => [...new Set(meshes.flatMap((mesh) => {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      return materials.map((material) =>
        `${material?.name || '(none)'}:${material?.color ? `#${material.color.getHexString()}` : 'none'}`
      );
    }))].join(',');
    document.body.dataset.mapRoadMaterials = materialSummary(roadMeshes);
    document.body.dataset.mapWallMaterials = materialSummary(wallMeshes);
    document.body.dataset.mapNonWallMaterials = materialSummary(nonWallMeshes);
    document.body.dataset.mapSandMaterials = materialSummary(sandMeshes);
    document.body.dataset.mapBlockedSurfaceMaterials = materialSummary(blockedSurfaceMeshes);
    document.body.dataset.mapSandMeshCount = String(sandMeshes.length);
    document.body.dataset.mapBlockedSurfaceMeshCount = String(blockedSurfaceMeshes.length);
    document.body.dataset.mapAllMaterials = materialSummary(mapSurfaceMeshes);
    const materialBounds = new Map();
    for (const mesh of mapSurfaceMeshes) {
      const bounds = new THREE.Box3().setFromObject(mesh);
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const name = material?.name || '(none)';
        if (!materialBounds.has(name)) materialBounds.set(name, new THREE.Box3());
        materialBounds.get(name).union(bounds);
      }
    }
    document.body.dataset.mapMaterialBounds = [...materialBounds.entries()]
      .map(([name, bounds]) => [
        name,
        bounds.min.x.toFixed(3),
        bounds.max.x.toFixed(3),
        bounds.min.y.toFixed(3),
        bounds.max.y.toFixed(3),
        bounds.min.z.toFixed(3),
        bounds.max.z.toFixed(3),
      ].join(':'))
      .join('|');
    if (!roadMeshes.length) console.warn(`[Map Warning] ${MAP_CONFIG.roadMaterial} road material was not found in ${url}.`);
    if (MAP_CONFIG.treePlacement.enabled && !treeSurfaceMeshes.length) {
      console.warn(`[Map Warning] ${MAP_CONFIG.treeSurfaceMaterial} tree surface was not found in ${url}.`);
    }
    if (DEBUG_MAP) {
      for (const mesh of roadMeshes) {
        const overlay = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshBasicMaterial({
            color: 0xff2030,
            wireframe: true,
            transparent: true,
            opacity: 0.8,
            depthTest: false,
          })
        );
        overlay.renderOrder = 100;
        mesh.add(overlay);
      }
    }

    const fin = new THREE.Box3().setFromObject(wrap);
    mapBounds = fin.clone();
    const roadBounds = new THREE.Box3();
    for (const mesh of roadMeshes) roadBounds.expandByObject(mesh);
    mapRoadBounds = roadBounds.clone();
    mapRayTop = fin.max.y + 10;
    mapRayBottom = fin.min.y - 10;
    BOUND_X_MIN = fin.min.x - 5;
    BOUND_X_MAX = fin.max.x + 5;
    BOUND_Z = Math.max(Math.abs(fin.min.z), Math.abs(fin.max.z)) + 5;
    document.body.dataset.mapBoundsX = `${fin.min.x.toFixed(3)},${fin.max.x.toFixed(3)}`;
    document.body.dataset.mapBoundsZ = `${fin.min.z.toFixed(3)},${fin.max.z.toFixed(3)}`;
    document.body.dataset.mapRoadBoundsX = roadBounds.isEmpty()
      ? 'empty'
      : `${roadBounds.min.x.toFixed(3)},${roadBounds.max.x.toFixed(3)}`;
    document.body.dataset.mapRoadBoundsZ = roadBounds.isEmpty()
      ? 'empty'
      : `${roadBounds.min.z.toFixed(3)},${roadBounds.max.z.toFixed(3)}`;
    addVerticalMapLoopCopies(wrap, fin);
    addSequenceLoopPreviews(sequenceLayout);
    if (sequenceLayout) {
      mapSequenceSeamZs = sequenceLayout.placements.slice(0, -1)
        .map((segment) => (
          segment.endZ + sequenceLayout.overlapLocal * 0.5
        ) * MAP_CONFIG.scale + MAP_CONFIG.positionOffsetZ);
      mapSequenceLoopSeamZs = [
        sequenceLayout.sequenceEndZ * MAP_CONFIG.scale + MAP_CONFIG.positionOffsetZ,
        sequenceLayout.placements[0].startZ * MAP_CONFIG.scale
          + MAP_CONFIG.positionOffsetZ,
      ];
      document.body.dataset.mapSegmentCount = String(sequenceLayout.placements.length);
      document.body.dataset.mapSegmentFiles = sourceUrls.join(',');
      document.body.dataset.mapSegmentSpansZ = sequenceLayout.placements
        .map((segment) => segment.spanZ.toFixed(3))
        .join(',');
      document.body.dataset.mapSegmentAppliedScales = sequenceLayout.placements
        .map((segment) => (MAP_CONFIG.scale * segment.scaleZ).toFixed(12))
        .join(',');
      document.body.dataset.mapSegmentAppliedHeightScales = sequenceLayout.placements
        .map((segment) => (MAP_CONFIG.scale * segment.scaleY).toFixed(12))
        .join(',');
      document.body.dataset.mapSegmentAppliedXScales = sequenceLayout.placements
        .map((segment) => (MAP_CONFIG.scale * segment.scaleX).toFixed(12))
        .join(',');
      document.body.dataset.mapSegmentAppliedZScales = sequenceLayout.placements
        .map((segment) => (MAP_CONFIG.scale * segment.scaleZ).toFixed(12))
        .join(',');
      document.body.dataset.mapSequenceEndZ = (sequenceLayout.sequenceEndZ * MAP_CONFIG.scale
        + MAP_CONFIG.positionOffsetZ).toFixed(3);
      document.body.dataset.mapSequenceOverlapMeters =
        String(MAP_CONFIG.sequenceOverlapMeters ?? 0);
      document.body.dataset.mapSequenceSeamZs =
        mapSequenceSeamZs.map((value) => value.toFixed(3)).join(',');
      document.body.dataset.mapSequenceLoopSeamZs =
        mapSequenceLoopSeamZs.map((value) => value.toFixed(3)).join(',');
      document.body.dataset.mapSequenceCenterLineMaterials =
        sequenceLayout.centerLineMaterials
          .map((entry) => `${entry.file}:${entry.materials.join('+')}`)
          .join(',');
      if (MAP_CONFIG.sequenceSeamBridges === false) {
        document.body.dataset.mapForestSeamBridgeRenderMode =
          'disabled-exact-road-edge-connection';
        document.body.dataset.mapForestSeamBridgeMeshCount = '0';
      } else {
        buildForestSeamBridges();
      }
    }
    console.info('[Map Load]', {
      course: MAP_CONFIG.label,
      file: sourceUrls.length > 1 ? sourceUrls : url,
      scale: MAP_CONFIG.scale,
      origin: [0, 0, 0],
      originalBoundingBox: { min: originalBox.min.toArray(), max: originalBox.max.toArray() },
      scaledBoundingBox: { min: fin.min.toArray(), max: fin.max.toArray() },
      roadMeshCount: roadMeshes.length,
      treeSurfaceMeshCount: treeSurfaceMeshes.length,
      estimatedRoadWidth: '設定値は通常二車線幅 7〜8m を目標にした初期値',
    });
    return out;
  }

  function findMapSpawn() {
    const spawnHeading = MAP_CONFIG.spawnHeading + MAP_CONFIG.spawnHeadingOffset;
    const applySpawnXZOffsets = (baseX, baseZ, heading) => ({
      x: baseX + MAP_CONFIG.spawnOffsetX + Math.cos(heading) * MAP_CONFIG.spawnOffsetRight,
      z: baseZ + MAP_CONFIG.spawnOffsetZ - Math.sin(heading) * MAP_CONFIG.spawnOffsetRight,
    });
    if (!roadMeshes.length) {
      console.warn('[Map Spawn] No road surface found near map origin.');
      const fallbackPosition = applySpawnXZOffsets(0, 0, spawnHeading);
      return {
        x: fallbackPosition.x,
        y: MAP_CONFIG.positionOffsetY + MAP_CONFIG.spawnOffsetY,
        z: fallbackPosition.z,
        heading: spawnHeading,
        distance: null,
        fallback: true,
      };
    }
    const referenceX = MAP_CONFIG.spawnReference === 'minCorner' && mapBounds
      ? mapBounds.min.x
      : MAP_CONFIG.spawnReference === 'fixed' ? MAP_CONFIG.spawnReferenceX : 0;
    const referenceZ = MAP_CONFIG.spawnReference === 'minCorner' && mapBounds
      ? mapBounds.min.z
      : MAP_CONFIG.spawnReference === 'fixed' ? MAP_CONFIG.spawnReferenceZ : 0;
    if (MAP_CONFIG.spawnExactReference) {
      const exactPosition = applySpawnXZOffsets(referenceX, referenceZ, spawnHeading);
      const roadY = MAP_CONFIG.spawnSurfaceMode === 'topDrivable'
        ? getTopDrivableHeightAt(exactPosition.x, exactPosition.z)
        : MAP_CONFIG.spawnSurfaceMode === 'mapSurface'
          ? (getMapSurfacesAt(exactPosition.x, exactPosition.z)[0]?.point.y ?? null)
          : MAP_CONFIG.spawnSurfaceMode === 'roadSurface'
            ? getRoadHeightNear(exactPosition.x, exactPosition.z, MAP_CONFIG.positionOffsetY)
            : getRoadHeightAt(exactPosition.x, exactPosition.z);
      const surfaceY = roadY ?? groundHeightAt(exactPosition.x, mapRayTop, exactPosition.z);
      return {
        x: exactPosition.x,
        y: surfaceY + MAP_CONFIG.spawnOffsetY + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset,
        z: exactPosition.z,
        heading: spawnHeading,
        distance: 0,
        fallback: false,
      };
    }
    let nearest = null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const closestSegment = (start, end) => {
      const dx = end.x - start.x, dz = end.z - start.z;
      const t = clamp(((referenceX - start.x) * dx + (referenceZ - start.z) * dz)
        / (dx * dx + dz * dz || 1), 0, 1);
      return new THREE.Vector3(
        start.x + dx * t,
        start.y + (end.y - start.y) * t,
        start.z + dz * t
      );
    };
    const closestTriangle = (va, vb, vc) => {
      const v0x = vb.x - va.x, v0z = vb.z - va.z;
      const v1x = vc.x - va.x, v1z = vc.z - va.z;
      const v2x = referenceX - va.x, v2z = referenceZ - va.z;
      const d00 = v0x * v0x + v0z * v0z;
      const d01 = v0x * v1x + v0z * v1z;
      const d11 = v1x * v1x + v1z * v1z;
      const d20 = v2x * v0x + v2z * v0z;
      const d21 = v2x * v1x + v2z * v1z;
      const denominator = d00 * d11 - d01 * d01;
      if (Math.abs(denominator) > 1e-12) {
        const v = (d11 * d20 - d01 * d21) / denominator;
        const w = (d00 * d21 - d01 * d20) / denominator;
        const u = 1 - v - w;
        if (u >= 0 && v >= 0 && w >= 0) {
          return new THREE.Vector3(referenceX, va.y * u + vb.y * v + vc.y * w, referenceZ);
        }
      }
      return [
        closestSegment(va, vb),
        closestSegment(vb, vc),
        closestSegment(vc, va),
      ].sort((left, right) =>
        (left.x - referenceX) ** 2 + (left.z - referenceZ) ** 2
        - (right.x - referenceX) ** 2 - (right.z - referenceZ) ** 2)[0];
    };
    for (const mesh of roadMeshes) {
      mesh.updateWorldMatrix(true, false);
      const geometry = mesh.geometry;
      const position = geometry.attributes.position;
      const index = geometry.index;
      const count = index ? index.count / 3 : position.count / 3;
      const vertex = (triangle, corner) => index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner;
      for (let i = 0; i < count; i++) {
        a.fromBufferAttribute(position, vertex(i, 0)).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(position, vertex(i, 1)).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(position, vertex(i, 2)).applyMatrix4(mesh.matrixWorld);
        const surfaceNormal = new THREE.Vector3()
          .crossVectors(
            new THREE.Vector3().subVectors(b, a),
            new THREE.Vector3().subVectors(c, a)
          )
          .normalize();
        if (Math.abs(surfaceNormal.y) < 0.55) continue;
        const point = closestTriangle(a, b, c);
        const distance = Math.hypot(point.x - referenceX, point.z - referenceZ);
        if (!nearest || distance < nearest.distance) {
          nearest = { x: point.x, y: point.y, z: point.z, distance };
        }
      }
    }
    if (!nearest || nearest.distance > MAP_CONFIG.spawnSearchRadius) {
      console.warn('[Map Spawn] No road surface found near map origin.');
      const fallbackPosition = applySpawnXZOffsets(0, 0, spawnHeading);
      return {
        x: fallbackPosition.x,
        y: MAP_CONFIG.positionOffsetY + MAP_CONFIG.spawnOffsetY,
        z: fallbackPosition.z,
        heading: spawnHeading,
        distance: null,
        fallback: true,
      };
    }

    const nearby = [];
    const directionRadius = Math.min(8, Math.max(4, MAP_CONFIG.spawnSearchRadius * 0.4));
    for (let dz = -directionRadius; dz <= directionRadius; dz += 1.5) {
      for (let dx = -directionRadius; dx <= directionRadius; dx += 1.5) {
        if (dx * dx + dz * dz > directionRadius * directionRadius) continue;
        const y = getRoadHeightAt(nearest.x + dx, nearest.z + dz);
        if (y !== null && Math.abs(y - nearest.y) < 2.5) nearby.push({ x: dx, z: dz });
      }
    }
    let heading = MAP_CONFIG.spawnHeading;
    if (MAP_CONFIG.spawnDirectionMode === 'auto' && nearby.length >= 6) {
      const meanX = nearby.reduce((sum, point) => sum + point.x, 0) / nearby.length;
      const meanZ = nearby.reduce((sum, point) => sum + point.z, 0) / nearby.length;
      let xx = 0, zz = 0, xz = 0;
      for (const point of nearby) {
        const x = point.x - meanX, z = point.z - meanZ;
        xx += x * x; zz += z * z; xz += x * z;
      }
      const axisAngleFromX = 0.5 * Math.atan2(2 * xz, xx - zz);
      const directionX = Math.cos(axisAngleFromX);
      const directionZ = Math.sin(axisAngleFromX);
      heading = Math.atan2(directionX, directionZ);
    }
    // 原点からの最近点は道路の縁になりやすいため、推定接線に直交する方向を
    // 横断サンプリングし、同じ路面高が連続する区間の中央へ寄せる。
    const normalX = -Math.cos(heading);
    const normalZ = Math.sin(heading);
    const crossSection = [];
    for (let offset = -12; offset <= 12; offset += 0.5) {
      const y = getRoadHeightAt(nearest.x + normalX * offset, nearest.z + normalZ * offset);
      crossSection.push({ offset, road: y !== null && Math.abs(y - nearest.y) < 2.5 });
    }
    const zeroIndex = crossSection.findIndex((sample) => Math.abs(sample.offset) < 0.01);
    let left = zeroIndex, right = zeroIndex;
    while (left > 0 && crossSection[left - 1].road) left--;
    while (right + 1 < crossSection.length && crossSection[right + 1].road) right++;
    if (zeroIndex >= 0 && crossSection[zeroIndex].road && right > left) {
      const centerOffset = (crossSection[left].offset + crossSection[right].offset) / 2;
      nearest.x += normalX * centerOffset;
      nearest.z += normalZ * centerOffset;
    }
    const finalHeading = heading + MAP_CONFIG.spawnHeadingOffset;
    const finalPosition = applySpawnXZOffsets(nearest.x, nearest.z, finalHeading);
    const finalX = finalPosition.x;
    const finalZ = finalPosition.z;
    const finalRoadY = MAP_CONFIG.spawnSurfaceMode === 'topDrivable'
      ? getTopDrivableHeightAt(finalX, finalZ)
      : MAP_CONFIG.spawnSurfaceMode === 'mapSurface'
        ? (getMapSurfacesAt(finalX, finalZ)[0]?.point.y ?? null)
        : MAP_CONFIG.spawnSurfaceMode === 'roadSurface'
          ? getRoadHeightNear(finalX, finalZ, nearest.y)
          : getRoadHeightAt(finalX, finalZ);
    if (finalRoadY === null) console.warn('[Map Spawn] Road height could not be found at adjusted spawn position.');
    const vehicleOffset = CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset;
    return {
      x: finalX,
      y: (finalRoadY ?? nearest.y) + MAP_CONFIG.spawnOffsetY + vehicleOffset,
      z: finalZ,
      heading: finalHeading,
      distance: nearest.distance,
      fallback: false,
    };
  }

  function addMapDebugVisuals(spawn) {
    if (!DEBUG_MAP) return;
    const origin = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x00ffff, depthTest: false })
    );
    origin.position.set(0, MAP_CONFIG.positionOffsetY + 0.7, 0);
    scene.add(origin);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff3030, depthTest: false })
    );
    marker.position.set(spawn.x, spawn.y + 0.85, spawn.z);
    scene.add(marker);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([origin.position, marker.position]),
      new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false })
    );
    scene.add(line);
    const direction = new THREE.Vector3(Math.sin(spawn.heading), 0, Math.cos(spawn.heading));
    scene.add(new THREE.ArrowHelper(direction, marker.position, 8, 0xff00ff, 2, 1));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        MAP_CONFIG.treePlacement.spawnExclusionRadius - 0.08,
        MAP_CONFIG.treePlacement.spawnExclusionRadius + 0.08,
        64
      ),
      new THREE.MeshBasicMaterial({ color: 0xffaa00, side: THREE.DoubleSide, depthTest: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(spawn.x, spawn.y + 0.05, spawn.z);
    scene.add(ring);
  }

  async function init() {
    const [playerCarMesh, tree1, tree2] = await Promise.all([
      VOX.load(PLAYER_CAR_VOX, { scale: VOXEL_SCALE }),
      VOX.load('vox/object/tree01.vox', { scale: TREE_SCALE }),
      VOX.load('vox/object/tree02.vox', { scale: TREE_SCALE }),
    ]);
    // 森林地帯はCPU車なし。ファイル探索・VOX読込自体も省いて初期表示を軽くする。
    const discoveredCpuVox = COURSE_KEY === 'forest'
      ? []
      : await discoverCpuCarVox();
    // 首都高速と海岸線は速度が車種ランク基準なので、cpu_car_list.txt の車種を
    // ひととおり読み込む（4車種だけだとランクが偏る）。
    const cpuVoxLimit = (CAR2_MODE || COURSE_KEY === 'sea' || COURSE_KEY === 'indy')
      ? CPU_VOX_LIMIT
      : 4;
    const cpuCars = COURSE_KEY === 'forest'
      ? []
      : await loadCpuCars(discoveredCpuVox.slice(0, cpuVoxLimit));
    const cpuMeshes = cpuCars.map((car) => car.mesh);

    playerCarMesh.updateMatrixWorld(true);
    const playerCarSize = new THREE.Box3()
      .setFromObject(playerCarMesh)
      .getSize(new THREE.Vector3());
    if (Number.isFinite(playerCarSize.y) && playerCarSize.y > 0.1) {
      playerVehicleHeight = playerCarSize.y;
      playerClimbHeight = playerVehicleHeight * 0.25;
    }
    document.body.dataset.playerVehicleHeight = playerVehicleHeight.toFixed(3);
    document.body.dataset.playerClimbHeight = playerClimbHeight.toFixed(3);

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
        playerNightMesh.visible = vehicleLightsShouldBeVisible();
        player.tilt.add(playerNightMesh);
        playerDayMesh = playerCarMesh;
        playerDayMesh.visible = !vehicleLightsShouldBeVisible();
      } catch (error) {
        console.warn('toyota86n.vox を読み込めなかったため、夜間も昼の車を使います。', error);
      }
    } else if (PLAYER_CAR_KEY === 'volvo240') {
      // Volvo は同じモデルのまま、フロントの白いライトパネルを夜に発光させる。
      // 小さな光球スプライト(ヘッド側)は使わない。
      playerNightMesh = buildPlayerNightMesh(playerCarMesh, isVolvoLampFace, 0xfff6d8);
      playerNightMesh.rotation.y = MODEL_YAW;
      playerNightMesh.position.y = -CAR_SINK;
      playerNightMesh.visible = vehicleLightsShouldBeVisible();
      player.tilt.add(playerNightMesh);
      playerDayMesh = playerCarMesh;
      playerDayMesh.visible = !vehicleLightsShouldBeVisible();
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
    playerHeadlight.visible = vehicleLightsShouldBeVisible();
    playerHeadlight.target.position.set(0, 0, 8);
    player.tilt.add(playerHeadlight);
    player.tilt.add(playerHeadlight.target);

    if (MAP_GLTF) {
      const info = await loadGltfMap(MAP_GLTF);
      // 130〜480mの常時フォグが地図全体を空色へ混ぜ、元色より白く見せていた。
      // 読み込み式の4マップでは無効化し、遠景までマテリアル本来の色を保つ。
      scene.fog = null;
      document.body.dataset.mapFog = 'none';
      mapSpawn = findMapSpawn();
      if (DEBUG_MAP) {
        topView = true;
        scene.fog = null;
      }
      player.pos.set(mapSpawn.x, mapSpawn.y, mapSpawn.z);
      player.heading = mapSpawn.heading;
      const debugSpeedKmh = DEBUG_MAP ? Number(pageQuery.get('debugSpeedKmh')) : 0;
      if (Number.isFinite(debugSpeedKmh) && debugSpeedKmh > 0) {
        const debugSpeed = Math.min(debugSpeedKmh / 3.6, PLAYER_TOP_SPEED);
        player.gear = GEARS.length - 1;
        player.vel.set(
          Math.sin(player.heading) * debugSpeed,
          0,
          Math.cos(player.heading) * debugSpeed
        );
        document.body.dataset.debugInitialSpeedKmh = (debugSpeed * 3.6).toFixed(1);
      }
      if (DEBUG_MAP && COURSE_KEY === 'sea' && pageQuery.get('debugSeaSideCross') === '1') {
        const crossSpeed = 12;
        player.heading = -Math.PI / 2;
        player.vel.set(-crossSpeed, 0, 0);
        player.gear = GEARS.length - 1;
        seaSideCrossDebug = {
          startX: player.pos.x,
          targetX: player.pos.x - 8,
        };
        document.body.dataset.debugSeaSideCross = 'running';
      }
      if (DEBUG_MAP && COURSE_KEY === 'sea' && pageQuery.get('debugSeaGrassClimb') === '1') {
        const startX = 54;
        const targetX = 65;
        // 区間端や三角形の稜線上を避け、低い砂浜面を実測して再現地点を決める。
        let climbStart = null;
        for (const insetZ of [20, 50, 100, 200]) {
          const startZ = mapBounds.max.z - insetZ;
          const lowSurface = getMapSurfacesAt(startX, startZ)
            .find((surface) => surface.point.y < -1);
          if (lowSurface) {
            climbStart = { startZ, surface: lowSurface };
            break;
          }
        }
        if (climbStart) {
          player.pos.set(
            startX,
            climbStart.surface.point.y + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012,
            climbStart.startZ
          );
          player.heading = Math.PI / 2;
          player.vel.set(12, 0, 0);
          player.gear = GEARS.length - 1;
          seaGrassClimbDebug = {
            startX,
            startY: player.pos.y,
            targetX,
          };
          document.body.dataset.debugSeaGrassClimb = 'running';
          document.body.dataset.debugSeaGrassClimbStartY = player.pos.y.toFixed(3);
          document.body.dataset.debugSeaGrassClimbStartZ = player.pos.z.toFixed(3);
        } else {
          document.body.dataset.debugSeaGrassClimb = 'low-surface-not-found';
        }
      }
      if (DEBUG_MAP && COURSE_KEY === 'sea' && pageQuery.get('debugSeaRoadGrass') === '1') {
        const startX = 68;
        const targetX = 54;
        const startZ = mapBounds.max.z - 50;
        const startSurface = getMapSurfaceAt(startX, startZ, mapSpawn.y, true);
        if (startSurface) {
          player.pos.set(
            startX,
            startSurface.point.y + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012,
            startZ
          );
          player.heading = -Math.PI / 2;
          player.vel.set(-8, 0, 0);
          player.gear = GEARS.length - 1;
          seaRoadGrassDebug = {
            phase: 'outbound',
            startX,
            targetX,
            startY: player.pos.y,
            lastY: player.pos.y,
            minY: player.pos.y,
            maxY: player.pos.y,
            maxYStep: 0,
            maxTiltDeg: 0,
          };
          document.body.dataset.debugSeaRoadGrass = 'outbound';
        } else {
          document.body.dataset.debugSeaRoadGrass = 'start-surface-not-found';
        }
      }
      if (DEBUG_MAP && COURSE_KEY === 'indy' && pageQuery.get('debugIndyBankCross') === '1') {
        const crossSection = findIndyBankCrossSection();
        if (crossSection) {
          const directionX = Math.sign(crossSection.target.x - crossSection.start.x);
          player.pos.set(
            crossSection.start.x,
            crossSection.start.y + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012,
            crossSection.start.z
          );
          const travelHeading = directionX > 0 ? Math.PI / 2 : -Math.PI / 2;
          player.heading = travelHeading + directionX * 0.45;
          player.vel.set(directionX * 10, 0, 0);
          player.drifting = true;
          player.gear = GEARS.length - 1;
          indyBankCrossDebug = {
            phase: 'climb',
            start: crossSection.start,
            target: crossSection.target,
            directionX,
            startWallHits: mapWallCollisionCount,
            minY: player.pos.y,
            maxY: player.pos.y,
            minSpeed: player.vel.length(),
            maxTiltDeg: 0,
            frames: 0,
            driftFrames: 0,
          };
          document.body.dataset.debugIndyBankCross = 'climb';
          document.body.dataset.debugIndyBankCrossRise =
            crossSection.rise.toFixed(3);
        } else {
          document.body.dataset.debugIndyBankCross = 'section-not-found';
        }
      }
      gameSpawn = { ...mapSpawn };
      car2LastRoadPos.copy(player.pos);
      setupMapLoopPortal();
      // 森林区間の接合を通常カメラで目視するための開発用開始位置。
      const debugForestSeamIndex = Number(pageQuery.get('debugForestSeam'));
      if (
        COURSE_KEY === 'forest'
        && pageQuery.has('debugForestSeam')
        && Number.isInteger(debugForestSeamIndex)
        && mapSequenceSeamZs.length
      ) {
        const seamIndex = clamp(debugForestSeamIndex, 0, mapSequenceSeamZs.length - 1);
        const seamZ = mapSequenceSeamZs[seamIndex];
        const seamStartZ = seamZ + 3;
        const seamRoadY = getRoadHeightAt(mapSpawn.x, seamStartZ);
        player.pos.set(
          mapSpawn.x,
          (seamRoadY ?? mapSpawn.y) + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset,
          seamStartZ
        );
        player.heading = Math.PI;
        const seamSpeedKmh = Number(pageQuery.get('debugForestSeamSpeedKmh'));
        const seamSpeed = Number.isFinite(seamSpeedKmh) && seamSpeedKmh > 0
          ? Math.min(seamSpeedKmh / 3.6, PLAYER_TOP_SPEED)
          : 0;
        player.vel.set(0, 0, -seamSpeed);
        if (seamSpeed > 0) player.gear = GEARS.length - 1;
        car2LastRoadPos.copy(player.pos);
        document.body.dataset.debugForestSeam = String(seamIndex);
        document.body.dataset.debugForestSeamZ = seamZ.toFixed(3);
        document.body.dataset.debugForestSeamSpeedKmh = (seamSpeed * 3.6).toFixed(1);
      }
      // 03終端→01先頭のループ接続を、通常の追従カメラで目視・実走確認する。
      if (
        COURSE_KEY === 'forest'
        && pageQuery.get('debugForestLoopSeam') === '1'
        && mapLoopPortal
      ) {
        const loopStartZ = mapLoopPortal.minZ + 3;
        const loopRoadY = getRoadHeightAt(mapSpawn.x, loopStartZ);
        player.pos.set(
          mapSpawn.x,
          (loopRoadY ?? mapSpawn.y) + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset,
          loopStartZ
        );
        player.heading = Math.PI;
        const loopSpeedKmh = Number(pageQuery.get('debugForestSeamSpeedKmh'));
        const loopSpeed = Number.isFinite(loopSpeedKmh) && loopSpeedKmh > 0
          ? Math.min(loopSpeedKmh / 3.6, PLAYER_TOP_SPEED)
          : 0;
        player.vel.set(0, 0, -loopSpeed);
        if (loopSpeed > 0) player.gear = GEARS.length - 1;
        car2LastRoadPos.copy(player.pos);
        document.body.dataset.debugForestLoopSeam = 'true';
        document.body.dataset.debugForestLoopSeamZ =
          mapLoopPortal.minZ.toFixed(3);
      }
      // 連結コースの終端ループを短時間で再現する開発用開始位置。
      // 通常プレイではURL指定がないため一切作動しない。
      if (DEBUG_MAP && pageQuery.get('debugNearSequenceEnd') === '1' && mapLoopPortal) {
        player.pos.z = mapLoopPortal.minZ + 0.1;
        const endRoadY = getRoadHeightAt(player.pos.x, player.pos.z);
        if (endRoadY !== null) {
          player.pos.y = endRoadY + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset;
        }
        car2LastRoadPos.copy(player.pos);
        document.body.dataset.debugNearSequenceEnd = 'true';
      }
      let indyBankedRoute = [];
      if (CAR2_MODE) {
        // 以前の首都高版と同じ固定ルートを、自動運転・実走検証にも使う。
        car2AutoRoute = CAR2_CPU_ROUTE.map(([x, z]) => ({ x, z }));
        document.body.dataset.car2AutoRoutePoints = String(car2AutoRoute.length);
        const loopSpan = mapBounds.max.z - mapBounds.min.z;
        buildCar2StreetLights(loopSpan);
      }
      if (COURSE_KEY === 'indy') {
        buildIndyOuterWallStreetLights();
        indyBankedRoute = buildIndyBankedRoute();
        car2AutoRoute = indyBankedRoute;
        document.body.dataset.autoDriveRoutePoints = String(car2AutoRoute.length);
      }
      addMapDebugVisuals(mapSpawn);
      placeTreesOnSurface(tree1, MAP_CONFIG.treePlacement, mulberry32(MAP_CONFIG.treePlacement.seed));
      document.body.dataset.course = COURSE_KEY;
      document.body.dataset.mapFile = MAP_CONFIG.segmentFiles?.length
        ? MAP_CONFIG.segmentFiles.join(',')
        : MAP_GLTF;
      document.body.dataset.mapScale = String(MAP_CONFIG.scale);
      document.body.dataset.mapRoadMeshCount = String(roadMeshes.length);
      document.body.dataset.mapTreeSurfaceMeshCount = String(treeSurfaceMeshes.length);
      document.body.dataset.mapSpawnX = player.pos.x.toFixed(4);
      document.body.dataset.mapSpawnY = player.pos.y.toFixed(4);
      document.body.dataset.mapSpawnZ = player.pos.z.toFixed(4);
      document.body.dataset.mapSpawnHeading = player.heading.toFixed(6);
      document.body.dataset.mapSpawnRoadDistance = mapSpawn.distance === null ? 'fallback' : mapSpawn.distance.toFixed(4);
      if (DEBUG_MAP) {
        document.body.dataset.mapSpawnSurfaceYs = getMapSurfacesAt(player.pos.x, player.pos.z)
          .map((hit) => hit.point.y.toFixed(4))
          .join(',');
      }
      document.body.dataset.mapTreesPlaced = String(mapDebugStats.treesPlaced);
      if (COURSE_KEY === 'sea') {
        document.body.dataset.mapSeaGapPassPolicy =
          'pass-except-h07-and-x-edge';
      }
      const meshPool = cpuMeshes.length
        ? Array.from({ length: 4 }, (_, i) => cpuMeshes[i % cpuMeshes.length].clone())
        : [];
      Object.keys(info.loops).slice(0, 4).forEach((name, i) => {
        if (CAR2_MODE || COURSE_KEY === 'indy' || COURSE_KEY === 'sea' || COURSE_KEY === 'forest') return;
        const wps = info.loops[name].sort((a, b) => a.i - b.i).map((waypoint) => ({
          x: waypoint.p.x,
          z: waypoint.p.z,
        }));
        if (wps.length < 2 || !meshPool[i]) return;
        const group = makeCarGroup(meshPool[i]);
        aiCars.push({
          group: group.group,
          tilt: group.tilt,
          pos: new THREE.Vector3(wps[0].x, groundHeightAt(wps[0].x, 500, wps[0].z), wps[0].z),
          heading: Math.atan2(wps[1].x - wps[0].x, wps[1].z - wps[0].z),
          v: 0,
          base: 9 + i * 1.5,
          wps,
          idx: 1,
          radius: carRadiusFor(false, group.group),
        });
      });
      if (CAR2_MODE) {
        // 首都高速CPUの基準は中心線。直線ではランクごとのレーンへ寄り、
        // ユーザー車の走る中央は空けておく（カーブでは全員が中心線へ戻る）。
        const tokyoCpuRoute = buildCar2CpuRoute();
        spawnCar2LoopCpuCars(tokyoCpuRoute, cpuCars.slice(0, CAR2_CPU_TRAFFIC_MAX));
        document.body.dataset.tokyoCpuCars = String(aiCars.length);
        document.body.dataset.tokyoCpuLaneSpacingMeters = String(CAR2_LANE_SPACING);
        document.body.dataset.tokyoCpuStraightPoints = String(
          tokyoCpuRoute.filter((point) => point.straightness > 0.5).length
        );
        document.body.dataset.tokyoCpuSharpTurnPoints = String(
          tokyoCpuRoute.filter((point) => Math.abs(point.turn) > CAR2_CPU_DRIFT_TURN).length
        );
      } else if (COURSE_KEY === 'sea') {
        const seaRoadCenterline = buildSequenceRoadCenterline();
        spawnSequenceTrafficCpuCars(seaRoadCenterline, cpuCars);
        car2AutoRoute = offsetSequenceLane(seaRoadCenterline);
        document.body.dataset.autoDriveRoutePoints = String(car2AutoRoute.length);
      } else if (COURSE_KEY === 'forest') {
        // Wood_Chips_01_1K路面全体を2m間隔で輪切りにし、
        // 曲線と03・04のアップダウンを保った道路中央ルートを作る。
        car2AutoRoute = buildSequenceRoadCenterline(2);
        document.body.dataset.autoDriveRoutePoints = String(car2AutoRoute.length);
        document.body.dataset.forestAutoDriveRoadMaterial = MAP_CONFIG.roadMaterial;
      } else if (COURSE_KEY === 'indy') {
        // デモ／自動運転では先に自車を実際のバンクルートへ合わせる。
        // その位置を基準にCPUを前方配置し、画面切替直後の重なりを防ぐ。
        if (
          DEMO_SEQUENCE_ACTIVE
          || (DEBUG_MAP && pageQuery.get('debugAutoDrive') === '1')
        ) {
          snapPlayerToIndyAutoRoute();
        }
        // ユーザー車の基準線はバンク外側34%。CPUはそこから内側へ寄せて
        // バンク中央を基本ラインにし、抜くときだけ外/内のラインへ出る。
        const indyCpuRoute = buildIndyCpuLane(indyBankedRoute, INDY_CPU_CENTER_OFFSET);
        spawnIndyCpuCars(indyCpuRoute, cpuCars);
        document.body.dataset.indyCpuLaneOffsetMeters = String(INDY_CPU_CENTER_OFFSET);
        document.body.dataset.indyCpuLane = 'bank-center';
        document.body.dataset.indyCpuLaneSpacingMeters = String(INDY_LANE_SPACING);
      }
      if (COURSE_KEY === 'forest') {
        document.body.dataset.forestCpuCars = '0';
      }
      document.body.dataset.autoDriveAvailable =
        String(Boolean(car2AutoRoute?.length >= 2));
      document.body.dataset.autoDriveMode =
        MAP_CONFIG.autoDriveMode ?? (CAR2_MODE ? 'tokyoCruise130' : 'none');
      document.body.dataset.carLightsFollowTilt = 'true';
      if (COURSE_KEY === 'indy') {
        document.body.dataset.indyCpuLightsFollowBank = 'true';
      }
      // 通常操作には影響しない、Y/Nモードの実走確認用URL指定。
      if (DEBUG_MAP && pageQuery.get('debugAutoDrive') === '1' && car2AutoRoute?.length >= 2) {
        autoDrive = true;
        autoIdx = -1;
        if (MAP_CONFIG.autoDriveMode === 'indyBankDrift') {
          snapPlayerToIndyAutoRoute();
        }
        document.body.dataset.autoDrive = 'true';
      }
      if (DEBUG_MAP && pageQuery.get('debugNight') === '1' && !nightMode) {
        nightMode = true;
      }
      // 初期の照明を確定させる。horizonの明度が最初から50%未満なら
      // この時点で地表も暗い状態から始まる。
      applyNight();
      console.info('[Map Spawn]', {
        course: MAP_CONFIG.label,
        file: MAP_GLTF,
        origin: [0, 0, 0],
        nearestRoadDistance: mapSpawn.distance,
        playerPosition: player.pos.toArray(),
        headingRadians: player.heading,
        roadHeight: getRoadHeightAt(player.pos.x, player.pos.z),
        roadMeshes: roadMeshes.map((mesh) => mesh.name || '(merged)'),
        treeSurfaceMeshes: treeSurfaceMeshes.map((mesh) => mesh.name || '(merged)'),
        ...mapDebugStats,
      });
      initFx();

      if (DEMO_SEQUENCE_ACTIVE && car2AutoRoute?.length >= 2) {
        enterDemoSequence();
      } else {
        demoActive = false;
        document.body.classList.remove('demo');
      }

      document.getElementById('loading').remove();
      window.__voxDrive = {
        player, aiCars, start: () => startGame(), inDemo: () => demoActive,
        soundState: () => ({
          mode: soundMode, interior: interiorCurrent,
          interiorUrl: AUDIO.interiorPlaying(),
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
      document.body.dataset.playerTopSpeedKmh = String(PLAYER_TOP_SPEED_KMH);
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
        wps, idx: (s + 1) % wps.length, radius: carRadiusFor(bike, g.group),
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
    document.body.dataset.playerTopSpeedKmh = String(PLAYER_TOP_SPEED_KMH);
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

  // -------------------------------------------- four-course attract demo --
  function postDemoShellMessage(type) {
    if (window.parent === window) return false;
    const targetOrigin = location.origin === 'null' ? '*' : location.origin;
    window.parent.postMessage({ type }, targetOrigin);
    return true;
  }

  // スマホは操作があるまで音付き再生が許可されず、デモは放置から始まるので
  // そのままでは曲が鳴らない。デモ中の操作を外枠(デモシェル)へ伝えて音を出す。
  function notifyDemoUserGesture() {
    if (!DEMO_SEQUENCE_ACTIVE) return;
    postDemoShellMessage('vox-demo-user-gesture');
  }
  window.addEventListener('pointerdown', notifyDemoUserGesture, { capture: true });
  window.addEventListener('touchstart', notifyDemoUserGesture, { capture: true, passive: true });
  window.addEventListener('keydown', notifyDemoUserGesture, { capture: true });

  function requestDemoBackgroundMusic() {
    if (postDemoShellMessage('vox-demo-bgm-start')) return;
    // demoShellを経由しないデバッグURLでも、指定曲の再生を試みる。
    if (document.getElementById('demo-sequence-bgm')) return;
    const frame = document.createElement('iframe');
    frame.id = 'demo-sequence-bgm';
    frame.title = 'Demo background music';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.style.cssText =
      'position:fixed;width:400px;height:300px;left:-400px;top:-400px;border:0;pointer-events:none;';
    // AO3uZdHDpNQは所有者が外部埋め込みを禁止しているため、
    // 同じ曲の埋め込み可能版をデバッグ直アクセス時にも使う。
    frame.src =
      'https://www.youtube.com/embed/N9JN4aqMduo'
      + '?autoplay=1&loop=1&playlist=N9JN4aqMduo&controls=0&playsinline=1&enablejsapi=1'
      + `&origin=${encodeURIComponent(location.origin)}`;
    document.body.appendChild(frame);
    document.body.dataset.demoBgmVolume = '80';
    const applyVolume = () => {
      const target = frame.contentWindow;
      if (!target) return;
      target.postMessage(JSON.stringify({
        event: 'command',
        func: 'setVolume',
        args: [80],
      }), 'https://www.youtube.com');
      target.postMessage(JSON.stringify({
        event: 'command',
        func: 'playVideo',
        args: [],
      }), 'https://www.youtube.com');
    };
    frame.addEventListener('load', () => {
      setTimeout(applyVolume, 300);
      setTimeout(applyVolume, 1200);
      setTimeout(applyVolume, 3000);
    }, { once: true });
  }

  // ------------------------------------------- demo track (BGM) driven mode --
  // デモは曲ごとに見せ方が変わる。曲の切替は親シェルが管理し、ここへ通知が来る。
  //   'sea-sunset' : 海岸線だけを走り、指定の空とカメラ切替にする
  //   'sunset'     : sea-sunsetと同じ空。コース遷移は通常どおり
  //   'night'      : コースは通常どおりで、空は常に夜(Nモード)
  //   'rain'       : コースは通常どおりで、走行中は雨を降らせる
  // 親シェルから曲情報が届かない場合（?demoTrack= での確認や、親なしの直接起動）
  // に備えて、曲順と見せ方の対応はゲーム側にも持っておく。
  const DEMO_TRACK_LABELS = [
    'Jerry Wallace,Lovers Of The World',
    'Eagles,Take it Easy',
    'Elton John,Understanding Women',
    '井上陽水,今夜、私に',
    'Snoop Dogg,Smoke Weed Everyday',
    '稲垣潤一,ドラマティック・レイン',
    "Billy Joel,The Stranger",
    'Jevetta Steele,Calling You',
    "Bee Gees,Stayin' Alive",
    '薬師丸ひろ子,ステキな恋の忘れ方',
  ];
  const DEMO_TRACK_MODES = [
    'normal', 'normal', 'sea-sunset', 'night',
    'normal', 'rain', 'normal', 'sunset', 'normal', 'normal',
  ];
  const requestedDemoTrack = Number.parseInt(pageQuery.get('demoTrack') || '', 10);
  const DEMO_TRACK_INDEX = Number.isInteger(requestedDemoTrack)
    && requestedDemoTrack >= 0
    && requestedDemoTrack < DEMO_TRACK_MODES.length
      ? requestedDemoTrack
      : 0;
  let demoTrackMode = DEMO_TRACK_MODES[DEMO_TRACK_INDEX];
  let demoTrackLabelTimer = 0;
  let demoTrackCameraAt = 0;
  const DEMO_TRACK_CAMERA_INTERVAL_MS = 20000;
  const DEMO_TRACK_LABEL_DELAY_MS = 3000;   // 再生開始から曲名を出すまで
  // 曲1だけはデモ突入から数える。BGMはデモ突入の7秒後に鳴り始めるので、
  // 「再生開始から3秒」だと音が鳴る前に曲名が出てしまう。
  const DEMO_TRACK1_LABEL_AT_MS = 12000;
  // 曲3の空。パネルの各メーター%をそのままHSLへ直した値。
  const DEMO_SUNSET_HORIZON = { h: 0.10, s: 1.00, meter: 0.20 };
  const DEMO_SUNSET_SKY = { h: 0.95, s: 0.95, meter: 0.35 };
  // 雨の曲の明るさ。上空・地平線ともパネルの明暗メーター25%相当。
  const DEMO_RAIN_BRIGHTNESS = 0.25;

  // 曲3と同じ夕景の空にする。明暗メーターの%(0〜1)は
  // HSLのlの0.10〜0.98へ割り当てられている。
  function applyDemoSunsetSky() {
    weatherHorizonHsl.h = DEMO_SUNSET_HORIZON.h;
    weatherHorizonHsl.s = DEMO_SUNSET_HORIZON.s;
    weatherHorizonHsl.l = 0.1 + DEMO_SUNSET_HORIZON.meter * 0.88;
    weatherTopHsl.h = DEMO_SUNSET_SKY.h;
    weatherTopHsl.s = DEMO_SUNSET_SKY.s;
    weatherTopHsl.l = 0.1 + DEMO_SUNSET_SKY.meter * 0.88;
  }

  function applyDemoTrackMode() {
    if (!DEMO_SEQUENCE_ACTIVE) return;
    document.body.dataset.demoTrackMode = demoTrackMode;
    const raining = demoTrackMode === 'rain';
    // 雨の曲だけ雨雲と雨を出し、それ以外の曲では必ず晴れへ戻す。
    weatherRain = raining;
    weatherCloudMode = raining ? 1 : 0;
    if (demoTrackMode === 'sea-sunset' || demoTrackMode === 'sunset') {
      applyDemoSunsetSky();
    } else if (raining) {
      // 上空・地平線とも明暗メーター25%まで落とし、雨雲の下の暗さにする。
      // 色相と彩度は触らないので、デモ中のランダムな色変えはそのまま効く。
      weatherTopHsl.l = 0.1 + DEMO_RAIN_BRIGHTNESS * 0.88;
      weatherHorizonHsl.l = 0.1 + DEMO_RAIN_BRIGHTNESS * 0.88;
    } else {
      // 夕景や雨で落とした明るさを既定へ戻す。
      weatherTopHsl.l = WEATHER_DEFAULT_TOP_L;
      weatherHorizonHsl.l = WEATHER_DEFAULT_HORIZON_L;
    }
    if (demoTrackMode === 'night') nightMode = true;
    else if (nightMode) nightMode = false;
    // 空の反映と、それに合わせた地表の明るさをまとめてやり直す。
    applyNight();
    refreshWeatherControls();
    if (demoTrackMode === 'sea-sunset') demoTrackCameraAt = performance.now();
  }

  function setDemoTrack(data) {
    const index = Number.isInteger(data.index) ? data.index : 0;
    const nextMode = data.mode || DEMO_TRACK_MODES[index] || 'normal';
    demoTrackMode = nextMode;
    document.body.dataset.demoTrackIndex = String(index);
    // 冪等なので毎回適用する。初期モードと一致する場合に飛ばすと、
    // ?demoTrack= 起動や曲を引き継いだ再読込みで空設定が入らない。
    applyDemoTrackMode();
    clearTimeout(demoTrackLabelTimer);
    const label = data.label || DEMO_TRACK_LABELS[index] || '';
    // デモシェルの中で動いている時、曲名はシェル側が出す。コース切替のたびに
    // このページは読み込み直されるので、ここで出すと切替のあいだ曲名が消える。
    if (DEMO_EMBEDDED) {
      document.body.dataset.demoTrackLabel = label;
    } else {
      // 単独起動(?demo=1 や ?demoTrack= での確認)では従来どおりここで出す。
      // 曲名は「再生開始の3秒後」に、通常の再生中表示と同じ見た目で出す。
      const show = () => {
        if (!demoActive) return;
        setNowPlaying(label);      // 通常の再生中表示と同じ「♪ 曲名」になる
        document.body.dataset.demoTrackLabel = label;
      };
      // このデモの開始曲はデモ突入から12秒後(音が鳴ってから)に出す。
      let delayMs = data.labelDelayMs > 0 ? data.labelDelayMs : 0;
      if (index === DEMO_TRACK_INDEX && delayMs > 0) {
        delayMs = Math.max(
          0, DEMO_TRACK1_LABEL_AT_MS - (performance.now() - demoSequenceStartedAt)
        );
      }
      if (delayMs > 0) demoTrackLabelTimer = setTimeout(show, delayMs);
      else show();
    }
    // 曲3は海岸線だけを走る。別コースにいるなら海岸線へ移す。
    if (demoTrackMode === 'sea-sunset' && COURSE_KEY !== 'sea') {
      jumpDemoToCourse('sea');
    }
  }

  function currentDemoTrackIndex() {
    const shown = Number.parseInt(document.body.dataset.demoTrackIndex || '', 10);
    return Number.isInteger(shown) ? shown : DEMO_TRACK_INDEX;
  }

  function jumpDemoToCourse(course) {
    if (demoSequenceLeaving) return;
    demoSequenceLeaving = true;
    const nextQuery = new URLSearchParams();
    nextQuery.set('car', PLAYER_CAR_KEY);
    nextQuery.set('course', course);
    nextQuery.set('demo', '1');
    nextQuery.set('demoStage', String(Math.max(0, DEMO_SEQUENCE.indexOf(course))));
    nextQuery.set('demoTrack', String(currentDemoTrackIndex()));
    if (DEMO_EMBEDDED) nextQuery.set('demoEmbedded', '1');
    if (DEBUG_MAP) nextQuery.set('debugMap', '1');
    location.replace(`${location.pathname}?${nextQuery}`);
  }

  window.addEventListener('message', (event) => {
    if (!DEMO_SEQUENCE_ACTIVE || event.source !== window.parent) return;
    if (event.data?.type === 'vox-demo-track') setDemoTrack(event.data);
  });

  function exitDemoSequenceToTitle() {
    if (!demoActive || demoSequenceLeaving) return;
    demoSequenceLeaving = true;
    document.body.dataset.demoSequenceLeaving = 'true';
    if (postDemoShellMessage('vox-demo-exit')) return;
    location.href = location.pathname;
  }

  function randomizeSeaDemoSky() {
    // 明るさはユーザー設定を維持し、指定どおり上空/地平線それぞれの
    // sea-sunset・sunsetは指定の空を見せるので、ランダム変更はしない。
    if (demoTrackMode === 'sea-sunset' || demoTrackMode === 'sunset') return;
    // 色調と彩度だけを独立してランダム変更する。
    weatherTopHsl.h = Math.random();
    weatherTopHsl.s = 0.38 + Math.random() * 0.57;
    weatherHorizonHsl.h = Math.random();
    weatherHorizonHsl.s = 0.30 + Math.random() * 0.65;
    applyWeatherSky();
    document.body.dataset.demoWeatherChanges = String(demoSequenceWeatherCount);
  }

  function enterDemoSequence() {
    if (!DEMO_SEQUENCE_ACTIVE || !car2AutoRoute || car2AutoRoute.length < 2) return false;
    demoSequenceStartedAt = performance.now();
    demoSequenceActionCount = 0;
    demoSequenceWeatherCount = 0;
    demoSequenceLeaving = false;
    autoIdx = -1;
    autoDrive = false;
    bonnetView = 0;
    cam.yaw = 0;
    cam.pitch = 0.34;
    cam.dist = 11;
    cam.lastDrag = 0;
    if (nightMode) {
      nightMode = false;
      applyNight();
    }
    if (MAP_CONFIG.autoDriveMode === 'indyBankDrift') snapPlayerToIndyAutoRoute();
    const hint = document.querySelector('#demo .hint');
    if (hint) {
      hint.textContent = IS_MOBILE
        ? 'スワイプでカメラ / タップで視点切替'
        : '何かボタンでタイトルへ / ドラッグでカメラ';
    }
    enterDemo(car2AutoRoute);
    document.body.dataset.demoSequence = 'true';
    document.body.dataset.demoSequenceStage = String(DEMO_SEQUENCE_STAGE);
    document.body.dataset.demoSequenceCourse = COURSE_KEY;
    document.body.dataset.demoSequenceElapsed = '0.0';
    document.body.dataset.demoBgmDelayMs = '7000';
    // コース切替で読み込み直された直後は、既に流れている曲を教えてもらう。
    // 親がいない直接起動や ?demoTrack= 指定では、その曲の設定で始める。
    postDemoShellMessage('vox-demo-ready');
    setDemoTrack({
      index: DEMO_TRACK_INDEX,
      mode: DEMO_TRACK_MODES[DEMO_TRACK_INDEX],
      label: DEMO_TRACK_LABELS[DEMO_TRACK_INDEX],
      labelDelayMs: DEMO_TRACK_LABEL_DELAY_MS,
    });
    setTimeout(() => {
      if (demoActive && DEMO_SEQUENCE_ACTIVE && !demoSequenceLeaving) {
        requestDemoBackgroundMusic();
      }
    }, 7000);
    return true;
  }

  // デモ画面はドラッグでカメラを動かせるが、その操作はブラウザの音声ロックを
  // 解除する(AUDIO.unlock)ため、以降エンジン音が鳴り続けてしまう。コースが
  // 切り替わる(ページ再読込)と消えるが、曲3は海岸線に留まるので消えない。
  // そこで「デモがカメラアングルを強制的に切り替える」タイミングで音を戻す。
  function resetDemoEngineSound() {
    if (!DEMO_SEQUENCE_ACTIVE || !demoActive) return;
    demoCamUserHeld = false;
    stopInterior();
    AUDIO.silence();
    document.body.dataset.demoEngineSoundResets = String(
      Number(document.body.dataset.demoEngineSoundResets || 0) + 1
    );
  }

  // デモの演出によるカメラ視点(V相当)の強制切り替え。
  function switchDemoCameraView() {
    switchBonnetView();
    resetDemoEngineSound();
  }

  function advanceDemoSequence() {
    if (demoSequenceLeaving) return;
    demoSequenceLeaving = true;
    const nextStage = (DEMO_SEQUENCE_STAGE + 1) % DEMO_SEQUENCE.length;
    // 4コースを一巡して首都高速へ戻るたび、デモ車を
    // Toyota 86 → Volvo 240 → Toyota 86… の順で交互にする。
    const nextCar = nextStage === 0
      ? (PLAYER_CAR_KEY === 'toyota86' ? 'volvo240' : 'toyota86')
      : PLAYER_CAR_KEY;
    const nextQuery = new URLSearchParams();
    nextQuery.set('car', nextCar);
    nextQuery.set('course', DEMO_SEQUENCE[nextStage]);
    nextQuery.set('demo', '1');
    nextQuery.set('demoStage', String(nextStage));
    // 流れている曲の見せ方をコース切替後も引き継ぐ（親からの通知が届く前の初期値）。
    nextQuery.set('demoTrack', String(currentDemoTrackIndex()));
    if (DEMO_EMBEDDED) nextQuery.set('demoEmbedded', '1');
    if (DEBUG_MAP) nextQuery.set('debugMap', '1');
    document.body.dataset.demoNextCar = nextCar;
    location.replace(`${location.pathname}?${nextQuery}`);
  }

  function updateDemoSequence(now) {
    if (!demoActive || !DEMO_SEQUENCE_ACTIVE || demoSequenceLeaving) return;
    const elapsed = Math.max(0, (now - demoSequenceStartedAt) / 1000);
    document.body.dataset.demoSequenceElapsed = elapsed.toFixed(1);

    if (COURSE_KEY === 'tokyo') {
      const expected = Math.min(2, Math.floor(elapsed / 5));
      while (demoSequenceActionCount < expected) {
        nightMode = !nightMode;     // N相当: 5秒/10秒
        applyNight();
        demoSequenceActionCount++;
      }
    } else if (COURSE_KEY === 'sea') {
      const expectedViews = Math.min(2, Math.floor(elapsed / 5));
      while (demoSequenceActionCount < expectedViews) {
        switchDemoCameraView();             // V相当: 5秒/10秒
        demoSequenceActionCount++;
      }
      const expectedWeather = Math.min(3, Math.floor(elapsed / 4));
      while (demoSequenceWeatherCount < expectedWeather) {
        demoSequenceWeatherCount++;
        randomizeSeaDemoSky();
      }
    } else if (COURSE_KEY === 'forest') {
      if (elapsed >= 10 && demoSequenceActionCount === 0) {
        switchDemoCameraView();             // V相当: 10秒
        demoSequenceActionCount = 1;
      }
    } else if (COURSE_KEY === 'indy') {
      const expected = Math.min(2, Math.floor(elapsed / 5));
      while (demoSequenceActionCount < expected) {
        nightMode = !nightMode;     // N相当: 5秒/10秒
        applyNight();
        demoSequenceActionCount++;
      }
    }
    document.body.dataset.demoSequenceActions = String(demoSequenceActionCount);
    // 夜の曲は昼夜の切替演出を打ち消して、常に夜のままにする。
    if (demoTrackMode === 'night' && !nightMode) {
      nightMode = true;
      applyNight();
    }
    if (demoTrackMode === 'sea-sunset') {
      // 曲3は海岸線に留まり、コースを先へ進めない。
      // カメラだけを20秒ごとに切り替えて見せ場を変える。
      if (now - demoTrackCameraAt >= DEMO_TRACK_CAMERA_INTERVAL_MS) {
        demoTrackCameraAt = now;
        switchDemoCameraView();
        document.body.dataset.demoTrackCameraSwitches = String(
          Number(document.body.dataset.demoTrackCameraSwitches || 0) + 1
        );
      }
      return;
    }
    if (elapsed >= DEMO_SEQUENCE_STAGE_MS / 1000) advanceDemoSequence();
  }

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
  let controlPanelTab = 'music';
  let controlPanelMusicPage = null;
  let controlPanelWeatherPage = null;
  let controlPanelMusicTab = null;
  let controlPanelWeatherTab = null;
  let weatherColorModeLabel = null;
  // スライダーで作った色を、そのままmusiclist.txtへ書ける形で見せる。
  let weatherColorCodeEl = null;
  let weatherHueInput = null;
  let weatherSatInput = null;
  let weatherLightInput = null;
  let weatherSkyColorButton = null;
  let weatherHorizonColorButton = null;
  let weatherRainButton = null;
  let weatherStarButton = null;
  let weatherMusicSkyButton = null;
  let weatherCloudButton = null;
  let musicAudio = null;
  let musicHls = null;
  let musicVolume = 0.8;
  // 曲ごとの音量補正。曲が終わったら1.0へ戻す。
  let musicTrackVolumeScale = 1;
  let engineVolume = 1.0;
  let ytPlayer = null;
  let ytHolder = null;
  let ytPlayerReady = false;
  let ytApiRequested = false;

  // 曲名「」のあとに書かれた演出指示を読む。書式は musiclist.txt を参照。
  //   #rrggbb / 空#rrggbb : 空色    地平線#rrggbb : 地平線色
  //     どちらも色調(色相・彩度)だけを当て、明るさはユーザー設定のまま残す。
  //   単色      : 空のグラデーションをやめ、地平線色と上空色をベタ塗りで分ける
  //   音量±N%  : その曲の間だけ音量を上げ下げする
  //   開始N秒   : 頭からではなくN秒目から流す
  //   夜        : 夜間モード(Nキー)にする
  //   星 / 雨   : 星・雨を出す
  //   雲1 / 雲2 : 2種類ある雲のどちらかを出す
  function parseMusicEffects(tail) {
    const effects = {};
    for (const token of String(tail).trim().split(/[\s　]+/)) {
      let matched;
      if ((matched = token.match(/^地平線#([0-9a-fA-F]{6})$/))) {
        effects.horizonHex = matched[1];
      } else if ((matched = token.match(/^(?:空)?#([0-9a-fA-F]{6})$/))) {
        effects.skyHex = matched[1];
      } else if ((matched = token.match(/^音量([+\-]?\d+)[%％]$/))) {
        effects.volumePercent = Number(matched[1]);
      } else if ((matched = token.match(/^開始(\d+)秒$/))) {
        effects.startSeconds = Number(matched[1]);
      } else if (token === '単色') {
        effects.monotone = true;
      } else if (token === '夜') {
        effects.night = true;
      } else if (token === '星') {
        effects.stars = true;
      } else if (token === '雨') {
        effects.rain = true;
      } else if ((matched = token.match(/^雲([12])$/))) {
        effects.cloudMode = Number(matched[1]);
      }
    }
    return Object.keys(effects).length ? effects : null;
  }

  async function loadMusicList() {
    try {
      const res = await fetch('musiclist.txt', { cache: 'no-store' });
      if (!res.ok) return;
      for (const raw of (await res.text()).split(/\r?\n/)) {
        const label = raw.match(/「(.+?)」/);
        if (!label) {
          // URLも「」も無い行(●●●●ラジオ●●●●などの見出し)はそのまま表示する。
          // 選択しても何も起きない(playCurrentがURL無しを再生しないため)。
          const trimmed = raw.trim();
          if (trimmed && !/https?:\/\//.test(trimmed)) {
            musicItems.push({ label: trimmed, url: null, type: 'header' });
          }
          continue;
        }
        const url = (raw.match(/https?:\/\/[^\s「」]+/) || [null])[0];
        const type = url
          ? (/youtube\.com|youtu\.be/.test(url) ? 'yt' : 'radio')
          : 'playlist';
        const effects = parseMusicEffects(raw.slice(label.index + label[0].length));
        musicItems.push({ label: label[1], url, type, effects });
      }
      document.body.dataset.musicItemCount = String(musicItems.length);
    } catch (_) { /* 音楽リストが無くても走行には影響しない */ }
  }

  // 実際に鳴らす音量。ユーザー設定に、その曲の補正を掛けたもの。
  function musicOutputVolume() {
    return clamp(musicVolume * musicTrackVolumeScale, 0, 1);
  }

  function applyMusicVolume() {
    const volume = musicOutputVolume();
    if (musicAudio) musicAudio.volume = volume;
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(Math.round(volume * 100));
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

  // 曲ごとの演出は、当てる前の状態を控えておき、曲が終わったらそこへ戻す。
  // 曲をまたぐ時も一度戻してから次の曲の指示を当てるので、効果は積み重ならない。
  let musicEffectSaved = null;
  // 今かかっている曲の指示。Music⇒Skyの入切で当て直すために覚えておく。
  let musicCurrentEffects = null;
  // 切ると、曲の空色指定で空が変わらなくなる(自分の調整だけが効く)。
  let musicSkyEnabled = true;

  function restoreMusicEffects() {
    if (!musicEffectSaved) return;
    const saved = musicEffectSaved;
    musicEffectSaved = null;
    weatherTopHsl.h = saved.topH;
    weatherTopHsl.s = saved.topS;
    weatherTopHsl.l = saved.topL;
    weatherHorizonHsl.h = saved.horizonH;
    weatherHorizonHsl.s = saved.horizonS;
    weatherHorizonHsl.l = saved.horizonL;
    weatherRain = saved.rain;
    weatherStars = saved.stars;
    weatherCloudMode = saved.cloudMode;
    weatherFlatSky = saved.flatSky;
    musicTrackVolumeScale = 1;
    applyMusicVolume();
    if (nightMode !== saved.night) {
      nightMode = saved.night;
      applyNight();
    } else {
      applyWeatherSky();
    }
    refreshWeatherControls();
    document.body.dataset.musicTrackEffects = '';
    document.body.dataset.weatherFlatSky = String(weatherFlatSky);
  }

  function applyMusicEffects(effects) {
    restoreMusicEffects();
    musicCurrentEffects = effects || null;
    if (!effects) return;
    musicEffectSaved = {
      topH: weatherTopHsl.h, topS: weatherTopHsl.s, topL: weatherTopHsl.l,
      horizonH: weatherHorizonHsl.h, horizonS: weatherHorizonHsl.s,
      horizonL: weatherHorizonHsl.l,
      rain: weatherRain, stars: weatherStars, cloudMode: weatherCloudMode,
      flatSky: weatherFlatSky, night: nightMode,
    };
    // 色調(色相・彩度)だけを当てる。明るさはユーザーが決めた値のまま残す。
    const applyTone = (hex, hsl) => {
      const tone = { h: 0, s: 0, l: 0 };
      new THREE.Color(`#${hex}`).getHSL(tone);
      hsl.h = tone.h;
      hsl.s = tone.s;
    };
    // Music⇒Skyを切っている間は、見え方に関わる指示を一切当てない。
    // 音量だけは切っていても常に効かせる。
    if (musicSkyEnabled) {
      if (effects.skyHex) applyTone(effects.skyHex, weatherTopHsl);
      if (effects.horizonHex) applyTone(effects.horizonHex, weatherHorizonHsl);
      // 単色は色をいじらず、空の描き方をベタ塗り2色へ切り替える。
      if (effects.monotone) weatherFlatSky = true;
      if (effects.rain) weatherRain = true;
      if (effects.stars) weatherStars = true;
      if (effects.cloudMode) weatherCloudMode = effects.cloudMode;
    }
    if (effects.volumePercent) {
      musicTrackVolumeScale = clamp(1 + effects.volumePercent / 100, 0, 2);
    }
    applyMusicVolume();
    // 夜指定の曲は夜間モードへ。地表の明るさまで変わるのでapplyNightを通す。
    if (musicSkyEnabled && effects.night && !nightMode) {
      nightMode = true;
      applyNight();
    } else {
      applyWeatherSky();
    }
    refreshWeatherControls();
    document.body.dataset.musicTrackEffects = JSON.stringify(effects);
    document.body.dataset.weatherFlatSky = String(weatherFlatSky);
  }

  function stopMusic() {
    restoreMusicEffects();
    if (musicHls) { musicHls.destroy(); musicHls = null; }
    if (musicAudio) { musicAudio.pause(); musicAudio = null; }
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
  }

  // 再生中の項目を再生する。終了したら次の再生可能な曲へ自動で進む。
  // YouTube側で埋め込み禁止になった曲は、自動的に次の曲へ送る。
  let musicAutoAdvance = false;
  let musicSkipAttempts = 0;
  function playCurrent(isAuto) {
    const it = musicItems[musicSel];
    if (!it || !it.url) return false;
    musicAutoAdvance = !!isAuto;
    if (!musicAutoAdvance) musicSkipAttempts = 0;
    stopMusic();
    if (it.type === 'yt') {
      // YouTube API の初回読込みがまだ終わっていない場合はメニューを閉じない。
      // 準備完了後の次の決定操作を、音付き再生のユーザー操作として使う。
      if (!playYouTube(it.url, it.effects?.startSeconds)) {
        setNowPlaying(it.label + '（準備中）');
        musicMenuRefresh();
        return false;
      }
    } else {
      playRadio(it.url, it.effects?.startSeconds);
    }
    // 鳴らし始められた時だけ演出を当てる。準備中で抜けた場合は当てない。
    applyMusicEffects(it.effects);
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
    musicSkipAttempts++;
    if (musicSkipAttempts >= Math.min(20, musicItems.length)) {
      musicToast('⚠ 再生可能な曲が見つかりません');
      setNowPlaying(label + '（エラー）');
      musicSkipAttempts = 0;
      return;
    }
    musicToast('⚠ 「' + label + '」は再生禁止のため次の曲へ');
    playNext(true);
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

  function playRadio(url, startSeconds) {
    musicAudio = new Audio();
    musicAudio.volume = musicOutputVolume();
    musicAudio.addEventListener('ended', playNext);   // 終了で次の曲へ
    musicAudio.addEventListener('error', handlePlaybackError);
    // 「開始N秒」の曲は頭出しをしてから鳴らす。URLの #t=N は読み込み前から効く。
    // 生放送のように飛べない音源では単に無視される。
    const seekable = startSeconds > 0 && !/#/.test(url);
    const srcUrl = seekable ? `${url}#t=${startSeconds}` : url;
    // #t= を解釈しないブラウザ向けの保険。飛べる状態になった時に一度だけ送る。
    if (startSeconds > 0) {
      const seekOnce = () => {
        if (musicAudio.currentTime >= startSeconds || !musicAudio.seekable?.length) return;
        try { musicAudio.currentTime = startSeconds; } catch (_) { /* 飛べない音源 */ }
      };
      musicAudio.addEventListener('loadedmetadata', seekOnce);
      musicAudio.addEventListener('canplay', seekOnce, { once: true });
    }
    const start = () => musicAudio && musicAudio.play().catch((e) => console.warn('ラジオを再生できませんでした:', url, e));
    if (/\.m3u8/.test(url)) {
      // HLS ストリームはブラウザ単体で鳴らないため hls.js を遅延読み込み
      const ready = () => {
        if (window.Hls && window.Hls.isSupported()) {
          musicHls = new window.Hls();
          musicHls.loadSource(url);
          musicHls.attachMedia(musicAudio);
          start();
        } else { musicAudio.src = srcUrl; start(); }
      };
      if (window.Hls) ready();
      else {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
        script.onload = ready;
        script.onerror = () => { musicAudio.src = srcUrl; start(); };
        document.head.appendChild(script);
      }
    } else {
      musicAudio.src = srcUrl;
      start();
    }
  }

  function youtubeId(url) {
    const m = url.match(/[?&]v=([\w-]{11})/) || url.match(/youtu\.be\/([\w-]{11})/);
    return m ? m[1] : null;
  }
  let ytPendingId = null;
  let ytCurrentId = null;            // 直近に再生を要求した動画ID
  function ensureYouTubeHolder() {
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
  }

  function prepareYouTubePlayer() {
    ensureYouTubeHolder();

    const create = () => {
      if (ytPlayer || !window.YT || !window.YT.Player) return;
      // 動画を指定せずプレイヤーだけ先に用意する。選曲決定時の
      // loadVideoById / playVideo がユーザー操作の最中に走るようにする。
      ytPlayer = new window.YT.Player('yt-player', {
        width: 400, height: 300,
        playerVars: {
          autoplay: 0,
          controls: 0,
          fs: 0,
          playsinline: 1,
          origin: location.origin,
        },
        events: {
          onReady: (ev) => {
            ytPlayerReady = true;
            ev.target.setVolume(Math.round(musicOutputVolume() * 100));
            const iframe = ev.target.getIframe ? ev.target.getIframe() : null;
            if (iframe) {
              iframe.setAttribute(
                'allow',
                'autoplay; encrypted-media; picture-in-picture'
              );
              iframe.referrerPolicy = 'strict-origin-when-cross-origin';
            }
            document.body.dataset.youtubePlayer = 'ready';
            if (ytPendingId) {
              ev.target.cueVideoById(ytPendingId);
              musicToast('♪ プレイヤー準備完了：もう一度決定すると再生');
            }
          },
          // 再生終了(state=0)で次の曲を自動再生
          onStateChange: (ev) => {
            document.body.dataset.youtubeState = String(ev.data);
            if (ev.data === 1) {
              document.body.dataset.youtubePlayer = 'playing';
              musicSkipAttempts = 0;
            }
            if (ev.data === 0) playNext();
          },
          // ブラウザが音付き自動再生と判断した場合は、黙ったままにせず
          // 選曲画面へ戻し、次の決定操作で確実に playVideo() を呼ぶ。
          onAutoplayBlocked: () => {
            document.body.dataset.youtubePlayer = 'autoplay-blocked';
            musicToast('♪ 再生が制限されました：選択曲をもう一度決定');
            openMusicMenu();
          },
          // 再生できない動画は通知を出して次の曲へスキップ。
          // 切替前の動画のエラーを選択曲のエラーと誤認しないよう、
          // エラー対象のIDを確認する。
          onError: (ev) => {
            document.body.dataset.youtubeError = String(ev.data);
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
    else if (!ytApiRequested) {
      ytApiRequested = true;
      const script = document.createElement('script');
      script.id = 'yt-api';
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => {
        ytApiRequested = false;
        document.body.dataset.youtubePlayer = 'api-error';
        musicToast('⚠ YouTubeプレイヤーを読み込めません');
      };
      document.head.appendChild(script);
      window.onYouTubeIframeAPIReady = create;
    }
  }

  function playYouTube(url, startSeconds) {
    const id = youtubeId(url);
    if (!id) return false;
    ytCurrentId = id;
    ytPendingId = id;
    prepareYouTubePlayer();
    if (!ytPlayerReady || !ytPlayer) {
      document.body.dataset.youtubePlayer = 'preparing';
      musicToast('♪ YouTubeプレイヤーを準備中…');
      return false;
    }

    ytPlayer.setVolume(Math.round(musicOutputVolume() * 100));
    let loadedId = null;
    try {
      loadedId = ytPlayer.getVideoData
        ? ytPlayer.getVideoData().video_id
        : null;
    } catch (_) { /* 未読込みなら loadVideoById へ進む */ }
    const start = startSeconds > 0 ? startSeconds : 0;
    if (loadedId === id && ytPlayer.playVideo) {
      if (start) ytPlayer.seekTo(start, true);
      ytPlayer.playVideo();
    } else if (start) {
      ytPlayer.loadVideoById({ videoId: id, startSeconds: start });
    } else {
      ytPlayer.loadVideoById(id);
    }
    ytPendingId = null;
    document.body.dataset.youtubePlayer = 'play-requested';
    return true;
  }

  function musicMenuRefresh() {
    if (!musicListEl) return;
    const rows = musicListEl.children;
    for (let i = 0; i < rows.length; i++) {
      // 緑液晶に濃いグレーの太字。選択中は反転表示+行頭を▶に(他は■)
      rows[i].style.background = i === musicSel ? '#2e342e' : 'transparent';
      rows[i].style.color = i === musicSel ? '#33CC33' : '#2e342e';
      const item = musicItems[i];
      if (item) {
        // 見出し行(●●●●ラジオ●●●●等)は再生マークを付けずそのまま表示する。
        rows[i].textContent = item.type === 'header'
          ? item.label
          : (i === musicSel ? '▶ ' : '■ ') + item.label;
      }
    }
    const row = rows[musicSel];
    // offsetTop は共通の親基準なのでリスト自身の位置を引いて中央に合わせる
    if (row) {
      musicListEl.scrollTop = (row.offsetTop - musicListEl.offsetTop) - musicListEl.clientHeight / 2 + 14;
    }
  }

  function switchControlPanelTab(tab) {
    controlPanelTab = tab === 'weather' ? 'weather' : 'music';
    if (controlPanelMusicPage) {
      controlPanelMusicPage.style.display =
        controlPanelTab === 'music' ? 'flex' : 'none';
    }
    if (controlPanelWeatherPage) {
      controlPanelWeatherPage.style.display =
        controlPanelTab === 'weather' ? 'flex' : 'none';
    }
    const styleTab = (button, active, color) => {
      if (!button) return;
      button.style.background = active ? color : '#8a8a8a';
      button.style.color = active ? '#25231e' : '#f4f4f4';
      button.style.boxShadow = active
        ? `inset 0 -4px 0 #25231e`
        : 'inset 0 -1px 0 #555';
    };
    styleTab(controlPanelMusicTab, controlPanelTab === 'music', '#33CC33');
    styleTab(controlPanelWeatherTab, controlPanelTab === 'weather', '#ff7f24');
    document.body.dataset.controlPanelTab = controlPanelTab;
    if (controlPanelTab === 'weather') {
      applyWeatherSky();
      refreshWeatherControls();
    }
  }

  function refreshWeatherControls() {
    const hsl = currentWeatherHsl();
    if (weatherColorModeLabel) {
      weatherColorModeLabel.textContent =
        weatherColorTarget === 'sky' ? '上空色' : '地平線色';
    }
    const brightnessPercentage = Math.round(
      clamp((hsl.l - 0.1) / 0.88, 0, 1) * 100
    );
    weatherHueInput?.renderMeter(hsl.h);
    weatherSatInput?.renderMeter(hsl.s);
    weatherLightInput?.renderMeter(brightnessPercentage / 100);
    weatherRainButton?.renderToggle(weatherRain);
    weatherStarButton?.renderToggle(weatherStars);
    weatherMusicSkyButton?.renderToggle(musicSkyEnabled);
    document.body.dataset.weatherMusicSky = String(musicSkyEnabled);
    weatherCloudButton?.renderCloud(weatherCloudMode);
    document.body.dataset.weatherRain = String(weatherRain);
    document.body.dataset.weatherStars = String(weatherStars);
    document.body.dataset.weatherCloudMode = String(weatherCloudMode);
    document.body.dataset.weatherPeriod = nightMode ? 'night' : 'day';
    const styleColorTargetButton = (button, active) => {
      if (!button) return;
      button.style.background = '#050505';
      button.style.color = active ? '#ffffff' : '#747474';
      button.style.textShadow = 'none';
    };
    styleColorTargetButton(weatherSkyColorButton, weatherColorTarget === 'sky');
    styleColorTargetButton(
      weatherHorizonColorButton,
      weatherColorTarget === 'horizon'
    );
  }

  function openMusicMenu() {
    // Music タブを開いている間に YouTube API とプレイヤーを先読みし、
    // 曲を決定した瞬間のユーザー操作で音付き再生を開始できる状態にする。
    prepareYouTubePlayer();
    if (!musicMenuEl) {
      musicMenuEl = document.createElement('div');
      musicMenuEl.style.cssText = 'position:fixed;inset:0;z-index:8;display:flex;'
        + 'align-items:center;justify-content:center;background:rgba(8,14,20,0.22);';
      musicMenuEl.id = 'control-panel';

      // 黒筐体+白二重枠。上部は画像に合わせてタイトル/Music/Weatherの3区画。
      const panel = document.createElement('div');
      panel.className = 'control-panel-window';
      panel.style.cssText = 'width:min(639px,90vw);height:min(426px,88vh);display:flex;flex-direction:column;'
        + 'overflow:hidden;'
        + 'background:#0a0a0a;border:3px double #fff;border-radius:0;padding:8px 14px 14px;color:#fff;'
        + 'font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",Meiryo,sans-serif;';

      const tabs = document.createElement('div');
      tabs.className = 'control-panel-tabs';
      tabs.style.cssText = 'display:grid;grid-template-columns:1.15fr 1fr 1fr 52px;'
        + 'gap:4px;margin:-1px 2px 14px;font:24px/1.6 "Courier New",monospace;';
      const title = document.createElement('div');
      title.textContent = 'Control Panel';
      title.style.cssText = 'background:#030303;color:#fff;padding:0 18px;white-space:nowrap;'
        + 'border-bottom:1px solid #fff;letter-spacing:.5px;';
      const makeTab = (text, tab) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.style.cssText = 'border:0;border-left:4px solid #111;cursor:pointer;'
          + 'font:inherit;line-height:1.6;transition:none;';
        button.addEventListener('click', () => {
          if (controlPanelTab === tab) return;
          playControlPanelSound(controlPanelTabSound, 'tab');
          switchControlPanelTab(tab);
        });
        return button;
      };
      controlPanelMusicTab = makeTab('Music', 'music');
      controlPanelWeatherTab = makeTab('Weather', 'weather');
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.textContent = '×';
      closeButton.setAttribute('aria-label', '閉じる');
      closeButton.title = '閉じる';
      closeButton.style.cssText = 'border:0;border-left:4px solid #111;outline:none;'
        + 'background:#030303;color:#fff;cursor:pointer;'
        + 'font:inherit;line-height:1.6;transition:none;';
      closeButton.addEventListener('click', closeMusicMenu);
      tabs.append(title, controlPanelMusicTab, controlPanelWeatherTab, closeButton);
      panel.appendChild(tabs);

      // 音量メーター: 音楽タブでは音量部も曲リストも緑色液晶へ統一。
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

      controlPanelMusicPage = document.createElement('div');
      controlPanelMusicPage.style.cssText =
        'display:flex;flex:1;flex-direction:column;min-height:0;overflow:hidden;'
        + 'padding:4px;background:#050505;box-sizing:border-box;';
      const volPanel = document.createElement('div');
      volPanel.style.cssText = 'background:linear-gradient(180deg,#43dd3d,#2fc92f);'
        + 'border:1px solid #666;padding:9px 12px 3px;margin:0 0 8px;';
      volPanel.appendChild(makeSlider('環境音量', engineVolume, (v) => {
        engineVolume = v;
        AUDIO.setVolume(v);
        AUDIO.setInteriorVolume(0.85 * v);
      }));
      volPanel.appendChild(makeSlider('音楽音量', musicVolume, (v) => {
        musicVolume = v;
        applyMusicVolume();
      }));
      controlPanelMusicPage.appendChild(volPanel);
      musicListEl = document.createElement('div');
      // 曲リスト: 青緑液晶バックに濃いグレーの太字(液晶風の等幅ゴシック)。
      // スクロールバーは表示しない(十字キー上下の高速閲覧で移動する)。
      musicListEl.style.cssText = 'overflow-y:hidden;font-size:19px;line-height:1.55;'
        + 'height:auto;flex:1;min-height:0;margin:0;padding:6px 4px 10px;border:1px solid #666;'
        + 'box-sizing:border-box;'
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
      controlPanelMusicPage.appendChild(musicListEl);
      const musicBottomFrame = document.createElement('div');
      musicBottomFrame.style.cssText =
        'height:18px;flex:none;background:#050505;';
      controlPanelMusicPage.appendChild(musicBottomFrame);
      // マウスホイールで選択を上下に送る(1ノッチ=1行)
      musicListEl.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        if (!musicItems.length) return;
        const step = Math.sign(ev.deltaY);
        musicSel = (musicSel + step + musicItems.length) % musicItems.length;
        musicMenuRefresh();
      }, { passive: false });
      panel.appendChild(controlPanelMusicPage);

      controlPanelWeatherPage = document.createElement('div');
      controlPanelWeatherPage.style.cssText =
        'display:none;flex:1;flex-direction:column;min-height:0;overflow:hidden;'
        + 'padding:4px;box-sizing:border-box;background:#050505;';
      const weatherLcdPanel = document.createElement('div');
      weatherLcdPanel.style.cssText =
        'display:flex;flex:none;flex-direction:column;min-height:0;overflow:hidden;'
        + 'padding:10px 20px 8px;box-sizing:border-box;border:1px solid #666;'
        + 'background:repeating-linear-gradient(0deg,rgba(77,35,0,.035) 0,'
        + 'rgba(77,35,0,.035) 1px,transparent 1px,transparent 4px),'
        + 'linear-gradient(180deg,#ff8a2a 0%,#ff8527 55%,#fe8324 100%);'
        + 'box-shadow:inset 0 0 48px rgba(88,36,0,.04);color:#302d27;'
        + 'font:900 19px "MS Gothic","ＭＳ ゴシック","Courier New",monospace;';

      const makeWeatherMeter = (labelText, key) => {
        const row = document.createElement('div');
        row.className = 'control-panel-lcd-text';
        row.style.cssText = 'display:grid;grid-template-columns:96px 1fr 58px;'
          + 'align-items:center;gap:8px;font-size:19px;line-height:1;';
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.whiteSpace = 'nowrap';
        const meter = document.createElement('div');
        meter.className = 'control-panel-segment-meter';
        meter.tabIndex = 0;
        meter.setAttribute('role', 'slider');
        meter.setAttribute('aria-label', labelText);
        meter.setAttribute('aria-valuemin', '0');
        meter.setAttribute('aria-valuemax', '100');
        meter.dataset.weatherKey = key;
        meter.style.cssText = 'display:flex;gap:3px;align-items:center;height:28px;'
          + 'padding:5px 8px;box-sizing:border-box;cursor:pointer;touch-action:none;'
          + 'background:#ff7f24;border:2px solid rgba(0,0,0,.45);';
        const segments = [];
        const segmentCount = 24;
        for (let index = 0; index < segmentCount; index++) {
          const segment = document.createElement('span');
          segment.style.cssText = 'display:block;flex:1;height:14px;';
          meter.appendChild(segment);
          segments.push(segment);
        }
        const readout = document.createElement('span');
        readout.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;'
          + 'height:28px;padding:0 4px;box-sizing:border-box;text-align:right;'
          + 'background:#ff7f24;color:#333029;font:900 19px "MS Gothic","Courier New",monospace;';
        meter.renderMeter = (fraction) => {
          const value = clamp(fraction, 0, 1);
          const percentage = Math.round(value * 100);
          const lit = Math.round(value * segmentCount);
          segments.forEach((segment, index) => {
            segment.style.background =
              index < lit ? '#333029' : 'rgba(51,52,46,.12)';
          });
          meter.value = String(percentage);
          meter.setAttribute('aria-valuenow', String(percentage));
          readout.textContent = `${percentage}%`;
        };
        meter.rowElement = row;
        const applyMeterValue = (fraction) => {
          const value = clamp(fraction, 0, 1);
          meter.renderMeter(value);
          if (key === 'l') {
            const lightness = 0.1 + value * 0.88;
            currentWeatherHsl().l = lightness;
            // 明暗は連続調整とし、25%付近で夜間モードへ強制移行しない。
            // 夜間モードの切替はNキーだけに任せる。
            // ただし horizon の明度が50%を切ったら地表の照明も合わせて落とす
            // （applyNight 内の weatherDuskLevel）。空だけ暗くなるのを防ぐ。
            if (weatherColorTarget === 'horizon') applyNight();
            else applyWeatherSky();
          } else {
            currentWeatherHsl()[key] = value;
            applyWeatherSky();
          }
        };
        const setFromPointer = (event) => {
          const rect = meter.getBoundingClientRect();
          const fraction =
            (event.clientX - rect.left - 8) / Math.max(1, rect.width - 16);
          applyMeterValue(fraction);
        };
        let dragging = false;
        meter.addEventListener('pointerdown', (event) => {
          dragging = true;
          meter.setPointerCapture(event.pointerId);
          setFromPointer(event);
        });
        meter.addEventListener('pointermove', (event) => {
          if (dragging) setFromPointer(event);
        });
        meter.addEventListener('pointerup', () => { dragging = false; });
        meter.addEventListener('pointercancel', () => { dragging = false; });
        meter.addEventListener('keydown', (event) => {
          let step = 0;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') step = -1;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') step = 1;
          if (!step) return;
          event.preventDefault();
          applyMeterValue((Number(meter.value) + step) / 100);
        });
        meter.renderMeter(0);
        row.append(label, meter, readout);
        return { row, meter };
      };
      const hue = makeWeatherMeter('色調', 'h');
      const sat = makeWeatherMeter('彩度', 's');
      const light = makeWeatherMeter('明暗', 'l');
      weatherHueInput = hue.meter;
      weatherSatInput = sat.meter;
      weatherLightInput = light.meter;
      // 3本のスライダーで作った色。musiclist.txtへそのまま書き写せる。
      const colorCodeRow = document.createElement('div');
      colorCodeRow.className = 'control-panel-lcd-text';
      // ラベルが「色調」より長いので、等幅グリッドではなく間隔を空けて並べる。
      colorCodeRow.style.cssText = 'display:flex;align-items:center;gap:22px;'
        + 'font-size:19px;line-height:1;';
      const colorCodeLabel = document.createElement('span');
      colorCodeLabel.textContent = 'カラーコード';
      colorCodeLabel.style.whiteSpace = 'nowrap';
      weatherColorCodeEl = document.createElement('span');
      weatherColorCodeEl.style.cssText = 'padding:0 8px;color:#302d27;'
        + 'font:900 23px "MS Gothic","Courier New",monospace;letter-spacing:2px;';
      colorCodeRow.append(colorCodeLabel, weatherColorCodeEl);
      const weatherSliderFrame = document.createElement('div');
      weatherSliderFrame.style.cssText =
        // 背景も影も置かず、外枠の面をそのまま見せる。ここに色を敷くと
        // 上と左右にだけ外枠の色が残り、境目の線に見えてしまう。
        'display:flex;flex-direction:column;justify-content:center;gap:18px;'
        + 'min-height:160px;padding:14px 28px;border:0;box-sizing:border-box;'
        + 'background:transparent;';
      const colorTargetRow = document.createElement('div');
      colorTargetRow.style.cssText =
        'display:grid;grid-template-columns:1fr 1fr;gap:0;margin:0;'
        + 'height:30px;min-height:30px;background:#050505;';
      const makeColorTargetButton = (label, target) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'height:30px;min-height:30px;border:0;border-radius:0;outline:none;'
          + 'cursor:pointer;font:900 18px "MS Gothic","Courier New",monospace;';
        if (target === 'sky') button.style.borderRight = '2px solid #fff';
        button.addEventListener('click', () => {
          weatherColorTarget = target;
          applyWeatherSky();
          refreshWeatherControls();
        });
        colorTargetRow.appendChild(button);
        return button;
      };
      weatherSkyColorButton = makeColorTargetButton('Sky Color', 'sky');
      weatherHorizonColorButton = makeColorTargetButton('Horizon Color', 'horizon');
      weatherSliderFrame.append(hue.row, sat.row, light.row, colorCodeRow);
      weatherLcdPanel.append(colorTargetRow, weatherSliderFrame);

      const weatherButtons = document.createElement('div');
      weatherButtons.style.cssText =
        'display:grid;flex:1;grid-template-columns:1.25fr 1fr 1fr 1.25fr;gap:10px;'
        + 'min-height:62px;margin:8px 0 0;padding:4px 8px;'
        + 'border:1px solid #666;box-sizing:border-box;'
        + 'background:repeating-linear-gradient(0deg,rgba(77,35,0,.035) 0,'
        + 'rgba(77,35,0,.035) 1px,transparent 1px,transparent 4px),'
        + 'linear-gradient(180deg,#ff8a2a 0%,#ff8527 55%,#fe8324 100%);'
        + 'color:#302d27;font:900 19px "MS Gothic","ＭＳ ゴシック","Courier New",monospace;';
      const makeWeatherSwitch = (labelText, handler) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = 'min-height:54px;padding:2px 8px;border:0;'
          + 'border-radius:0;background:transparent;color:#302d27;cursor:pointer;'
          + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;'
          + 'font:900 19px "MS Gothic","Courier New",monospace;';
        const title = document.createElement('span');
        title.textContent = labelText;
        title.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'width:100%;height:24px;line-height:1;white-space:nowrap;';
        const track = document.createElement('span');
        track.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'width:84px;height:30px;border:2px solid #050505;box-sizing:border-box;';
        const spacer = document.createElement('span');
        spacer.style.cssText = 'display:block;width:100%;height:14px;';
        button.append(title, track, spacer);
        button.renderToggle = (active) => {
          button.setAttribute('aria-pressed', String(active));
          track.textContent = active ? 'ON' : 'OFF';
          track.style.background = active ? '#ff7f24' : '#050505';
          track.style.color = active ? '#050505' : '#9a9a9a';
        };
        button.addEventListener('click', handler);
        weatherButtons.appendChild(button);
        return button;
      };
      // 曲の空色指定を効かせるかどうか。切ると自分の調整だけが空へ反映される。
      const makeMusicSkyCheckbox = () => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = 'weather-music-sky';
        button.setAttribute('role', 'checkbox');
        button.style.cssText = 'min-height:54px;padding:2px 8px;border:0;'
          + 'border-radius:0;background:transparent;color:#302d27;cursor:pointer;'
          + 'display:flex;align-items:center;justify-content:center;gap:10px;';
        const box = document.createElement('span');
        box.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'width:30px;height:30px;flex:none;box-sizing:border-box;'
          + 'border:2px solid #050505;background:transparent;'
          + 'font:900 24px "MS Gothic","Courier New",monospace;line-height:1;';
        const title = document.createElement('span');
        // 2行表示。改行と行頭の全角空白をそのまま出すため white-space:pre。
        title.textContent = 'Music\n　→Sky Color';
        title.style.cssText = 'font:900 18px "MS Gothic","ＭＳ ゴシック","Courier New",monospace;'
          + 'white-space:pre;line-height:1.15;';
        button.append(box, title);
        button.renderToggle = (active) => {
          button.setAttribute('aria-checked', String(active));
          box.textContent = active ? '✓' : '';
        };
        button.addEventListener('click', () => {
          musicSkyEnabled = !musicSkyEnabled;
          // 入切した時点で、今の曲の指示を当て直す(切れば自分の色へ戻る)。
          applyMusicEffects(musicCurrentEffects);
          refreshWeatherControls();
        });
        weatherButtons.appendChild(button);
        return button;
      };
      weatherMusicSkyButton = makeMusicSkyCheckbox();
      weatherRainButton = makeWeatherSwitch('☂ Rain', () => {
        weatherRain = !weatherRain;
        refreshWeatherControls();
      });
      weatherStarButton = makeWeatherSwitch('★ Star', () => {
        weatherStars = !weatherStars;
        refreshWeatherControls();
      });
      const makeCloudSlider = () => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'min-height:54px;padding:2px 8px;border:0;'
          + 'box-sizing:border-box;display:flex;flex-direction:column;align-items:center;'
          + 'justify-content:center;gap:4px;color:#302d27;';
        const title = document.createElement('span');
        title.textContent = '☁ Cloud';
        title.style.cssText = 'display:flex;align-items:center;justify-content:center;'
          + 'width:100%;height:24px;line-height:1;white-space:nowrap;';
        const track = document.createElement('div');
        track.tabIndex = 0;
        track.setAttribute('role', 'slider');
        track.setAttribute('aria-label', 'Cloud');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '2');
        track.style.cssText = 'position:relative;display:grid;grid-template-columns:repeat(3,1fr);'
          + 'align-items:center;width:100%;height:30px;border:0;box-sizing:border-box;'
          + 'background:transparent;cursor:pointer;touch-action:none;';
        const cloudRail = document.createElement('span');
        cloudRail.style.cssText = 'position:absolute;left:0;right:0;top:50%;height:4px;'
          + 'background:#050505;transform:translateY(-50%);pointer-events:none;';
        track.appendChild(cloudRail);
        const cloudSegments = [];
        for (let mode = 0; mode < 3; mode++) {
          const segment = document.createElement('span');
          segment.style.cssText = 'position:relative;height:100%;background:transparent;';
          track.appendChild(segment);
          cloudSegments.push(segment);
        }
        const marker = document.createElement('span');
        marker.style.cssText = 'position:absolute;top:-3px;width:10px;height:36px;'
          + 'box-sizing:border-box;border:2px solid #050505;'
          + 'background:linear-gradient(90deg,#8d8d8d,#f2f2f2,#aaa);'
          + 'pointer-events:none;transform:translateX(-50%);';
        track.appendChild(marker);
        const labels = document.createElement('span');
        labels.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);width:100%;'
          + 'font:900 13px "MS Gothic","Courier New",monospace;text-align:center;';
        for (const text of ['0', 'A', 'B']) {
          const label = document.createElement('span');
          label.textContent = text;
          labels.appendChild(label);
        }
        const setCloudMode = (mode) => {
          weatherCloudMode = clamp(Math.round(mode), 0, 2);
          refreshWeatherControls();
        };
        track.renderCloud = (mode) => {
          const current = clamp(Math.round(mode), 0, 2);
          track.value = String(current);
          track.setAttribute('aria-valuenow', String(current));
          track.setAttribute(
            'aria-valuetext',
            ['0 No Clouds', 'A Cloud A', 'B Cloud B'][current]
          );
          cloudSegments.forEach((segment) => {
            segment.style.background = 'transparent';
          });
          marker.style.left = `${((current + 0.5) / 3) * 100}%`;
        };
        const setFromPointer = (event) => {
          const rect = track.getBoundingClientRect();
          const mode = Math.floor(
            clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 0.9999) * 3
          );
          setCloudMode(mode);
        };
        track.addEventListener('pointerdown', setFromPointer);
        track.addEventListener('keydown', (event) => {
          let step = 0;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') step = -1;
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') step = 1;
          if (!step) return;
          event.preventDefault();
          setCloudMode(Number(track.value) + step);
        });
        wrap.append(title, track, labels);
        weatherButtons.appendChild(wrap);
        return track;
      };
      weatherCloudButton = makeCloudSlider();
      controlPanelWeatherPage.appendChild(weatherLcdPanel);
      controlPanelWeatherPage.appendChild(weatherButtons);
      const weatherBottomFrame = document.createElement('div');
      weatherBottomFrame.style.cssText =
        'height:18px;flex:none;background:#050505;';
      controlPanelWeatherPage.appendChild(weatherBottomFrame);
      panel.appendChild(controlPanelWeatherPage);

      musicMenuEl.appendChild(panel);
      document.body.appendChild(musicMenuEl);
    }
    musicMode = true;
    switchControlPanelTab('music');
    for (const key of Object.keys(keys)) keys[key] = false;   // 押しっぱなし解除
    musicMenuEl.style.display = 'flex';
    musicMenuRefresh();
    document.body.dataset.musicMode = 'true';
    document.body.dataset.controlPanelOpen = 'true';
  }
  function closeMusicMenu() {
    musicMode = false;
    if (musicMenuEl) musicMenuEl.style.display = 'none';
    document.body.dataset.musicMode = 'false';
    document.body.dataset.controlPanelOpen = 'false';
  }
  // musicMode 中のキー処理。運転側へはキーを渡さない。
  // ↑↓は押しっぱなし(リピート)で3行ずつ進み、高速に閲覧できる。
  function musicKeydown(k, isRepeat) {
    if (controlPanelTab !== 'music') return;
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

  function snapPlayerToIndyAutoRoute() {
    const wps = car2AutoRoute;
    if (!wps || wps.length < 2) return;
    let best = 0;
    let bestD2 = Infinity;
    for (let i = 0; i < wps.length; i++) {
      const d2 = (wps[i].x - player.pos.x) ** 2 + (wps[i].z - player.pos.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    const at = wps[best];
    const next = wps[(best + 1) % wps.length];
    const speed = player.vel.length();
    player.pos.set(
      at.x,
      at.y + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012,
      at.z
    );
    player.heading = Math.atan2(next.x - at.x, next.z - at.z);
    player.vel.set(
      Math.sin(player.heading) * speed,
      0,
      Math.cos(player.heading) * speed
    );
    player.drifting = false;
    car2LastRoadPos.copy(player.pos);
    autoIdx = (best + 1) % wps.length;
    document.body.dataset.autoDriveSnapDistance =
      Math.sqrt(bestD2).toFixed(2);
    document.body.dataset.autoDriveBankEntry = 'true';
  }

  // Y: コース別自動運転。首都高は従来ルート、海岸線は左車線130km/h巡航、
  // 森林地帯は道路中央を130km/h巡航して急カーブだけドリフト、
  // インディアナポリスは外周バンクを右回りし直線全開・カーブドリフト。
  function car2Autopilot() {
    const wps = car2AutoRoute;
    const n = wps.length;
    const speed = player.vel.length();
    const autoMode = MAP_CONFIG.autoDriveMode;
    const angleTo = (p) => {
      let a = Math.atan2(p.x - player.pos.x, p.z - player.pos.z) - player.heading;
      while (a > Math.PI) a -= Math.PI * 2;
      while (a < -Math.PI) a += Math.PI * 2;
      return a;
    };
    if (autoMode === 'forestCruise130Drift') {
      // ドリフトで外へ膨らんでも樹木側へ逸走し続けないよう、道路幅を越えた時だけ
      // 最寄りのWood_Chips路面中心へ滑らかに戻す。道路内では位置補正しない。
      let nearest = 0;
      let nearestD2 = Infinity;
      for (let i = 0; i < n; i++) {
        const d2 = (wps[i].x - player.pos.x) ** 2 + (wps[i].z - player.pos.z) ** 2;
        if (d2 < nearestD2) {
          nearestD2 = d2;
          nearest = i;
        }
      }
      const nearestPoint = wps[nearest];
      const routeDistance = Math.sqrt(nearestD2);
      const allowedDistance = clamp((nearestPoint.width ?? 7) * 0.42, 2.6, 4.8);
      document.body.dataset.autoDriveRoadDistance = routeDistance.toFixed(2);
      if (routeDistance > allowedDistance) {
        const correction = routeDistance > allowedDistance * 1.8 ? 0.16 : 0.07;
        player.pos.x = THREE.MathUtils.lerp(player.pos.x, nearestPoint.x, correction);
        player.pos.z = THREE.MathUtils.lerp(player.pos.z, nearestPoint.z, correction);
        autoIdx = (nearest + 1) % n;
        car2LastRoadPos.copy(player.pos);
        document.body.dataset.autoDriveLaneAssist = 'forest-road-center';
      } else {
        document.body.dataset.autoDriveLaneAssist = 'inside-road';
      }
    }
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
        if (autoMode === 'seaCruise130' || autoMode === 'forestCruise130Drift') {
          const target = 130 / 3.6;
          document.body.dataset.autoDriveTargetKmh = '130';
          document.body.dataset.autoDrivePhase =
            autoMode === 'forestCruise130Drift'
              ? 'forest-portal-cruise'
              : 'left-lane-portal-cruise';
          return {
            throttle: speed < target,
            brake: speed > target + 1.5,
            handbrake: false,
            steer: 0,
          };
        }
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
    document.body.dataset.autoDriveWaypoint = [
      wp.x.toFixed(2),
      wp.z.toFixed(2),
      diff.toFixed(3),
    ].join(',');

    if (autoMode === 'seaCruise130') {
      const target = 130 / 3.6;
      document.body.dataset.autoDriveTargetKmh = '130';
      document.body.dataset.autoDrivePhase = 'left-lane-cruise';
      return {
        throttle: speed < target,
        brake: speed > target + 1.5,
        handbrake: false,
        steer: clamp(diff * 1.45, -1, 1),
      };
    }

    if (autoMode === 'forestCruise130Drift') {
      // 2m間隔の森林道路ルートを約12m・24m先まで読み、
      // 緩いカーブは130km/h巡航、急カーブだけサイドブレーキで旋回する。
      const diffNearCurve = angleTo(wps[(autoIdx + 6) % n]);
      const diffFarCurve = angleTo(wps[(autoIdx + 12) % n]);
      const curveAmount = Math.max(
        Math.abs(diff),
        Math.abs(diffFar),
        Math.abs(diffNearCurve),
        Math.abs(diffFarCurve)
      );
      const sharp = curveAmount > 0.42;
      const bend = curveAmount > 0.22;
      // 通常道路と緩いカーブは130km/hを維持。急カーブだけ
      // ドリフト旋回に必要な105km/hまで落とす。
      const targetKmh = sharp ? 105 : 130;
      const target = targetKmh / 3.6;
      // 遠方の急カーブを見つけた時点では減速だけ行い、サイドブレーキは
      // 実際の曲がり口へ来てから使う。長時間のロックによる失速を防ぐ。
      const driftNow = sharp
        && (Math.abs(diff) > 0.24 || Math.abs(diffFar) > 0.32);
      document.body.dataset.autoDriveTargetKmh = String(targetKmh);
      document.body.dataset.autoDrivePhase = driftNow
        ? 'forest-drift'
        : bend
          ? 'forest-bend'
          : 'forest-cruise';
      return {
        throttle: speed < target,
        brake: sharp && speed > target + 5,
        handbrake: driftNow && speed > 24,
        steer: clamp(diff * (player.drifting ? 2.45 : 1.7), -1, 1),
      };
    }

    if (autoMode === 'indyBankDrift') {
      const diffCurve = angleTo(wps[(autoIdx + 10) % n]);
      const curve = Math.abs(diffCurve) > 0.16 || Math.abs(diffFar) > 0.22;
      const sharp = Math.abs(diffCurve) > 0.38 || Math.abs(diffFar) > 0.42;
      // 直線はコース別のユーザー車上限。バンクカーブは速度を残してサイドブレーキで旋回。
      const target = curve ? (sharp ? 112 : 142) / 3.6 : PLAYER_TOP_SPEED;
      document.body.dataset.autoDriveTargetKmh =
        String(curve ? (sharp ? 112 : 142) : PLAYER_TOP_SPEED_KMH);
      document.body.dataset.autoDrivePhase = curve ? 'bank-drift' : 'full-throttle';
      return {
        throttle: speed < target,
        brake: sharp && speed > target + 7,
        handbrake: curve && speed > 24,
        steer: clamp(diff * (player.drifting ? 2.35 : 1.75), -1, 1),
      };
    }

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
      wps, idx: (s + 1) % wps.length, radius: carRadiusFor(bike, g.group), criminal: true,
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
    // 4コースデモはすべて各コースのY自動運転と同じ5速巡航。
    if (demoActive) player.gear = car2AutoRoute ? 6 : (SUZUKA_MODE ? 5 : 3);
    // gears
    // シフトが実際に動いた時だけ音を鳴らす（端で押しても鳴らさない）。
    if (shiftUp) {
      const next = Math.min(player.gear + 1, GEARS.length - 1);
      if (next !== player.gear) AUDIO.playGearShift();
      player.gear = next;
      shiftUp = false;
    }
    if (shiftDown) {
      const next = Math.max(player.gear - 1, 0);
      if (next !== player.gear) AUDIO.playGearShift();
      player.gear = next;
      shiftDown = false;
    }
    const gear = GEARS[player.gear];

    let throttle, brake, handbrake, input;
    if (demoActive) {
      // 各コースのデモはY自動運転と同じルート/速度/ドリフト制御を使う。
      const c = car2AutoRoute ? car2Autopilot() : demoAutopilot();
      throttle = c.throttle; brake = c.brake; handbrake = c.handbrake; input = c.steer;
    } else if (autoDrive && car2AutoRoute) {
      if (player.gear < 6) player.gear = 6;   // 自動運転は5速固定で巡航
      const c = car2Autopilot();
      throttle = c.throttle; brake = c.brake; handbrake = c.handbrake; input = c.steer;
    } else if (indyBankCrossDebug) {
      // 急バンク再現試験は、実プレイと同じくアクセルとドリフトを維持する。
      throttle = true;
      brake = false;
      handbrake = true;
      input = 0;
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
      const accelMultiplier = gear.vmax > 0 ? PLAYER_ACCEL_MULTIPLIER : 1;
      vF += Math.sign(gear.vmax) * gear.acc * accelMultiplier * factor * dt;
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
    // 移動後では高速時に薄い壁を通り越すため、現在位置から移動予定距離の
    // 全体へ先行レイを飛ばし、速度を壁面方向から除いてから移動する。
    const wallBlockedThisFrame = mapRoot ? collideWalls(dt) : false;
    advancePlayerAcrossMap(player.vel.x * dt, player.vel.z * dt);

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
      if (d2 >= min * min || d2 < 1e-6) return false;
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
      return true;
    }
    if (COURSE_KEY !== 'sea') {
      for (const o of obstacles) collideCircle(o.x, o.z, o.r);
    }
    // CPU車との衝突は、車の向きに合わせた長方形（車体よりやや小さめ）で判定する。
    // ユーザー車側は前後2点の円で近似し、長方形へ入り込んだ分だけ外へ押し出す。
    function collideCarRect(cx, cz, heading, halfL, halfW) {
      const fxr = Math.sin(heading), fzr = Math.cos(heading);   // 相手の前方
      const rxr = fzr, rzr = -fxr;                              // 相手の右方
      const pfx = Math.sin(player.heading), pfz = Math.cos(player.heading);
      let hit = false;
      for (const off of [1.4, -1.4]) {
        const px = player.pos.x + pfx * off;
        const pz = player.pos.z + pfz * off;
        const dx = px - cx, dz = pz - cz;
        const lf = clamp(dx * fxr + dz * fzr, -halfL, halfL);
        const lr = clamp(dx * rxr + dz * rzr, -halfW, halfW);
        const nearX = cx + fxr * lf + rxr * lr;
        const nearZ = cz + fzr * lf + rzr * lr;
        let nx = px - nearX, nz = pz - nearZ;
        const d2 = nx * nx + nz * nz;
        if (d2 >= player.radius * player.radius) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          // 中心まで食い込んだ場合は相手の中心から離れる向きへ出す。
          const away = Math.hypot(dx, dz) || 1;
          nx = dx / away;
          nz = dz / away;
          d = 0;
        } else {
          nx /= d;
          nz /= d;
        }
        const push = player.radius - d;
        player.pos.x += nx * push;
        player.pos.z += nz * push;
        const dot = player.vel.x * nx + player.vel.z * nz;
        if (dot < 0) {
          player.vel.x -= 1.6 * dot * nx;
          player.vel.z -= 1.6 * dot * nz;
          player.vel.multiplyScalar(0.5);
        }
        hit = true;
      }
      return hit;
    }
    // 自動運転中(Yキー・デモ)はCPU車とすり抜ける。ユーザー車はルート上を、
    // CPU車は走行ライン上を、どちらも毎フレーム強制されるため、当たり判定を
    // 効かせると押し合いになって両方その場で止まってしまう。
    // ユーザーが操作している間は従来どおり当たり判定あり（ぶつかれば避ける）。
    // 海岸線は交通量を優先し、操作中も相互にすり抜ける。
    const cpuCollisionOff = COURSE_KEY === 'sea' || demoActive || autoDrive;
    document.body.dataset.playerCpuCollisionMode = cpuCollisionOff ? 'pass' : 'solid';
    if (!cpuCollisionOff) {
      for (const ai of aiCars) {
        // 出番待ちの車（非表示）には当たらない。位置が残ったままなので、
        // 判定すると見えない車に衝突する。
        if (ai.appearManaged && !ai.active) continue;
        // 普通車2.1×4.6mに対し1.9×4.2mの長方形（やや小さめ＝ユーザー指定）。
        // 長さは車体の実寸に合わせてあるので、track.vox など長い車では長くなる。
        const halfL = ai.group.userData.collideHalfLength
          ?? (ai.kabu ? BIKE_COLLIDE_HALF_LENGTH : CAR_COLLIDE_HALF_LENGTH);
        const halfW = ai.group.userData.collideHalfWidth
          ?? (ai.kabu ? BIKE_COLLIDE_HALF_WIDTH : CAR_COLLIDE_HALF_WIDTH);
        if (collideCarRect(
          ai.group.position.x, ai.group.position.z, ai.heading, halfL, halfW
        )) {
          document.body.dataset.playerCpuCollisions = String(
            Number(document.body.dataset.playerCpuCollisions || 0) + 1
          );
        }
      }
    }

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
    let mapSurfaceAligned = false;
    playerOnSand = false;
    if (mapRoot) {
      let roadSurface = keepCar2OnRoad();
      const wrongLayerAfterWall = roadSurface
        && Math.abs(roadSurface.point.y - player.pos.y) > playerVehicleHeight * 0.75;
      if (wallBlockedThisFrame && (!roadSurface || wrongLayerAfterWall)) {
        // 壁際で走行面を見失ったり、壁の向こう側の屋根・上層を拾った場合は、
        // 直前の正常な接地位置へ戻して宙に浮く状態を防ぐ。
        player.pos.copy(car2LastRoadPos);
        player.vel.multiplyScalar(0.2);
        roadSurface = getMapSurfaceAt(player.pos.x, player.pos.z, player.pos.y);
      }
      if (roadSurface?.face) {
        playerOnSand = sandMeshes.includes(roadSurface.object);
        document.body.dataset.playerSurface = playerOnSand ? 'sand' : 'drivable';
        mapFallVelocity = 0;
        mapMissingSurfaceTime = 0;
        // 中心面の法線でバンクを取得する。親グループが旋回角を持つため、
        // 法線は車体ローカルへ戻してからピッチ/ロールへ変換する。
        roadSurfaceNormal.copy(roadSurface.face.normal)
          .transformDirection(roadSurface.object.matrixWorld)
          .normalize();
        // 表裏が逆の面でも、車体の上方向へ揃えてから傾きを計算する。
        if (roadSurfaceNormal.y < 0) roadSurfaceNormal.negate();
        roadSurfaceLocalUp.copy(roadSurfaceNormal)
          .applyAxisAngle(UP, -player.heading)
          .normalize();
        let roadPitch = Math.atan2(roadSurfaceLocalUp.z, roadSurfaceLocalUp.y);
        let roadRoll = Math.atan2(-roadSurfaceLocalUp.x, roadSurfaceLocalUp.y);

        // 4輪位置で路面を測る。斜めに坂へ入る場合や、片側だけバンクへ入る場合も
        // 車体全体に対するピッチ・ロール・中心高を同時に求める。
        const rightX = fz;
        const rightZ = -fx;
        const centerSurfaceY = roadSurface.point.y;
        // ぐんまーの低い垂直リップは、前輪が先に上面を拾うことで車体を
        // 短い仮想坂のように持ち上げる。他マップは従来値のまま。
        const maxWheelLayerError = Math.max(
          0.32,
          playerClimbHeight * 1.1,
          roadSeamAssistHeight(roadSurface.object)
        );
        const sampleWheelY = (forward, right) => {
          const dx = fx * forward + rightX * right;
          const dz = fz * forward + rightZ * right;
          if (roadSurface.seaBridgeInfo) {
            // 仮想スロープ上では4輪それぞれの進み具合から高さを求める。
            // 前輪→後輪の順に上下するため、道路と草地の往復でも車体が自然に傾く。
            return seaBridgeHeightAt(
              roadSurface.seaBridgeInfo,
              player.pos.x + dx,
              player.pos.z + dz
            );
          }
          // 中心面の平面上で予想した高さを基準にする。これにより橋・トンネル・
          // バンクで一輪だけ下層の面を拾い、車体が地面へ沈むことを防ぐ。
          const expectedY = centerSurfaceY
            - (roadSurfaceNormal.x * dx + roadSurfaceNormal.z * dz)
              / Math.max(0.05, roadSurfaceNormal.y);
          const surface = getMapSurfaceAt(player.pos.x + dx, player.pos.z + dz, expectedY);
          if (!surface) return expectedY;
          const layerError = surface.point.y - expectedY;
          if (Math.abs(layerError) > maxWheelLayerError) return expectedY;
          // 数cmの三角面誤差は姿勢計算へ入れず、連続した坂・バンクはそのまま使う。
          return Math.abs(layerError) < 0.035 ? expectedY : surface.point.y;
        };
        const frontLeftY = sampleWheelY(PLAYER_AXLE_HALF, -PLAYER_TRACK_HALF);
        const frontRightY = sampleWheelY(PLAYER_AXLE_HALF, PLAYER_TRACK_HALF);
        const rearLeftY = sampleWheelY(-PLAYER_AXLE_HALF, -PLAYER_TRACK_HALF);
        const rearRightY = sampleWheelY(-PLAYER_AXLE_HALF, PLAYER_TRACK_HALF);
        const frontY = (frontLeftY + frontRightY) * 0.5;
        const rearY = (rearLeftY + rearRightY) * 0.5;
        const leftY = (frontLeftY + rearLeftY) * 0.5;
        const rightY = (frontRightY + rearRightY) * 0.5;
        roadPitch = -Math.atan2(frontY - rearY, PLAYER_AXLE_HALF * 2);
        roadRoll = Math.atan2(rightY - leftY, PLAYER_TRACK_HALF * 2);
        // ぐんまーの粗い路面は、4点が同一平面に乗らない「ねじれ」がある。
        // 平均高だと高い側へ車体がめり込むため、求めた剛体平面が全支持点より
        // 必ず上になる最小の中心高を使う（低い側のタイヤが少し浮くのは許容）。
        const forwardSlope = (frontY - rearY) / (PLAYER_AXLE_HALF * 2);
        const rightSlope = (rightY - leftY) / (PLAYER_TRACK_HALF * 2);
        const supportCenterY = Math.max(
          centerSurfaceY,
          frontLeftY - forwardSlope * PLAYER_AXLE_HALF
            + rightSlope * PLAYER_TRACK_HALF,
          frontRightY - forwardSlope * PLAYER_AXLE_HALF
            - rightSlope * PLAYER_TRACK_HALF,
          rearLeftY + forwardSlope * PLAYER_AXLE_HALF
            + rightSlope * PLAYER_TRACK_HALF,
          rearRightY + forwardSlope * PLAYER_AXLE_HALF
            - rightSlope * PLAYER_TRACK_HALF
        );
        player.pos.y = supportCenterY
          + CAR_CONFIGS[PLAYER_CAR_KEY].groundOffset + 0.012;
        roadTiltEuler.set(roadPitch, 0, roadRoll);
        roadTiltTarget.setFromEuler(roadTiltEuler);
        mapSurfaceAligned = true;
        document.body.dataset.playerFallingOutsideRoad = 'false';
        if (seaRoadGrassDebug) {
          seaRoadGrassDebug.minY = Math.min(seaRoadGrassDebug.minY, player.pos.y);
          seaRoadGrassDebug.maxY = Math.max(seaRoadGrassDebug.maxY, player.pos.y);
          seaRoadGrassDebug.maxYStep = Math.max(
            seaRoadGrassDebug.maxYStep,
            Math.abs(player.pos.y - seaRoadGrassDebug.lastY)
          );
          seaRoadGrassDebug.maxTiltDeg = Math.max(
            seaRoadGrassDebug.maxTiltDeg,
            THREE.MathUtils.radToDeg(Math.max(Math.abs(roadPitch), Math.abs(roadRoll)))
          );
          seaRoadGrassDebug.lastY = player.pos.y;
        }
        if (indyBankCrossDebug) {
          indyBankCrossDebug.frames++;
          if (player.drifting) indyBankCrossDebug.driftFrames++;
          indyBankCrossDebug.minY = Math.min(indyBankCrossDebug.minY, player.pos.y);
          indyBankCrossDebug.maxY = Math.max(indyBankCrossDebug.maxY, player.pos.y);
          indyBankCrossDebug.minSpeed = Math.min(
            indyBankCrossDebug.minSpeed,
            player.vel.length()
          );
          indyBankCrossDebug.maxTiltDeg = Math.max(
            indyBankCrossDebug.maxTiltDeg,
            THREE.MathUtils.radToDeg(Math.max(Math.abs(roadPitch), Math.abs(roadRoll)))
          );
        }
      } else {
        if (MAP_CONFIG.fallOutsideRoad) {
          // M08道路の外では、緑地・建物上面など別材質を足場として拾わない。
          // ただし三角面のごく小さな継ぎ目は0.12秒だけ保持し、走行中の瞬間的な
          // レイ抜けで落下しないようにする。
          mapMissingSurfaceTime += dt;
          if (mapMissingSurfaceTime > 0.12) {
            mapFallVelocity = Math.max(-45, mapFallVelocity - 18 * dt);
            player.pos.y += mapFallVelocity * dt;
            document.body.dataset.playerFallingOutsideRoad = 'true';
          }
        } else {
          // 小さな穴やメッシュ境界では直前の高さ・傾きを保持する。無条件の
          // 下向きレイは道路下の地面を拾い、坂道カーブで落下する原因になる。
          mapSurfaceAligned = true;
        }
      }
    } else {
      // 街モード: ドリフトコースの坂に乗る(平地では高さ 0 で従来どおり)
      const gy = courseHeightAt(player.pos.x, player.pos.z);
      player.pos.y += (gy - player.pos.y) * Math.min(1, dt * 9);
      const hx = Math.sin(player.heading) * 3, hz = Math.cos(player.heading) * 3;
      const hF = courseHeightAt(player.pos.x + hx, player.pos.z + hz);
      const hB = courseHeightAt(player.pos.x - hx, player.pos.z - hz);
      slopePitch = Math.atan2(hF - hB, 6);   // 登りで + / 下りで -
    }

    if (seaSideCrossDebug && player.pos.x <= seaSideCrossDebug.targetX) {
      document.body.dataset.debugSeaSideCross = 'passed';
      document.body.dataset.debugSeaSideCrossDistance =
        (seaSideCrossDebug.startX - player.pos.x).toFixed(2);
      document.body.dataset.debugSeaSideCrossBlockedStops =
        document.body.dataset.mapBlockedSurfaceStops || '0';
      player.vel.set(0, 0, 0);
      seaSideCrossDebug = null;
    }
    if (seaGrassClimbDebug && player.pos.x >= seaGrassClimbDebug.targetX) {
      document.body.dataset.debugSeaGrassClimb = 'passed';
      document.body.dataset.debugSeaGrassClimbDistance =
        (player.pos.x - seaGrassClimbDebug.startX).toFixed(2);
      document.body.dataset.debugSeaGrassClimbFinalY = player.pos.y.toFixed(3);
      document.body.dataset.debugSeaGrassClimbRise =
        (player.pos.y - seaGrassClimbDebug.startY).toFixed(3);
      document.body.dataset.debugSeaGrassClimbBlockedStops =
        document.body.dataset.mapBlockedSurfaceStops || '0';
      document.body.dataset.debugSeaGrassClimbBridgeUses =
        document.body.dataset.mapSeaForwardBridgeUses || '0';
      player.vel.set(0, 0, 0);
      seaGrassClimbDebug = null;
    }
    if (seaRoadGrassDebug) {
      if (
        seaRoadGrassDebug.phase === 'outbound'
        && player.pos.x <= seaRoadGrassDebug.targetX
      ) {
        seaRoadGrassDebug.phase = 'return';
        player.heading = Math.PI / 2;
        player.vel.set(8, 0, 0);
        document.body.dataset.debugSeaRoadGrass = 'return';
      } else if (
        seaRoadGrassDebug.phase === 'return'
        && player.pos.x >= seaRoadGrassDebug.startX
      ) {
        document.body.dataset.debugSeaRoadGrass = 'passed';
        document.body.dataset.debugSeaRoadGrassMinY =
          seaRoadGrassDebug.minY.toFixed(3);
        document.body.dataset.debugSeaRoadGrassMaxY =
          seaRoadGrassDebug.maxY.toFixed(3);
        document.body.dataset.debugSeaRoadGrassMaxYStep =
          seaRoadGrassDebug.maxYStep.toFixed(4);
        document.body.dataset.debugSeaRoadGrassMaxTiltDeg =
          seaRoadGrassDebug.maxTiltDeg.toFixed(2);
        document.body.dataset.debugSeaRoadGrassBridgeUses =
          document.body.dataset.mapSeaForwardBridgeUses || '0';
        player.vel.set(0, 0, 0);
        seaRoadGrassDebug = null;
      }
    }
    if (indyBankCrossDebug) {
      const reachedTarget = indyBankCrossDebug.directionX > 0
        ? player.pos.x >= indyBankCrossDebug.target.x
        : player.pos.x <= indyBankCrossDebug.target.x;
      const returnedToStart = indyBankCrossDebug.directionX > 0
        ? player.pos.x <= indyBankCrossDebug.start.x
        : player.pos.x >= indyBankCrossDebug.start.x;
      if (indyBankCrossDebug.phase === 'climb' && reachedTarget) {
        indyBankCrossDebug.phase = 'descent';
        const descentHeading = indyBankCrossDebug.directionX > 0
          ? -Math.PI / 2
          : Math.PI / 2;
        player.heading = descentHeading - indyBankCrossDebug.directionX * 0.45;
        player.vel.set(-indyBankCrossDebug.directionX * 10, 0, 0);
        player.drifting = true;
        document.body.dataset.debugIndyBankCross = 'descent';
      } else if (indyBankCrossDebug.phase === 'descent' && returnedToStart) {
        document.body.dataset.debugIndyBankCross = 'passed';
        document.body.dataset.debugIndyBankCrossMinY =
          indyBankCrossDebug.minY.toFixed(3);
        document.body.dataset.debugIndyBankCrossMaxY =
          indyBankCrossDebug.maxY.toFixed(3);
        document.body.dataset.debugIndyBankCrossMinSpeedKmh =
          (indyBankCrossDebug.minSpeed * 3.6).toFixed(1);
        document.body.dataset.debugIndyBankCrossMaxTiltDeg =
          indyBankCrossDebug.maxTiltDeg.toFixed(2);
        document.body.dataset.debugIndyBankCrossDriftPercent = (
          indyBankCrossDebug.driftFrames
          / Math.max(1, indyBankCrossDebug.frames) * 100
        ).toFixed(1);
        document.body.dataset.debugIndyBankCrossWallHits = String(
          mapWallCollisionCount - indyBankCrossDebug.startWallHits
        );
        document.body.dataset.debugIndyBankCrossSeamPasses =
          document.body.dataset.indyBankSeamPasses || '0';
        player.vel.set(0, 0, 0);
        indyBankCrossDebug = null;
      }
    }

    // visuals
    player.group.position.copy(player.pos);
    player.group.rotation.y = player.heading;   // テールランプ残像はCPU車のみ
    const acc = (vF - vBefore) / Math.max(dt, 1e-4);
    player.accSmooth += (acc - player.accSmooth) * Math.min(1, dt * 5);
    // 荷重移動:
    // 左操舵(正)では右側を沈め、右操舵(負)では左側を沈める。
    // 加速(正)では後ろを沈め、減速・ブレーキ(負)では前を沈める。
    const driveRoll = clamp(-player.steer * vF * 0.010 + vS * 0.008, -0.09, 0.09);
    const drivePitch = clamp(-player.accSmooth * 0.006, -0.28, 0.28);
    if (mapSurfaceAligned) {
      // 路面だけを滑らかに追従させ、以前の旋回・加減速の傾きは遅延なしで重ねる。
      // 前後車軸の高さと同時に姿勢を合わせるため、路面側も遅延させない。
      smoothedRoadTilt.copy(roadTiltTarget);
      driveTiltEuler.set(drivePitch, 0, driveRoll);
      driveTiltTarget.setFromEuler(driveTiltEuler);
      combinedTiltTarget.copy(smoothedRoadTilt).multiply(driveTiltTarget);
      player.tilt.quaternion.copy(combinedTiltTarget);
    } else {
      // 手続き生成コースでも同じ荷重移動方向を使い、地形ピッチを加える。
      player.tilt.rotation.z = driveRoll;
      player.tilt.rotation.x = clamp(drivePitch - slopePitch, -0.28, 0.28);
    }

    // D02砂浜は通常走行でも砂煙を出す。ドリフト中は発生間隔を短くして濃くする。
    const sandDustHeavy = player.drifting && Math.abs(vS) > 1.6;
    if (playerOnSand && player.vel.length() > 1.0 && dustPool.length) {
      emitSandDust(fx, fz, sx, sz, dt, sandDustHeavy);
    } else if (player.drifting && Math.abs(vS) > 1.6) {
      emitTyreFx(fx, fz, sx, sz, dt);
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
    let cpuOvertakingNow = 0;
    let tokyoCpuDriftingNow = 0;
    let tokyoCpuMinSpeedNow = Infinity;
    let indyCpuDriftingNow = 0;
    let indyCpuBankAlignedNow = 0;
    let indyCpuBankSurfaceMissesNow = 0;
    let indyCpuMinSpeedNow = Infinity;
    let indyCpuMaxSlipNow = 0;
    // 出現タイマーと、離れすぎた車の引き上げ。
    if (CAR2_MODE) updateCar2CpuTraffic(dt);
    for (const ai of aiCars) {
      // 出番待ちの車は動かさない（描画もしない）。
      if (ai.appearManaged && !ai.active) continue;
      if (ai.car2Loop) {
        // ワープ検出。前フレームの速度から進めるはずの距離を大きく超えたら記録。
        if (ai.stepPrevX !== undefined) {
          const step = Math.hypot(ai.pos.x - ai.stepPrevX, ai.pos.z - ai.stepPrevZ);
          const limit = (ai.v + 10) * (ai.stepPrevDt || dt) * 2 + 1;
          if (step > limit && step > cpuWorstJumpMeters) {
            cpuWorstJumpMeters = step;
            // どの状況で跳んだかを残す（原因調査用）。
            document.body.dataset.cpuMaxJumpInfo = [
              'idx=' + ai.idx, 'len=' + ai.wps.length,
              'lane=' + (ai.laneShift ?? 0).toFixed(1),
              'v=' + (ai.v * 3.6).toFixed(0),
              'from=' + ai.stepPrevX.toFixed(1) + ',' + ai.stepPrevZ.toFixed(1),
              'to=' + ai.pos.x.toFixed(1) + ',' + ai.pos.z.toFixed(1),
            ].join(' ');
          }
        }
        ai.stepPrevX = ai.pos.x;
        ai.stepPrevZ = ai.pos.z;
        ai.stepPrevDt = dt;
      }
      if (ai.car2Loop) {
        const targetWp = ai.wps[ai.idx];
        const previousWp = ai.wps[Math.max(0, ai.idx - 1)];
        const segX = targetWp.x - previousWp.x;
        const segZ = targetWp.z - previousWp.z;
        const passed = (ai.pos.x - targetWp.x) * segX + (ai.pos.z - targetWp.z) * segZ > 0;
        const reached = Math.hypot(targetWp.x - ai.pos.x, targetWp.z - ai.pos.z) < 11;
        if ((passed || reached) && ai.idx >= ai.wps.length - 1 && ai.closedLoop) {
          // 周回コース(インディ)はルートが輪。位置も向きもそのままに
          // 目標だけ先頭へ戻す。座標を書き換えると周回のたびに車が跳ぶ。
          ai.idx = 0;
        } else if ((passed || reached) && ai.idx >= ai.wps.length - 1) {
          // 追越し用交通はループ先頭へ一斉に出現させず、その時点の
          // プレイヤー前方へ各車固有の車間で再配置する。
          const respawnIndex = ai.overtakeTraffic
            ? routeIndexAheadByDistance(
              ai.wps,
              nearestRouteIndexTo(ai.wps, player.pos.x, player.pos.z),
              ai.respawnAheadM ?? 180
            )
            : 0;
          const nextIndex = Math.min(ai.wps.length - 1, respawnIndex + 1);
          const start = ai.wps[respawnIndex], next = ai.wps[nextIndex];
          const startY = Number.isFinite(start.y)
            ? start.y
            : groundHeightAt(start.x, 6, start.z);
          ai.pos.set(start.x, startY, start.z);
          ai.heading = Math.atan2(next.x - start.x, next.z - start.z);
          ai.idx = nextIndex;
          ai.travelFromX = ai.pos.x;
          ai.travelFromZ = ai.pos.z;
          ai.stepPrevX = undefined;   // ルート端の巻き戻しはワープ検出に数えない
          if (ai.overtakeTraffic) {
            document.body.dataset.cpuRespawnedAhead = String(
              Number(document.body.dataset.cpuRespawnedAhead || 0) + 1
            );
          }
        } else if (passed || reached) {
          ai.idx++;
        }
      }
      // 前をふさいでいる車を1台だけ拾い（ユーザー車も含む）、抜けるならレーンをずらす。
      let blockedAhead = null;
      if (ai.rankLane || ai.indyLane) {
        const fx = Math.sin(ai.heading), fz = Math.cos(ai.heading);
        let outerBusy = false;
        let innerBusy = false;
        const consider = (x, z, v, otherShift) => {
          const rx = x - ai.pos.x, rz = z - ai.pos.z;
          const ahead = rx * fx + rz * fz;
          const lateral = Math.abs(rx * fz - rz * fx);
          const distance = Math.hypot(rx, rz);
          if (ahead >= 0 && ahead <= CAR2_CPU_OVERTAKE_LOOK_M
            && lateral <= CAR2_CPU_OVERTAKE_LATERAL_M
            && (!blockedAhead || ahead < blockedAhead.gap)) {
            blockedAhead = { gap: ahead, v };
          }
          if (!ai.indyLane) return;
          // インディは隣のラインが空いているかも見る（前後どちらの車も邪魔になる）。
          if (distance < INDY_CROWD_LOOK_M && ahead > -12) {
            const relative = otherShift - (ai.laneShift ?? 0);
            if (relative > 0.8) outerBusy = true;
            if (relative < -0.8) innerBusy = true;
          }
        };
        for (const other of aiCars) {
          if (other !== ai && (other.rankLane || other.indyLane) && other.active !== false) {
            consider(other.pos.x, other.pos.z, other.v, other.laneShift ?? 0);
          }
        }
        // ユーザー車はバンクの外寄りを走るので、外側の混雑として数える。
        consider(
          player.pos.x, player.pos.z,
          Math.hypot(player.vel.x, player.vel.z),
          ai.indyLane ? 99 : 0
        );
        // 自分より遅い相手にだけ仕掛ける。
        const blocked = Boolean(blockedAhead) && blockedAhead.v < ai.v - 0.6;
        const playerNearby = Math.hypot(
          player.pos.x - ai.pos.x, player.pos.z - ai.pos.z
        ) < CAR2_PLAYER_LANE_CLEAR_M;
        // 行き先を毎フレーム決め直すと車が左右にフラつく。一度決めたら
        // しばらく保ってから次の判断に移る。
        ai.laneHoldIn = (ai.laneHoldIn ?? 0) - dt;
        if (ai.laneHoldIn <= 0) {
          const decided = ai.indyLane
            ? indyLaneShiftFor(blocked, outerBusy, innerBusy)
            : car2LaneShiftFor(ai, blocked, playerNearby);
          if (decided !== ai.laneTarget) {
            ai.laneTarget = decided;
            ai.laneHoldIn = CPU_LANE_HOLD_S;
            cpuOvertakeStartTotal++;
          }
        }
        const previousShift = ai.laneShift ?? 0;
        const targetShift = ai.laneTarget ?? 0;
        // 車線変更は実車と同じくらいの時間をかける。速いと横へワープしたように見える。
        ai.laneShift = previousShift
          + (targetShift - previousShift) * Math.min(1, dt * CPU_LANE_CHANGE_RATE);
        if (Math.abs(ai.laneShift) < 0.02) ai.laneShift = 0;
        if (Math.abs(ai.laneShift) > 0.5) cpuOvertakingNow++;
      }
      let wp = ai.wps[ai.idx];
      if (ai.laneShift) {
        // 追い越し中は目標点も横へずらし、隣の線をなぞらせる。
        const previous = ai.wps[Math.max(0, ai.idx - 1)];
        const ex = wp.x - previous.x, ez = wp.z - previous.z;
        const length = Math.hypot(ex, ez) || 1;
        wp = {
          x: wp.x + (ez / length) * ai.laneShift,
          z: wp.z - (ex / length) * ai.laneShift,
        };
      }
      const dx = wp.x - ai.pos.x, dz = wp.z - ai.pos.z;
      if (!ai.car2Loop && dx * dx + dz * dz < 6 * 6) ai.idx = (ai.idx + 1) % ai.wps.length;

      let diff = Math.atan2(dx, dz) - ai.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      let indyCurve = 0;
      if (ai.indyBanked) {
        const lookAhead = ai.wps[(ai.idx + 5) % ai.wps.length];
        indyCurve = Math.atan2(
          lookAhead.x - ai.pos.x,
          lookAhead.z - ai.pos.z
        ) - ai.heading;
        while (indyCurve > Math.PI) indyCurve -= Math.PI * 2;
        while (indyCurve < -Math.PI) indyCurve += Math.PI * 2;
        // バンクのコーナーへ入る瞬間に、そのコーナーをドリフトで回るか1回だけ決める。
        // 8割はドリフト・2割はグリップ走行。ドリフトの方がコーナーで遅い。
        const inCorner = Math.abs(indyCurve) > 0.08 || Math.abs(diff) > 0.08;
        if (inCorner && !ai.wasInCorner) ai.cornerDrift = Math.random() < INDY_DRIFT_CHANCE;
        ai.wasInCorner = inCorner;
      }
      const turn = ai.turnRate ?? (ai.criminal ? 2.2 : 1.7);   // 犯人はキビキビ曲がる
      ai.heading += clamp(diff, -turn * dt, turn * dt);

      // slow down for corners(犯人は減速控えめ)
      const cornerSlowdown = ai.cornerSlowdown ?? (ai.criminal ? 0.45 : 0.72);
      let target;
      if (ai.indyBanked) {
        const nearCurve = Math.max(Math.abs(diff), Math.abs(indyCurve));
        if (ai.cornerDrift === false) {
          // グリップ走行: 205km/hまで進入前に減速を終えてから曲がる。
          // 60m先まで見てブレーキし、コーナー中は上限を強制する。
          const farAhead = ai.wps[(ai.idx + 11) % ai.wps.length];
          let farCurve = Math.atan2(
            farAhead.x - ai.pos.x, farAhead.z - ai.pos.z
          ) - ai.heading;
          while (farCurve > Math.PI) farCurve -= Math.PI * 2;
          while (farCurve < -Math.PI) farCurve += Math.PI * 2;
          const cap = INDY_CORNER_GRIP_KMH / 3.6;
          const intensity = Math.min(1, Math.max(nearCurve, Math.abs(farCurve)) * 4);
          target = ai.base - Math.max(0, ai.base - cap) * intensity;
          ai.cornerCapNow = nearCurve > 0.08 ? cap : null;
          ai.driftScrubCap = null;
        } else {
          // ドリフト走行: ブレーキで事前減速しない。コーナーへ入ったら横滑り
          // そのものが速度を削り、150km/h近辺まで勝手に落ちる（ユーザー車と同じ）。
          const cap = INDY_CORNER_DRIFT_KMH / 3.6;
          target = nearCurve > 0.08 ? Math.min(ai.base, cap) : ai.base;
          ai.cornerCapNow = null;
          ai.driftScrubCap = cap;
        }
      } else if (ai.driftOnSharpCurve) {
        // 首都高もコーナリング性能はユーザー車と同じ絶対値。ドリフトで入る
        // カーブはブレーキではなく横滑りが速度を削る（下のスクラブ処理）。
        const capKmh = car2CornerCapKmh(ai);
        target = capKmh === null ? ai.base : Math.min(ai.base, capKmh / 3.6);
        ai.cornerCapNow = null;
        ai.driftScrubCap = capKmh === null ? null : capKmh / 3.6;
      } else {
        target = ai.base * (1 - cornerSlowdown * Math.min(1, Math.abs(diff) * 1.4));
      }
      // CPU同士は前車に合わせて減速しない。詰まったら横のレーンへ出て抜き、
      // それでも詰まる場面はすり抜けさせる。速度を落として車間を保つと、
      // 抜けない車が次々に後ろへ連なって数珠つなぎになるため（ユーザー指定）。
      if (ai.indyBanked) {
        // 同じ右回りライン上でCPUが自車へ後方から追突しないよう、
        // 前方の自車を検出した時だけ速度を合わせて最低12mの車間を守る。
        // 横へ並んだ自車には反応しないため、ユーザー側の追い越しは妨げない。
        const forwardX = Math.sin(ai.heading);
        const forwardZ = Math.cos(ai.heading);
        const toPlayerX = player.pos.x - ai.pos.x;
        const toPlayerZ = player.pos.z - ai.pos.z;
        const playerAhead = toPlayerX * forwardX + toPlayerZ * forwardZ;
        const playerLateral = Math.abs(
          toPlayerX * forwardZ - toPlayerZ * forwardX
        );
        let headingDifference = player.heading - ai.heading;
        while (headingDifference > Math.PI) headingDifference -= Math.PI * 2;
        while (headingDifference < -Math.PI) headingDifference += Math.PI * 2;
        if (
          playerAhead > 0
          && playerAhead < 34
          && playerLateral < 3.4
          && Math.abs(headingDifference) < 0.7
        ) {
          const playerForwardSpeed = Math.max(
            0,
            player.vel.x * forwardX + player.vel.z * forwardZ
          );
          const followingSpeed = playerForwardSpeed
            + Math.max(0, playerAhead - 12) * 0.55;
          target = Math.min(target, followingSpeed);
          // 高速接近時は通常の緩いCPU減速を待たず、追突前に速度を落とす。
          ai.v = Math.min(ai.v, followingSpeed);
          document.body.dataset.indyCpuRearEndBraking = String(
            Number(document.body.dataset.indyCpuRearEndBraking || 0) + 1
          );
          document.body.dataset.indyCpuFollowingGapMeters =
            playerAhead.toFixed(2);
        }
      }
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
        // グリップ走行の車だけブレーキで進入前に減速を終える。
        // ドリフト車はブレーキを使わず、横滑りの削り（下のスクラブ処理）に任せる。
        if (ai.indyBanked && ai.cornerDrift === false && target < ai.v) rate = 4;
        let deltaV = (target - ai.v) * Math.min(1, dt * rate);
        if (ai.indyBanked && deltaV > 0) {
          // 加速性能はユーザー車と同じ。速度差に比例した従来式のままだと
          // ドリフト明けに37m/s^2まで出てユーザー車(最大21m/s^2)を超えていた。
          deltaV = Math.min(deltaV, playerLikeMaxAccel(ai.v) * dt);
        }
        ai.v += deltaV;
        if (ai.indyBanked && dt > 0) {
          indyCpuMaxAccelNow = Math.max(indyCpuMaxAccelNow, deltaV / dt);
        }
        if (ai.cornerCapNow) {
          // グリップ走行のコーナー上限(205km/h)は絶対値で強制する。
          ai.v = Math.min(ai.v, ai.cornerCapNow);
        }
      }
      // car2 のCPU車はドリフトで曲がる: 車体(heading)が先に向きを変え、
      // 進行方向(dir)はグリップ分だけ遅れて追従する。コーナーではグリップを
      // 落として横滑り角がつき、直線で素早く収束する。
      let moveDir = ai.heading;
      if (ai.car2Loop) {
        if (ai.sequenceTraffic) {
          // 海岸線の一般車はドリフトさせず、左右それぞれの車線中心を走る。
          ai.dir = ai.heading;
          ai.slip = 0;
        } else {
          if (ai.dir === undefined) ai.dir = ai.heading;
          let slip = ai.heading - ai.dir;
          while (slip > Math.PI) slip -= Math.PI * 2;
          while (slip < -Math.PI) slip += Math.PI * 2;
          const curveAmount = ai.indyBanked
            ? Math.max(Math.abs(diff), Math.abs(indyCurve))
            : Math.abs(diff);
          // 首都高速CPUは、走行ラインの曲がり角が30度より大きいカーブだけドリフトで回る。
          const sharpTurn = ai.driftOnSharpCurve ? car2SharpTurnAhead(ai) : 0;
          const indyDrifting = ai.indyBanked
            && curveAmount > 0.08 && ai.cornerDrift !== false;
          const grip = ai.indyBanked
            ? (indyDrifting ? 0.85 : 4.5)
            : sharpTurn
              ? 1.1
              : (Math.abs(diff) > 0.12 ? 2.0 : 5.5);
          slip = clamp(slip * Math.exp(-grip * dt), -0.55, 0.55);
          if (ai.indyBanked && !indyDrifting) {
            // グリップ走行の車はスモークの出る横滑り角(0.15)まで行かせない。
            // コーナー中の追い越しで姿勢角が瞬間的に増えると、205km/hのまま
            // 「ドリフトしている」ように見えてしまうため。
            slip = clamp(slip, -0.12, 0.12);
          }
          if (indyDrifting) {
            // バンクカーブでは車体を先に内側へ向け、進行方向を遅らせて
            // 明確な横滑り角を維持する。直線へ入ると通常グリップへ戻る。
            const driftSign = Math.sign(indyCurve || diff || 1);
            const targetSlip = driftSign * Math.min(0.48, 0.12 + curveAmount * 0.75);
            slip += (targetSlip - slip) * Math.min(1, dt * 2.8);
          } else if (sharpTurn) {
            // 曲がる向きへ車体を先に振り、進行方向を遅らせて横滑り角を作る。
            const targetSlip = Math.sign(sharpTurn)
              * Math.min(0.5, 0.18 + Math.abs(sharpTurn) * 0.42);
            slip += (targetSlip - slip) * Math.min(1, dt * 3.2);
          }
          // ドリフトはブレーキではなく横滑りそのものが速度を削る（ユーザー車と同じ）。
          // 削り量は横滑り角に比例し、コーナー上限速度まで勝手に落ちて下回らない。
          if (ai.driftScrubCap != null && Math.abs(slip) > 0.12
            && ai.v > ai.driftScrubCap) {
            ai.v = Math.max(
              ai.driftScrubCap,
              ai.v - Math.abs(slip) * CPU_DRIFT_SCRUB_DECEL * dt
            );
          }
          ai.dir = ai.heading - slip;
          ai.slip = slip;
          moveDir = ai.dir;
          if (ai.indyBanked && Math.abs(slip) > 0.08) indyCpuDriftingNow++;
          if (ai.driftOnSharpCurve && Math.abs(slip) > 0.15) tokyoCpuDriftingNow++;
        }
      }
      ai.pos.x += Math.sin(moveDir) * ai.v * dt;
      ai.pos.z += Math.cos(moveDir) * ai.v * dt;
      if (ai.driftOnSharpCurve) {
        // 「同じ場所で震えて止まる」検出用に、実際に動いた距離を積算する。
        if (ai.travelFromX !== undefined) {
          ai.travelMeters = (ai.travelMeters || 0)
            + Math.hypot(ai.pos.x - ai.travelFromX, ai.pos.z - ai.travelFromZ);
        }
        ai.travelFromX = ai.pos.x;
        ai.travelFromZ = ai.pos.z;
        tokyoCpuMinSpeedNow = Math.min(tokyoCpuMinSpeedNow, ai.v);
        // すれ違い回数。近づいて離れるまでを1回と数える。
        const near = Math.hypot(ai.pos.x - player.pos.x, ai.pos.z - player.pos.z)
          < CAR2_CPU_ENCOUNTER_M;
        if (near && !ai.playerNear) car2CpuEncounterTotal++;
        ai.playerNear = near;
      }
      if (ai.sequenceTraffic && Number.isFinite(ai.fixedRouteX)) {
        // 海岸線は全区間が直線。固定経路へ戻したうえで、左右それぞれの
        // 車線X範囲から一切出ないよう座標で強制制限する。
        ai.pos.x = clamp(ai.fixedRouteX, ai.laneMinX, ai.laneMaxX);
        const prefix = ai.sequenceTraffic === 'oncoming'
          ? 'seaCpuOncomingActual'
          : 'seaCpuSameDirectionActual';
        const minKey = `${prefix}MinX`;
        const maxKey = `${prefix}MaxX`;
        const previousMin = Number(document.body.dataset[minKey]);
        const previousMax = Number(document.body.dataset[maxKey]);
        document.body.dataset[minKey] = String(
          Number.isFinite(previousMin) ? Math.min(previousMin, ai.pos.x) : ai.pos.x
        );
        document.body.dataset[maxKey] = String(
          Number.isFinite(previousMax) ? Math.max(previousMax, ai.pos.x) : ai.pos.x
        );
      }
      if (ai.car2Loop) {
        // 道路外へ出ないよう、毎フレーム走行ラインから横±2.5mに位置を制限。
        // ドリフトで膨らんでも壁の外へは絶対に出ない。
        // 周回コースは継ぎ目(終端→先頭)もセグメントとして見る。見ないと
        // idxが0へ戻った瞬間に「最寄り＝先頭の点」となり、継ぎ目の隙間の分
        // だけ車が前へスナップして毎周ワープになる。
        const segCount = ai.wps.length;
        let bestD2 = Infinity, bestX = 0, bestY = ai.pos.y, bestZ = 0, tanA = ai.heading;
        for (let off = -3; off <= 0; off++) {
          let s = ai.idx + off;
          if (ai.closedLoop) s = ((s % segCount) + segCount) % segCount;
          else if (s < 0 || s > segCount - 2) continue;
          const a = ai.wps[s];
          const b = ai.wps[ai.closedLoop ? (s + 1) % segCount : s + 1];
          const ex = b.x - a.x, ez = b.z - a.z;
          const len2 = ex * ex + ez * ez || 1;
          const t = clamp(((ai.pos.x - a.x) * ex + (ai.pos.z - a.z) * ez) / len2, 0, 1);
          const px = a.x + ex * t, pz = a.z + ez * t;
          const d2 = (ai.pos.x - px) ** 2 + (ai.pos.z - pz) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestX = px;
            bestY = Number.isFinite(a.y) && Number.isFinite(b.y)
              ? a.y + (b.y - a.y) * t
              : ai.pos.y;
            bestZ = pz;
            tanA = Math.atan2(ex, ez);
          }
        }
        if (ai.indyBanked) ai.routeSupportY = bestY;
        // 追い越し中は拘束の基準ライン自体を横へずらす。
        if (ai.laneShift) {
          bestX += Math.cos(tanA) * ai.laneShift;
          bestZ += -Math.sin(tanA) * ai.laneShift;
          bestD2 = (ai.pos.x - bestX) ** 2 + (ai.pos.z - bestZ) ** 2;
        }
        // 追い越し中は中心線側へ寄っているので、膨らみ代を絞って外へ出さない。
        const MAX_OFF = ai.laneShift && ai.overtakeMaxRouteOffset !== undefined
          ? ai.overtakeMaxRouteOffset
          : (ai.maxRouteOffset ?? 2.5);
        if (bestD2 > MAX_OFF * MAX_OFF) {
          const d = Math.sqrt(bestD2);
          ai.pos.x = bestX + (ai.pos.x - bestX) * (MAX_OFF / d);
          ai.pos.z = bestZ + (ai.pos.z - bestZ) * (MAX_OFF / d);
          ai.dir = tanA;                                // 端に達したら道なりへ戻す
          // インディCPUはファンタジー路面ロック。経路補正で速度を落とさない。
          if (!ai.indyBanked) ai.v = Math.min(ai.v, ai.base * 0.85);
        }
        ai.roadCheckIn -= dt;
        if (!ai.skipRoadRecovery && ai.roadCheckIn <= 0) {
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
            const recoveryY = Number.isFinite(at.y)
              ? at.y
              : groundHeightAt(at.x, 6, at.z);
            ai.pos.set(at.x, recoveryY, at.z);
            ai.heading = Math.atan2(next.x - at.x, next.z - at.z);
            ai.idx = nextIndex;
            ai.v = Math.min(ai.v, ai.base * 0.55);
            const recovered = Number(document.body.dataset.car2CpuRecoveries || 0) + 1;
            document.body.dataset.car2CpuRecoveries = String(recovered);
            if (ai.sequenceTraffic) {
              const recoveryKey = ai.sequenceTraffic === 'oncoming'
                ? 'seaCpuRecoveriesOncoming'
                : 'seaCpuRecoveriesSame';
              document.body.dataset[recoveryKey] = String(
                Number(document.body.dataset[recoveryKey] || 0) + 1
              );
            }
          }
        }
      }
      let aiBankPitch = 0;
      let aiBankRoll = 0;
      let aiBankAligned = false;
      if (mapRoot) {
        const bankSurface = ai.indyBanked
          ? getRoadSurfaceAt(ai.pos.x, ai.pos.z, ai.pos.y)
          : null;
        if (ai.indyBanked && bankSurface?.face && ai.tilt) {
          aiRoadNormal.copy(bankSurface.face.normal)
            .transformDirection(bankSurface.object.matrixWorld)
            .normalize();
          if (aiRoadNormal.y < 0) aiRoadNormal.negate();
          const forwardX = Math.sin(ai.heading);
          const forwardZ = Math.cos(ai.heading);
          const rightX = forwardZ;
          const rightZ = -forwardX;
          const centerY = bankSurface.point.y;
          const sampleWheelY = (forward, right) => {
            const dx = forwardX * forward + rightX * right;
            const dz = forwardZ * forward + rightZ * right;
            const expectedY = centerY
              - (aiRoadNormal.x * dx + aiRoadNormal.z * dz)
                / Math.max(0.02, aiRoadNormal.y);
            const surface = getRoadSurfaceAt(
              ai.pos.x + dx,
              ai.pos.z + dz,
              expectedY
            );
            if (!surface) return expectedY;
            return Math.abs(surface.point.y - expectedY) < playerVehicleHeight * 10
              ? surface.point.y
              : expectedY;
          };
          const frontLeftY = sampleWheelY(PLAYER_AXLE_HALF, -PLAYER_TRACK_HALF);
          const frontRightY = sampleWheelY(PLAYER_AXLE_HALF, PLAYER_TRACK_HALF);
          const rearLeftY = sampleWheelY(-PLAYER_AXLE_HALF, -PLAYER_TRACK_HALF);
          const rearRightY = sampleWheelY(-PLAYER_AXLE_HALF, PLAYER_TRACK_HALF);
          const frontY = (frontLeftY + frontRightY) * 0.5;
          const rearY = (rearLeftY + rearRightY) * 0.5;
          const leftY = (frontLeftY + rearLeftY) * 0.5;
          const rightY = (frontRightY + rearRightY) * 0.5;
          aiBankPitch = -Math.atan2(
            frontY - rearY,
            PLAYER_AXLE_HALF * 2
          );
          aiBankRoll = Math.atan2(
            rightY - leftY,
            PLAYER_TRACK_HALF * 2
          );
          const forwardSlope = (frontY - rearY) / (PLAYER_AXLE_HALF * 2);
          const rightSlope = (rightY - leftY) / (PLAYER_TRACK_HALF * 2);
          ai.pos.y = Math.max(
            centerY,
            frontLeftY - forwardSlope * PLAYER_AXLE_HALF
              + rightSlope * PLAYER_TRACK_HALF,
            frontRightY - forwardSlope * PLAYER_AXLE_HALF
              - rightSlope * PLAYER_TRACK_HALF,
            rearLeftY + forwardSlope * PLAYER_AXLE_HALF
              + rightSlope * PLAYER_TRACK_HALF,
            rearRightY + forwardSlope * PLAYER_AXLE_HALF
              - rightSlope * PLAYER_TRACK_HALF
          );
          aiBankAligned = true;
          indyCpuBankAlignedNow++;
          const bankTiltDeg = THREE.MathUtils.radToDeg(
            Math.max(Math.abs(aiBankPitch), Math.abs(aiBankRoll))
          );
          document.body.dataset.indyCpuBankPitchDeg =
            THREE.MathUtils.radToDeg(aiBankPitch).toFixed(2);
          document.body.dataset.indyCpuBankRollDeg =
            THREE.MathUtils.radToDeg(aiBankRoll).toFixed(2);
          document.body.dataset.indyCpuMaxBankTiltDeg = Math.max(
            Number(document.body.dataset.indyCpuMaxBankTiltDeg || 0),
            bankTiltDeg
          ).toFixed(2);
        } else if (ai.indyBanked) {
          // 三角形の極小隙間では経路自身の高さを使う。位置・速度を戻さない。
          ai.pos.y = Number.isFinite(ai.routeSupportY)
            ? ai.routeSupportY
            : ai.pos.y;
          indyCpuBankSurfaceMissesNow++;
        } else {
          const gy = groundHeightAt(ai.pos.x, ai.pos.y, ai.pos.z);
          ai.pos.y += (gy - ai.pos.y) * Math.min(1, dt * 9);
        }
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
      if (ai.indyBanked) {
        indyCpuMinSpeedNow = Math.min(indyCpuMinSpeedNow, ai.v * 3.6);
        indyCpuMaxSlipNow = Math.max(indyCpuMaxSlipNow, Math.abs(aiSlip));
      }
      const driftRoll = clamp(diff * ai.v * 0.006 + aiSlip * 0.18, -0.1, 0.1);
      if (ai.indyBanked && aiBankAligned) {
        // バンクの4輪傾斜を保持したまま、ドリフトの荷重移動だけを加える。
        ai.tilt.rotation.set(
          aiBankPitch,
          0,
          clamp(aiBankRoll + driftRoll, -1.45, 1.45)
        );
      } else {
        ai.tilt.rotation.z = driftRoll;
      }

      // インディアナポリスのCPUも、左右後輪の直下へ独立してタイヤ痕を貼る。
      // 上側タイヤの痕もバンク面へ追従させ、ユーザー車と演出を統一する。
      if (COURSE_KEY === 'indy' && Math.abs(aiSlip) > 0.15 && skidPool.length) {
        const rearX = ai.pos.x - Math.sin(ai.heading) * 1.5;
        const rearZ = ai.pos.z - Math.cos(ai.heading) * 1.5;
        const lastCpuSkid = ai.lastSkid ?? { x: 1e9, z: 1e9 };
        const skidDx = rearX - lastCpuSkid.x;
        const skidDz = rearZ - lastCpuSkid.z;
        if (skidDx * skidDx + skidDz * skidDz > 0.5 * 0.5) {
          ai.lastSkid = { x: rearX, z: rearZ };
          const forwardX = Math.sin(ai.heading);
          const forwardZ = Math.cos(ai.heading);
          const rightX = forwardZ;
          const rightZ = -forwardX;
          for (const side of [-0.75, 0.75]) {
            const mark = skidPool[skidIdx];
            skidIdx = (skidIdx + 1) % SKID_MAX;
            const markX = rearX + rightX * side;
            const markZ = rearZ + rightZ * side;
            const surface = getRoadSurfaceAt(markX, markZ, ai.pos.y);
            let markY = ai.pos.y + 0.11;
            skidSurfaceNormal.set(0, 1, 0);
            if (surface) {
              markY = surface.point.y + 0.028;
              if (surface.face) {
                skidSurfaceNormal.copy(surface.face.normal)
                  .transformDirection(surface.object.matrixWorld)
                  .normalize();
                if (skidSurfaceNormal.y < 0) skidSurfaceNormal.negate();
              }
            }
            skidForward.set(forwardX, 0, forwardZ)
              .addScaledVector(
                skidSurfaceNormal,
                -skidForward.dot(skidSurfaceNormal)
              )
              .normalize();
            if (skidForward.lengthSq() < 0.01) {
              skidForward.set(forwardX, 0, forwardZ);
            }
            skidAcross.crossVectors(skidForward, skidSurfaceNormal).normalize();
            skidBasis.makeBasis(skidAcross, skidForward, skidSurfaceNormal);
            mark.quaternion.setFromRotationMatrix(skidBasis);
            mark.position.set(
              markX,
              markY + (skidIdx % 8) * 0.0012,
              markZ
            );
            mark.material.opacity = 0.5;
            mark.visible = true;
            const key = side < 0
              ? 'indyCpuSkidMarksRight'
              : 'indyCpuSkidMarksLeft';
            document.body.dataset[key] = String(
              Number(document.body.dataset[key] || 0) + 1
            );
          }
        }
      }

      // ドリフト中はリアからタイヤスモーク(近くの車だけ・プールを共用)。
      // インディアナポリスでもタイヤ痕と同時に発生させる。
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
          if (COURSE_KEY === 'indy') {
            document.body.dataset.indyCpuSmokePuffs = String(
              Number(document.body.dataset.indyCpuSmokePuffs || 0) + 1
            );
          }
        }
      }
    }
    if (CAR2_MODE) {
      // 首都高速CPUの走行状態。震え・固まりは最小移動距離が伸びないことで分かる。
      const tokyoCpus = aiCars.filter((ai) => ai.driftOnSharpCurve && ai.active);
      // ユーザー車の走行距離（ループ地点の座標ジャンプは数えない）。
      if (car2PlayerTravelFromX !== undefined) {
        const step = Math.hypot(
          player.pos.x - car2PlayerTravelFromX, player.pos.z - car2PlayerTravelFromZ
        );
        if (step < 80) car2PlayerTravelMeters += step;
      }
      car2PlayerTravelFromX = player.pos.x;
      car2PlayerTravelFromZ = player.pos.z;
      document.body.dataset.tokyoCpuEncounters = String(car2CpuEncounterTotal);
      document.body.dataset.tokyoCpuAppearances = String(car2CpuAppearTotal);
      document.body.dataset.tokyoCpuActiveNow = String(tokyoCpus.length);
      document.body.dataset.tokyoCpuActiveRanks = tokyoCpus.map((ai) => ai.rank).join(',');
      // 各車が今どのレーンにいるか（中心線からの横位置）。
      document.body.dataset.tokyoCpuLaneShifts =
        tokyoCpus.map((ai) => (ai.laneShift ?? 0).toFixed(1)).join(',');
      document.body.dataset.tokyoCpuActiveKmh =
        tokyoCpus.map((ai) => (ai.v * 3.6).toFixed(0)).join(',');
      // ユーザー車から見た前後距離（＋が前方）。
      if (car2CpuRoute) {
        const anchor = nearestRouteIndexTo(car2CpuRoute, player.pos.x, player.pos.z);
        document.body.dataset.tokyoCpuAlongM =
          tokyoCpus.map((ai) => car2AlongFromPlayer(ai.idx, anchor).toFixed(0)).join(',');
      }
      document.body.dataset.tokyoCpuNextAppearIn = car2CpuAppearIn.toFixed(1);
      document.body.dataset.tokyoPlayerAvgSpeedKmh = car2PlayerAvgSpeedKmh.toFixed(0);
      document.body.dataset.tokyoCpuAppearScale = car2AppearSpeedScale().toFixed(2);
      document.body.dataset.cpuMaxJumpMeters = cpuWorstJumpMeters.toFixed(1);
      // 検証用: 各車の現在速度（カーブで上限へ落ち、直線で最高速へ戻るのが正しい）。
      document.body.dataset.tokyoCpuCurrentSpeedsKmh = tokyoCpus
        .map((ai) => (ai.v * 3.6).toFixed(0)).join(',');
      document.body.dataset.tokyoCpuOvertakesStarted = String(cpuOvertakeStartTotal);
      document.body.dataset.tokyoCpuOvertakingNow = String(cpuOvertakingNow);
      // 数珠つなぎ・重なりの検出。車体が重なると4mを大きく下回る。
      let minPairGap = Infinity;
      for (let i = 0; i < tokyoCpus.length; i++) {
        for (let j = i + 1; j < tokyoCpus.length; j++) {
          const gap = Math.hypot(
            tokyoCpus[i].pos.x - tokyoCpus[j].pos.x,
            tokyoCpus[i].pos.z - tokyoCpus[j].pos.z
          );
          if (gap < minPairGap) minPairGap = gap;
        }
      }
      if (Number.isFinite(minPairGap)) {
        const previous = Number(document.body.dataset.tokyoCpuMinPairGapMeters);
        document.body.dataset.tokyoCpuMinPairGapMeters =
          (Number.isFinite(previous) ? Math.min(previous, minPairGap) : minPairGap).toFixed(1);
      }
      document.body.dataset.tokyoPlayerTravelMeters = car2PlayerTravelMeters.toFixed(0);
      if (car2PlayerTravelMeters > 1 && car2RouteLengthMeters > 1) {
        // 「ユーザー車が一周する間に何台とすれ違うか」。調整の目安にする。
        document.body.dataset.tokyoCpuEncountersPerLap = (
          car2CpuEncounterTotal / (car2PlayerTravelMeters / car2RouteLengthMeters)
        ).toFixed(1);
      }
      document.body.dataset.tokyoCpuDriftingNow = String(tokyoCpuDriftingNow);
      document.body.dataset.tokyoCpuMaxDriftingSimultaneously = String(Math.max(
        Number(document.body.dataset.tokyoCpuMaxDriftingSimultaneously || 0),
        tokyoCpuDriftingNow
      ));
      if (Number.isFinite(tokyoCpuMinSpeedNow)) {
        document.body.dataset.tokyoCpuMinSpeedKmh = (tokyoCpuMinSpeedNow * 3.6).toFixed(1);
      }
      if (tokyoCpus.length) {
        document.body.dataset.tokyoCpuTravelMeters = tokyoCpus
          .map((ai) => (ai.travelMeters || 0).toFixed(0)).join(',');
      }
    }
    if (COURSE_KEY === 'indy') {
      document.body.dataset.indyCpuOvertakesStarted = String(cpuOvertakeStartTotal);
      document.body.dataset.indyCpuOvertakingNow = String(cpuOvertakingNow);
      // 検証用: 各車の現在速度（コーナーで落ちて直線で戻るのが正しい）とワープ最大値。
      document.body.dataset.indyCpuCurrentSpeedsKmh = aiCars
        .filter((ai) => ai.indyBanked)
        .map((ai) => (ai.v * 3.6).toFixed(0)).join(',');
      document.body.dataset.cpuMaxJumpMeters = cpuWorstJumpMeters.toFixed(1);
      // 「ドリフト中に観測された最高速度」。152を大きく超えたら上限が破れている。
      // しきい値0.15はスモークが出る=見た目にドリフトと分かる横滑り角。
      // グリップ走行の車もコーナーでは6度前後の姿勢角(slip≈0.1)が付くので、
      // それを「ドリフト」と数えないための値。
      const indyDriftSpeeds = aiCars
        .filter((ai) => ai.indyBanked && Math.abs(ai.slip ?? 0) > 0.15)
        .map((ai) => ai.v * 3.6);
      if (indyDriftSpeeds.length) {
        document.body.dataset.indyCpuMaxDriftSpeedKmh = Math.max(
          Number(document.body.dataset.indyCpuMaxDriftSpeedKmh || 0),
          ...indyDriftSpeeds
        ).toFixed(0);
      }
      // 観測された最大加速度。ユーザー車の上限(21m/s^2)を超えたら違反。
      document.body.dataset.indyCpuMaxAccel = indyCpuMaxAccelNow.toFixed(1);
      document.body.dataset.playerMaxAccelLimit =
        playerLikeMaxAccel(0).toFixed(1);
      document.body.dataset.indyCpuDriftingNow = String(indyCpuDriftingNow);
      document.body.dataset.indyCpuBankAlignedNow = String(indyCpuBankAlignedNow);
      document.body.dataset.indyCpuBankSurfaceMissesNow =
        String(indyCpuBankSurfaceMissesNow);
      document.body.dataset.indyCpuBankFallbackFrames = String(
        Number(document.body.dataset.indyCpuBankFallbackFrames || 0)
          + indyCpuBankSurfaceMissesNow
      );
      const minSpeedKmh = Number.isFinite(indyCpuMinSpeedNow) ? indyCpuMinSpeedNow : 0;
      const previousMinimumSpeedKmh =
        Number(document.body.dataset.indyCpuMinimumObservedSpeedKmh);
      const minimumObservedSpeedKmh = Number.isFinite(previousMinimumSpeedKmh)
        ? Math.min(previousMinimumSpeedKmh, minSpeedKmh)
        : minSpeedKmh;
      const maxSlipDeg = THREE.MathUtils.radToDeg(indyCpuMaxSlipNow);
      document.body.dataset.indyCpuMinActualSpeedKmh = minSpeedKmh.toFixed(1);
      document.body.dataset.indyCpuMinimumObservedSpeedKmh =
        minimumObservedSpeedKmh.toFixed(1);
      document.body.dataset.indyCpuMaxSlipDeg = Math.max(
        Number(document.body.dataset.indyCpuMaxSlipDeg || 0),
        maxSlipDeg
      ).toFixed(2);
      document.body.dataset.indyCpuMaxDriftingSimultaneously = String(Math.max(
        Number(document.body.dataset.indyCpuMaxDriftingSimultaneously || 0),
        indyCpuDriftingNow
      ));
      document.body.dataset.indyCpuRecoveries =
        document.body.dataset.car2CpuRecoveries || '0';
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
    document.body.dataset.camYaw = cam.yaw.toFixed(3);
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
    sun.castShadow = MAP_CONFIG.renderShadows !== false;
    document.body.dataset.playerMapMarkerVisible = 'false';
    document.body.dataset.criminalMapMarkerVisible = 'false';
    camera.up.set(0, 1, 0);
    if (demoActive && bonnetView === 0) {
      // スワイプ(ドラッグ)中とその直後はユーザーのカメラ操作を優先する
      const t = performance.now();
      if (cam.dragging || t - cam.lastDrag < 2500) {
        // 何もしない(ユーザーの視点を保持)。実際にドラッグされた時だけ印を付ける
        // (lastDrag=0 の起動直後を「今ドラッグした」と数えないため)。
        demoCamUserHeld = cam.lastDrag > 0;
      } else if (demoCamUserHeld) {
        // デモがカメラを取り戻す = アングルの強制切り替え。
        // ドラッグで鳴り始めたエンジン音もここで消す(首都高/森林/インディ用)。
        demoCamUserHeld = false;
        resetDemoEngineSound();
      } else if (DEMO_SEQUENCE_ACTIVE) {
        const elapsed = Math.max(0, (t - demoSequenceStartedAt) / 1000);
        let targetYaw = 0;
        let targetPitch = 0.34;
        let targetDist = 11;
        if (COURSE_KEY === 'tokyo' || COURSE_KEY === 'sea') {
          // マウスで眺め回すように、左右・上下・距離を連続的に変える。
          targetYaw = Math.sin(elapsed * 0.56) * 0.72
            + Math.sin(elapsed * 0.21) * 0.18;
          targetPitch = 0.31 + Math.sin(elapsed * 0.43 + 0.8) * 0.11;
          targetDist = 11.5 + Math.sin(elapsed * 0.35 + 1.4) * 2.1;
        }
        // 森林地帯は通常位置へ固定。インディアナポリスもN演出が
        // 見やすい通常後方視点を維持する。
        const g = Math.min(1, dt * 2.2);
        cam.yaw += (targetYaw - cam.yaw) * g;
        cam.pitch += (targetPitch - cam.pitch) * g;
        cam.dist += (targetDist - cam.dist) * g;
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
      const lookPitch = CAM_LOOK_BASE_PITCH - cam.pitch;   // 上ドラッグで上を向く
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
    }
    // ドラッグで振ったカメラは、そのままの向きで置いておく。
    // 車の背後へ戻すのは視点切替(V)のときだけ。
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
    if (demoActive && DEMO_SEQUENCE_ACTIVE) {
      if (!IS_MOBILE && gp.buttons.some((button) => button?.pressed)) {
        exitDemoSequenceToTitle();
      }
      gamepadState.steer = 0;
      gamepadState.throttle = false;
      gamepadState.brake = false;
      gamepadState.handbrake = false;
      return;
    }
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
      if (xBtn && !gpPrev.x) switchBonnetView();
      if (lbBtn && !gpPrev.lb && CAR2_MODE) {
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
      updateDemoSequence(now);
      // car2デモ: 10秒ごとに昼夜をチェンジ
      if (demoActive && CAR2_MODE && !DEMO_SEQUENCE_ACTIVE && now >= demoDayNightAt) {
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
      if (DEBUG_MAP && player.group) {
        document.body.dataset.debugPlayerX = player.pos.x.toFixed(3);
        document.body.dataset.debugPlayerY = player.pos.y.toFixed(3);
        document.body.dataset.debugPlayerZ = player.pos.z.toFixed(3);
        document.body.dataset.debugPlayerSpeedKmh = (player.vel.length() * 3.6).toFixed(1);
        document.body.dataset.debugPlayerPitchDeg =
          THREE.MathUtils.radToDeg(player.tilt.rotation.x).toFixed(3);
        document.body.dataset.debugPlayerRollDeg =
          THREE.MathUtils.radToDeg(player.tilt.rotation.z).toFixed(3);
        document.body.dataset.debugMapMotionSweepSteps = String(mapMotionSweepSteps);
      }
      updateFx(dt);
      updateTailTrails(dt);
      updateCamera(dt);
      updateWeatherEffects(dt);
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
