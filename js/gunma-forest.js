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
  // Conifer outline (half tree, from the rim to the tip): branch tiers make
  // small notches, so the edge reads as a row of firs rather than a smooth wave.
  const profileU = [1, 0.8, 0.62, 0.45, 0.3, 0.15, 0];
  const profileY = [0.30, 0.46, 0.43, 0.64, 0.60, 0.82, 1];
  const treeHeightAt = (u) => {
    const a = Math.min(Math.abs(u), 1);
    for (let k = 1; k < profileU.length; k++) {
      if (a >= profileU[k]) {
        const t = (a - profileU[k]) / (profileU[k - 1] - profileU[k]);
        return profileY[k] + (profileY[k - 1] - profileY[k]) * t;
      }
    }
    return 1;
  };
  // Distance along the road -> position beside it.
  const lengths = [0];
  for (let i = 1; i <= route.length; i++) {
    const a = route[i - 1], b = route[i % route.length];
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = lengths[route.length];
  let cursor = 0;
  const besideRoad = (distance, offset) => {
    while (lengths[cursor + 1] < distance) cursor++;
    const t = (distance - lengths[cursor]) / (lengths[cursor + 1] - lengths[cursor]);
    const a = route[cursor], b = route[(cursor + 1) % route.length];
    const na = tangents[cursor], nb = tangents[(cursor + 1) % route.length];
    return {
      x: a.x + (b.x - a.x) * t + (na.x + (nb.x - na.x) * t) * offset,
      z: a.z + (b.z - a.z) * t + (na.z + (nb.z - na.z) * t) * offset,
    };
  };
  // Row 1: dark green firs beside the verge, broken by occasional clearings.
  // Row 2: darker, about as tall as row 1's tallest trees, so it only shows
  // through the clearings and above row 1's lower trees.
  const rows = [
    { offset: 10.4, step: 0.5, spacing: [2.2, 3.4], width: [1.5, 2.3],
      height: [6.5, 11], green: [0.10, 0.24, 0.13], gapChance: 0.07, gap: [8, 24] },
    { offset: 18.5, step: 0.8, spacing: [2.6, 4.0], width: [1.8, 2.8],
      height: [9.5, 11.5], green: [0.05, 0.13, 0.08], gapChance: 0, gap: [0, 0] },
  ];
  const range = ([min, max]) => min + random() * (max - min);
  for (const row of rows) {
    for (const side of [-1, 1]) {
      // Place trees first, then sample the upper envelope of their outlines.
      const trees = [];
      for (let d = 0; d < total; d += range(row.spacing)) {
        if (random() < row.gapChance) { d += range(row.gap); continue; }
        trees.push({ at: d, width: range(row.width), height: range(row.height),
          shade: 0.8 + random() * 0.3 });
      }
      cursor = 0;
      let previous = null, first = 0;
      for (let d = 0; d < total; d += row.step) {
        while (first < trees.length && trees[first].at + trees[first].width < d) first++;
        let top = 0, shade = 1;
        for (let k = first; k < trees.length && trees[k].at - trees[k].width <= d; k++) {
          const tree = trees[k];
          const u = (d - tree.at) / tree.width;
          if (Math.abs(u) > 1) continue;
          const h = tree.height * treeHeightAt(u);
          if (h > top) { top = h; shade = tree.shade; }
        }
        const { x, z } = besideRoad(d, side * row.offset);
        if (top <= 0 || !withinTerrain(x, z) || !clearOfRoad(x, z, row.offset - 1.5)) {
          previous = null;
          continue;
        }
        const ground = groundHeightAt(x, z);
        const a = ridgePositions.length / 3;
        ridgePositions.push(x, ground - 0.7, z, x, ground + top, z);
        for (let vertex = 0; vertex < 2; vertex++) {
          ridgeColors.push(...row.green.map((channel) => channel * shade));
        }
        if (previous !== null) {
          ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
        }
        previous = a;
      }
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
