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
  // The moor also repeats north-south every zPeriod metres, so the car can
  // drive off across the grass for ever in any direction.
  const zPeriod = 2400;
  const wz = (2 * Math.PI) / zPeriod;
  // Wrap z into the one period around the road.
  const wrapZ = (z) => z - zPeriod * Math.round(z / zPeriod);
  // Rolling hills, periodic along x and z so every copy matches.
  const hillPhase = [random(), random(), random(), random()].map((v) => v * Math.PI * 2);
  const hillsAt = (x, z) => {
    const u = (x - x0) * w, v = z * wz;
    return 20
      + 7.5 * Math.sin(2 * u + hillPhase[0] + 2 * v)
      + 4.5 * Math.sin(3 * u + hillPhase[1] - 3 * v)
      + 2 * Math.sin(7 * u + hillPhase[2] + 11 * v)
      + 5 * Math.sin(u + hillPhase[3] + 4 * v);
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
  const mistColor = new THREE.Color(0x9ea596);
  const mistTime = { value: 0 };
  // Distant moor fades into the overcast haze, like the photographs.
  const farHaze = [0.16, 0.14];
  // Nearby grass keeps its own colour; only thin wisps drift over it.
  const nearHaze = [0.03, 0.22];

  // Ground: the road's own level beside it, easing into the rolling hills.
  const terrainSampleAt = (x, z) => {
    const [rx, rz] = ringPosition(x, z);
    // Far from the road the ground is the hills alone.
    if (Math.abs(z - zAt(x)) > 260) return { height: hillsAt(rx, rz), distance: 260 };
    let nearest = Infinity, roadY = 0;
    for (let i = 0; i < ext.length; i += 3) {
      const p = ext[i];
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < nearest) { nearest = d; roadY = p.y; }
    }
    const blend = THREE.MathUtils.smoothstep(nearest, 9, 80);
    return { height: THREE.MathUtils.lerp(roadY - 0.45, hillsAt(rx, rz), blend), distance: nearest };
  };
  const extBounds = new THREE.Box3().setFromPoints(ext);
  const minX = extBounds.min.x - 450, maxX = extBounds.max.x + 450;
  // One full z period plus a view margin each side of the wrap lines.
  const minZ = -zPeriod / 2 - 700, maxZ = zPeriod / 2 + 700;
  const cell = 16;
  const columns = Math.ceil((maxX - minX) / cell);
  const lines = Math.ceil((maxZ - minZ) / cell);
  const terrainVertices = new Float32Array((columns + 1) * (lines + 1) * 3);
  const terrainColors = new Float32Array(terrainVertices.length);
  const terrainMistDistances = new Float32Array((columns + 1) * (lines + 1));
  const terrainMistPatches = new Float32Array(terrainMistDistances.length);
  const terrainIndices = [];
  // Straw grass, green grass and brown heather, mixed in broad patches.
  // Linear colour values (they display brighter than they read).
  const straw = [0.36, 0.29, 0.14], green = [0.17, 0.25, 0.09], heather = [0.21, 0.13, 0.10];
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
      terrainMistPatches[iz * (columns + 1) + ix] = mistPatchAt(rx, wrapZ(rz));
      const greenMix = 0.5 + 0.5 * Math.sin(rx * 0.011 + Math.sin(rz * wz * 5) * 1.6);
      const heatherMix = THREE.MathUtils.smoothstep(Math.sin(rx * 0.0067 - rz * wz * 3 + 1.3), 0.35, 0.9);
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
  terrain.name = 'MoorGround';
  // Kept out of the map group, so it is never ray-cast: the car reads the
  // ground height straight from the grid instead (groundHeightAt).
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

  // Ground height with nothing past the mesh, for the atmosphere module.
  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ
    ? -Infinity : groundHeightAt(x, z));
  const climb = Math.max(...route.map((p) => p.y)) - Math.min(...route.map((p) => p.y));
  // Normal of the ground mesh at (x, z), from its height field.
  const groundNormalAt = (x, z) => new THREE.Vector3(
    groundHeightAt(x - 1, z) - groundHeightAt(x + 1, z), 2,
    groundHeightAt(x, z - 1) - groundHeightAt(x, z + 1)).normalize();
  return { group, ground: terrain, route, tangents, ext, extTangents, extIndices, seam, climb,
    mistColor, mistTime, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    zWrap: { center: 0, period: zPeriod }, gridBounds: { minX, maxX, minZ, maxZ } };
}
