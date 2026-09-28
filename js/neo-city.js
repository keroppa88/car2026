import * as THREE from '../lib/three.module.js';

// 未来都市の沿道。どれも地図グループの外に置き、車のレイキャスト対象にしない
// (車は道路の上だけを走り、左右の壁はガードレールと同じ横の制限で止める)。
//  - 市街地: 道路際まで迫る高層ビル。空はほとんど見えない。窓の明かりとネオン帯。
//  - 高速道路: ビル街が途切れて空が開ける。低い側壁と光る街灯。
//  - トンネル: 側壁と天井、天井灯と壁のネオン線。
// 市街地の道路は東西・南北に直角なので、ビルは軸に沿った格子へ並べる。
// 格子は輪の周期(2400m)で割り切れる24m刻みにして、継ぎ目の両側で同じ街になる。

const CELL = 24;
const ROAD_CLEARANCE = 8.6;       // 道路中心からビルの壁までの最小距離
const HIGHWAY_CLEARANCE = 150;    // 高速道路・トンネルの周りはビルを建てない
const HIGHWAY_SKY = 650;          // ここまで離れるまでビルを低くして、高速道路から空を見せる
const NEON = [0x2ff3ff, 0xff3fb0, 0xb44bff, 0xffd23f, 0x3fff9c, 0xff5a3f].map((c) => new THREE.Color(c));

