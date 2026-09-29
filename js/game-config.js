export const CAR_CONFIGS = {
  toyota86: {
    label: 'Toyota 86',
    preview: 'picture/toyota86.png',
    model: 'vox/toyota86.vox',
    groundOffset: 0.02,
  },
  volvo240: {
    label: 'Volvo 240',
    preview: 'picture/volvo240.png',
    model: 'vox/volvo240.vox',
    groundOffset: 0.02,
  },
};

// ルート66(driving_us_s)のループ順。108区間で1周。
// 3:青看板 8:黄看板 17:シェル 26:黄看板 35:マルボロ 44:青看板 53:ケンタッキー
// 59:黄看板 66:青看板 80:黄看板 89:バグダッドカフェ 101:軍事基地 108:ナイトホーク
// ルート66の地図の倍率。道路・看板・建物をまとめて同じ割合で拡大する(1=元の寸法)。
export const ROUTE66_SCALE = 1.17;   // 1.3 × 0.9
const R66 = (meters) => +(meters * ROUTE66_SCALE).toFixed(3);
// ルート66の車線中心の、中央線からの距離(m)。元の2.9m×倍率から0.6m内側。
const ROUTE66_LANE = +(R66(2.9) - 0.6).toFixed(3);

const ROUTE66_GROUND_MATERIALS = [
  '[Formica Beige]', 'Formica Beige', 'M01_Silver_Fog', 'M01',
  '[Color M05]', 'M05', '[Blacktop Old 01]', 'Blacktop Old 01',
  '[Color M04]', 'M04', '97a8128a-f00f-4500-98e2-d94e18e18c43',
];

export const ROUTE66_SEQUENCE = [
  'sa01','sa01','sa01','sa02','sa01','sa01','sa01','sa01','sa03','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa06',
  'sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa03','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa05',
  'sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa02','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa04',
  'sa01','sa01','sa01','sa01','sa01','sa03','sa01','sa01','sa01','sa01','sa01','sa01','sa02','sa01','sa01','sa01','sa01','sa01',
  'sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa03','sa01','sa01','sa01','sa01','sa07',
  'sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa01','sa09','sa01','sa01','sa01','sa01','sa01','sa08',
];

