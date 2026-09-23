import * as THREE from '../lib/three.module.js';

// A closed mountain circuit. The five traverses have gentle bends; alternating
// 27 m radius U turns climb the slope. An outer road returns to the start.
export function buildGunmaMap(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const points = [];
  const halfLength = 190 + random() * 22;
  const radius = 25 + random() * 4;
  const rowSpacing = radius * 2;
  const grade = 2.8 + random() * 1.5;
  const phase = random() * Math.PI * 2;
  const bend = 3 + random() * 4;
  for (let row = 0; row < 5; row++) {
    const forward = row % 2 === 0;
    for (let i = row === 0 ? 0 : 1; i <= 105; i++) {
      const t = i / 105;
      const x = (forward ? -1 : 1) * halfLength * (1 - 2 * t);
      const wobble = Math.sin(Math.PI * t) * Math.sin(t * Math.PI * 2 + phase + row) * bend;
      points.push(new THREE.Vector3(x,
        4 + row * grade + Math.sin(Math.PI * t) * Math.sin(t * Math.PI * 2 + row + phase) * 1.4,
        -row * rowSpacing + wobble));
    }
    if (row === 4) break;
    const endX = forward ? halfLength : -halfLength;
    for (let i = 1; i <= 24; i++) {
      const angle = Math.PI * i / 24;
      const x = endX + (forward ? 1 : -1) * radius * Math.sin(angle);
      const z = -row * rowSpacing - radius * (1 - Math.cos(angle));
      const y = 4 + (row + (1 - Math.cos(angle)) / 2) * grade;
      points.push(new THREE.Vector3(x, y, z));
    }
  }
  // Keep the return outside the switchbacks. Catmull-Rom rounds its corners.
  const last = points[points.length - 1];
  const controls = [
    last.clone(),
    new THREE.Vector3(halfLength + 50, 4 + 4 * grade, -4 * rowSpacing),
    new THREE.Vector3(halfLength + 95, 4 + 3.8 * grade, -3.4 * rowSpacing),
    new THREE.Vector3(halfLength + 120, 4 + 3 * grade, -2 * rowSpacing),
    new THREE.Vector3(halfLength + 122, 4 + 2 * grade, -20),
    new THREE.Vector3(halfLength + 95, 4 + grade, 57),
    new THREE.Vector3(halfLength + 40, 5, 90),
    new THREE.Vector3(-halfLength - 30, 5, 90),
    new THREE.Vector3(-halfLength - 70, 4.5, 62),
    new THREE.Vector3(-halfLength - 65, 4, 24),
    points[0].clone(),
  ];
  const returnCurve = new THREE.CatmullRomCurve3(controls, false, 'centripetal');
  const returnSteps = Math.ceil(returnCurve.getLength() / 4);
  for (let i = 1; i < returnSteps; i++) points.push(returnCurve.getPoint(i / returnSteps));
  // Smooth the few joints of the return without changing the straight sections.
  const path = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  const count = Math.ceil(path.getLength() / 3);
  path.arcLengthDivisions = count * 4;
  path.updateArcLengths();
  const route = Array.from({ length: count }, (_, i) => path.getPointAt(i / count));
  const tangents = route.map((_, i) => {
    const a = route[(i - 1 + count) % count];
    const b = route[(i + 1) % count];
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dz / length, z: -dx / length };
  });
  const group = new THREE.Group();
  group.name = 'gunma_procedural';
  const bands = [
    { name: 'GunmaRoad', from: -3.6, to: 3.6, y: 0, color: 0x44484b },
    { name: 'GunmaShoulder', from: -7.5, to: -3.6, y: -0.11, color: 0x686750 },
    { name: 'GunmaShoulder', from: 3.6, to: 7.5, y: -0.11, color: 0x686750 },
    { name: 'GunmaForestFloor', from: -32, to: -7.5, y: -0.38, color: 0x486441 },
    { name: 'GunmaForestFloor', from: 7.5, to: 32, y: -0.38, color: 0x486441 },
    { name: 'GunmaCenterLine', from: -0.055, to: 0.055, y: 0.018, color: 0xcac9ae },
    { name: 'GunmaEdgeLine', from: -3.43, to: -3.37, y: 0.018, color: 0xd8d8d0 },
    { name: 'GunmaEdgeLine', from: 3.37, to: 3.43, y: 0.018, color: 0xd8d8d0 },
  ];
  for (const band of bands) {
    const vertices = new Float32Array(count * 2 * 3);
    const indices = [];
    for (let i = 0; i < count; i++) {
      const point = route[i], normal = tangents[i];
      for (let side = 0; side < 2; side++) {
        const offset = side ? band.to : band.from;
        const o = (i * 2 + side) * 3;
        vertices[o] = point.x + normal.x * offset;
        vertices[o + 1] = point.y + band.y;
        vertices[o + 2] = point.z + normal.z * offset;
      }
      const next = (i + 1) % count;
      indices.push(i * 2, next * 2, i * 2 + 1, i * 2 + 1, next * 2, next * 2 + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      name: band.name, color: band.color, side: THREE.DoubleSide,
    }));
    mesh.name = band.name;
    group.add(mesh);
  }
  return { group, route, tangents, random };
}

export function placeGunmaTrees(scene, treeMeshes, course, seed) {
  let state = (seed ^ 0xa531b937) >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const lists = treeMeshes.map(() => []);
  const { route, tangents } = course;
  for (let i = 0; i < route.length; i += 2) {
    for (const side of [-1, 1]) {
      if (random() < 0.15) continue;
      const point = route[i], normal = tangents[i];
      const distance = 10 + random() * 21;
      const x = point.x + side * normal.x * distance;
      const z = point.z + side * normal.z * distance;
      // Avoid placing a tree on another leg of the switchback.
      if (route.some((other, j) => j % 4 === 0 && Math.hypot(x - other.x, z - other.z) < 7.5)) continue;
      if (Math.hypot(x - route[0].x, z - route[0].z) < 18) continue;
      lists[Math.floor(random() * lists.length)].push({
        x, z, y: point.y - 0.38, angle: random() * Math.PI * 2,
        size: 1.2 + random() * 0.65,
      });
    }
  }
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let total = 0;
  lists.forEach((items, index) => {
    if (!items.length) return;
    const tree = treeMeshes[index];
    const instances = new THREE.InstancedMesh(tree.geometry, tree.material, items.length);
    items.forEach((item, i) => {
      quaternion.setFromAxisAngle(up, item.angle);
      matrix.compose(new THREE.Vector3(item.x, item.y, item.z), quaternion,
        new THREE.Vector3(item.size, item.size, item.size));
      instances.setMatrixAt(i, matrix);
    });
    instances.computeBoundingSphere();
    // Decorative foliage must never become a road or collision surface.
    instances.raycast = () => {};
    scene.add(instances);
    total += items.length;
  });
  return total;
}