export function createNeoCity(scene, course) {
  const { ext, extTangents, extZones, seam } = course;
  const period = seam.offset.x;
  const group = new THREE.Group();
  group.name = 'neo-city';
  scene.add(group);

  const hash = (a, b, salt) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  // 道路点の空間ハッシュ(20m格子)。
  const buckets = new Map();
  const key = (x, z) => `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  ext.forEach((p, i) => {
    const k = key(p.x, p.z);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  });
  // 箱(軸に沿った xz の矩形)から最も近い道路点までの距離と、その点の種類。
  const nearestRoad = (minX, minZ, maxX, maxZ, reach) => {
    let best = Infinity, bestZone = null;
    const r = Math.ceil(reach / 20);
    const cx = Math.floor((minX + maxX) / 40), cz = Math.floor((minZ + maxZ) / 40);
    for (let gx = cx - r - 1; gx <= cx + r + 1; gx++) {
      for (let gz = cz - r - 1; gz <= cz + r + 1; gz++) {
        for (const i of buckets.get(`${gx},${gz}`) ?? []) {
          const p = ext[i];
          const dx = Math.max(minX - p.x, 0, p.x - maxX);
          const dz = Math.max(minZ - p.z, 0, p.z - maxZ);
          const d = Math.hypot(dx, dz);
          if (d < best) { best = d; bestZone = extZones[i]; }
        }
      }
    }
    return { distance: best, zone: bestZone };
  };
  // 高速道路・トンネルの道路点(間引き)。そこからの距離でビルを間引き・低くする。
  const openPoints = ext.filter((_, i) => extZones[i] !== 'city' && i % 4 === 0);
  const openDistance = (x, z) => {
    let best = Infinity;
    for (const p of openPoints) best = Math.min(best, Math.hypot(x - p.x, z - p.z));
    return best;
  };

  // ------------------------------------------------------------- ビル ---
  const buildings = [];
  const bounds = new THREE.Box3().setFromPoints(ext);
  const originX = seam.startX;
  const cellsX0 = Math.floor((bounds.min.x - 140 - originX) / CELL);
  const cellsX1 = Math.ceil((bounds.max.x + 140 - originX) / CELL);
  const cellsZ0 = Math.floor((bounds.min.z - 140) / CELL);
  const cellsZ1 = Math.ceil((bounds.max.z + 140) / CELL);
  const periodCells = Math.round(period / CELL);
  const tryBox = (minX, minZ, maxX, maxZ, hx, hz, salt) => {
    const near = nearestRoad(minX, minZ, maxX, maxZ, 140);
    if (near.distance < ROAD_CLEARANCE || near.distance > 130) return false;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const open = openDistance(cx, cz);
    if (open < HIGHWAY_CLEARANCE) return false;
    // 道路に近いほど高く、谷間の空をふさぐ。奥は少し低くしてもよい。
    const tall = hash(hx, hz, salt + 3);
    const skyline = THREE.MathUtils.clamp((open - HIGHWAY_CLEARANCE) / (HIGHWAY_SKY - HIGHWAY_CLEARANCE), 0.12, 1);
    const height = (near.distance < 40
      ? 90 + tall * 170
      : 60 + tall * 140) * skyline;
    buildings.push({ minX, minZ, maxX, maxZ, height, hx, hz, salt });
    return true;
  };
  for (let ix = cellsX0; ix <= cellsX1; ix++) {
    // 輪の周期でくり返す格子番号(継ぎ目の両側で同じビルになる)。
    const hx = ((ix % periodCells) + periodCells) % periodCells;
    for (let iz = cellsZ0; iz <= cellsZ1; iz++) {
      const x = originX + ix * CELL, z = iz * CELL;
      const gap = 1 + hash(hx, iz, 7) * 2;
      if (tryBox(x + gap, z + gap, x + CELL - gap, z + CELL - gap, hx, iz, 0)) continue;
      // 道路際で入りきらない区画は、4分割した小さなビルで埋める。
      const half = CELL / 2;
      for (let q = 0; q < 4; q++) {
        const qx = x + (q % 2) * half, qz = z + Math.floor(q / 2) * half;
        tryBox(qx + 0.8, qz + 0.8, qx + half - 0.8, qz + half - 0.8, hx, iz, 11 + q);
      }
    }
  }

  // 窓の明かりはシェーダーで描く(3.6m階・2.4m幅の格子、ところどころ点灯)。
  const buildingMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });
  buildingMaterial.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec3 neoWorld;\nvarying vec3 neoNormal;\n' + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      neoWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      neoNormal = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal);`);
    // 窓は霧をかける前に足す(遠くのビルは窓ごと靄に沈める)。
    shader.fragmentShader = 'varying vec3 neoWorld;\nvarying vec3 neoNormal;\n' + shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `if (abs(neoNormal.y) < 0.5) {
        float along = abs(neoNormal.x) > 0.5 ? neoWorld.z : neoWorld.x;
        vec2 cell = floor(vec2(along / 2.4, neoWorld.y / 3.6));
        vec2 inCell = fract(vec2(along / 2.4, neoWorld.y / 3.6));
        float lit = step(0.62, fract(sin(dot(cell, vec2(12.9898, 78.233)) + floor(neoWorld.x * 0.05) * 3.1) * 43758.5453));
        float pane = step(0.18, inCell.x) * step(inCell.x, 0.82) * step(0.25, inCell.y) * step(inCell.y, 0.8);
        float tint = fract(sin(dot(cell, vec2(3.7, 9.1))) * 9731.0);
        vec3 windowColor = mix(vec3(1.0, 0.78, 0.45), vec3(0.45, 0.85, 1.0), step(0.7, tint));
        gl_FragColor.rgb += windowColor * lit * pane * 0.85 * step(1.0, neoWorld.y);
      }
      #include <fog_fragment>`);
  };
  buildingMaterial.customProgramCacheKey = () => 'neo-building-v2';
  const buildingMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), buildingMaterial, Math.max(1, buildings.length));
  const bodyColors = [0x1c1f2e, 0x242238, 0x161a26, 0x2a2a3a, 0x1e2433].map((c) => new THREE.Color(c));
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3(), scale = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  buildings.forEach((b, i) => {
    position.set((b.minX + b.maxX) / 2, b.height / 2, (b.minZ + b.maxZ) / 2);
    scale.set(b.maxX - b.minX, b.height, b.maxZ - b.minZ);
    matrix.compose(position, quaternion, scale);
    buildingMesh.setMatrixAt(i, matrix);
    buildingMesh.setColorAt(i, bodyColors[Math.floor(hash(b.hx, b.hz, b.salt + 5) * bodyColors.length)]);
  });
  buildingMesh.count = buildings.length;
  buildingMesh.name = 'NeoBuildings';
  group.add(buildingMesh);

  // ネオン帯: ビルを一周する光る帯と、角の縦線。照明を受けずに光る。
  const neonBoxes = [];
  for (const b of buildings) {
    const r = hash(b.hx, b.hz, b.salt + 17);
    const color = NEON[Math.floor(hash(b.hx, b.hz, b.salt + 19) * NEON.length)];
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    if (r < 0.75) {
      const rings = 1 + Math.floor(hash(b.hx, b.hz, b.salt + 23) * 3);
      for (let k = 0; k < rings; k++) {
        const y = 6 + hash(b.hx, b.hz, b.salt + 29 + k) * (b.height - 10);
        neonBoxes.push({ x: cx, y, z: cz, sx: w + 0.3, sy: 0.45, sz: d + 0.3, color });
      }
    }
    if (r > 0.45) {
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        neonBoxes.push({ x: cx + ox * w / 2, y: b.height / 2, z: cz + oz * d / 2,
          sx: 0.35, sy: b.height, sz: 0.35, color });
      }
    }
  }

  // ----------------------------------------------- 高速道路: 側壁と街灯 ---
  const wallBand = (from, to, top, zone, material, name) => {
    const vertices = [], indices = [];
    let run = -1;
    for (let i = 0; i < ext.length; i++) {
      if (extZones[i] !== zone) { run = -1; continue; }
      const p = ext[i], n = extTangents[i];
      const base = vertices.length / 3;
      for (const across of [from, to]) {
        for (const y of [top[0], top[1]]) {
          vertices.push(p.x + n.x * across, y, p.z + n.z * across);
        }
      }
      if (run >= 0) {
        for (let q = 0; q < 2; q++) {
          const a = run + q * 2, b = base + q * 2;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      run = base;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    group.add(mesh);
    return mesh;
  };
  const wallMaterial = new THREE.MeshLambertMaterial({ color: 0x3a3c48, side: THREE.DoubleSide });
  // 左右の側壁(内側・外側の2面を同じ帯で作る)。
  wallBand(-7.6, 7.6, [0, 1.1], 'highway', wallMaterial, 'NeoHighwayWall');
  const glow = (color) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
  wallBand(-7.62, 7.62, [1.1, 1.25], 'highway', glow(0x2ff3ff), 'NeoHighwayWallNeon');
  // 街灯: 40mおきに両側。支柱と、光る灯具。
  const lamps = [];
  for (let i = 0; i < ext.length; i += 13) {
    if (extZones[i] !== 'highway') continue;
    const p = ext[i], n = extTangents[i];
    for (const side of [-1, 1]) {
      lamps.push({ x: p.x + n.x * side * 8.2, z: p.z + n.z * side * 8.2, nx: n.x * side, nz: n.z * side });
    }
  }
  const poleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 11, 0.3),
    new THREE.MeshLambertMaterial({ color: 0x55586a }), Math.max(1, lamps.length));
  lamps.forEach((l, i) => {
    matrix.makeTranslation(l.x, 5.5, l.z);
    poleMesh.setMatrixAt(i, matrix);
  });
  poleMesh.count = lamps.length;
  group.add(poleMesh);
  for (const l of lamps) {
    neonBoxes.push({ x: l.x - l.nx * 1.6, y: 11, z: l.z - l.nz * 1.6, sx: 3.6, sy: 0.25, sz: 0.9,
      color: new THREE.Color(0xfff0d0), yawFrom: [l.nx, l.nz] });
  }

  // ------------------------------------------------------ トンネル ---
  const tunnelMaterial = new THREE.MeshLambertMaterial({ color: 0x2b2d38, side: THREE.DoubleSide });
  wallBand(-7.6, 7.6, [0, 7.5], 'tunnel', tunnelMaterial, 'NeoTunnelWall');
  wallBand(-7.62, 7.62, [1.0, 1.18], 'tunnel', glow(0xff3fb0), 'NeoTunnelNeonLow');
  wallBand(-7.62, 7.62, [5.6, 5.75], 'tunnel', glow(0x2ff3ff), 'NeoTunnelNeonHigh');
  // 天井: 左右の壁の上端をつなぐ帯。
  {
    const vertices = [], indices = [];
    let run = -1;
    for (let i = 0; i < ext.length; i++) {
      if (extZones[i] !== 'tunnel') { run = -1; continue; }
      const p = ext[i], n = extTangents[i];
      const base = vertices.length / 3;
      vertices.push(p.x - n.x * 7.6, 7.5, p.z - n.z * 7.6, p.x + n.x * 7.6, 7.5, p.z + n.z * 7.6);
      if (run >= 0) indices.push(run, base, run + 1, run + 1, base, base + 1);
      run = base;
      // 天井灯: 6mおきに2列。
      if (i % 2 === 0) {
        for (const side of [-2.6, 2.6]) {
          neonBoxes.push({ x: p.x + n.x * side, y: 7.35, z: p.z + n.z * side, sx: 0.5, sy: 0.12, sz: 0.5,
            color: new THREE.Color(0xffe6b0) });
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const ceiling = new THREE.Mesh(geometry, tunnelMaterial);
    ceiling.name = 'NeoTunnelCeiling';
    group.add(ceiling);
  }
  // 入口と出口の門構え(両脇の柱と上の梁)。
  for (let i = 1; i < ext.length; i++) {
    const entering = extZones[i] === 'tunnel' && extZones[i - 1] !== 'tunnel';
    const leaving = extZones[i] !== 'tunnel' && extZones[i - 1] === 'tunnel';
    if (!entering && !leaving) continue;
    const p = ext[i], n = extTangents[i];
    const yaw = Math.atan2(n.x, n.z);
    const portal = new THREE.Mesh(new THREE.BoxGeometry(24, 4, 2.5), tunnelMaterial);
    portal.position.set(p.x, 9.5, p.z);
    portal.rotation.y = yaw;
    group.add(portal);
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(4, 11.5, 2.5), tunnelMaterial);
      pillar.position.set(p.x + n.x * side * 9.6, 5.75, p.z + n.z * side * 9.6);
      pillar.rotation.y = yaw;
      group.add(pillar);
    }
    neonBoxes.push({ x: p.x, y: 7.7, z: p.z, sx: 15.4, sy: 0.3, sz: 0.3, color: NEON[1], yaw });
  }

  // ネオンと灯具をまとめて1つの InstancedMesh で描く。
  const neonMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, neonBoxes.length));
  neonBoxes.forEach((box, i) => {
    const yaw = box.yaw ?? (box.yawFrom ? Math.atan2(box.yawFrom[0], box.yawFrom[1]) : 0);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    position.set(box.x, box.y, box.z);
    scale.set(box.sx, box.sy, box.sz);
    matrix.compose(position, quaternion, scale);
    neonMesh.setMatrixAt(i, matrix);
    neonMesh.setColorAt(i, box.color);
  });
  quaternion.identity();
  neonMesh.count = neonBoxes.length;
  neonMesh.name = 'NeoNeon';
  group.add(neonMesh);

  // ------------------------------------------------------------ 地面 ---
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000),
    new THREE.MeshLambertMaterial({ color: 0x14141c }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.name = 'NeoGround';
  group.add(ground);

  document.body.dataset.neoBuildings = String(buildings.length);
  document.body.dataset.neoNeonBoxes = String(neonBoxes.length);
  return {
    group,
    update(camera, hidden) {
      ground.position.x = Math.round(camera.position.x / 50) * 50;
      ground.position.z = Math.round(camera.position.z / 50) * 50;
      group.visible = !hidden;
    },
  };
}
