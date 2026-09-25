import * as THREE from '../lib/three.module.js';

function mistPatchAt(x, z) {
  const wisps = Math.sin(x * 0.12 + Math.sin(z * 0.09) * 1.3)
    * Math.sin(z * 0.10 - x * 0.05) + 0.15 * Math.sin(x * 0.28 + z * 0.17);
  return THREE.MathUtils.smoothstep(wisps, -0.5, 0.7);
}

// Haze is applied only to grass. Asphalt and guardrails keep their full contrast.
function addSideMist(material, mistColor, mistTime, seam) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.gunmaMistColor = { value: mistColor };
    shader.uniforms.gunmaSeam = { value: new THREE.Vector4(seam.startX, seam.endX, seam.offset.x, seam.offset.z) };
    shader.uniforms.gunmaMistTime = mistTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float mistDistance;
        attribute float mistPatch;
        varying float vMistDistance;
        varying float vMistPatch;
        varying vec3 vMistWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vMistDistance = mistDistance;
        vMistPatch = mistPatch;
        vMistWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 gunmaMistColor;
        uniform float gunmaMistTime;
        uniform vec4 gunmaSeam;
        varying float vMistDistance;
        varying float vMistPatch;
        varying vec3 vMistWorld;
        float mistHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float mistNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(mistHash(i),mistHash(i+vec2(1,0)),f.x),
            mix(mistHash(i+vec2(0,1)),mistHash(i+vec2(1,1)),f.x),f.y);
        }`)
      .replace('#include <output_fragment>', `
        float roadside = smoothstep(4.5, 19.0, vMistDistance);
        float farField = smoothstep(65.0, 310.0, distance(cameraPosition, vMistWorld));
        // Copies beyond either end of the road reuse the pattern of the other end.
        vec2 ringXZ = vMistWorld.xz - (vMistWorld.x > gunmaSeam.y ? gunmaSeam.zw
          : vMistWorld.x < gunmaSeam.x ? -gunmaSeam.zw : vec2(0.0));
        vec2 flow = ringXZ * vec2(0.045,0.07) + vec2(gunmaMistTime*0.017,-gunmaMistTime*0.009);
        float mistDensity = mistNoise(flow)*0.65 + mistNoise(flow*2.7+4.3)*0.35;
        float wisps = smoothstep(0.22,0.76,mistDensity);
        // Distant ground keeps its forest colour; the cloud sea supplies the white.
        // A strong far-field haze here painted the valley as one flat pale sheet.
        float haze = roadside * mix(0.12+0.64*wisps, 0.14+0.20*wisps, farField);
        // Fine detail is evaluated per pixel, not interpolated across broad terrain triangles.
        outgoingLight *= 0.86 + 0.20*mistDensity + 0.04*vMistPatch;
        outgoingLight = mix(outgoingLight, gunmaMistColor*(0.90+0.10*wisps), haze);
        #include <output_fragment>`);
  };
  material.customProgramCacheKey = () => 'gunma-side-mist-v6';
  return material;
}

