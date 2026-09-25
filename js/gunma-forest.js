import * as THREE from '../lib/three.module.js';

export function createGunmaRoadsideForest(scene, route, tangents, groundHeightAt, seed) {
  let state = (seed ^ 0x3f8a9d71) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const group = new THREE.Group();
  group.name = 'gunma-roadside-forest';
  // Same unconverted RGB values used by the former dark-green tree shader.
  const treeGreen = [0.16, 0.30, 0.21];
  const ridgePositions = [], ridgeColors = [], ridgeIndices = [];
  const terrainBounds = new THREE.Box3().setFromPoints(route);
  const withinTerrain = (x, z) => x > terrainBounds.min.x - 120 && x < terrainBounds.max.x + 120
    && z > terrainBounds.min.z - 115 && z < terrainBounds.max.z + 115;
  // Check nearby road sections so switchback trees do not grow through another lane.
  const clearOfRoad = (x, z, clearance) => {
    let nearest2 = Infinity;
    for (let i = 0; i < route.length; i += 6) {
      const dx = x - route[i].x, dz = z - route[i].z;
      nearest2 = Math.min(nearest2, dx * dx + dz * dz);
    }
    return nearest2 >= clearance * clearance;
  };
  // Keep the low canopy beside the road without individual flat trees.
  for (const side of [-1, 1]) {
    let previous = null;
    for (let i = 0; i <= route.length; i += 2) {
      const index = i % route.length;
      const point = route[index], normal = tangents[index];
      const offset = side * (10.4 + 0.4 * Math.sin(i * 0.11 + side));
      const x = point.x + normal.x * offset, z = point.z + normal.z * offset;
      const valid = withinTerrain(x, z) && clearOfRoad(x, z, 9);
      if (!valid) { previous = null; continue; }
      const ground = groundHeightAt(x, z);
      const top = ground + 7.5 + 2.7 * Math.sin(i * 0.19 + side)
        + 1.9 * Math.sin(i * 0.63 - side) + random() * 2.1;
      const a = ridgePositions.length / 3;
      ridgePositions.push(x, ground - 0.7, z, x, top, z);
      const shade = 0.74 + random() * 0.24;
      for (let vertex = 0; vertex < 2; vertex++) {
        ridgeColors.push(...treeGreen.map((channel) => channel * shade));
      }
      if (previous !== null) {
        ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
      }
      previous = a;
    }
  }
  // Row 1: a lower fir canopy 1 m nearer the road than the band above (row 2),
  // unbroken, with blunt tips. Row 2 shows above its lower stretches. A
  // separate random stream leaves row 2 and the foothills exactly as before.
  let row1State = (seed ^ 0x51c3e2a7) >>> 0;
  const row1Random = () => ((row1State = (Math.imul(row1State, 1664525) + 1013904223) >>> 0) / 4294967296);
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
  const lengths = [0];
  for (let i = 1; i <= route.length; i++) {
    const a = route[i - 1], b = route[i % route.length];
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = lengths[route.length];
  const row1Green = [0.17, 0.33, 0.21];
  for (const side of [-1, 1]) {
    const trees = [];
    for (let d = 0; d < total; d += 2.6 + row1Random() * 1.4) {
      trees.push({ at: d, width: 2.4 + row1Random() * 1.0,
        rise: 1.6 + row1Random() * 1.8, shade: 0.82 + row1Random() * 0.2 });
    }
    let previous = null, first = 0, segment = 0;
    for (let d = 0; d < total; d += 0.6) {
      while (lengths[segment + 1] < d) segment++;
      while (first < trees.length && trees[first].at + trees[first].width < d) first++;
      let top = 0, shade = 0.9;
      for (let k = first; k < trees.length && trees[k].at - trees[k].width <= d; k++) {
        const h = trees[k].rise * firShape((d - trees[k].at) / trees[k].width);
        if (h > top) { top = h; shade = trees[k].shade; }
      }
      const t = (d - lengths[segment]) / (lengths[segment + 1] - lengths[segment]);
      const next = (segment + 1) % route.length;
      const a0 = route[segment], a1 = route[next];
      const n0 = tangents[segment], n1 = tangents[next];
      const offset = side * (9.4 + 0.4 * Math.sin((segment + t) * 0.11 + side));
      const x = a0.x + (a1.x - a0.x) * t + (n0.x + (n1.x - n0.x) * t) * offset;
      const z = a0.z + (a1.z - a0.z) * t + (n0.z + (n1.z - n0.z) * t) * offset;
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
  const size = terrainBounds.getSize(new THREE.Vector3());
  const center = terrainBounds.getCenter(new THREE.Vector3());
  const mountainRadius = Math.hypot(size.x, size.z) * 0.5 + 450;
  const segments = 384;
  let previous = null;
  for (let i = 0; i <= segments; i++) {
    const angle = i / segments * Math.PI * 2;
    const profile = 0.5 + 0.23 * Math.sin(angle * 5)
      + 0.16 * Math.sin(angle * 11) + 0.11 * Math.sin(angle * 19);
    const mountainTop = terrainBounds.max.y - 30 + profile * 95;
    const canopy = terrainBounds.min.y + (mountainTop - terrainBounds.min.y) * 0.5;
    const top = canopy + 3 * Math.sin(angle * 47) + 2 * Math.sin(angle * 89)
      + random() * 2.5;
    const radius = mountainRadius - 18;
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const a = ridgePositions.length / 3;
    ridgePositions.push(x, terrainBounds.min.y - 180, z, x, top, z);
    for (let vertex = 0; vertex < 2; vertex++) {
      ridgeColors.push(...treeGreen.map((channel) => channel * 0.86));
    }
    if (previous !== null) {
      ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
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
  scene.add(group);
  return group;
}
