import * as THREE from '../lib/three.module.js';

// ルート66(driving_us_s)の砂漠を飾る three.js の要素:
//  - 小石: カメラ周辺だけに、世界座標に固定した格子で配置する1つの InstancedMesh。
//  - 砂漠の延長面: GLB の地面(横幅約400m)の外側を地平線まで埋める。
//  - 遠景の山: 地平線より少し上に浮かせ、すそを透明へぼかした薄い山並み。
//    地面と接しないので、山が砂漠の上に重なって灰色の帯になることがない。
// 元ゲームの座標は 0.4 倍・中心寄せされていたので、ここでは GLB の元座標(m)に直している。
// 地図は scale 倍に拡大して置かれるので、世界座標 ÷ scale で元座標に戻して判定する。

const SEGMENT_STEP = 585;          // 区間の間隔(GLB 595.76m から 10.76m 重ねる)
const SEGMENT_TOP_Z = 7.17;        // GLB の元座標で区間の手前端(Z 最大)
const ROAD_BAND = [-2.97, 7.53];   // 小石を置かない道路帯(元座標 X)
const PEBBLE_RADIUS = 60;
const PEBBLE_CELL = 4.5;           // 元ゲームの密度(約0.05個/m²)に合わせた格子
// 道路の両側は地平線まで砂漠だけ。GLBの地面が画面に出る色(実測)に合わせ、
// 外側の面と霧を同じ色にして、境目も灰色の帯も出ないようにする。
export const DESERT_COLOR = 0xc0aa8a;

// 建物などの下に小石が出ないよう、区間ごとに除外する範囲(元座標)。
const PEBBLE_ZONES = {
  sa04: [{ maxX: -1.72, z: [-533.2, -453.2] }],
  sa05: [{ minX: 6.28, z: [-238.7, -233.2] }],
  sa06: [{ maxX: -1.72, z: [-523.2, -427.2] }],
  sa07: [{ maxX: -1.72, z: [-408.2, -330.7] }],
};

