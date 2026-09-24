import * as THREE from '../lib/three.module.js';

// A closed mountain circuit: nine winding traverses and a grassy return road.
// One lap rises for roughly half its length, then descends back to the start.
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
  const rows = 9;
  const phase = random() * Math.PI * 2;
  const bend = 3 + random() * 4;
  for (let row = 0; row < rows; row++) {
    const forward = row % 2 === 0;
    for (let i = row === 0 ? 0 : 1; i <= 105; i++) {
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
  // Keep the return outside the switchbacks. Catmull-Rom rounds its corners.
  const last = points[points.length - 1];
  const controls = [
    last.clone(),
    new THREE.Vector3(halfLength + 50, 0, -(rows - 1) * rowSpacing),
    new THREE.Vector3(halfLength + 95, 0, -(rows - 2) * rowSpacing),
    new THREE.Vector3(halfLength + 120, 0, -4 * rowSpacing),
    new THREE.Vector3(halfLength + 122, 0, -20),
    new THREE.Vector3(halfLength + 95, 0, 57),
    new THREE.Vector3(halfLength + 40, 0, 90),
    new THREE.Vector3(-halfLength - 30, 0, 90),
    new THREE.Vector3(-halfLength - 70, 0, 62),
    new THREE.Vector3(-halfLength - 65, 0, 24),
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
  // 1.65x the previous 85–105 m climb; the same profile supplies the descent.
  const climb = (85 + random() * 20) * 1.65;
  route.forEach((point, i) => {
    // Uniformly spaced samples make each half lap one continuous climb/descent.
    point.y = 4 + climb * (1 - Math.cos(2 * Math.PI * i / count)) / 2;
  });
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
    { name: 'GunmaRoad', from: -4.32, to: 4.32, y: 0, color: 0x44484b },
    { name: 'GunmaShoulder', from: -8.22, to: -4.32, y: -0.11, color: 0x75b757 },
    { name: 'GunmaShoulder', from: 4.32, to: 8.22, y: -0.11, color: 0x75b757 },
    { name: 'GunmaGrass', from: -32, to: -8.22, y: -0.38, color: 0x68ad50 },
    { name: 'GunmaGrass', from: 8.22, to: 32, y: -0.38, color: 0x68ad50 },
    { name: 'GunmaCenterLine', from: -0.055, to: 0.055, y: 0.018, color: 0xcac9ae },
    { name: 'GunmaEdgeLine', from: -4.15, to: -4.09, y: 0.018, color: 0xd8d8d0 },
    { name: 'GunmaEdgeLine', from: 4.09, to: 4.15, y: 0.018, color: 0xd8d8d0 },
  ];
  let grassOuterHeightAt = null;
  const addRoadsideBands = () => {
    for (const band of bands) {
      const vertices = new Float32Array(count * 2 * 3);
      const indices = [];
      for (let i = 0; i < count; i++) {
        const point = route[i], normal = tangents[i];
        for (let side = 0; side < 2; side++) {
          const offset = side ? band.to : band.from;
          const o = (i * 2 + side) * 3;
          vertices[o] = point.x + normal.x * offset;
          vertices[o + 2] = point.z + normal.z * offset;
          vertices[o + 1] = band.name === 'GunmaGrass'
            ? Math.abs(offset) > 20
              ? grassOuterHeightAt(vertices[o], vertices[o + 2])
              : point.y - 0.11
            : band.name === 'GunmaShoulder'
              ? point.y - (Math.abs(offset) > 4.33 ? 0.11 : 0)
              : point.y + band.y;
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
  };
  // A lower envelope of gradual slopes remains continuous where the nearest
  // road changes. Nearest-road elevation alone created abrupt vertical cliffs.
  const terrainHeightAt = (x, z) => {
    let height = Infinity;
    for (let i = 0; i < count; i += 4) {
      const p = route[i];
      const distance = Math.hypot(x - p.x, z - p.z);
      height = Math.min(height, p.y - 3 + distance * 0.28);
    }
    return height;
  };
  const minX = -halfLength - 180, maxX = halfLength + 300;
  const minZ = -(rows - 1) * rowSpacing - 165, maxZ = 250;
  const columns = Math.ceil((maxX - minX) / 12);
  const lines = Math.ceil((maxZ - minZ) / 12);
  const terrainVertices = new Float32Array((columns + 1) * (lines + 1) * 3);
  const terrainColors = new Float32Array(terrainVertices.length);
  const terrainIndices = [];
  for (let iz = 0; iz <= lines; iz++) {
    for (let ix = 0; ix <= columns; ix++) {
      const x = minX + (maxX - minX) * ix / columns;
      const z = minZ + (maxZ - minZ) * iz / lines;
      const index = (iz * (columns + 1) + ix) * 3;
      terrainVertices[index] = x;
      terrainVertices[index + 1] = terrainHeightAt(x, z);
      terrainVertices[index + 2] = z;
      const shade = 0.85 + 0.14 * Math.sin(ix * 1.71 + iz * 2.13);
      terrainColors[index] = 0.42 * shade;
      terrainColors[index + 1] = 0.68 * shade;
      terrainColors[index + 2] = 0.32 * shade;
      if (ix < columns && iz < lines) {
        const a = iz * (columns + 1) + ix, b = a + columns + 1;
        terrainIndices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const terrainGeometry = new THREE.BufferGeometry();
  terrainGeometry.setAttribute('position', new THREE.BufferAttribute(terrainVertices, 3));
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(terrainColors, 3));
  terrainGeometry.setIndex(terrainIndices);
  terrainGeometry.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshLambertMaterial({
    name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide,
  }));
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

  // White twin rails and regularly spaced posts follow both road edges.
  const railMaterial = new THREE.MeshLambertMaterial({
    name: 'GunmaGuardrail', color: 0xf0f0e8, side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    for (const [bottom, top] of [[0.53, 0.79], [0.24, 0.31]]) {
      const vertices = new Float32Array(count * 2 * 3);
      const indices = [];
      for (let i = 0; i < count; i++) {
        const point = route[i], normal = tangents[i];
        const offset = side * 5.27;
        const o = i * 6;
        vertices[o] = vertices[o + 3] = point.x + normal.x * offset;
        vertices[o + 1] = point.y + bottom;
        vertices[o + 4] = point.y + top;
        vertices[o + 2] = vertices[o + 5] = point.z + normal.z * offset;
        const next = (i + 1) % count;
        indices.push(i * 2, next * 2, i * 2 + 1,
          i * 2 + 1, next * 2, next * 2 + 1);
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
    const posts = new THREE.InstancedMesh(postGeometry, railMaterial, Math.ceil(count / 3));
    const matrix = new THREE.Matrix4();
    let post = 0;
    for (let i = 0; i < count; i += 3) {
      const p = route[i], n = tangents[i];
      matrix.makeTranslation(p.x + side * n.x * 5.27, p.y + 0.54,
        p.z + side * n.z * 5.27);
      posts.setMatrixAt(post++, matrix);
    }
    posts.name = 'GunmaGuardrail';
    posts.computeBoundingSphere();
    group.add(posts);
  }
  return { group, route, tangents, climb };
}
