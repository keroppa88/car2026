import * as THREE from '../lib/three.module.js';

// 未来都市: 高層ビルの谷間を走る二車線道路。約7割は街区に沿って直角に曲がる
// 市街地(zone: city)。ビル街が途切れると高速道路のような開けた区間(highway)で
// ゆるいカーブになり、続いてゆるいS字のトンネル(tunnel)に入る。ぐんまー・嵐が丘と同じ無限の輪で、
// 最後の点は route[0] + seam.offset へ続き、端を越えると反対側の同じ場所へ移る。
//
// 1周は東へ進む。北(-z)へ曲がった分と南(+z)へ曲がった分を等しくして、
// 両端が z = 0 で東向きに揃うようにしてある。

// 1周分の道(約4.2km、首都高と同程度)。dir は E/N/S の直線、s は東向きのゆるいS字。
// zone は沿道の種類。東西の長さ(周期)はビルの格子24mで割り切れる3048mにしてある。
const LAYOUT = [
  { dir: 'E', len: 200, zone: 'city' },
  { dir: 'N', len: 180, zone: 'city' },
  { dir: 'E', len: 220, zone: 'city' },
  { dir: 'S', len: 180, zone: 'city' },
  { dir: 'E', len: 160, zone: 'city' },
  { dir: 'S', len: 160, zone: 'city' },
  { dir: 'E', len: 240, zone: 'city' },
  { dir: 'N', len: 160, zone: 'city' },
  { dir: 'E', len: 180, zone: 'city' },
  { dir: 'N', len: 140, zone: 'city' },
  { dir: 'E', len: 160, zone: 'city' },
  { dir: 'S', len: 140, zone: 'city' },
  { dir: 'E', len: 120, zone: 'city' },
  { dir: 'N', len: 150, zone: 'city' },
  { dir: 'E', len: 248, zone: 'city' },
  { dir: 'S', len: 150, zone: 'city' },
  { dir: 'E', len: 180, zone: 'city' },
  { s: true, len: 640, amp: 80, zone: 'highway' },
  { s: true, len: 520, amp: -60, zone: 'tunnel' },
  { dir: 'E', len: 180, zone: 'highway' },
];
// 直角の角の丸み(m)。街の交差点らしく小さく、ただし車線が裏返らない大きさ。
const CORNER_RADIUS = 16;
const DIRS = { E: new THREE.Vector3(1, 0, 0), N: new THREE.Vector3(0, 0, -1), S: new THREE.Vector3(0, 0, 1) };