export function createRoute66Scenery(scene, segmentFiles, mapScale = 1) {
  const names = segmentFiles.map((file) => file.replace(/^.*\//, '').replace(/\.glb$/, ''));
  const step = SEGMENT_STEP;
  const group = new THREE.Group();
  group.name = 'route66-scenery';
  scene.add(group);

  // ---------------------------------------------------------- 遠景の山 ---
  // 輪郭の内側を塗り、下40%は透明から徐々に濃くする(すそをぼかす)。
  function mountainTexture(seed) {
    const W = 2048, H = 256;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const profile = new Float32Array(W + 1);
    for (let x = 0; x <= W; x++) {
      const t = x / W * Math.PI * 2;
      profile[x] = 0.30 * Math.sin(t * 3 + seed) + 0.20 * Math.sin(t * 7 + seed * 1.3)
        + 0.10 * Math.sin(t * 13 + seed * 0.7) + 0.05 * Math.sin(t * 23 + seed * 2.1)
        + 0.03 * Math.sin(t * 41 + seed * 1.7);
    }
    let min = Infinity, max = -Infinity;
    for (const v of profile) { min = Math.min(min, v); max = Math.max(max, v); }
    const fade = ctx.createLinearGradient(0, H, 0, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.4, 'rgba(255,255,255,1)');
    fade.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = fade;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x++) {
      const n = (profile[x] - min) / (max - min);
      // 峰は上端、谷は高さの45%まで。
      ctx.lineTo(x, H * (1 - n) * 0.55);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    return new THREE.CanvasTexture(canvas);
  }
  // 以前の山と同じくらいの見かけの高さ(仰角2〜3度)。遠い層ほど淡い。
  const MOUNTAIN_LIFT = 6;          // 地平線から浮かせる高さ(m)
  const mountainLayers = [
    { r: 1000, h: 48, seed: 1.2, grey: 0x7c7f88, opacity: 0.5 },
    { r: 1120, h: 62, seed: 2.7, grey: 0x8c909a, opacity: 0.35 },
  ];
  const mountains = mountainLayers.map((layer) => {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(layer.r, layer.r, layer.h, 64, 1, true),
      new THREE.MeshBasicMaterial({
        map: mountainTexture(layer.seed), color: layer.grey, side: THREE.BackSide,
        transparent: true, opacity: layer.opacity, depthWrite: false, fog: false,
      }));
    mesh.position.y = MOUNTAIN_LIFT + layer.h / 2;
    mesh.frustumCulled = false;
    mesh.renderOrder = -0.4;
    mesh.name = 'Route66Mountains';
    mesh.userData.grey = new THREE.Color(layer.grey);
    group.add(mesh);
    return mesh;
  });
  const tint = new THREE.Color();

  // ---------------------------------------------------- 砂漠の延長面 ---
  // 照明を受けない色にする。照明を受けると地平線で明るい線が出る。
  const desert = new THREE.Mesh(
    new THREE.PlaneGeometry(3000, 3000),
    new THREE.MeshBasicMaterial({ color: DESERT_COLOR }));
  desert.rotation.x = -Math.PI / 2;
  desert.position.y = -0.05;
  desert.frustumCulled = false;
  desert.name = 'Route66DesertPlane';
  group.add(desert);

  // -------------------------------------------------------------- 小石 ---
  const cells = Math.ceil(PEBBLE_RADIUS / PEBBLE_CELL);
  const capacity = (cells * 2 + 1) ** 2;
  const pebbleMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const pebbles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), pebbleMaterial, capacity);
  pebbles.frustumCulled = false;
  pebbles.name = 'Route66Pebbles';
  group.add(pebbles);
  const colors = [0xd0d0cc, 0xd9cc90, 0xd4a08a, 0xccb890].map((c) => new THREE.Color(c));
  const hash = (a, b, salt) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  // 世界座標 z がどの区間の、元座標でどこに当たるか。
  const segmentAt = (z) => {
    const raw = Math.floor(-z / step);
    const index = ((raw % names.length) + names.length) % names.length;
    return { name: names[index], localZ: z + raw * step + SEGMENT_TOP_Z };
  };
  const blocked = (worldX, worldZ) => {
    const x = worldX / mapScale, z = worldZ / mapScale;
    if (x > ROAD_BAND[0] && x < ROAD_BAND[1]) return true;
    const { name, localZ } = segmentAt(z);
    for (const zone of PEBBLE_ZONES[name] ?? []) {
      if (localZ < zone.z[0] || localZ > zone.z[1]) continue;
      if (zone.maxX !== undefined && x < zone.maxX) return true;
      if (zone.minX !== undefined && x >= zone.minX) return true;
    }
    return false;
  };
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler(), position = new THREE.Vector3(), scale = new THREE.Vector3();
  const lastCentre = new THREE.Vector2(Infinity, Infinity);
  const relay = (cx, cz) => {
    const gx = Math.round(cx / PEBBLE_CELL), gz = Math.round(cz / PEBBLE_CELL);
    let n = 0;
    for (let iz = -cells; iz <= cells; iz++) {
      for (let ix = -cells; ix <= cells; ix++) {
        const cellX = gx + ix, cellZ = gz + iz;
        const x = (cellX + hash(cellX, cellZ, 11) - 0.5) * PEBBLE_CELL;
        const z = (cellZ + hash(cellX, cellZ, 23) - 0.5) * PEBBLE_CELL;
        if (Math.hypot(x - cx, z - cz) > PEBBLE_RADIUS || blocked(x, z)) continue;
        const r = 0.05 + hash(cellX, cellZ, 37) * 0.17;
        const sy = 0.4 + hash(cellX, cellZ, 41) * 0.45;
        scale.set(r * (0.7 + hash(cellX, cellZ, 43) * 0.6), r * sy, r * (0.7 + hash(cellX, cellZ, 47) * 0.6));
        euler.set(hash(cellX, cellZ, 53) * Math.PI, hash(cellX, cellZ, 59) * Math.PI, hash(cellX, cellZ, 61) * Math.PI);
        quaternion.setFromEuler(euler);
        position.set(x, r * sy * 0.45, z);
        matrix.compose(position, quaternion, scale);
        pebbles.setMatrixAt(n, matrix);
        pebbles.setColorAt(n, colors[Math.floor(hash(cellX, cellZ, 67) * colors.length)]);
        n++;
      }
    }
    pebbles.count = n;
    pebbles.instanceMatrix.needsUpdate = true;
    if (pebbles.instanceColor) pebbles.instanceColor.needsUpdate = true;
  };

  return {
    group,
    update(camera, horizonColor, night, hidden) {
      for (const mesh of mountains) {
        mesh.position.x = camera.position.x;
        mesh.position.z = camera.position.z;
        mesh.visible = !hidden;
        // 地平線の色に半分なじませて、空に溶け込む淡い山にする。
        tint.copy(horizonColor);
        mesh.material.color.copy(mesh.userData.grey).lerp(tint, 0.5);
        if (night) mesh.material.color.multiplyScalar(0.2);
      }
      const cx = camera.position.x, cz = camera.position.z;
      desert.position.x = Math.round(cx / 50) * 50;
      desert.position.z = Math.round(cz / 50) * 50;
      desert.material.color.setHex(DESERT_COLOR);
      if (night) desert.material.color.multiplyScalar(0.12);
      pebbles.visible = !hidden;
      if (Math.hypot(cx - lastCentre.x, cz - lastCentre.y) > 4) {
        lastCentre.set(cx, cz);
        relay(cx, cz);
      }
    },
  };
}
