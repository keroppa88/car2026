import * as THREE from '../lib/three.module.js';
import { addSideMist, mistPatchAt } from './gunma-map.js?v=20260927-moor-1';

// 嵐が丘: a two-lane road across open West Yorkshire moorland. Gentle curves
// and a gentle rise and fall over rolling grass, with low dry-stone walls in
// place of guardrails. The same endless ring as Gunma: the last point
// continues to route[0] + seam.offset, and crossing either end warps the car
// by that offset onto an identical copy of the other end.
//
// The road runs east over one period P. Its sideways wander and the hills are
// built only from whole-period waves along x, so the ends match exactly and
// the ground just past each end is the same as the ground at the other end.
export function buildMoorMap(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const period = 4200;
  // The spawn point (0, 0) sits just past the start of the ring.
  const x0 = -40;
  // Sideways wander: whole-period waves with a correction term so both ends
  // sit on z = 0 heading due east.
  const wander = [
    { k: 2, a: 150 + random() * 40, phase: random() * Math.PI * 2 },
    { k: 3, a: 80 + random() * 30, phase: random() * Math.PI * 2 },
    { k: 5, a: 26 + random() * 10, phase: random() * Math.PI * 2 },
    { k: 7, a: 9 + random() * 5, phase: random() * Math.PI * 2 },
  ];
  const w = (2 * Math.PI) / period;
  const zAt = (x) => {
    const u = x - x0;
    let z = 0;
    for (const { k, a, phase } of wander) {
      z += a * (Math.sin(k * w * u + phase) - Math.sin(phase)
        - k * Math.cos(phase) * Math.sin(w * u));
    }
    return z;
  };
  // Rolling hills, periodic along x so the copies past each end match.
  const hillPhase = [random(), random(), random(), random()].map((v) => v * Math.PI * 2);
  const hillsAt = (x, z) => {
    const u = (x - x0) * w;
    return 20
      + 7.5 * Math.sin(2 * u + hillPhase[0] + z * 0.004)
      + 4.5 * Math.sin(3 * u + hillPhase[1] - z * 0.006)
      + 2 * Math.sin(7 * u + hillPhase[2] + z * 0.011)
      + 5 * Math.sin(u + hillPhase[3] + z * 0.009);
  };

  const count = Math.round(period / 3);
  const samples = Array.from({ length: count + 1 }, (_, i) => {
    const x = x0 + period * i / count;
    return new THREE.Vector3(x, 0, zAt(x));
  });
  // Resample by arc length so points are evenly spaced along the road.
  const lengths = [0];
  for (let i = 1; i <= count; i++) lengths.push(lengths[i - 1] + samples[i].distanceTo(samples[i - 1]));
  const total = lengths[count];
  const routeCount = Math.ceil(total / 3);
  const route = [];
  for (let i = 0, j = 0; i < routeCount; i++) {
    const d = total * i / routeCount;
    while (lengths[j + 1] < d) j++;
    const t = (d - lengths[j]) / (lengths[j + 1] - lengths[j]);
    route.push(samples[j].clone().lerp(samples[j + 1], t));
  }
  const offset = new THREE.Vector3(period, 0, 0);
  // The road follows the hills, smoothed over about 90 m.
  const rawY = route.map((p) => hillsAt(p.x, p.z));
  const ring = (i) => ((i % routeCount) + routeCount) % routeCount;
  route.forEach((p, i) => {
    let sum = 0;
    for (let k = -15; k <= 15; k++) sum += rawY[ring(i + k)];
    p.y = sum / 31;
  });
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
  const seam = {
    offset: { x: offset.x, z: offset.z },
    startX: route[0].x, endX: route[0].x + offset.x,
  };
  const ringPosition = (x, z) => (x > seam.endX ? [x - offset.x, z - offset.z]
    : x < seam.startX ? [x + offset.x, z + offset.z] : [x, z]);

  const group = new THREE.Group();
  group.name = 'moor_procedural';
  const mistColor = new THREE.Color(0xb7bcb6);
  const mistTime = { value: 0 };
  // Distant moor fades into the overcast haze, like the photographs.
  const farHaze = [0.30, 0.22];
  // Nearby grass keeps its own colour; only thin wisps drift over it.
  const nearHaze = [0.03, 0.22];

  // Ground: the road's own level beside it, easing into the rolling hills.
  const terrainSampleAt = (x, z) => {
    let nearest = Infinity, roadY = 0;
    for (let i = 0; i < ext.length; i += 3) {
      const p = ext[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < nearest) { nearest = d; roadY = p.y; }
    }
    const [rx, rz] = ringPosition(x, z);
    const blend = THREE.MathUtils.smoothstep(nearest, 9, 80);
    return { height: THREE.MathUtils.lerp(roadY - 0.45, hillsAt(rx, rz), blend), distance: nearest };
  };
  const extBounds = new THREE.Box3().setFromPoints(ext);
  const minX = extBounds.min.x - 450, maxX = extBounds.max.x + 450;
  const minZ = extBounds.min.z - 450, maxZ = extBounds.max.z + 450;
  const cell = 16;
  const columns = Math.ceil((maxX - minX) / cell);
  const lines = Math.ceil((maxZ - minZ) / cell);
  const terrainVertices = new Float32Array((columns + 1) * (lines + 1) * 3);
  const terrainColors = new Float32Array(terrainVertices.length);
  const terrainMistDistances = new Float32Array((columns + 1) * (lines + 1));
  const terrainMistPatches = new Float32Array(terrainMistDistances.length);
  const terrainIndices = [];
  // Straw grass, green grass and brown heather, mixed in broad patches.
  const straw = [0.55, 0.50, 0.31], green = [0.34, 0.43, 0.22], heather = [0.37, 0.28, 0.24];
  for (let iz = 0; iz <= lines; iz++) {
    for (let ix = 0; ix <= columns; ix++) {
      const x = minX + (maxX - minX) * ix / columns;
      const z = minZ + (maxZ - minZ) * iz / lines;
      const index = (iz * (columns + 1) + ix) * 3;
      const sample = terrainSampleAt(x, z);
      const [rx, rz] = ringPosition(x, z);
      terrainVertices[index] = x;
      terrainVertices[index + 1] = sample.height;
      terrainVertices[index + 2] = z;
      terrainMistDistances[iz * (columns + 1) + ix] = sample.distance;
      terrainMistPatches[iz * (columns + 1) + ix] = mistPatchAt(rx, rz);
      const greenMix = 0.5 + 0.5 * Math.sin(rx * 0.011 + Math.sin(rz * 0.013) * 1.6);
      const heatherMix = THREE.MathUtils.smoothstep(Math.sin(rx * 0.0067 - rz * 0.0081 + 1.3), 0.35, 0.9);
      const shade = 0.88 + 0.12 * Math.sin(ix * 1.71 + iz * 2.13);
      for (let c = 0; c < 3; c++) {
        const base = straw[c] + (green[c] - straw[c]) * greenMix;
        terrainColors[index + c] = (base + (heather[c] - base) * heatherMix * 0.7) * shade;
      }
      if (ix < columns && iz < lines) {
        const a = iz * (columns + 1) + ix, b = a + columns + 1;
        terrainIndices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute('position', new THREE.BufferAttribute(terrainVertices, 3));
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(terrainColors, 3));
  terrainGeometry.setAttribute('mistDistance', new THREE.BufferAttribute(terrainMistDistances, 1));
  terrainGeometry.setAttribute('mistPatch', new THREE.BufferAttribute(terrainMistPatches, 1));
  terrainGeometry.setIndex(terrainIndices);
  terrainGeometry.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeometry, addSideMist(new THREE.MeshLambertMaterial({
    name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide,
  }), mistColor, mistTime, seam, farHaze, nearHaze));
  terrain.name = 'GunmaGrass';
  group.add(terrain);
  // Height of the ground mesh itself, so the verge and scenery sit on it.
  const groundHeightAt = (x, z) => {
    const fx = THREE.MathUtils.clamp((x - minX) * columns / (maxX - minX), 0, columns - 1e-6);
    const fz = THREE.MathUtils.clamp((z - minZ) * lines / (maxZ - minZ), 0, lines - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const index = (iz * (columns + 1) + ix) * 3 + 1;
    const a = terrainVertices[index];
    const right = terrainVertices[index + 3];
    const down = terrainVertices[index + (columns + 1) * 3];
    const diagonal = terrainVertices[index + (columns + 2) * 3];
    return tx + tz <= 1
      ? a * (1 - tx - tz) + right * tx + down * tz
      : right * (1 - tz) + down * (1 - tx) + diagonal * (tx + tz - 1);
  };

  const bands = [
    { name: 'GunmaRoad', from: -4.32, to: 4.32, y: 0, color: 0x46484a },
    { name: 'GunmaShoulder', from: -7.4, to: -4.32, y: -0.11, color: 0x7a7c50 },
    { name: 'GunmaShoulder', from: 4.32, to: 7.4, y: -0.11, color: 0x7a7c50 },
    { name: 'GunmaGrass', from: -30, to: -7.4, y: -0.38, color: 0x8a8456 },
    { name: 'GunmaGrass', from: 7.4, to: 30, y: -0.38, color: 0x8a8456 },
    { name: 'GunmaCenterLine', from: -0.055, to: 0.055, y: 0.018, color: 0xd8d6c4 },
    { name: 'GunmaEdgeLine', from: -4.15, to: -4.09, y: 0.018, color: 0xd8d8d0 },
    { name: 'GunmaEdgeLine', from: 4.09, to: 4.15, y: 0.018, color: 0xd8d8d0 },
  ];
  for (const band of bands) {
    const vertices = new Float32Array(ext.length * 2 * 3);
    const hazy = band.name === 'GunmaGrass' || band.name === 'GunmaShoulder';
    const mistDistances = hazy ? new Float32Array(ext.length * 2) : null;
    const mistPatches = hazy ? new Float32Array(ext.length * 2) : null;
    const indices = [];
    for (let i = 0; i < ext.length; i++) {
      const point = ext[i], normal = extTangents[i];
      for (let side = 0; side < 2; side++) {
        const across = side ? band.to : band.from;
        const o = (i * 2 + side) * 3;
        vertices[o] = point.x + normal.x * across;
        vertices[o + 2] = point.z + normal.z * across;
        if (hazy) {
          mistDistances[i * 2 + side] = Math.abs(across);
          mistPatches[i * 2 + side] = mistPatchAt(...ringPosition(vertices[o], vertices[o + 2]));
        }
        vertices[o + 1] = band.name === 'GunmaGrass'
          ? Math.abs(across) > 20
            ? groundHeightAt(vertices[o], vertices[o + 2])
            : point.y - 0.11
          : band.name === 'GunmaShoulder'
            ? point.y - (Math.abs(across) > 4.33 ? 0.11 : 0)
            : point.y + band.y;
      }
      if (i + 1 < ext.length) {
        const next = i + 1;
        indices.push(i * 2, next * 2, i * 2 + 1, i * 2 + 1, next * 2, next * 2 + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    if (hazy) {
      geometry.setAttribute('mistDistance', new THREE.BufferAttribute(mistDistances, 1));
      geometry.setAttribute('mistPatch', new THREE.BufferAttribute(mistPatches, 1));
    }
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const material = new THREE.MeshLambertMaterial({
      name: band.name, color: band.color, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry,
      hazy ? addSideMist(material, mistColor, mistTime, seam, farHaze, nearHaze) : material);
    mesh.name = band.name;
    group.add(mesh);
  }

  // Low dry-stone walls along both edges, in place of guardrails. The top
  // edge wobbles a little so the wall reads as stacked stone.
  const wallMaterial = new THREE.MeshLambertMaterial({
    name: 'GunmaGuardrail', color: 0x6a675e, side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    const vertices = new Float32Array(ext.length * 4 * 3);
    const indices = [];
    for (let i = 0; i < ext.length; i++) {
      const point = ext[i], normal = extTangents[i];
      const r = ((extIndices[i] % routeCount) + routeCount) % routeCount;
      const top = 0.78 + 0.07 * Math.sin(r * 2.3) + 0.04 * Math.sin(r * 5.1);
      const o = i * 12;
      for (const [k, across, y] of [[0, 5.27, -0.3], [1, 5.27, top], [2, 5.62, top], [3, 5.62, -0.3]]) {
        vertices[o + k * 3] = point.x + side * normal.x * across;
        vertices[o + k * 3 + 1] = point.y + y;
        vertices[o + k * 3 + 2] = point.z + side * normal.z * across;
      }
      if (i + 1 < ext.length) {
        const a = i * 4, b = (i + 1) * 4;
        // Road face, top and back face.
        for (const [p, q] of [[0, 1], [1, 2], [2, 3]]) {
          indices.push(a + p, b + p, a + q, a + q, b + p, b + q);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const wall = new THREE.Mesh(geometry, wallMaterial);
    wall.name = 'GunmaGuardrail';
    group.add(wall);
  }

  // Ground height with nothing past the mesh, for the atmosphere module.
  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ
    ? -Infinity : groundHeightAt(x, z));
  const climb = Math.max(...route.map((p) => p.y)) - Math.min(...route.map((p) => p.y));
  return { group, route, tangents, ext, extTangents, extIndices, seam, climb, mistColor, mistTime,
    groundHeightAt, terrainHeightAt, ringPosition, gridBounds: { minX, maxX, minZ, maxZ } };
}
