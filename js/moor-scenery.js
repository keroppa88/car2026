import * as THREE from '../lib/three.module.js';

// Lone trees on the open moor, instanced: a handful of draw calls in total.
// Positions are chosen along one period of the ring, then repeated one seam
// before and after, so the copies past each end of the road match.
export function createMoorScenery(scene, course, seed) {
  let state = (seed ^ 0x6d2b79f5) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const { route, groundHeightAt, seam } = course;
  const offset = seam.offset;
  const group = new THREE.Group();
  group.name = 'moor-scenery';
  const nearestRoad = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < route.length; i += 4) {
      best = Math.min(best, Math.hypot(x - route[i].x, z - route[i].z));
    }
    // Also the neighbouring copies across the seam.
    for (const k of [-1, 1]) {
      for (let i = 0; i < route.length; i += 4) {
        best = Math.min(best, Math.hypot(x - route[i].x - offset.x * k, z - route[i].z - offset.z * k));
      }
    }
    return best;
  };
  // Pick a spot beside the road at a chosen distance band.
  const place = (minDistance, maxDistance) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = route[Math.floor(random() * route.length)];
      const angle = random() * Math.PI * 2;
      const r = minDistance + random() * (maxDistance - minDistance);
      const x = p.x + Math.cos(angle) * r, z = p.z + Math.sin(angle) * r;
      if (x < seam.startX || x >= seam.endX) continue;
      if (nearestRoad(x, z) < minDistance) continue;
      return { x, z };
    }
    return null;
  };
  const copies = (spot, fn) => {
    for (const k of [-1, 0, 1]) {
      const x = spot.x + offset.x * k, z = spot.z + offset.z * k;
      // Only the nearby copies are ever seen; skip the rest.
      if (k !== 0 && Math.min(Math.abs(x - seam.startX), Math.abs(x - seam.endX)) > 600) continue;
      fn(x, z);
    }
  };
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  // Lone trees: gnarled, wind-bent hawthorns that are mostly bare branches.
  // Four shapes are grown once and shared by instancing.
  // Two shapes lean with the wind, two stand upright.
  const variants = [1, 1, 0, 0].map((lean) => buildTreeGeometry(random, lean));
  const treeSpots = [];
  for (let i = 0; i < 60; i++) {
    const spot = place(14, 260);
    if (spot) treeSpots.push({ ...spot, size: 0.8 + random() * 0.6, turn: (random() - 0.5) * 0.8, variant: i % variants.length });
  }
  const barkMaterial = new THREE.MeshLambertMaterial({ color: 0x4a4038, flatShading: true });
  variants.forEach((geometry, v) => {
    const placed = [];
    for (const tree of treeSpots) if (tree.variant === v) copies(tree, (x, z) => placed.push({ x, z, tree }));
    const mesh = new THREE.InstancedMesh(geometry, barkMaterial, Math.max(placed.length, 1));
    mesh.count = placed.length;
    placed.forEach(({ x, z, tree }, i) => {
      position.set(x, groundHeightAt(x, z) - 0.15, z);
      // The prevailing wind bends every tree the same way; only a little turn.
      quaternion.setFromAxisAngle(up, tree.turn);
      scale.setScalar(tree.size);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.name = 'MoorTree';
    group.add(mesh);
  });

  scene.add(group);
  return group;
}

// One gnarled tree: a leaning trunk that forks into ever thinner branches,
// every branch pushed downwind (+x) and a little upward. Built from open
// five-sided tubes, all in one geometry.
function buildTreeGeometry(random, lean) {
  const positions = [], indices = [];
  const wind = new THREE.Vector3(1, 0, 0.25).normalize();
  const upward = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3(), other = new THREE.Vector3(), point = new THREE.Vector3();
  const tube = (start, end, r0, r1) => {
    const dir = end.clone().sub(start).normalize();
    side.set(dir.y, -dir.x, 0);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    other.crossVectors(dir, side).normalize();
    const base = positions.length / 3;
    for (const [centre, r] of [[start, r0], [end, r1]]) {
      for (let k = 0; k < 5; k++) {
        const angle = k / 5 * Math.PI * 2;
        point.copy(centre).addScaledVector(side, Math.cos(angle) * r).addScaledVector(other, Math.sin(angle) * r);
        positions.push(point.x, point.y, point.z);
      }
    }
    for (let k = 0; k < 5; k++) {
      const a = base + k, b = base + (k + 1) % 5;
      indices.push(a, b, a + 5, b, b + 5, a + 5);
    }
  };
  const grow = (start, dir, length, radius, depth) => {
    // A slight kink halfway makes each branch crooked rather than straight.
    const bend = new THREE.Vector3(random() - 0.5, random() * 0.3, random() - 0.5).multiplyScalar(0.35);
    const middle = start.clone().addScaledVector(dir, length * 0.5);
    const endDir = dir.clone().add(bend).normalize();
    const end = middle.clone().addScaledVector(endDir, length * 0.5);
    const tip = Math.max(radius * 0.62, 0.03);
    tube(start, middle, radius, (radius + tip) / 2);
    tube(middle, end, (radius + tip) / 2, tip);
    if (depth === 0) return;
    const children = depth >= 4 ? 2 : 2 + (random() < 0.5 ? 1 : 0);
    for (let c = 0; c < children; c++) {
      const axis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).cross(endDir).normalize();
      const childDir = endDir.clone().applyAxisAngle(axis, 0.45 + random() * 0.55)
        .addScaledVector(wind, 0.15 + 0.25 * lean).addScaledVector(upward, 0.12).normalize();
      grow(end, childDir, length * (0.66 + random() * 0.14), tip, depth - 1);
    }
  };
  // Trunk leans gently downwind (or stands upright), then forks low like a
  // hawthorn on open moor.
  const trunkDir = upward.clone().addScaledVector(wind, (0.17 + random() * 0.13) * lean).normalize();
  grow(new THREE.Vector3(0, 0, 0), trunkDir, 2.4 + random() * 0.8, 0.3, 5);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
