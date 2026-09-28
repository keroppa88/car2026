import * as THREE from '../lib/three.module.js';

// 未来都市(トロン風): 黒い空間に光る格子だけの抽象的なコース。
// 90度近いなめらかなカーブが主体。前半(zone: tube)は上下左右を格子に囲まれた
// チューブの中、後半(zone: open)は格子の地面だけが広がり夜空が開ける。
// 道幅は二車線から広くなったり戻ったりする(halfWidths)。
// ぐんまー・嵐が丘と同じ無限の輪: 最後の点は route[0] + seam.offset へ続く。

// 前半の道。s は直線(m)、t は曲がる角度(度・左が正)と半径 r。wide は広い道幅。
// 後半は前半を南北に反転した形で、両端が z = 0 で東向きにそろう。
const HALF = [
  { s: 200 },
  { t: 85, r: 55 },
  { s: 160, wide: true },
  { t: -85, r: 55 },
  { s: 140 },
  { t: -90, r: 45 },
  { s: 180 },
  { t: 90, r: 45 },
  { s: 120 },
  { t: 80, r: 65 },
  { s: 180, wide: true },
  { t: -80, r: 65 },
  { s: 150 },
  { t: -88, r: 50 },
  { s: 130 },
  { t: 88, r: 50 },
  { s: 180 },
];
const NARROW = 4.32;              // 二車線の半幅(ぐんまーと同じ)
const WIDE = 8.6;                 // 広い区間の半幅(四車線ぶん)
const GRID_STEP = 10;             // 後半の地面の格子(m)。周期をこの倍数にして継ぎ目で揃える