const commonMap = {
  rotationY: 0,
  positionOffsetX: 0,
  positionOffsetY: 0,
  positionOffsetZ: 0,
  centerMapXZ: false,
  // 全マップ共通: シャドウマップを使用しない。
  renderShadows: false,
  edgeOutlines: false,
  edgeOutlineColor: 0x343b42,
  edgeOutlineOpacity: 0.28,
  edgeOutlineThresholdDegrees: 32,
  spawnSearchRadius: 20,
  spawnOffsetX: 0,
  spawnOffsetY: 0,
  spawnOffsetZ: 0,
  // 最終的な車の向きを基準にした右方向への相対オフセット（m）。
  spawnOffsetRight: 0,
  spawnHeading: 0,
  spawnHeadingOffset: 0,
  spawnReference: 'origin',
  spawnReferenceX: 0,
  spawnReferenceZ: 0,
  spawnExactReference: false,
  spawnDirectionMode: 'auto',
  spawnSurfaceMode: 'primaryRoad',
  // マップ複製と端部ワープはZ方向（縦）だけ。横方向には複製しない。
  loopMode: 'vertical',
  // 道路メッシュ間だけ前輪先行の高さ差を許可する。道路色以外の垂直障害物は
  // collideWalls() 側で車高1/4を越えると停止する。
  roadSeamAssistRatio: 1.25,
  // 全マップ共通: 高速時も0.25mごとに路面を追跡し、坂・曲線を飛び越えない。
  roadMotionStep: 0.25,
  // 全マップ共通: 道路色の急坂・バンク三角面を走行支持面として認識する。
  ignoreRoadTriangleWalls: true,
  roadMaterial: 'M08',
  // SketchUp の M08/F08 が、現在の glTF では ARGB 名へ変換されている。
  roadMaterialAliases: ['FF565656'],
  // 壁色を地図ごとに明示し、道路色と混同せず垂直衝突へ使用する。
  wallMaterialAliases: [],
  // 道路以外でも地表として通過でき、垂直壁判定から除外する材質。
  nonWallMaterialAliases: [],
  // true の地図は道路材質だけを車体支持面にし、路外では重力落下させる。
  fallOutsideRoad: false,
  // drivable の地図は、道路と明示された走行可能材質だけを車体支持面にする。
  supportSurfaceMode: 'all',
  // 走行可能面を外れた時、空中走行せず直前の有効位置で停止する。
  blockOutsideDrivableSurface: false,
  // 地図内の垂直面レイ衝突をすべて無効にするコース向け設定。
  ignoreMapWallCollisions: false,
  // 道路以外の走行可能面にも適用する段差追従量（車高比）。
  drivableSeamAssistRatio: null,
  // 地図固有の砂煙面・進入禁止面。
  sandMaterialAliases: [],
  blockedSurfaceMaterialAliases: [],
  // 白線・白地表・無彩色の路肩も、全マップ共通で走行可能面として扱う。
  drivableMaterialAliases: [
    'FFFFFFFF', 'FFF5F5F5', 'FFE2E2E2', 'FFC6C6C6',
    'FFACACAC', 'FFAAAAAA', 'FF8E8E8E', 'FF727272',
    'FF565656', 'FF3A3A3A', 'FF1E1E1E', 'CCCCCCCC',
    '[Color M00]', '[Color M01]', '[Color M02]', '[Color M03]',
    '[Color M04]', '[Color M05]', '[Color M06]', '[Color M07]',
    '[Color M08]', '[Color M09]', 'Ty_Gray1',
  ],
  treeSurfaceMaterial: 'F08',
  treeSurfaceMaterialAliases: ['FF4863A5'],
};

const commonTrees = {
  enabled: false,
  density: 0.015,
  maxCount: 600,
  minDistance: 4,
  roadClearance: 1.5,
  spawnExclusionRadius: 15,
  maxSlopeDegrees: 35,
  scaleMin: 0.85,
  scaleMax: 1.2,
  seed: 12345,
};