export function buildNeoMap() {
  const x0 = -40;
  // 各区間の始点・終点(角)と向き。
  const pieces = [];
  let cursor = new THREE.Vector3(x0, 0, 0);
  for (const piece of LAYOUT) {
    const dir = piece.s ? DIRS.E : DIRS[piece.dir];
    const end = cursor.clone().addScaledVector(dir, piece.len);
    pieces.push({ ...piece, dir, start: cursor.clone(), end });
    cursor = end;
  }
  const period = cursor.x - x0;

  // 細かい点列を作る。直線の両端は角の丸みの分だけ短くし、角は四分円でつなぐ。
  const dense = [];
  const push = (p, zone) => {
    const last = dense[dense.length - 1];
    if (!last || last.p.distanceToSquared(p) > 1e-4) dense.push({ p, zone });
  };
  const turnAt = (i) => i > 0 && i < pieces.length && !pieces[i - 1].dir.equals(pieces[i].dir);
  pieces.forEach((piece, i) => {
    const trimStart = turnAt(i) ? CORNER_RADIUS : 0;
    const trimEnd = turnAt(i + 1) ? CORNER_RADIUS : 0;
    if (piece.s) {
      const steps = Math.ceil(piece.len / 2);
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const s = Math.sin(Math.PI * t);
        push(new THREE.Vector3(piece.start.x + piece.len * t, 0, piece.start.z + piece.amp * s * s), piece.zone);
      }
    } else {
      const a = piece.start.clone().addScaledVector(piece.dir, trimStart);
      const b = piece.end.clone().addScaledVector(piece.dir, -trimEnd);
      const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 2));
      for (let k = 0; k <= steps; k++) push(a.clone().lerp(b, k / steps), piece.zone);
    }
    if (turnAt(i + 1)) {
      const next = pieces[i + 1];
      const centre = piece.end.clone().addScaledVector(piece.dir, -CORNER_RADIUS)
        .addScaledVector(next.dir, CORNER_RADIUS);
      const from = piece.end.clone().addScaledVector(piece.dir, -CORNER_RADIUS).sub(centre);
      const to = piece.end.clone().addScaledVector(next.dir, CORNER_RADIUS).sub(centre);
      const a0 = Math.atan2(from.z, from.x);
      let delta = Math.atan2(to.z, to.x) - a0;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      for (let k = 1; k < 12; k++) {
        const angle = a0 + delta * k / 12;
        push(new THREE.Vector3(centre.x + Math.cos(angle) * CORNER_RADIUS, 0,
          centre.z + Math.sin(angle) * CORNER_RADIUS), piece.zone);
      }
    }
  });

  // 3m間隔に取り直す。沿道の種類も一緒に運ぶ。
  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + dense[i].p.distanceTo(dense[i - 1].p));
  const total = lengths[lengths.length - 1];
  const routeCount = Math.ceil(total / 3);
  const route = [];
  const zones = [];
  for (let i = 0, j = 0; i < routeCount; i++) {
    const d = total * i / routeCount;
    while (lengths[j + 1] < d) j++;
    const t = (d - lengths[j]) / (lengths[j + 1] - lengths[j]);
    route.push(dense[j].p.clone().lerp(dense[j + 1].p, t));
    zones.push(t < 0.5 ? dense[j].zone : dense[j + 1].zone);
  }
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
  const copy = Math.ceil(160 / (total / routeCount));
  const extIndices = Array.from({ length: routeCount + copy * 2 }, (_, j) => j - copy);
  const ext = extIndices.map(at);
  const extTangents = extIndices.map(normalAt);
  const extZones = extIndices.map((i) => zones[((i % routeCount) + routeCount) % routeCount]);
  const seam = {
    offset: { x: offset.x, z: offset.z },
    startX: route[0].x, endX: route[0].x + offset.x,
  };
  const ringPosition = (x, z) => (x > seam.endX ? [x - offset.x, z - offset.z]
    : x < seam.startX ? [x + offset.x, z + offset.z] : [x, z]);

  const group = new THREE.Group();
  group.name = 'neo_procedural';
  // 道路。縁の線はネオンのように自ら光る(照明に左右されない)。
  const bands = [
    { name: 'GunmaRoad', from: -4.32, to: 4.32, y: 0, color: 0x24262e },
    { name: 'GunmaShoulder', from: -7.4, to: -4.32, y: 0.02, color: 0x33303f },
    { name: 'GunmaShoulder', from: 4.32, to: 7.4, y: 0.02, color: 0x33303f },
    { name: 'GunmaCenterLine', from: -0.07, to: 0.07, y: 0.018, color: 0xff3fb0, glow: true },
    { name: 'GunmaEdgeLine', from: -4.2, to: -4.08, y: 0.018, color: 0x2ff3ff, glow: true },
    { name: 'GunmaEdgeLine', from: 4.08, to: 4.2, y: 0.018, color: 0x2ff3ff, glow: true },
  ];
  for (const band of bands) {
    const vertices = new Float32Array(ext.length * 2 * 3);
    const indices = [];
    for (let i = 0; i < ext.length; i++) {
      const point = ext[i], normal = extTangents[i];
      for (let side = 0; side < 2; side++) {
        const across = side ? band.to : band.from;
        const o = (i * 2 + side) * 3;
        vertices[o] = point.x + normal.x * across;
        vertices[o + 1] = point.y + band.y;
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
    const material = band.glow
      ? new THREE.MeshBasicMaterial({ name: band.name, color: band.color, side: THREE.DoubleSide })
      : new THREE.MeshLambertMaterial({ name: band.name, color: band.color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = band.name;
    group.add(mesh);
  }

  // 平らな街。地面の高さは常に0。
  const groundHeightAt = () => 0;
  const groundNormalAt = () => new THREE.Vector3(0, 1, 0);
  const terrainHeightAt = () => 0;
  return { group, route, tangents, ext, extTangents, extIndices, extZones, zones, seam,
    climb: 0, mistColor: new THREE.Color(0x2a1a44), mistTime: { value: 0 },
    groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition };
}