export function buildNeoMap() {
  const x0 = -40;
  const pieces = [
    ...HALF.map((p) => ({ ...p, zone: 'tube' })),
    ...HALF.map((p) => ({ ...p, t: p.t === undefined ? undefined : -p.t, zone: 'open' })),
  ];
  // 細かい点列(2m間隔)を向きと曲率で積み上げる。
  const dense = [];
  let x = x0, z = 0, heading = 0;   // heading 0 = 東(+x)、正 = 北(-z)へ曲がる
  const push = (zone, wide) => dense.push({ p: new THREE.Vector3(x, 0, z), zone, wide });
  push('tube', false);
  const walk = (length, curvature, zone, wide) => {
    const steps = Math.max(1, Math.ceil(length / 2));
    const ds = length / steps;
    for (let k = 0; k < steps; k++) {
      heading += curvature * ds / 2;
      x += Math.cos(heading) * ds;
      z -= Math.sin(heading) * ds;
      heading += curvature * ds / 2;
      push(zone, wide);
    }
  };
  pieces.forEach((piece) => {
    if (piece.s !== undefined) walk(piece.s, 0, piece.zone, !!piece.wide);
    else {
      const angle = THREE.MathUtils.degToRad(piece.t);
      walk(Math.abs(angle) * piece.r, Math.sign(angle) / piece.r, piece.zone, false);
    }
  });
  // 周期を格子の倍数にするため、最後の直線を少し延ばす。
  const extra = Math.ceil((x - x0) / GRID_STEP) * GRID_STEP - (x - x0);
  if (extra > 1e-6) walk(extra, 0, 'open', false);
  const period = Math.round(x - x0);

  // 3m前後の等間隔に取り直す(点の数は4の倍数: 格子の輪が継ぎ目で揃う)。
  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + dense[i].p.distanceTo(dense[i - 1].p));
  const total = lengths[lengths.length - 1];
  const routeCount = Math.round(total / 3 / 4) * 4;
  const route = [], zones = [], wideFlags = [];
  for (let i = 0, j = 0; i < routeCount; i++) {
    const d = total * i / routeCount;
    while (lengths[j + 1] < d) j++;
    const t = (d - lengths[j]) / (lengths[j + 1] - lengths[j]);
    route.push(dense[j].p.clone().lerp(dense[j + 1].p, t));
    const near = t < 0.5 ? dense[j] : dense[j + 1];
    zones.push(near.zone);
    wideFlags.push(near.wide ? 1 : 0);
  }
  const ring = (i) => ((i % routeCount) + routeCount) % routeCount;
  // 道幅は約45mかけてなめらかに広げ・戻す。
  const halfWidths = wideFlags.map((_, i) => {
    let sum = 0;
    for (let k = -15; k <= 15; k++) sum += wideFlags[ring(i + k)];
    const t = THREE.MathUtils.smoothstep(sum / 31, 0, 1);
    return NARROW + (WIDE - NARROW) * t;
  });

  const offset = new THREE.Vector3(period, 0, 0);
  const at = (i) => {
    const laps = Math.floor(i / routeCount);
    const p = route[i - laps * routeCount];
    return new THREE.Vector3(p.x + offset.x * laps, p.y, p.z + offset.z * laps);
  };
  const normalAt = (i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dz / length, z: -dx / length };
  };
  const tangents = route.map((_, i) => normalAt(i));
  const copy = Math.ceil(160 / (total / routeCount) / 2) * 2;
  const extIndices = Array.from({ length: routeCount + copy * 2 }, (_, j) => j - copy);
  const ext = extIndices.map(at);
  const extTangents = extIndices.map(normalAt);
  const extZones = extIndices.map((i) => zones[ring(i)]);
  const extHalfWidths = extIndices.map((i) => halfWidths[ring(i)]);
  const seam = {
    offset: { x: offset.x, z: offset.z },
    startX: route[0].x, endX: route[0].x + offset.x,
  };
  const ringPosition = (px, pz) => (px > seam.endX ? [px - offset.x, pz - offset.z]
    : px < seam.startX ? [px + offset.x, pz + offset.z] : [px, pz]);

  // 走行面: 道路と、その外のチューブの床まで(車が横の制限まで寄れるように)。
  // 見た目は黒一色。光る線は neo-city.js が描く。
  const group = new THREE.Group();
  group.name = 'neo_procedural';
  const bands = [
    { name: 'GunmaRoad', from: -1, to: 1, color: 0x05060a },
    { name: 'GunmaShoulder', from: -1, to: -1, extra: -4.7, color: 0x020306 },
    { name: 'GunmaShoulder', from: 1, to: 1, extra: 4.7, color: 0x020306 },
  ];
  for (const band of bands) {
    const vertices = new Float32Array(ext.length * 2 * 3);
    const indices = [];
    for (let i = 0; i < ext.length; i++) {
      const point = ext[i], normal = extTangents[i], w = extHalfWidths[i];
      for (let side = 0; side < 2; side++) {
        // 路肩は道路の端から外へ extra(m) まで。
        const across = band.extra
          ? band.from * w + (side ? band.extra : 0)
          : (side ? band.to : band.from) * w;
        const o = (i * 2 + side) * 3;
        vertices[o] = point.x + normal.x * across;
        vertices[o + 1] = point.y;
        vertices[o + 2] = point.z + normal.z * across;
      }
      if (i + 1 < ext.length) {
        const next = i + 1;
        indices.push(i * 2, next * 2, i * 2 + 1, i * 2 + 1, next * 2, next * 2 + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry,
      new THREE.MeshBasicMaterial({ name: band.name, color: band.color, side: THREE.DoubleSide }));
    mesh.name = band.name;
    group.add(mesh);
  }

  const groundHeightAt = () => 0;
  const groundNormalAt = () => new THREE.Vector3(0, 1, 0);
  const terrainHeightAt = () => 0;
  return { group, route, tangents, ext, extTangents, extIndices, extZones, zones,
    halfWidths, extHalfWidths, seam, climb: 0, gridStep: GRID_STEP,
    mistColor: new THREE.Color(0x0a1f1a), mistTime: { value: 0 },
    groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition };
}
