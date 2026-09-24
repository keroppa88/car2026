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
