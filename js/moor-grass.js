import * as THREE from '../lib/three.module.js';

// Upright moor grass (tussocks) around the camera only. One instanced mesh of
// crossed blade cards on a world-anchored grid, re-laid only when the camera
// has moved a few metres, so the tufts stay put as the car drives through.
const RADIUS = 44;
const SPACING = 1.7;

export function createMoorGrass(scene, course) {
  const { route, seam, groundHeightAt } = course;
  const texture = makeBladeTexture();
  // Three crossed cards, origin at the base.
  const card = new THREE.PlaneGeometry(1.3, 1, 1, 1).translate(0, 0.5, 0);
  const cards = [0, 1, 2].map((k) => card.clone().rotateY(k * Math.PI / 3));
  const geometry = mergeCards(cards);
  const time = { value: 0 };
  const material = new THREE.MeshLambertMaterial({
    map: texture, alphaTest: 0.45, side: THREE.FrontSide, vertexColors: false,
  });
  // Tips sway gently in the wind; the base stays planted.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.grassTime = time;
    shader.vertexShader = 'uniform float grassTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec4 grassRoot = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float sway = sin(grassTime * 1.7 + grassRoot.x * 0.35 + grassRoot.z * 0.21) * 0.12
        + sin(grassTime * 3.1 + grassRoot.z * 0.5) * 0.04;
      transformed.x += sway * position.y * position.y;`);
  };
  material.customProgramCacheKey = () => 'moor-grass-v1';
  const cells = Math.ceil(RADIUS / SPACING);
  const capacity = Math.ceil(Math.PI * cells * cells) + 16;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  mesh.name = 'MoorGrass';
  // Straw, pale gold and olive, so the grass does not look uniform.
  const tints = [0xd8b886, 0xe2c292, 0xc9a877, 0xbcb27f, 0xd4ae7e].map((c) => new THREE.Color(c));
  scene.add(mesh);

  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const lastCentre = new THREE.Vector2(Infinity, Infinity);
  const hash = (a, b, salt) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  const relay = (cx, cz) => {
    // Road points near the camera, including the copies across the seam.
    const nearRoad = [];
    for (const k of [-1, 0, 1]) {
      const ox = seam.offset.x * k, oz = seam.offset.z * k;
      for (let i = 0; i < route.length; i += 2) {
        const x = route[i].x + ox, z = route[i].z + oz;
        if (Math.abs(x - cx) < RADIUS + 12 && Math.abs(z - cz) < RADIUS + 12) nearRoad.push(x, z);
      }
    }
    const gx = Math.round(cx / SPACING), gz = Math.round(cz / SPACING);
    let n = 0;
    for (let iz = -cells; iz <= cells; iz++) {
      for (let ix = -cells; ix <= cells; ix++) {
        const cellX = gx + ix, cellZ = gz + iz;
        const x = (cellX + hash(cellX, cellZ, 11) - 0.5) * SPACING;
        const z = (cellZ + hash(cellX, cellZ, 23) - 0.5) * SPACING;
        const d = Math.hypot(x - cx, z - cz);
        if (d > RADIUS || n >= capacity) continue;
        // Keep the road and its verge clear.
        let clear = true;
        for (let r = 0; r < nearRoad.length; r += 2) {
          if ((x - nearRoad[r]) ** 2 + (z - nearRoad[r + 1]) ** 2 < 7.6 * 7.6) { clear = false; break; }
        }
        if (!clear) continue;
        // Shrink towards the edge of the patch so it has no visible rim.
        const fade = 1 - THREE.MathUtils.smoothstep(d, RADIUS * 0.7, RADIUS);
        const height = (0.55 + hash(cellX, cellZ, 37) * 0.6) * fade;
        if (height < 0.05) continue;
        position.set(x, groundHeightAt(x, z) - 0.08, z);
        quaternion.setFromAxisAngle(up, hash(cellX, cellZ, 51) * Math.PI);
        scale.set(0.8 + hash(cellX, cellZ, 67) * 0.6, height, 0.8 + hash(cellX, cellZ, 79) * 0.6);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(n, matrix);
        mesh.setColorAt(n, tints[Math.floor(hash(cellX, cellZ, 93) * tints.length)]);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  return {
    mesh,
    update(dt, camera, hidden) {
      time.value += dt;
      mesh.visible = !hidden;
      const cx = camera.position.x, cz = camera.position.z;
      if (Math.hypot(cx - lastCentre.x, cz - lastCentre.y) > 4) {
        lastCentre.set(cx, cz);
        relay(cx, cz);
      }
    },
  };
}

// Tapered blades on a transparent card, in light and dark straw.
function makeBladeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  let seed = 7;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 70; i++) {
    const x = 3 + random() * 58, lean = (random() - 0.5) * 22, top = 4 + random() * 44;
    const width = 0.8 + random() * 1.6;
    const shade = 175 + Math.floor(random() * 75);
    ctx.fillStyle = `rgb(${shade},${Math.floor(shade * 0.9)},${Math.floor(shade * 0.62)})`;
    ctx.beginPath();
    ctx.moveTo(x - width, 128);
    ctx.quadraticCurveTo(x + lean * 0.3, 70, x + lean, top);
    ctx.quadraticCurveTo(x + lean * 0.3 + width * 0.4, 70, x + width, 128);
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function mergeCards(cards) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (const g of cards) {
    const base = positions.length / 3;
    positions.push(...g.attributes.position.array);
    // Light the blades like the ground beneath them, whichever way they face.
    for (let i = 0; i < g.attributes.position.count; i++) normals.push(0, 1, 0);
    uvs.push(...g.attributes.uv.array);
    // Both faces wound forwards, so neither side is lit as a back face.
    const index = g.index.array;
    for (let t = 0; t < index.length; t += 3) {
      indices.push(base + index[t], base + index[t + 1], base + index[t + 2]);
      indices.push(base + index[t], base + index[t + 2], base + index[t + 1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
