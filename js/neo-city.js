import * as THREE from '../lib/three.module.js';

// 未来都市(トロン風)の見た目。黒い面と、光る細い格子線だけで描く。
//  - 前半 tube: 床・左右の壁・天井で道を囲む四角いチューブ。
//    道に沿った縦線と、約6mおきの輪で格子にする。
//  - 後半 open: 地面いっぱいの格子(10m)と、道の縁の光る線。夜空が開ける。
// どれも地図グループの外に置き、車のレイキャストの対象にしない。

const TUBE_MARGIN = 4.7;      // 道路の端からチューブの壁まで(m)
const TUBE_HEIGHT = 8;
const TUBE_COLOR = 0xbfe8ff;  // チューブの格子(淡い水色)
const OPEN_COLOR = 0x3fbf9a;  // 地面の格子(青緑)
const EDGE_COLOR = 0x7ffff0;  // 後半の道の縁

export function createNeoCity(scene, course) {
  const { ext, extTangents, extZones, extHalfWidths, gridStep } = course;
  const group = new THREE.Group();
  group.name = 'neo-grid';
  scene.add(group);

  const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
  const tubeLines = [], edgeLines = [];
  // i 番目の断面上の点。across は道の中心からの横位置、y は高さ。
  const point = (i, across, y) => {
    const p = ext[i], n = extTangents[i];
    return [p.x + n.x * across, y, p.z + n.z * across];
  };

  // ------------------------------------------------ 前半: チューブ ---
  // 黒い床・壁・天井(後ろの地面の格子や夜空を隠す)。
  const shell = { vertices: [], indices: [] };
  let run = -1;
  for (let i = 0; i < ext.length; i++) {
    if (extZones[i] !== 'tube') { run = -1; continue; }
    const half = extHalfWidths[i] + TUBE_MARGIN;
    const base = shell.vertices.length / 3;
    // 断面の4隅(床左・床右・天井右・天井左)。床は地面の格子より少し上に置いて隠す。
    shell.vertices.push(...point(i, -half, 0.07), ...point(i, half, 0.07),
      ...point(i, half, TUBE_HEIGHT), ...point(i, -half, TUBE_HEIGHT));
    if (run >= 0) {
      for (let k = 0; k < 4; k++) {
        const a = run + k, b = run + (k + 1) % 4, c = base + k, d = base + (k + 1) % 4;
        shell.indices.push(a, c, b, b, c, d);
      }
    }
    run = base;
  }
  {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(shell.vertices, 3));
    geometry.setIndex(shell.indices);
    const mesh = new THREE.Mesh(geometry, black);
    mesh.name = 'NeoTubeShell';
    mesh.renderOrder = -0.2;
    group.add(mesh);
  }
  // 格子の縦線(道に沿う線)の位置: 床・両壁・天井。道幅に比例して広がる。
  const floorAcross = [-1, -0.5, 0, 0.5, 1];            // 道路半幅に対する割合
  const wallHeights = [2, 4, 6];
  const ceilingAcross = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];  // チューブ半幅に対する割合
  for (let i = 1; i < ext.length; i++) {
    if (extZones[i] !== 'tube' || extZones[i - 1] !== 'tube') continue;
    const w0 = extHalfWidths[i - 1], w1 = extHalfWidths[i];
    const h0 = w0 + TUBE_MARGIN, h1 = w1 + TUBE_MARGIN;
    for (const f of floorAcross) tubeLines.push(...point(i - 1, f * w0, 0.1), ...point(i, f * w1, 0.1));
    for (const side of [-1, 1]) {
      tubeLines.push(...point(i - 1, side * h0, 0.1), ...point(i, side * h1, 0.1));
      for (const y of wallHeights) tubeLines.push(...point(i - 1, side * h0, y), ...point(i, side * h1, y));
    }
    for (const f of ceilingAcross) tubeLines.push(...point(i - 1, f * h0, TUBE_HEIGHT), ...point(i, f * h1, TUBE_HEIGHT));
  }
  // 輪: 2点(約6m)おきに、床・壁・天井を一周する線。点の数は偶数なので継ぎ目でも揃う。
  for (let i = 0; i < ext.length; i++) {
    if (extZones[i] !== 'tube' || course.extIndices[i] % 2 !== 0) continue;
    const h = extHalfWidths[i] + TUBE_MARGIN;
    const corners = [point(i, -h, 0.1), point(i, h, 0.1), point(i, h, TUBE_HEIGHT), point(i, -h, TUBE_HEIGHT)];
    for (let k = 0; k < 4; k++) tubeLines.push(...corners[k], ...corners[(k + 1) % 4]);
  }

  // ------------------------------------------------ 後半: 道の縁 ---
  for (let i = 1; i < ext.length; i++) {
    if (extZones[i] !== 'open' || extZones[i - 1] !== 'open') continue;
    for (const side of [-1, 1]) {
      edgeLines.push(...point(i - 1, side * extHalfWidths[i - 1], 0.1), ...point(i, side * extHalfWidths[i], 0.1));
    }
  }

  const lines = (positions, color, name) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
    mesh.name = name;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  lines(tubeLines, TUBE_COLOR, 'NeoTubeGrid');
  lines(edgeLines, EDGE_COLOR, 'NeoRoadEdges');

  // ------------------------------------------- 地面の格子(どこまでも) ---
  // カメラに付いて格子の間隔ごとに動かすので、線は世界に固定されて見える。
  // 周期は格子の倍数なので、継ぎ目で車が移っても線の位置は変わらない。
  // 長い1本の線はカメラの近くで描かれないことがあるので、20mずつに区切る。
  // 霧で見えなくなる距離(約500m)まであれば足りる。
  const extent = 600, count = Math.round(extent * 2 / gridStep), piece = 20;
  const floor = [];
  for (let k = 0; k <= count; k++) {
    const v = -extent + k * gridStep;
    for (let u = -extent; u < extent; u += piece) {
      floor.push(u, 0.04, v, u + piece, 0.04, v, v, 0.04, u, v, 0.04, u + piece);
    }
  }
  const floorGrid = lines(floor, OPEN_COLOR, 'NeoFloorGrid');
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 2.5, extent * 2.5),
    new THREE.MeshBasicMaterial({ color: 0x000000 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.04;
  ground.name = 'NeoGround';
  group.add(ground);

  document.body.dataset.neoGridSegments = String((tubeLines.length + edgeLines.length + floor.length) / 6);
  return {
    group,
    update(camera, hidden) {
      const snapX = Math.round(camera.position.x / gridStep) * gridStep;
      const snapZ = Math.round(camera.position.z / gridStep) * gridStep;
      floorGrid.position.set(snapX, 0, snapZ);
      ground.position.x = snapX;
      ground.position.z = snapZ;
      group.visible = !hidden;
    },
  };
}
