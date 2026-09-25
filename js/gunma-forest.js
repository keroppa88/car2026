import * as THREE from '../lib/three.module.js';

// The road is endless: the ring of route points continues past its last point
// at route[0] + seam.offset. Both rows are drawn along the ring and ~160 m of
// copies beyond each end, with per-point randomness keyed to the ring index,
// so the forest on either side of the seam is identical.
export function createGunmaRoadsideForest(scene, route, tangents, groundHeightAt, seed, seam) {
  let state = (seed ^ 0x3f8a9d71) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const hash = (n) => {
    let h = Math.imul((n | 0) ^ seed, 0x9e3779b1) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  const group = new THREE.Group();
  group.name = 'gunma-roadside-forest';
  // Same unconverted RGB values used by the former dark-green tree shader.
  const treeGreen = [0.16, 0.30, 0.21];
  const ridgePositions = [], ridgeColors = [], ridgeIndices = [];
  const count = route.length;
  const offset = seam?.offset ?? { x: 0, z: 0 };
  const ring = (i) => ((i % count) + count) % count;
  const at = (i) => {
    const laps = Math.floor(i / count), p = route[ring(i)];
    return { x: p.x + offset.x * laps, y: p.y, z: p.z + offset.z * laps };
  };
  const step = Math.hypot(route[1].x - route[0].x, route[1].z - route[0].z);
  const copy = Math.ceil(160 / step);
  const extPoints = [];
  for (let i = -copy; i < count + copy; i++) extPoints.push(at(i));
  const terrainBounds = new THREE.Box3().setFromPoints(extPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
  const withinTerrain = (x, z) => x > terrainBounds.min.x - 120 && x < terrainBounds.max.x + 120
    && z > terrainBounds.min.z - 115 && z < terrainBounds.max.z + 115;
  // Check nearby road sections so switchback trees do not grow through another lane.
  const clearOfRoad = (x, z, clearance) => {
    let nearest2 = Infinity;
    for (let i = 0; i < extPoints.length; i += 6) {
      const dx = x - extPoints[i].x, dz = z - extPoints[i].z;
      nearest2 = Math.min(nearest2, dx * dx + dz * dz);
    }
    return nearest2 >= clearance * clearance;
  };
  // Row 2: the original low canopy band beside the road.
  for (const side of [-1, 1]) {
    let previous = null;
    for (let j = -copy; j < count + copy; j++) {
      const i = ring(j);
      if (i % 2 !== 0) continue;
      const point = at(j), normal = tangents[i];
      const offsetSide = side * (10.4 + 0.4 * Math.sin(i * 0.11 + side));
      const x = point.x + normal.x * offsetSide, z = point.z + normal.z * offsetSide;
      const valid = withinTerrain(x, z) && clearOfRoad(x, z, 9);
      if (!valid) { previous = null; continue; }
      const ground = groundHeightAt(x, z);
      const top = ground + 7.5 + 2.7 * Math.sin(i * 0.19 + side)
        + 1.9 * Math.sin(i * 0.63 - side) + hash(i * 4 + side + 1) * 2.1;
      const a = ridgePositions.length / 3;
      ridgePositions.push(x, ground - 0.7, z, x, top, z);
      const shade = 0.74 + hash(i * 4 + side + 2) * 0.24;
      for (let vertex = 0; vertex < 2; vertex++) {
        ridgeColors.push(...treeGreen.map((channel) => channel * shade));
      }
      if (previous !== null) {
        ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
      }
      previous = a;
    }
  }
  // Row 1: a lower fir canopy 1 m nearer the road than row 2, unbroken, with
  // blunt tips. Row 2 shows above its lower stretches.
  // Half a fir outline from the rim (u = 1) to the tip (u = 0), with small
  // branch-tier notches.
  const profileU = [1, 0.72, 0.55, 0.3, 0.18, 0];
  const profileY = [0, 0.38, 0.33, 0.68, 0.62, 1];
  const firShape = (u) => {
    const a = Math.abs(u);
    if (a >= 1) return 0;
    for (let k = 1; k < profileU.length; k++) {
      if (a >= profileU[k]) {
        const t = (a - profileU[k]) / (profileU[k - 1] - profileU[k]);
        return profileY[k] + (profileY[k - 1] - profileY[k]) * t;
      }
    }
    return 1;
  };
  // Distance along the ring; the last segment runs across the seam.
  const lengths = [0];
  for (let i = 1; i <= count; i++) {
    const a = at(i - 1), b = at(i);
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = lengths[count];
  const row1Green = [0.17, 0.33, 0.21];
  for (const side of [-1, 1]) {
    const ringTrees = [];
    for (let d = 0, k = 0; d < total; d += 2.6 + hash(k * 8 + side + 3) * 1.4, k++) {
      ringTrees.push({ at: d, width: 2.4 + hash(k * 8 + side + 4) * 1.0,
        rise: 1.6 + hash(k * 8 + side + 5) * 1.8, shade: 0.82 + hash(k * 8 + side + 6) * 0.2 });
    }
    // One lap of trees on each side of the ring, for the copies past the seam.
    const trees = [-1, 0, 1].flatMap((lap) => ringTrees.map((tree) => ({ ...tree, at: tree.at + lap * total })));
    const extent = copy * step;
    let previous = null, first = 0;
    for (let d = -extent; d < total + extent; d += 0.6) {
      while (first < trees.length && trees[first].at + trees[first].width < d) first++;
      let top = 0, shade = 0.9;
      for (let k = first; k < trees.length && trees[k].at - trees[k].width <= d; k++) {
        const h = trees[k].rise * firShape((d - trees[k].at) / trees[k].width);
        if (h > top) { top = h; shade = trees[k].shade; }
      }
      const laps = Math.floor(d / total);
      const dm = d - laps * total;
      let lo = 0, hi = count;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (lengths[mid] <= dm) lo = mid; else hi = mid;
      }
      const t = (dm - lengths[lo]) / (lengths[lo + 1] - lengths[lo]);
      const a0 = at(lo + laps * count), a1 = at(lo + 1 + laps * count);
      const n0 = tangents[lo], n1 = tangents[ring(lo + 1)];
      const offsetSide = side * (9.4 + 0.4 * Math.sin((lo + t) * 0.11 + side));
      const x = a0.x + (a1.x - a0.x) * t + (n0.x + (n1.x - n0.x) * t) * offsetSide;
      const z = a0.z + (a1.z - a0.z) * t + (n0.z + (n1.z - n0.z) * t) * offsetSide;
      if (!withinTerrain(x, z) || !clearOfRoad(x, z, 8)) { previous = null; continue; }
      const ground = groundHeightAt(x, z);
      const a = ridgePositions.length / 3;
      ridgePositions.push(x, ground - 0.7, z, x, ground + 4.2 + top, z);
      for (let vertex = 0; vertex < 2; vertex++) {
        ridgeColors.push(...row1Green.map((channel) => channel * shade));
      }
      if (previous !== null) {
        ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
      }
      previous = a;
    }
  }
  // Forested foothills fill the lower half of the distant mountains. Use the
  // existing mountain radius and first-layer height profile, leaving the peaks clear.
  const farPositions = [], farColors = [], farIndices = [];
  const loopBounds = new THREE.Box3().setFromPoints(route);
  const size = loopBounds.getSize(new THREE.Vector3());
  const center = loopBounds.getCenter(new THREE.Vector3());
  const mountainRadius = Math.hypot(size.x, size.z) * 0.5 + 450;
  const segments = 384;
  let previous = null;
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const profile = 0.5 + 0.23 * Math.sin(angle * 5)
      + 0.16 * Math.sin(angle * 11) + 0.11 * Math.sin(angle * 19);
    const mountainTop = loopBounds.max.y - 30 + profile * 95;
    const canopy = loopBounds.min.y + (mountainTop - loopBounds.min.y) * 0.5;
    const top = canopy + 3 * Math.sin(angle * 47) + 2 * Math.sin(angle * 89)
      + random() * 2.5;
    const radius = mountainRadius - 18;
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const a = farPositions.length / 3;
    farPositions.push(x, loopBounds.min.y - 180, z, x, top, z);
    for (let vertex = 0; vertex < 2; vertex++) {
      farColors.push(...treeGreen.map((channel) => channel * 0.86));
    }
    if (previous !== null) {
      farIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
    }
    previous = a;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ridgePositions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(ridgeColors, 3));
  geometry.setIndex(ridgeIndices);
  const ridge = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    vertexShader: `
      attribute vec3 color;
      varying vec3 forestColor;
      void main() {
        forestColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 forestColor;
      void main() { gl_FragColor = vec4(forestColor, 1.0); }`,
    side: THREE.DoubleSide,
  }));
  ridge.name = 'GunmaForestSilhouette';
  group.add(ridge);
  // The foothill ring is its own mesh: it follows the camera like the distant
  // ridges, so it does not jump at the seam.
  const farGeometry = new THREE.BufferGeometry();
  farGeometry.setAttribute('position', new THREE.Float32BufferAttribute(farPositions, 3));
  farGeometry.setAttribute('color', new THREE.Float32BufferAttribute(farColors, 3));
  farGeometry.setIndex(farIndices);
  const farRing = new THREE.Mesh(farGeometry, ridge.material);
  farRing.name = 'GunmaForestFoothills';
  group.add(farRing);
  group.userData.farRing = farRing;
  group.userData.farCenter = { x: center.x, z: center.z };
  scene.add(group);
  return group;
}