export const MAP_CONFIGS = {
  tokyo: {
    ...commonMap,
    label: '首都高速',
    file: 'map/map_tokyo.glb',
    preview: 'picture/tokyo.png',
    scale: 0.002952755906,
    assetRevision: '20260728-tokyo-m06-1',
    spawnSearchRadius: 30,
    // 差し替え後のGLBでは濃いM06が道路、少し明るいM05が両側の垂直壁。
    roadMaterialAliases: ['FF565656', '[Color M06]'],
    wallMaterialAliases: ['FF727272', '[Color M05]'],
    // 新旧の地図は同じ大きさで原点だけが異なるため、旧版と同じくX/Z中央へ配置する。
    centerMapXZ: true,
    edgeOutlines: true,
    spawnReference: 'fixed',
    spawnReferenceX: -128.55,
    spawnReferenceZ: 1644,
    spawnExactReference: true,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI,
    treePlacement: { ...commonTrees, enabled: false, seed: 20260701 },
  },
  sea: {
    ...commonMap,
    label: '海岸線',
    file: 'map/searoad01.glb',
    preview: 'picture/sea.png',
    // 60%版から1.2倍。新海岸線の初期表示に対して72%。
    scale: 0.00011338582752,
    // 1.2倍後のM06路面高+0.01728mを相殺し、ゲーム内道路高を0に揃える。
    positionOffsetY: -0.01728,
    // M06道路、D02砂地、soil_04_1k草地は走行可能。H07海面は進入禁止。
    roadMaterial: '[Color M06]',
    roadMaterialAliases: ['M06', 'M06_Steel_Smoke', 'FF565656'],
    nonWallMaterialAliases: [
      '[Color D02]', 'D02', 'D02_Buttercup_Glow',
      // 現行GLBではD02砂地がこのD03名で書き出されている。
      '[Color D03]', 'D03', 'D03_Lemon_Mist',
      'soil_04_1k',
      // 海側路肩の草地が現行GLBではこの材質名で書き出されている。
      'Wood_Chips_01_1K',
      // 中央白線は高さ・三角面の向きに関係なく絶対に壁扱いしない。
      '[Color M00]', 'M00', 'M00_Soft_Cloud',
    ],
    drivableMaterialAliases: [
      '[Color D02]', 'D02', 'D02_Buttercup_Glow',
      '[Color D03]', 'D03', 'D03_Lemon_Mist',
      'soil_04_1k',
      'Wood_Chips_01_1K',
      '[Color M00]', 'M00', 'M00_Soft_Cloud',
    ],
    sandMaterialAliases: [
      '[Color D02]', 'D02', 'D02_Buttercup_Glow',
      '[Color D03]', 'D03', 'D03_Lemon_Mist',
    ],
    blockedSurfaceMaterialAliases: ['[Color H07]', 'H07'],
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    // 海岸線では段差・電柱など垂直オブジェクトに車を止められない。
    ignoreMapWallCollisions: true,
    // 道路・砂浜・草地の相互移動では高さのある境目も完全に無視する。
    // 対象材質を上の4種類へ限定しているため、建物上面へ吸着することはない。
    drivableSeamAssistRatio: 10,
    // 中央線は各素材マップ内で最も白い一意の材質。変換後の材質名が
    // ファイルごとに異なるため、読込時に明度から自動認識する。
    cpuCenterLineMode: 'brightestGrayPerSegment',
    // 白線から左右それぞれ約2mを左車線・対向車線の中心にする。
    cpuLaneOffset: 2.4,
    // 全区間が直線で、中央白線のゲーム内X座標も共通。
    // 建物などの別の白面を誤追跡しないよう座標を固定する。
    cpuCenterLineEntryX: 70.075,
    // 海側の左車線（同方向）と草地側の右車線（対向）を座標範囲で固定。
    cpuSameDirectionLaneRangeX: [66.6, 69.1],
    cpuOncomingLaneRangeX: [71.1, 73.8],
    // 01を6回走った後だけ02→03→04→06と順に切り替え、06の後は01を7回
    // 走ってから05で締める36区間をループ。
    segmentFiles: [
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad02.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad03.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad04.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad06.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb', 'map/searoad01.glb', 'map/searoad01.glb',
      'map/searoad01.glb',
      'map/searoad05.glb',
    ],
    cpuSameDirectionSpeedsKmh: [100, 120, 150],
    // 対向車は従来90/100/120km/hの約2/3。
    cpuOncomingSpeedsKmh: [60, 70, 80],
    autoDriveMode: 'seaCruise130',
    // 夜は車両の灯火だけ。白線・建物・路面自身は発光させない。
    mapWhiteGlow: false,
    roadNightEmissive: false,
    // 左側の海端でXを揃える。X方向の複製や接続は行わない。
    sequenceAnchorX: 'min',
    loopMode: 'sequence',
    spawnSearchRadius: 2000,
    spawnReference: 'origin',
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    // 元データY最小→最大はゲーム内でZ最大→最小。左側（海側）車線へ寄せる。
    spawnHeading: Math.PI,
    spawnOffsetRight: -2.4,
    // 開始地点では建物の屋根ではなく、必ず道路材質へ接地する。
    spawnSurfaceMode: 'roadSurface',
    // 海岸線の全素材マップ共通: 鮮やかな緑F07だけに樹木を配置する。
    treeSurfaceMaterial: '[Color F07]',
    treeSurfaceMaterialAliases: ['F07', 'F07_Moss_Shine'],
    treePlacement: { ...commonTrees, enabled: false, seed: 20260705 },
  },
  forest: {
    ...commonMap,
    label: '森林地帯',
    file: 'map/forest01.glb',
    preview: 'picture/forest.png',
    // 海岸線と同じSketchUp出力単位。4ファイルは縦横とも同寸なので
    // 個別のサイズ補正を一切かけず、同じ縮尺で接続する。
    // 初期森林サイズから、縦・横・高さを一様に75%へ縮小。
    scale: 0.00008503937064,
    assetRevision: '20260730-forest01-04-lite',
    // 元マップY最大端→次マップY最小端の順に、縦方向だけへ接続する。
    segmentFiles: [
      'map/forest01.glb',
      'map/forest02.glb',
      'map/forest04.glb',
      'map/forest02.glb',
      'map/forest01.glb',
      'map/forest03.glb',
    ],
    // 4ファイルは同寸。forest01のX最小端へ全区間の横端を揃えれば、
    // 同じ位置に作られた道路入口・出口も一致する。
    sequenceAnchorX: 'min',
    // 木の枝を含むGLB外形ではなく、Wood_Chips道路の入口・出口を直接接続する。
    // 新GLBは道路端の中心・幅・高さが一致するため、重複面や補間面は不要。
    sequenceConnectByRoad: true,
    sequenceOverlapMeters: 0,
    sequenceSeamBridges: false,
    loopMode: 'sequence',
    roadMaterial: 'Wood_Chips_01_1K',
    roadMaterialAliases: [
      'WOOD_CHIPS_01_1K',
      // SketchUp側の表記揺れ（数字1／英字I）も同じ道路として扱う。
      'WOOD_CHIPS_01_IK',
    ],
    // 草地と植樹地は地表。三角面の向きに関係なく壁扱いしない。
    nonWallMaterialAliases: [
      'Soil_04_1K',
      'F08_Forest_Shadow',
      // 道路両脇のオリーブ色路肩。微細な垂直面を障害物にしない。
      'E08_Lime_Depth',
    ],
    drivableMaterialAliases: [
      'Soil_04_1K',
      'F08_Forest_Shadow',
      'E08_Lime_Depth',
    ],
    // ウッドチップ路面は通常走行でも薄い土埃、ドリフトでは大量の土煙を出す。
    sandMaterialAliases: ['Wood_Chips_01_1K', 'Wood_Chips_01_ik'],
    dustNormalInterval: 0.06,
    dustHeavyInterval: 0.012,
    dustScale: 1.12,
    dustColor: [164, 133, 86],
    // 03・04の緩い起伏を高速でも飛び越えず、4輪で連続追跡する。
    roadMotionStep: 0.1,
    roadSeamAssistRatio: 10,
    drivableSeamAssistRatio: 10,
    ignoreRoadTriangleWalls: true,
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    spawnSearchRadius: 250,
    spawnReference: 'origin',
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI,
    // 区間先頭の地表端から3m内側へ置き、開始直後も確実に道路へ接地する。
    spawnOffsetZ: -3,
    spawnSurfaceMode: 'roadSurface',
    autoDriveMode: 'forestCruise130Drift',
    treeSurfaceMaterial: 'F08_Forest_Shadow',
    treeSurfaceMaterialAliases: ['F08_FOREST_SHADOW'],
    treePlacement: {
      ...commonTrees,
      enabled: true,
      density: 0.02,
      maxCount: 700,
      minDistance: 3.5,
      roadClearance: 1.8,
      // 従来の0.85～1.2倍を、そのまま全体的に1.5倍へ拡大。
      scaleMin: 1.275,
      scaleMax: 1.8,
      seed: 20260728,
    },
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
  gunma: {
    ...commonMap,
    label: 'ぐんまー',
    file: 'procedural:gunma',
    preview: 'picture/gunma-pixel.png',
    scale: 1,
    roadMaterial: 'GunmaRoad',
    roadMaterialAliases: [],
    nonWallMaterialAliases: ['GunmaShoulder', 'GunmaGrass', 'GunmaCenterLine', 'GunmaEdgeLine', 'GunmaGuardrail'],
    drivableMaterialAliases: [],
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    ignoreMapWallCollisions: true,
    loopMode: 'none',
    roadMotionStep: 0.15,
    spawnReference: 'fixed',
    spawnReferenceX: 0,
    spawnReferenceZ: 0,
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI / 2,
    spawnOffsetRight: 1.68,
    spawnSurfaceMode: 'roadSurface',
    autoDriveMode: 'gunmaTouge',
    treePlacement: { ...commonTrees, enabled: false, seed: 20260923 },
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
  moor: {
    ...commonMap,
    label: '嵐が丘',
    file: 'procedural:moor',
    preview: 'picture/arashigaoka.png',
    scale: 1,
    roadMaterial: 'GunmaRoad',
    roadMaterialAliases: [],
    nonWallMaterialAliases: ['GunmaShoulder', 'GunmaGrass', 'GunmaCenterLine', 'GunmaEdgeLine', 'GunmaGuardrail'],
    // 嵐が丘は路肩と草原にも入れる(草原の先はコード側で地面の高さを返す)。
    drivableMaterialAliases: ['GunmaShoulder', 'GunmaGrass'],
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    ignoreMapWallCollisions: true,
    // 草原では森林地帯と同じ砂煙を車の後ろに出す。
    sandMaterialAliases: ['GunmaGrass'],
    dustNormalInterval: 0.06,
    dustHeavyInterval: 0.012,
    dustScale: 1.12,
    dustColor: [164, 133, 86],
    loopMode: 'none',
    roadMotionStep: 0.15,
    spawnReference: 'fixed',
    spawnReferenceX: 0,
    spawnReferenceZ: 0,
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI / 2,
    spawnOffsetRight: 1.68,
    spawnSurfaceMode: 'roadSurface',
    autoDriveMode: 'gunmaTouge',
    treePlacement: { ...commonTrees, enabled: false, seed: 20260923 },
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
  route66: {
    ...commonMap,
    label: 'ルート66',
    file: 'map/route66/sa01.glb',
    preview: 'picture/root66.png',
    // driving_us_s の砂漠マップ。GLBは1単位=1m。道路幅を広げるため全体を拡大する。
    scale: ROUTE66_SCALE,
    assetRevision: '20260927-route66-1',
    // sa01(ベース道路)の間に看板・店などの特殊マップが入る108区間を1周とする。
    segmentFiles: ROUTE66_SEQUENCE.map((name) => `map/route66/${name}.glb`),
    // 各GLBは595.76m。元ゲームは585m間隔で並べていたので、10.76m重ねる。
    sequenceOverlapMeters: R66(10.76),
    sequenceAnchorX: 'min',
    loopMode: 'sequence',
    // 元ゲームが非表示にしていた緑・青緑・マゼンタ系の装飾メッシュを隠す。
    hideVegetationMeshes: true,
    roadMaterial: 'M06_Steel_Smoke',
    roadMaterialAliases: ['M06'],
    // 砂漠(Formica Beige)と中央線は地表。壁扱いせず、どこでも走れる。
    // 地面の高さにある面の材質は区間ごとに違う(全9ファイルを下向きに走査して確認):
    // sa06 の道路 M05 とアスファルト、sa09 基地の M04、sa08 の小さな面。
    nonWallMaterialAliases: [...ROUTE66_GROUND_MATERIALS],
    // sa06(最初のガソリンスタンド)・sa08 のセンターラインは建物と同じ材質。
    // 乗って走れる面にだけ加え、壁判定からは外さない(建物の壁は壁のまま)。
    drivableMaterialAliases: [...ROUTE66_GROUND_MATERIALS, '[Color M00]', 'M00', '[Color M01]'],
    sandMaterialAliases: ['[Formica Beige]', 'Formica Beige'],
    dustNormalInterval: 0.06,
    dustHeavyInterval: 0.012,
    dustScale: 1.12,
    dustColor: [164, 133, 86],
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    drivableSeamAssistRatio: 10,
    // 元ゲームと同じく建物・看板には衝突しない。
    ignoreMapWallCollisions: true,
    // 右側通行。車線は中央線(元寸法でx=2.25)から左右へ約3.2m。
    // 元の2.9m(1.3倍で3.77m)は外側に寄りすぎたので、車体幅の1/3(約0.6m)中央へ寄せた。
    // 自動運転・同方向車・対向車・開始位置はすべてこの距離にそろえる。
    cpuCenterLineEntryX: R66(2.25),
    cpuLaneOffset: -ROUTE66_LANE,
    cpuSameDirectionLaneRangeX: [R66(3.6), R66(6.3)],
    cpuOncomingLaneRangeX: [R66(-1.8), R66(0.9)],
    // CPU車は海岸線の速度の1/3。ただし同方向車は100〜150km/hに設定する。
    cpuSpeedScale: 1 / 3,
    cpuSameDirectionSpeedRangeKmh: [100, 150],
    // 対向車はさらに半分の速度にする。
    cpuOncomingSpeedScale: 0.5,
    // 砂漠を走ると画面を縦に小刻みに揺らす。
    desertShake: true,
    autoDriveMode: 'seaCruise130',
    spawnSearchRadius: 2000,
    spawnReference: 'fixed',
    spawnReferenceX: R66(2.25),
    spawnReferenceZ: -20,
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI,
    // Z減少方向を向くと、このゲームの「右」は-X。右車線(+X)へは負の値で寄せる。
    spawnOffsetRight: -ROUTE66_LANE,
    spawnSurfaceMode: 'roadSurface',
    treePlacement: { ...commonTrees, enabled: false, seed: 20260927 },
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
  neo: {
    ...commonMap,
    label: 'NeoTokyo',
    file: 'procedural:neo',
    preview: 'picture/neotokyo.png',
    scale: 1,
    roadMaterial: 'GunmaRoad',
    roadMaterialAliases: [],
    nonWallMaterialAliases: ['GunmaShoulder', 'GunmaCenterLine', 'GunmaEdgeLine'],
    drivableMaterialAliases: ['GunmaShoulder'],
    supportSurfaceMode: 'drivable',
    blockOutsideDrivableSurface: true,
    // ビル・トンネルは地図の外に置いてあり、左右はガードレールと同じ横の制限で止める。
    ignoreMapWallCollisions: true,
    loopMode: 'none',
    roadMotionStep: 0.15,
    spawnReference: 'fixed',
    spawnReferenceX: 0,
    spawnReferenceZ: 0,
    spawnExactReference: false,
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI / 2,
    spawnOffsetRight: 1.68,
    spawnSurfaceMode: 'roadSurface',
    autoDriveMode: 'gunmaTouge',
    treePlacement: { ...commonTrees, enabled: false, seed: 20260928 },
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
  monaco: {
    ...commonMap,
    label: 'モンテカルロ',
    file: 'map/map_monaco.glb',
    preview: 'picture/monaco.png',
    // 従来比1.7倍。開始位置の相対関係を保つため距離設定も同率で拡大。
    scale: 4.912598425,
    spawnSearchRadius: 85,
    // 濃灰色M08だけが道路。薄灰色M04は垂直壁として必ず衝突させる。
    roadMaterialAliases: ['FF3A3A3A', '[Color M08]'],
    wallMaterialAliases: ['FF8E8E8E', '[Color M04]'],
    // 面積の大きい暗緑は除外し、鮮やかな緑G07だけを植樹面にする。
    treeSurfaceMaterial: '[Color G07]',
    treeSurfaceMaterialAliases: ['G07'],
    // 高速時も短い急坂を飛び越えないよう、ぐんまーと同じ間隔で路面を追跡する。
    roadMotionStep: 0.25,
    // 道路メッシュ間だけ前輪先行の高さ差を許し、急坂での地中潜りを防ぐ。
    roadSeamAssistRatio: 1.25,
    ignoreRoadTriangleWalls: true,
    // 現在位置から車4台分（12.24m）左へ移した位置。
    spawnOffsetX: 0,
    // 開始位置は維持し、従来向きから180度反転した向きを明示指定する。
    spawnDirectionMode: 'configured',
    spawnHeading: Math.PI,
    // スタート地点は灰色面が上下に重なるため、画面上側の走行面へ置く。
    spawnSurfaceMode: 'topDrivable',
    // G07の直下に道路レイヤーが重なるため、下層道路による除外は行わない。
    treePlacement: { ...commonTrees, enabled: true, roadClearance: 0, seed: 20260703 },
  },
  indy: {
    ...commonMap,
    label: 'インディアナポリス',
    file: 'map/map_indy.glb',
    preview: 'picture/indy.png',
    scale: 0.225590551,
    assetRevision: '20260728-indy-materials-3',
    spawnSearchRadius: 100,
    // M06・M07が道路。D07砂地・E07草地は壁判定を持たない自由走行面。
    roadMaterial: '[Color M06]',
    roadMaterialAliases: [
      'FF565656', 'FF3A3A3A', '[Color M07]',
      'M06_Steel_Smoke', 'M07_Charcoal_Gleam',
    ],
    nonWallMaterialAliases: [
      '[Color D07]', '[Color E07]', 'D07', 'E07',
      'D07_Ochre_Flame', 'E07_Verdant_Light',
    ],
    drivableMaterialAliases: [
      '[Color M06]', '[Color M07]', 'M06', 'M07',
      'FF565656', 'FF3A3A3A',
      'M06_Steel_Smoke', 'M07_Charcoal_Gleam',
      '[Color D07]', '[Color E07]', 'D07', 'E07',
      'D07_Ochre_Flame', 'E07_Verdant_Light',
    ],
    // 建物や外周壁の上面を接地候補へ混ぜず、道路・砂地・草地だけを支持面にする。
    supportSurfaceMode: 'drivable',
    // 原点が内側ショルダー際にあるため、道路中央側へ微調整する。
    spawnOffsetX: -6.1,
    // 現在の開始位置から、最終進行方向を基準に車2台分（6.12m）左へ移す。
    spawnOffsetRight: -6.12,
    // 250km/h走行と横向きドリフトでも、粗いバンク分割面を連続路面として追う。
    roadMotionStep: 0.1,
    // インディアナポリスはファンタジー優先。道路材質である限り、車高を越える
    // 急なバンク分割でも同じ連続路面として扱い、上下方向とも引っ掛けない。
    roadSeamAssistRatio: 10,
    drivableSeamAssistRatio: 10,
    ignoreRoadTriangleWalls: true,
    // 道路材質だけのレイが上空の別面を拾うため、車の直下にある走行面へ接地する。
    spawnSurfaceMode: 'mapSurface',
    // インディアナポリスだけは単一マップ。表示用複製も端部ワープも行わない。
    loopMode: 'none',
    treeSurfaceMaterialAliases: ['FF4863A5', 'Ty_Green'],
    // インディアナポリスには自動樹木を配置しない。
    treePlacement: { ...commonTrees, enabled: false, seed: 20260704 },
    cpuSpeedsKmh: [100, 120, 150, 170],
    autoDriveMode: 'indyBankDrift',
    // 夜は車両灯火と外周街灯だけを発光させる。
    mapWhiteGlow: false,
    roadNightEmissive: false,
  },
};

export const COURSE_ORDER = ['tokyo', 'sea', 'forest', 'indy', 'gunma', 'moor', 'route66', 'neo'];