// An endless touge: a short straight, hairpins over two mountains, and a short
// straight that runs back into the first one. The route is stored as a ring
// whose last point continues to route[0] + seam.offset: crossing that seam
// warps the car back by the offset. The road just past each end is drawn as a
// copy of the other end, so the view does not change at the warp.
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
  const rows = 13;
  const straight = 90;
  const phase = random() * Math.PI * 2;
  const bend = 3 + random() * 4;
  for (let i = 0; i < 30; i++) {
    points.push(new THREE.Vector3(-halfLength - straight * (1 - i / 30), 0, 0));
  }
  for (let row = 0; row < rows; row++) {
    const forward = row % 2 === 0;
    for (let i = 0; i <= 105; i++) {
      if (row > 0 && i === 0) continue;
      const t = i / 105;
      const x = (forward ? -1 : 1) * halfLength * (1 - 2 * t);
      const wobble = Math.sin(Math.PI * t) * Math.sin(t * Math.PI * 2 + phase + row) * bend;
      points.push(new THREE.Vector3(x, 0, -row * rowSpacing + wobble));
    }
    if (row === rows - 1) break;
    const endX = forward ? halfLength : -halfLength;
    for (let i = 1; i <= 24; i++) {
      const angle = Math.PI * i / 24;
      const x = endX + (forward ? 1 : -1) * radius * Math.sin(angle);
      const z = -row * rowSpacing - radius * (1 - Math.cos(angle));
      points.push(new THREE.Vector3(x, 0, z));
    }
  }
  // An odd row count ends heading east, parallel to the first straight.
  const lastZ = -(rows - 1) * rowSpacing;
  for (let i = 1; i <= 30; i++) {
    points.push(new THREE.Vector3(halfLength + straight * i / 30, 0, lastZ));
  }
  const path = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const total = path.getLength();
  const count = Math.ceil(total / 3);
  path.arcLengthDivisions = count * 4;
  path.updateArcLengths();
  const route = Array.from({ length: count }, (_, i) => path.getPointAt(i / count));
  const offset = new THREE.Vector3().subVectors(points[points.length - 1], points[0]);
  // Two humps with a saddle between them; both straights stay on the valley floor.
  const climb = 135 + random() * 30;
  const flat = straight / total;
  route.forEach((point, i) => {
    const u = THREE.MathUtils.clamp((i / count - flat) / (1 - 2 * flat), 0, 1);
    point.y = 4 + climb * (0.65 * (1 - Math.cos(4 * Math.PI * u)) / 2
      + 0.35 * (1 - Math.cos(2 * Math.PI * u)) / 2);
  });
  // Point i of the endless road (any integer): the ring shifted by whole seams.
  const at = (i) => {
    const laps = Math.floor(i / count);
    const p = route[i - laps * count];
    return new THREE.Vector3(p.x + offset.x * laps, p.y, p.z + offset.z * laps);
  };
  const normalAt = (i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dz / length, z: -dx / length };
  };
  const tangents = route.map((_, i) => normalAt(i));
  // Copies drawn beyond each end of the ring (about 160 m each way).
  const copy = Math.ceil(160 / (total / count));
  const extIndices = Array.from({ length: count + copy * 2 }, (_, j) => j - copy);
  const ext = extIndices.map(at);
  const extTangents = extIndices.map(normalAt);
  const seam = {
    offset: { x: offset.x, z: offset.z },
    // Anything west of startX or east of endX is a copy of the other end.
    startX: route[0].x, endX: route[0].x + offset.x,
  };
  const ringPosition = (x, z) => (x > seam.endX ? [x - offset.x, z - offset.z]
    : x < seam.startX ? [x + offset.x, z + offset.z] : [x, z]);
  const group = new THREE.Group();
  group.name = 'gunma_procedural';
  const mistColor = new THREE.Color(0xaebdb4);
  const mistTime = { value: 0 };
  const bands = [
    { name: 'GunmaRoad', from: -4.32, to: 4.32, y: 0, color: 0x44484b },
    { name: 'GunmaShoulder', from: -8.22, to: -4.32, y: -0.11, color: 0x63805a },
    { name: 'GunmaShoulder', from: 4.32, to: 8.22, y: -0.11, color: 0x63805a },
    { name: 'GunmaGrass', from: -32, to: -8.22, y: -0.38, color: 0x506d4a },
    { name: 'GunmaGrass', from: 8.22, to: 32, y: -0.38, color: 0x506d4a },
    { name: 'GunmaCenterLine', from: -0.055, to: 0.055, y: 0.018, color: 0xcac9ae },
    { name: 'GunmaEdgeLine', from: -4.15, to: -4.09, y: 0.018, color: 0xd8d8d0 },
    { name: 'GunmaEdgeLine', from: 4.09, to: 4.15, y: 0.018, color: 0xd8d8d0 },
  ];
  let grassOuterHeightAt = null;
  const addRoadsideBands = () => {
    for (const band of bands) {
      const vertices = new Float32Array(ext.length * 2 * 3);
      const mistDistances = (band.name === 'GunmaGrass' || band.name === 'GunmaShoulder') ? new Float32Array(ext.length * 2) : null;
      const mistPatches = mistDistances ? new Float32Array(ext.length * 2) : null;
      const indices = [];
      for (let i = 0; i < ext.length; i++) {
        const point = ext[i], normal = extTangents[i];
        for (let side = 0; side < 2; side++) {
          const offset = side ? band.to : band.from;
          const o = (i * 2 + side) * 3;
          if (mistDistances) mistDistances[i * 2 + side] = Math.abs(offset);
          vertices[o] = point.x + normal.x * offset;
          vertices[o + 2] = point.z + normal.z * offset;
          if (mistPatches) {
            const [px, pz] = ringPosition(vertices[o], vertices[o + 2]);
            mistPatches[i * 2 + side] = mistPatchAt(px, pz);
          }
          vertices[o + 1] = band.name === 'GunmaGrass'
            ? Math.abs(offset) > 20
              ? grassOuterHeightAt(vertices[o], vertices[o + 2])
              : point.y - 0.11
            : band.name === 'GunmaShoulder'
              ? point.y - (Math.abs(offset) > 4.33 ? 0.11 : 0)
              : point.y + band.y;
        }
        if (i + 1 < ext.length) {
          const next = i + 1;
          indices.push(i * 2, next * 2, i * 2 + 1, i * 2 + 1, next * 2, next * 2 + 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      if (mistDistances) geometry.setAttribute('mistDistance', new THREE.BufferAttribute(mistDistances, 1));
      if (mistPatches) geometry.setAttribute('mistPatch', new THREE.BufferAttribute(mistPatches, 1));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const material = new THREE.MeshLambertMaterial({
        name: band.name, color: band.color, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry,
        mistDistances ? addSideMist(material, mistColor, mistTime, seam) : material);
      mesh.name = band.name;
      group.add(mesh);
    }
  };
  // A lower envelope of gradual slopes remains continuous where the nearest
  // road changes. Nearest-road elevation alone created abrupt vertical cliffs.
  const terrainSampleAt = (x, z) => {
    let height = Infinity, nearest = Infinity;
    for (let i = 0; i < ext.length; i += 4) {
      const p = ext[i];
      const distance = Math.hypot(x - p.x, z - p.z);
      height = Math.min(height, p.y - 3 + distance * 0.28);
      nearest = Math.min(nearest, distance);
    }
    // Far from every road the mountain sinks below the cloud sea. The slope
    // follows the road's curves, so the outline is rounded, and the square
    // edge of this mesh stays hidden under the clouds.
    const sink = THREE.MathUtils.smoothstep(nearest, 80, 230);
    return { height: THREE.MathUtils.lerp(height, -40, sink), distance: nearest };
  };
  const extBounds = new THREE.Box3().setFromPoints(ext);
  const minX = extBounds.min.x - 280, maxX = extBounds.max.x + 280;
  const minZ = extBounds.min.z - 280, maxZ = extBounds.max.z + 280;
  const columns = Math.ceil((maxX - minX) / 12);
  const lines = Math.ceil((maxZ - minZ) / 12);
  const terrainVertices = new Float32Array((columns + 1) * (lines + 1) * 3);
  const terrainColors = new Float32Array(terrainVertices.length);
  const terrainMistDistances = new Float32Array((columns + 1) * (lines + 1));
  const terrainMistPatches = new Float32Array(terrainMistDistances.length);
  const terrainIndices = [];
  for (let iz = 0; iz <= lines; iz++) {
    for (let ix = 0; ix <= columns; ix++) {
      const x = minX + (maxX - minX) * ix / columns;
      const z = minZ + (maxZ - minZ) * iz / lines;
      const index = (iz * (columns + 1) + ix) * 3;
      terrainVertices[index] = x;
      const sample = terrainSampleAt(x, z);
      terrainMistDistances[iz * (columns + 1) + ix] = sample.distance;
      terrainMistPatches[iz * (columns + 1) + ix] = mistPatchAt(...ringPosition(x, z));
      terrainVertices[index + 1] = sample.height;
      terrainVertices[index + 2] = z;
      const shade = 0.81 + 0.19 * Math.sin(ix * 1.71 + iz * 2.13);
      const forest = THREE.MathUtils.smoothstep(sample.distance, 32, 65);
      const shadow = 0.14 * (0.5 + 0.5 * Math.sin(x * 0.11 + z * 0.08))
        * (0.5 + 0.5 * Math.sin(x * 0.23 - z * 0.17));
      terrainColors[index] = THREE.MathUtils.lerp(0.30 * shade, 0.08 + shadow, forest);
      terrainColors[index + 1] = THREE.MathUtils.lerp(0.47 * shade, 0.19 + shadow, forest);
      terrainColors[index + 2] = THREE.MathUtils.lerp(0.28 * shade, 0.13 + shadow * 0.7, forest);
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
  }), mistColor, mistTime, seam));
  terrain.name = 'GunmaGrass';
  group.add(terrain);
  // Sample the very same triangles used by the large ground mesh at the
  // roadside edge. The grassy bank and the ground then share one seam height.
  grassOuterHeightAt = (x, z) => {
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
  addRoadsideBands();
  // Beyond the ground mesh there is no ground: report it as bottomless so the
  // cloud sea can fill the void around the mountain.
  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ
    ? -Infinity : grassOuterHeightAt(x, z));

  // White twin rails and regularly spaced posts follow both road edges.
  const railMaterial = new THREE.MeshLambertMaterial({
    name: 'GunmaGuardrail', color: 0xf0f0e8, side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    for (const [bottom, top] of [[0.53, 0.79], [0.24, 0.31]]) {
      const vertices = new Float32Array(ext.length * 2 * 3);
      const indices = [];
      for (let i = 0; i < ext.length; i++) {
        const point = ext[i], normal = extTangents[i];
        const offset = side * 5.27;
        const o = i * 6;
        vertices[o] = vertices[o + 3] = point.x + normal.x * offset;
        vertices[o + 1] = point.y + bottom;
        vertices[o + 4] = point.y + top;
        vertices[o + 2] = vertices[o + 5] = point.z + normal.z * offset;
        if (i + 1 < ext.length) {
          const next = i + 1;
          indices.push(i * 2, next * 2, i * 2 + 1,
            i * 2 + 1, next * 2, next * 2 + 1);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const rail = new THREE.Mesh(geometry, railMaterial);
      rail.name = 'GunmaGuardrail';
      group.add(rail);
    }
    const postGeometry = new THREE.BoxGeometry(0.13, 1.08, 0.13);
    const posts = new THREE.InstancedMesh(postGeometry, railMaterial, Math.ceil(ext.length / 3) + 1);
    const matrix = new THREE.Matrix4();
    let post = 0;
    for (let i = 0; i < ext.length; i++) {
      // Keyed to the ring index so the copies repeat the same post spacing.
      if (((extIndices[i] % count) + count) % count % 3 !== 0) continue;
      const p = ext[i], n = extTangents[i];
      matrix.makeTranslation(p.x + side * n.x * 5.27, p.y + 0.54,
        p.z + side * n.z * 5.27);
      posts.setMatrixAt(post++, matrix);
    }
    posts.count = post;
    posts.name = 'GunmaGuardrail';
    posts.computeBoundingSphere();
    group.add(posts);
  }
  return { group, route, tangents, ext, extTangents, seam, climb, mistColor, mistTime,
    groundHeightAt: grassOuterHeightAt, terrainHeightAt, gridBounds: { minX, maxX, minZ, maxZ } };
}
