import * as THREE from '../lib/three.module.js';

// Low fog lying in patches over the moor, close to the ground. One instanced
// mesh of soft camera-facing sheets on a world-anchored grid around the
// camera: most grid cells stay clear, a few hold a patch of three or four
// sheets that drift slowly with the wind.
const RADIUS = 260;
const CELL = 36;

export function createMoorFog(scene, course) {
  const { groundHeightAt } = course;
  const texture = makeFogTexture();
  const time = { value: 0 };
  const tint = { value: new THREE.Color(0xc9cdc6) };
  const cells = Math.ceil(RADIUS / CELL);
  const capacity = Math.ceil(Math.PI * cells * cells) * 4;
  const material = new THREE.ShaderMaterial({
    uniforms: { fogMap: { value: texture }, time, tint },
    vertexShader: `
      uniform float time;
      varying vec2 fogUv;
      varying float fogFade;
      void main() {
        vec4 centre = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // Slow drift and a gentle swell, different for every sheet.
        centre.x += sin(time * 0.06 + centre.z * 0.013) * 9.0;
        centre.z += cos(time * 0.045 + centre.x * 0.011) * 5.0;
        vec4 view = viewMatrix * modelMatrix * centre;
        float range = length(view.xyz);
        // Clear right around the camera and far away, so no sheet edge shows.
        fogFade = smoothstep(12.0, 40.0, range) * (1.0 - smoothstep(${(RADIUS * 0.75).toFixed(1)}, ${RADIUS.toFixed(1)}, range));
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
        float alpha = texture2D(fogMap, fogUv).a * 0.42 * fogFade;
        if (alpha < 0.01) discard;
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
  const matrix = new THREE.Matrix4();
  const lastCentre = new THREE.Vector2(Infinity, Infinity);
  const relay = (cx, cz) => {
    const gx = Math.round(cx / CELL), gz = Math.round(cz / CELL);
    let n = 0;
    for (let iz = -cells; iz <= cells; iz++) {
      for (let ix = -cells; ix <= cells; ix++) {
        const cellX = gx + ix, cellZ = gz + iz;
        // About one cell in four holds a fog patch.
        if (hash(cellX, cellZ, 3) > 0.26) continue;
        const sheets = 3 + Math.floor(hash(cellX, cellZ, 5) * 2);
        for (let k = 0; k < sheets && n < capacity; k++) {
          const x = (cellX + hash(cellX, cellZ, 7 + k) - 0.5) * CELL;
          const z = (cellZ + hash(cellX, cellZ, 17 + k) - 0.5) * CELL;
          if (Math.hypot(x - cx, z - cz) > RADIUS) continue;
          const width = 26 + hash(cellX, cellZ, 29 + k) * 30;
          const height = 3.5 + hash(cellX, cellZ, 41 + k) * 3;
          // Centre a little above the ground; the faint lower edge sinks in.
          matrix.makeScale(width, height, 1);
          matrix.setPosition(x, groundHeightAt(x, z) + height * 0.32, z);
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

// Several soft blobs clustered into one wide, low bank of fog.
function makeFogTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  let seed = 11;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 16; i++) {
    const x = 28 + random() * 72, y = 30 + random() * 12, r = 14 + random() * 14;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 64);
  }
  return new THREE.CanvasTexture(canvas);
}
