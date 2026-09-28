import * as THREE from '../lib/three.module.js';

// ルート66(driving_us_s)の砂漠を飾る three.js の要素:
//  - 小石: カメラ周辺だけに、世界座標に固定した格子で配置する1つの InstancedMesh。
//  - 砂漠の延長面: GLB の地面(横幅約400m)の外側を地平線まで埋める。
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
