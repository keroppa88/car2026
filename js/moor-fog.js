import * as THREE from '../lib/three.module.js';

// Low fog pooled in the hollows of the moor, close to the ground. One instanced
// mesh of small, round, soft puffs on a world-anchored grid around the camera.
// A grid cell only holds fog when it lies lower than the ground around it, so
// the fog gathers at the foot of the slopes; many overlapping puffs make a
// fluffy bank with no straight edge.
const RADIUS = 260;
const CELL = 30;
const PUFFS = 10;

export function createMoorFog(scene, course) {
  const { groundHeightAt } = course;
  const texture = makePuffTexture();
  const time = { value: 0 };
  const tint = { value: new THREE.Color(0xc9cdc6) };
  const cells = Math.ceil(RADIUS / CELL);
  const capacity = Math.ceil(Math.PI * cells * cells) * PUFFS;
  const material = new THREE.ShaderMaterial({
    uniforms: { fogMap: { value: texture }, time, tint },
    vertexShader: `
      uniform float time;
      varying vec2 fogUv;
      varying float fogFade;
      void main() {
        vec4 centre = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // Slow drift and a gentle swell, different for every puff.
        centre.x += sin(time * 0.06 + centre.z * 0.013) * 6.0;
        centre.z += cos(time * 0.045 + centre.x * 0.011) * 4.0;
        centre.y += sin(time * 0.2 + centre.x * 0.05) * 0.4;
        vec4 view = viewMatrix * modelMatrix * centre;
        float range = length(view.xyz);
        // Clear right around the camera and far away, so no puff pops in.
        // The instance's z scale carries how deep the hollow is (0..1).
        fogFade = length(instanceMatrix[2].xyz)
          * smoothstep(8.0, 30.0, range) * (1.0 - smoothstep(${(RADIUS * 0.7).toFixed(1)}, ${RADIUS.toFixed(1)}, range));
        view.xy += position.xy * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
        fogUv = uv;
        gl_Position = projectionMatrix * view;
      }`,
    fragmentShader: `
      uniform sampler2D fogMap;
      uniform vec3 tint;
      varying vec2 fogUv;
      varying float fogFade;
      void main() {
        float alpha = texture2D(fogMap, fogUv).a * 0.3 * fogFade;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(tint, alpha);
      }`,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, capacity);
  mesh.frustumCulled = false;
  mesh.name = 'MoorGroundFog';
  mesh.renderOrder = 2;
  scene.add(mesh);

  const hash = (a, b, salt) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  // How far a spot sits below the ground around it, 0 (not a hollow) to 1.
  // Cached per cell: the terrain never changes.
  const hollowCache = new Map();
  const hollowAt = (cellX, cellZ) => {
    const key = cellX * 100003 + cellZ;
    let depth = hollowCache.get(key);
    if (depth !== undefined) return depth;
    const x = cellX * CELL, z = cellZ * CELL;
    let around = 0;
    for (let k = 0; k < 8; k++) {
      const angle = k / 8 * Math.PI * 2;
      around += groundHeightAt(x + Math.cos(angle) * 80, z + Math.sin(angle) * 80);
    }
    depth = THREE.MathUtils.smoothstep(around / 8 - groundHeightAt(x, z), 1.0, 3.0);
    hollowCache.set(key, depth);
    return depth;
  };
  const matrix = new THREE.Matrix4();
  const lastCentre = new THREE.Vector2(Infinity, Infinity);
  const relay = (cx, cz) => {
    const gx = Math.round(cx / CELL), gz = Math.round(cz / CELL);
    let n = 0;
    for (let iz = -cells; iz <= cells; iz++) {
      for (let ix = -cells; ix <= cells; ix++) {
        const cellX = gx + ix, cellZ = gz + iz;
        if (Math.hypot(cellX * CELL - cx, cellZ * CELL - cz) > RADIUS + CELL) continue;
        const depth = hollowAt(cellX, cellZ);
        // Not every hollow holds fog, so it lies here and there.
        if (depth < 0.05 || hash(cellX, cellZ, 3) > 0.7) continue;
        const puffs = Math.round(PUFFS * (0.5 + depth * 0.5));
        for (let k = 0; k < puffs && n < capacity; k++) {
          // Puffs cluster round the cell centre, overlapping one another.
          const angle = hash(cellX, cellZ, 7 + k) * Math.PI * 2;
          const r = Math.sqrt(hash(cellX, cellZ, 17 + k)) * CELL * 0.75;
          const x = cellX * CELL + Math.cos(angle) * r;
          const z = cellZ * CELL + Math.sin(angle) * r;
          const width = 16 + hash(cellX, cellZ, 29 + k) * 18;
          const height = width * (0.28 + hash(cellX, cellZ, 41 + k) * 0.12);
          // Centre a little above the ground; the soft lower edge sinks in.
          matrix.makeScale(width, height, depth);
          matrix.setPosition(x, groundHeightAt(x, z) + height * 0.3, z);
          mesh.setMatrixAt(n++, matrix);
        }
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  };
  return {
    mesh,
    update(dt, camera, color, hidden) {
      time.value += dt;
      if (color) tint.value.copy(color).lerp(new THREE.Color(1, 1, 1), 0.35);
      mesh.visible = !hidden;
      const cx = camera.position.x, cz = camera.position.z;
      if (Math.hypot(cx - lastCentre.x, cz - lastCentre.y) > 8) {
        lastCentre.set(cx, cz);
        relay(cx, cz);
      }
    },
  };
}

// One round, soft puff: dense in the middle, fading smoothly to nothing well
// inside the square, so no edge of the sheet ever shows.
function makePuffTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2 - 1);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    // Gaussian-like falloff, exactly zero at the rim.
    const a = Math.exp(-t * t * 3.2) * (1 - t);
    g.addColorStop(t, `rgba(255,255,255,${a.toFixed(3)})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
