import * as THREE from '../lib/three.module.js';

// Two flat silhouettes share one tiny texture; no tree meshes or shadow maps.
function treeMask() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  for (let kind = 0; kind < 2; kind++) {
    const x = kind * 128 + 64;
    ctx.fillRect(x - 5, 12, 10, 51);
    if (kind === 0) {
      // Irregular fir outline, with the lower branches wide enough to show gaps.
      for (let layer = 0; layer < 4; layer++) {
        const y = 103 - layer * 18, half = 42 - layer * 8;
        ctx.beginPath();
        ctx.moveTo(x, y + 23);
        ctx.lineTo(x - half * 0.53, y + 3);
        ctx.lineTo(x - half, y - 13);
        ctx.lineTo(x - half * 0.36, y - 9);
        ctx.lineTo(x, y + 23);
        ctx.lineTo(x + half * 0.36, y - 9);
        ctx.lineTo(x + half, y - 13);
        ctx.lineTo(x + half * 0.53, y + 3);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      // A broadleaf crown breaks up the repeated conifer shapes.
      for (const [dx, dy, rx, ry] of [
        [-27, 81, 19, 21], [26, 79, 20, 23], [-13, 99, 25, 20],
        [16, 103, 24, 18], [0, 81, 31, 29],
      ]) {
        ctx.beginPath();
        ctx.ellipse(x + dx, dy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function createGunmaRoadsideForest(scene, route, tangents, groundHeightAt, seed) {
  let state = (seed ^ 0x3f8a9d71) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const group = new THREE.Group();
  group.name = 'gunma-roadside-forest';
  const instances = [];
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
  // Tree trunks sit just outside the guardrail (5.27 m from the centerline).
  for (let i = 0; i < route.length; i += 6) {
    for (const side of [-1, 1]) {
      if (random() < 0.14) continue;
      const point = route[i], normal = tangents[i];
      const offset = side * (7.1 + random() * 0.8);
      const x = point.x + normal.x * offset, z = point.z + normal.z * offset;
      if (!withinTerrain(x, z) || !clearOfRoad(x, z, 6.1)) continue;
      const height = 7.0 + random() * 5.5;
      instances.push({ x, y: groundHeightAt(x, z) + height * 0.47, z,
        width: 5.2 + random() * 2.8, height, kind: random() < 0.68 ? 0 : 1,
        shade: 0.74 + random() * 0.24 });
    }
  }
  const trees = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: { treeMask: { value: treeMask() }, mistColor: { value: new THREE.Color(0xaebdb4) } },
    vertexShader: `
      attribute float treeKind;
      attribute float treeShade;
      varying vec2 maskUv;
      varying float shade;
      varying float rangeToEye;
      void main() {
        vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 facing = normalize(cameraPosition - center.xyz);
        vec3 right = normalize(vec3(facing.z, 0.0, -facing.x));
        vec3 world = center.xyz + right * position.x * length(instanceMatrix[0].xyz)
          + vec3(0.0, position.y * length(instanceMatrix[1].xyz), 0.0);
        rangeToEye = distance(world, cameraPosition);
        maskUv = vec2((uv.x + treeKind) * 0.5, uv.y);
        shade = treeShade;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D treeMask;
      uniform vec3 mistColor;
      varying vec2 maskUv;
      varying float shade;
      varying float rangeToEye;
      void main() {
        if (texture2D(treeMask, maskUv).a < 0.5) discard;
        vec3 forest = vec3(0.16, 0.30, 0.21) * shade;
        float haze = smoothstep(38.0, 220.0, rangeToEye) * 0.76;
        gl_FragColor = vec4(mix(forest, mistColor, haze), 1.0);
      }`,
    side: THREE.DoubleSide,
  }), instances.length);
  const matrix = new THREE.Matrix4();
  const kinds = new Float32Array(instances.length), shades = new Float32Array(instances.length);
  instances.forEach((tree, index) => {
    matrix.makeScale(tree.width, tree.height, 1);
    matrix.setPosition(tree.x, tree.y, tree.z);
    trees.setMatrixAt(index, matrix);
    kinds[index] = tree.kind;
    shades[index] = tree.shade;
  });
  trees.geometry.setAttribute('treeKind', new THREE.InstancedBufferAttribute(kinds, 1));
  trees.geometry.setAttribute('treeShade', new THREE.InstancedBufferAttribute(shades, 1));
  trees.instanceMatrix.needsUpdate = true;
  trees.frustumCulled = false; // Camera-facing quads extend beyond their unrotated bounds.
  trees.name = 'GunmaFlatTrees';
  group.add(trees);

  // The jagged forest edge sits roughly 3 m behind the roadside tree trunks.
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
      const shade = 0.78 + random() * 0.20;
      for (let vertex = 0; vertex < 2; vertex++) {
        ridgeColors.push(0.28 * shade, 0.42 * shade, 0.33 * shade);
      }
      if (previous !== null) {
        ridgeIndices.push(previous, a, previous + 1, previous + 1, a, a + 1);
      }
      previous = a;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(ridgePositions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(ridgeColors, 3));
  geometry.setIndex(ridgeIndices);
  geometry.computeVertexNormals();
  const ridge = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false,
  }));
  ridge.name = 'GunmaForestSilhouette';
  group.add(ridge);
  scene.add(group);
  return group;
}
