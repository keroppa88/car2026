import * as THREE from '../lib/three.module.js';

// 地表を区分して作った実メッシュ。色を付けるための重ね面・深度マスクは使わない。
// 表示、支持面、路面種別の判定がすべて同じ三角形を参照する。
export async function loadNativeSurfaces(url, group) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`地表データ: ${response.status}`);
  const data = await response.json();
  if (data.version !== 1) throw new Error('地表データの形式が異なります');
  const binaryResponse = await fetch(new URL(data.binary, response.url || new URL(url, location.href)));
  if (!binaryResponse.ok) throw new Error(`地表メッシュ: ${binaryResponse.status}`);
  const encoded = await binaryResponse.arrayBuffer();
  const buffer = data.compression === 'gzip'
    ? await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : encoded;
  if (buffer.byteLength !== data.byteLength) throw new Error('地表メッシュのサイズが一致しません');
  const material = new THREE.MeshLambertMaterial({ name: 'shonan-native-surface', vertexColors: true, side: THREE.DoubleSide });
  const waterMaterial = makeWaterMaterial();
  const meshes = [], support = [], grid = new Map(), cell = 25;
  for (const chunk of data.chunks) {
    const positions = new Float32Array(buffer, chunk.positions, chunk.count * 3);
    const colors = new Uint8Array(buffer, chunk.colors, chunk.count * 3);
    const kinds = new Uint8Array(buffer, chunk.kinds, chunk.count / 3);
    // 表示用は陸→水の順に並べ替え、水の三角形だけ海面の材質で描く(判定は元の配列を使う)。
    const order = [], wet = [];
    for (let t = 0; t < kinds.length; t++) (kinds[t] === 3 ? wet : order).push(t);
    const land = order.length; order.push(...wet);
    const pos = new Float32Array(positions.length), col = new Uint8Array(colors.length);
    order.forEach((t, i) => { pos.set(positions.subarray(t * 9, t * 9 + 9), i * 9); col.set(colors.subarray(t * 9, t * 9 + 9), i * 9); });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    if (land) geometry.addGroup(0, land * 3, 0);
    if (wet.length) geometry.addGroup(land * 3, wet.length * 3, 1);
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, [material, waterMaterial]);
    mesh.position.set(chunk.x, 0, chunk.z); mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
    mesh.name = chunk.water ? 'shonan-water' : 'shonan-surface';
    mesh.userData.noLift = true; mesh.userData.nativeSurface = true;
    group.add(mesh); meshes.push(mesh); if (!chunk.water) support.push(mesh);
    // 陸の近くの水だけを判定に登録。遠い沖合には走れる範囲がない。
    for (let t = 0; t < kinds.length; t++) {
      const k = t * 9;
      const ax = positions[k] + chunk.x, az = positions[k + 2] + chunk.z;
      const bx = positions[k + 3] + chunk.x, bz = positions[k + 5] + chunk.z;
      const cx = positions[k + 6] + chunk.x, cz = positions[k + 8] + chunk.z;
      const [x0, z0, x1, z1] = data.bounds;
      if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > x1 || Math.max(az, bz, cz) < z0 || Math.min(az, bz, cz) > z1) continue;
      const triangle = { positions, k, x: chunk.x, z: chunk.z, kind: kinds[t] };
      for (let i = Math.floor(Math.min(ax, bx, cx) / cell); i <= Math.floor(Math.max(ax, bx, cx) / cell); i++)
        for (let j = Math.floor(Math.min(az, bz, cz) / cell); j <= Math.floor(Math.max(az, bz, cz) / cell); j++) {
          const key = `${i},${j}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(triangle);
        }
    }
  }
  let lastX, lastZ, last;
  const at = (x, z) => {
    if (x === lastX && z === lastZ) return last;
    lastX = x; lastZ = z; last = null;
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) || []) {
      const p = t.positions, k = t.k, px = x - t.x, pz = z - t.z;
      const ax = p[k], az = p[k + 2], bx = p[k + 3], bz = p[k + 5], cx = p[k + 6], cz = p[k + 8];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-12) continue;
      const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
      const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * p[k + 1] + v * p[k + 4] + w * p[k + 7];
      if (!last || y > last.y) last = { y, kind: t.kind };
    }
    return last;
  };
  return { meshes, support, at, bounds: data.bounds, stats: data.stats };
}

// 海面: 波の形は作らず、平らな面に大まかな光の反射を描く(遠くから見た油絵のような海)。
// ・大きなまだら(色の濃淡)  ・横に伸びた筆の筋  ・空の映り込み(浅い角度ほど明るい)
// ・南の空の太陽のきらめきを筆の筋に沿って途切れ途切れに
const WATER_TIME = { value: 0 };
const SEA_DAY = { value: 1 };
export function setSeaNight(on) { SEA_DAY.value = on ? 0.12 : 1; }
export const SEA_DROP = 2;   // 砂浜・海・川は道路より 2m 下(tools/shonan/build_surfaces.py の DROP と同じ)
function makeWaterMaterial() {
  // Lambert には cameraPosition が渡されないので、光沢なしの Phong を使う
  const m = new THREE.MeshPhongMaterial({ name: 'shonan-sea', vertexColors: true, side: THREE.DoubleSide, specular: 0x000000, shininess: 1 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterTime = WATER_TIME;
    shader.uniforms.uSeaDay = SEA_DAY;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeaPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSeaPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vSeaPos;
uniform float uWaterTime;
uniform float uSeaDay;   // 昼 1、夜は暗く(遠くの海・水平線が光らないように)
float seaHash(vec2 p) { p = mod(p, 1024.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float seaNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), f.x), mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + 1.0), f.x), f.y);
}
float seaFbm(vec2 p) { return seaNoise(p) * 0.55 + seaNoise(p * 2.1 + 7.3) * 0.3 + seaNoise(p * 4.3 + 3.1) * 0.15; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// 道路から眺める海。筆の跡は「方角」と「距離の対数」で決める(地平線へ向かって自然に細かくなり、遠くがちらつかない)。
vec3 seaD = vSeaPos - cameraPosition;
float seaDist = length(seaD.xz);
float seaAz = atan(seaD.x, seaD.z);
vec2 uv = vec2(seaAz * 9.0, log(max(seaDist, 1.0)) * 7.0);
float seaT = uWaterTime;
float blot = seaFbm(uv * vec2(0.35, 0.5) + vec2(seaT * 0.01, 0.0));
float stroke = seaNoise(vec2(uv.x * 0.5, uv.y * 0.9) + vec2(blot * 2.0, seaT * 0.02));
diffuseColor.rgb *= mix(0.84, 1.1, blot * 0.6 + stroke * 0.4);
diffuseColor.rgb *= vec3(0.86, 0.98, 1.1);
vec2 sp = vSeaPos.xz;
// 波は地図の下(南の沖)から上(北の岸)へまっすぐ進む: 波の筋は東西(幹線道路と平行)
float swellBend = seaNoise(vec2(sp.x * 0.002, 0.0)) * 1.2;
float swell = sin(sp.y * 0.045 + seaT * 0.7 + swellBend);
float swell2 = sin(sp.y * 0.08 + seaT * 1.1 + swellBend * 0.5);
diffuseColor.rgb *= 1.0 + (swell * 0.08 + swell2 * 0.04) * (1.0 - smoothstep(250.0, 1100.0, seaDist));`)
      .replace('#include <fog_fragment>', `{
  // 手前は緑がかった浅い色、沖へ行くほど深い青(空の霞と見分けがつくように)。地平線ぎわだけ空が映って少し明るむ
  float far = smoothstep(80.0, 2500.0, seaDist);
  vec3 deep = vec3(0.17, 0.36, 0.5) * mix(0.9, 1.12, stroke) * uSeaDay;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, deep, far * 0.85);
  float rim = smoothstep(3500.0, 9000.0, seaDist);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.7, 0.8) * uSeaDay, rim * 0.6);
  // 南の低い太陽の光の道: 太陽の方角に幅のある筋。横長の筆の跡で途切れさせる
  float sunAz = atan(0.1, 1.0);
  float dAz = abs(mod(seaAz - sunAz + 3.14159, 6.28318) - 3.14159);
  float width = mix(0.45, 0.12, far);
  float path = exp(-dAz * dAz / (width * width));
  // 近くは光らせない(遠くから眺めた海)。光の強さはゆっくり脈打つ
  path *= smoothstep(250.0, 900.0, seaDist) * (0.7 + 0.3 * sin(seaT * 0.35 + uv.y * 0.4));
  float brush = smoothstep(0.4, 0.75, seaNoise(vec2(uv.x * 0.9, uv.y * 2.6) + vec2(seaT * 0.05, blot * 3.0)));
  gl_FragColor.rgb += uSeaDay * (1.0 - smoothstep(150.0, 500.0, cameraPosition.y)) * vec3(1.0, 0.94, 0.8) * path * (0.1 + brush * 0.8) * (0.3 + 0.7 * far);
}
#include <fog_fragment>`);
  };
  m.customProgramCacheKey = () => 'shonan-sea-9';
  return m;
}
export function updateWaterTime(t) { WATER_TIME.value = t; }

// 砂浜の波打ち際の白い泡(tools/shonan/make_foam.py で作った帯)。
// 寄せる波の白い線が岸へ進み、岸では泡が寄せたり引いたりする。
export async function loadFoam(url, group) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const W = data.width, R = data.rows;
  const pos = [], dd = [], uu = [], ee = [], idx = [];
  for (const s of data.strips) {
    const base = pos.length / 3;
    for (let i = 0; i < s.pts.length / 2; i++) { pos.push(s.pts[i * 2], -SEA_DROP - 0.01, s.pts[i * 2 + 1]); dd.push(s.d[i]); uu.push(s.u[i]); ee.push(s.e[i]); }
    for (let c = 0; c + 1 < s.n; c++) for (let r = 0; r + 1 < R; r++) {
      const a = base + c * R + r, b = a + R;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aD', new THREE.Float32BufferAttribute(dd, 1));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(uu, 1));
  g.setAttribute('aE', new THREE.Float32BufferAttribute(ee, 1));
  g.setIndex(idx); g.computeBoundingSphere();
  const m = new THREE.ShaderMaterial({
    uniforms: { uWaterTime: WATER_TIME, uW: { value: W }, uBright: { value: 1 } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `attribute float aD; attribute float aU; attribute float aE; varying float vD; varying float vU; varying float vE; varying vec3 vP;
      void main() { vD = aD; vU = aU; vE = aE; vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`,
    fragmentShader: `precision highp float;
      uniform float uWaterTime; uniform float uW; uniform float uBright; varying float vD; varying float vU; varying float vE; varying vec3 vP;
      float h(vec2 p) { p = mod(p, 1024.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + 1.0), f.x), f.y); }
      void main() {
        float t = uWaterTime, dn = vD / uW;
        float lag = n2(vec2(vP.x * 0.004, 0.0)) * 0.3;              // 東西で少しだけずらす
        // 寄せる波の線(岸へ進みながら崩れる)
        float ph = fract(vP.z / 18.0 + t / 7.0 + lag);   // 寄せる波の線は東西方向、南から北へ進む
        float crest = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.08, 0.45, ph));
        crest *= smoothstep(0.15, 0.85, n2(vec2(vU * 0.035, t * 0.15 + lag * 3.0)) * 0.7 + n2(vec2(vU * 0.12, dn * 2.0)) * 0.3);
        // 岸の泡: 寄せては引く
        float reach = 0.22 + 0.1 * sin(t * 0.9 + lag * 6.28);
        float edge = 1.0 - smoothstep(reach * 0.5, reach, dn);
        edge *= 0.7 + 0.3 * n2(vec2(vU * 0.25, dn * 12.0 + t * 0.6));
        float a = max(crest * 0.75 * (1.0 - dn * 0.5), edge * 0.95);
        a *= 1.0 - smoothstep(0.75, 1.0, dn);
        a *= smoothstep(0.0, 12.0, vE);
        a *= 1.0 - smoothstep(150.0, 700.0, length(cameraPosition - vP)) * 0.6;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vec3(0.95, 0.97, 0.97) * uBright, a);   // 夜は暗く(光らない)
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'shonan-foam'; mesh.frustumCulled = false; mesh.renderOrder = 1;
  mesh.userData.setNight = (on) => { m.uniforms.uBright.value = on ? 0.16 : 1; };
  mesh.userData.noLift = true;
  group.add(mesh);
  return mesh;
}

// 道路・陸と、2m 下の砂浜・水面の境目のグレーの垂直な護岸(build_surfaces.py が作る map/shonan-walls.json)。
export async function loadWalls(url, group) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json(), D = data.drop ?? SEA_DROP, S = data.stride ?? 8;
  // 縦の面(上端 y から高さ h だけ下へ)を作る。w: 護岸、c: 歩道の縁
  const faces = (w, color, name) => {
    if (!w || !w.length) return;
    const n = w.length / S, pos = new Float32Array(n * 18), nor = new Float32Array(n * 18);
    for (let i = 0; i < n; i++) {
      const k = i * S, ax = w[k], az = w[k + 1], ay = w[k + 2], bx = w[k + 3], bz = w[k + 4], by = w[k + 5], nx = w[k + 6], nz = w[k + 7], h = S > 8 ? w[k + 8] : D;
      pos.set([ax, ay - h - 0.05, az, bx, by - h - 0.05, bz, bx, by, bz, ax, ay - h - 0.05, az, bx, by, bz, ax, ay, az], i * 18);
      for (let q = 0; q < 6; q++) nor.set([nx, 0, nz], i * 18 + q * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
    mesh.name = name; mesh.userData.noLift = true; mesh.frustumCulled = false;
    group.add(mesh);
  };
  faces(data.w, 0x9a9b98, 'shonan-seawalls');
  faces(data.c, 0x76787a, 'shonan-curbs');   // 縁石と同じ色
  return data;
}

// 国道134号の街灯・電柱・電線(tools/shonan/make_lamps.py が作る map/shonan-lamps.json)。寸法は街並みマップと同じ。
// 向き a: 道路の方を向く角度(sin a, cos a)。
export async function loadLamps(url, group, native) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const parts = new Map();   // 色ごとに箱をまとめる
  const box = (color, x, z, a, lx, y, lz, sx, sy, sz) => {   // (lx, lz): 向きに沿った位置、y: 下端
    if (!parts.has(color)) parts.set(color, { p: [], n: [] });
    const o = parts.get(color), fx = Math.sin(a), fz = Math.cos(a), rx = Math.cos(a), rz = -Math.sin(a);
    const cx = x + fx * lz + rx * lx, cz = z + fz * lz + rz * lx, hx = sx / 2, hz = sz / 2;
    const P = (u, v, w) => [cx + rx * u + fx * w, y + v, cz + rz * u + fz * w];
    const faces = [   // [法線, 4つの角]
      [[rx, 0, rz], [[hx, 0, -hz], [hx, 0, hz], [hx, sy, hz], [hx, sy, -hz]]],
      [[-rx, 0, -rz], [[-hx, 0, hz], [-hx, 0, -hz], [-hx, sy, -hz], [-hx, sy, hz]]],
      [[fx, 0, fz], [[hx, 0, hz], [-hx, 0, hz], [-hx, sy, hz], [hx, sy, hz]]],
      [[-fx, 0, -fz], [[-hx, 0, -hz], [hx, 0, -hz], [hx, sy, -hz], [-hx, sy, -hz]]],
      [[0, 1, 0], [[-hx, sy, -hz], [hx, sy, -hz], [hx, sy, hz], [-hx, sy, hz]]],
      [[0, -1, 0], [[-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz], [-hx, 0, -hz]]],
    ];
    for (const [nrm, q] of faces) {
      const c = q.map(([u, v, w]) => P(u, v, w));
      for (const i of [0, 1, 2, 0, 2, 3]) { o.p.push(...c[i]); o.n.push(...nrm); }
    }
  };
  const ground = (x, z) => native?.at(x, z)?.y ?? 0;
  for (const [x, z, a] of data.lamps) {   // 街灯: 柱 7m、道路側へ腕 1.6m、灯具
    const y = ground(x, z);
    box(0x9aa0a6, x, z, a, 0, y, 0, 0.18, 7, 0.18);
    box(0x9aa0a6, x, z, a, 0, y + 7.0, 0.8, 0.08, 0.08, 1.6);
    box(0xf5f0e0, x, z, a, 0, y + 6.88, 1.55, 0.3, 0.15, 0.8);
  }
  for (const [x, z, a, arm] of data.bridgeLamps || []) {   // 橋の真ん中: 柱 8m、左右に腕と灯具
    const y = ground(x, z);
    box(0x9aa0a6, x, z, a, 0, y, 0, 0.2, 8, 0.2);
    for (const sd of [-1, 1]) {
      box(0x9aa0a6, x, z, a, 0, y + 7.95, sd * arm / 2, 0.08, 0.08, arm);
      box(0xf5f0e0, x, z, a, 0, y + 7.83, sd * (arm - 0.3), 0.3, 0.15, 0.8);
    }
  }
  const tops = [];
  for (const [x, z, a] of data.poles) {   // 電柱: 9.5m、上に道路と直角の腕木 2.2m
    const y = ground(x, z);
    box(0xb9b6ae, x, z, a, 0, y, 0, 0.34, 9.5, 0.34);
    box(0x8a8a86, x, z, a, 0, y + 8.74, 0, 0.12, 0.12, 2.2);
    tops.push([x, z, a, y]);
  }
  // 夜の明かり(街並みマップと同じ): 灯具が光り、足元の道路に 16m 四方の光だまり
  const headMat = new THREE.MeshLambertMaterial({ color: 0xf5f0e0, emissive: 0xffd49a, emissiveIntensity: 0 });   // 少しオレンジ
  for (const [color, o] of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, color === 0xf5f0e0 ? headMat : new THREE.MeshLambertMaterial({ color }));
    m.name = 'shonan-lamps'; m.userData.noLift = true; m.frustumCulled = false; group.add(m);
  }
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const cg = c.getContext('2d'), gr = cg.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,218,160,1)'); gr.addColorStop(0.45, 'rgba(255,204,138,.55)'); gr.addColorStop(1, 'rgba(255,196,124,0)');   // 少しオレンジ
  cg.fillStyle = gr; cg.fillRect(0, 0, 128, 128);
  const poolTex = new THREE.CanvasTexture(c); poolTex.colorSpace = THREE.SRGBColorSpace;
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const PP = [], PU = [], PH = 9.8;   // 光だまり: 街並みマップの 16m 四方を、面積 1.5 倍(19.6m 四方)に
  const pool = (cx, cz) => {
    // 歩道(+20cm)・縁石より上に浮かせる(同じ高さだと面どうしが重なってちらつく)
    const y = Math.max(ground(cx, cz), ground(cx - 6, cz), ground(cx + 6, cz), ground(cx, cz - 6), ground(cx, cz + 6)) + 0.45;
    const q = [[cx - PH, cz - PH, 0, 0], [cx + PH, cz - PH, 1, 0], [cx + PH, cz + PH, 1, 1], [cx - PH, cz + PH, 0, 1]];
    for (const i of [0, 2, 1, 0, 3, 2]) { PP.push(q[i][0], y, q[i][1]); PU.push(q[i][2], q[i][3]); }
  };
  for (const [x, z, a] of data.lamps) pool(x + Math.sin(a) * 4.5, z + Math.cos(a) * 4.5);
  for (const [x, z, a, arm] of data.bridgeLamps || []) for (const sd of [-1, 1]) pool(x + Math.sin(a) * sd * (arm + 1.5), z + Math.cos(a) * sd * (arm + 1.5));
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(PP, 3));
  pg.setAttribute('uv', new THREE.Float32BufferAttribute(PU, 2));
  const pools = new THREE.Mesh(pg, poolMat);
  pools.name = 'shonan-lamp-pools'; pools.userData.noLift = true; pools.frustumCulled = false; pools.renderOrder = 2; pools.visible = false;
  group.add(pools);
  // 電線: 腕木の両端(道路と直角に ±0.9m)を次の電柱へ、たるみ 0.7m
  const W = [], A = new THREE.Vector3(), B = new THREE.Vector3(), M = new THREE.Vector3();
  const curve = new THREE.QuadraticBezierCurve3(A, M, B);
  for (const [i, j] of data.wires) {
    const [ax, az, aa, ay] = tops[i], [bx, bz, ba, by] = tops[j];
    for (const s of [-0.9, 0.9]) {
      A.set(ax + Math.sin(aa) * s, ay + 8.95, az + Math.cos(aa) * s);
      B.set(bx + Math.sin(ba) * s, by + 8.95, bz + Math.cos(ba) * s);
      M.copy(A).lerp(B, 0.5); M.y -= 0.7;
      const pts = curve.getPoints(6);
      for (let k = 0; k < pts.length - 1; k++) W.push(pts[k], pts[k + 1]);
    }
  }
  if (W.length) {
    const wires = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(W), new THREE.LineBasicMaterial({ color: 0x2a2a2a }));
    wires.name = 'shonan-wires'; wires.userData.noLift = true; wires.frustumCulled = false; group.add(wires);
  }
  // 明るさのピークは街並みマップ(0.7)の2割減
  return { setNight(on) { headMat.emissiveIntensity = on ? 2 : 0; poolMat.opacity = on ? 0.56 : 0; pools.visible = on; } };
}

// ---- 江ノ電(単線): 道路より 2m 高い砂利の路盤、レール、架線柱と架線、2両の電車 ----
// data.pts: [[x, z, h], ...] 2m ごと(h: 道路からの高さ。踏切は 0)。tools/shonan/make_enoden.py
export function buildEnoden(data, group, native) {
  const P = data?.pts; if (!P || P.length < 2) return null;
  const n = P.length, ground = (x, z) => native?.at(x, z)?.y ?? 0;
  const S = [0]; for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const base = P.map(([x, z]) => Math.max(0, ground(x, z)));
  const top = P.map((q, i) => base[i] + q[2]);
  const dir = (i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const HALF = 2.0;
  const bedTop = [], side = [], rails = [];
  const push = (arr, ...v) => { for (const x of v) arr.push(x); };
  for (let i = 0; i + 1 < n; i++) {
    const [ax, az] = P[i], [bx, bz] = P[i + 1], [tx, tz] = dir(i), [ux, uz] = dir(i + 1);
    const an = [tz, -tx], bn = [uz, -ux], ya = top[i], yb = top[i + 1];
    const A = (o) => [ax + an[0] * o, az + an[1] * o], B = (o) => [bx + bn[0] * o, bz + bn[1] * o];
    const [a1, a2, b1, b2] = [A(HALF), A(-HALF), B(HALF), B(-HALF)];
    push(bedTop, a1[0], ya + 0.02, a1[1], b1[0], yb + 0.02, b1[1], b2[0], yb + 0.02, b2[1], a1[0], ya + 0.02, a1[1], b2[0], yb + 0.02, b2[1], a2[0], ya + 0.02, a2[1]);
    for (const [p, q, nn] of [[a1, b1, an], [b2, a2, [-an[0], -an[1]]]]) {   // 側面(コンクリート)
      const y0 = Math.min(base[i], base[i + 1]) - 0.1;
      push(side, p[0], y0, p[1], q[0], y0, q[1], q[0], q === b1 ? yb : ya, q[1], p[0], y0, p[1], q[0], q === b1 ? yb : ya, q[1], p[0], p === a1 ? ya : yb, p[1]);
    }
    for (const g of [0.55, -0.55]) {   // レール(狭軌 1.067m)
      const r0 = A(g), r1 = B(g), w = 0.07;
      push(rails, r0[0] - an[0] * w, ya + 0.17, r0[1] - an[1] * w, r1[0] - bn[0] * w, yb + 0.17, r1[1] - bn[1] * w, r1[0] + bn[0] * w, yb + 0.17, r1[1] + bn[1] * w,
        r0[0] - an[0] * w, ya + 0.17, r0[1] - an[1] * w, r1[0] + bn[0] * w, yb + 0.17, r1[1] + bn[1] * w, r0[0] + an[0] * w, ya + 0.17, r0[1] + an[1] * w);
    }
  }
  const mesh = (pos, color, name) => {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide })); m.name = name; m.userData.noLift = true; m.frustumCulled = false; group.add(m); return m;
  };
  mesh(bedTop, 0x7d6a55, 'enoden-bed'); mesh(side, 0x9a9b98, 'enoden-wall'); mesh(rails, 0x8f9397, 'enoden-rails');
  // 架線柱(30m ごと、線路の山側)と架線(高さ 5.3m)
  const poles = [], wire = [];
  let last = null;
  for (let s = 10; s < S[n - 1]; s += 30) {
    let i = 0; while (i < n - 2 && S[i + 1] < s) i++;
    const t = (s - S[i]) / ((S[i + 1] - S[i]) || 1), x = P[i][0] + (P[i + 1][0] - P[i][0]) * t, z = P[i][1] + (P[i + 1][1] - P[i][1]) * t, y = top[i] + (top[i + 1] - top[i]) * t;
    const [tx, tz] = dir(i), nx = tz, nz = -tx, sd = -1;   // 進む向き(西→東)の右 = 北(山側)
    const px = x + nx * sd * 2.3, pz = z + nz * sd * 2.3;
    const box = (cx, cy, cz, sx, sy, sz, ang) => { const g = new THREE.BoxGeometry(sx, sy, sz); g.rotateY(ang); g.translate(cx, cy, cz); poles.push(g); };
    const ang = Math.atan2(tx, tz);
    box(px, y + 3.2, pz, 0.25, 6.4, 0.25, ang);
    box((px + x) / 2, y + 6.0, (pz + z) / 2, 0.08, 0.08, 2.4, ang + Math.PI / 2);
    const wp = new THREE.Vector3(x, y + 5.3, z);
    if (last) wire.push(last, wp);
    last = wp;
  }
  if (poles.length) {
    const merged = new THREE.BufferGeometry(); const arr = []; for (const g of poles) { const p = g.toNonIndexed().getAttribute('position').array; for (const v of p) arr.push(v); }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); merged.computeVertexNormals();
    const m = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: 0x8a8d90 })); m.name = 'enoden-poles'; m.userData.noLift = true; m.frustumCulled = false; group.add(m);
  }
  if (wire.length) { const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wire), new THREE.LineBasicMaterial({ color: 0x2a2a2a })); l.name = 'enoden-wire'; l.frustumCulled = false; group.add(l); }
  // ---- 電車: 2両。上下は薄い緑、真ん中はクリーム色、窓は濃いグレー ----
  const makeCar = () => {
    const g = new THREE.Group(), L = 12.5, Wd = 2.6, H = 3.5;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const add = (sx, sy, sz, y, c, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat(c)); m.position.set(0, y, z); g.add(m); };
    add(Wd, 1.2, L, 0.95, 0x7fb37a);            // 下(薄い緑)
    add(Wd + 0.02, 1.3, L, 2.2, 0xefe4c2);      // 真ん中(クリーム)
    add(Wd, 0.6, L, 3.15, 0x7fb37a);            // 上(薄い緑)
    add(Wd - 0.3, 0.25, L - 0.6, 3.55, 0x9ea3a6);   // 屋根の機器
    for (const sd of [-1, 1]) for (let k = 0; k < 5; k++) { const w = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.85, 1.6), mat(0x3a3f44)); w.position.set(sd * (Wd / 2 + 0.01), 2.25, -L / 2 + 1.6 + k * 2.3); g.add(w); }
    for (const sd of [-1, 1]) { const w = new THREE.Mesh(new THREE.BoxGeometry(Wd - 0.5, 0.9, 0.04), mat(0x3a3f44)); w.position.set(0, 2.3, sd * (L / 2 + 0.01)); g.add(w); }   // 前後の窓
    g.traverse((o) => { o.userData.noLift = true; });
    return g;
  };
  const cars = [makeCar(), makeCar()];
  for (const c of cars) { c.visible = false; group.add(c); }
  const at = (s) => {
    s = Math.max(0, Math.min(S[n - 1], s)); let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const t = (s - S[lo]) / ((S[hi] - S[lo]) || 1);
    return { x: P[lo][0] + (P[hi][0] - P[lo][0]) * t, z: P[lo][1] + (P[hi][1] - P[lo][1]) * t, y: top[lo] + (top[hi] - top[lo]) * t + 0.2, h: Math.atan2(P[hi][0] - P[lo][0], P[hi][1] - P[lo][1]) };
  };
  // 車が線路から 120m 以内に来たら、離れた所(手前か先 350m)に電車を出して時速 40km で走らせる。離れたら消す
  const V = 40 / 3.6, GAP = 13.0;
  let train = null, ps = 0;
  const project = (x, z) => { let best = Infinity, bs = 0; for (let i = 0; i + 1 < n; i += 2) { const d = (P[i][0] - x) ** 2 + (P[i][1] - z) ** 2; if (d < best) { best = d; bs = S[i]; } } return [bs, Math.sqrt(best)]; };
  const update = (dt, px, pz) => {
    const [s0, dd] = project(px, pz); ps = s0;
    if (!train && dd < 120) {
      const ahead = Math.random() < 0.5;
      const s = Math.max(0, Math.min(S[n - 1], s0 + (ahead ? 350 : -350)));
      train = { s, dir: ahead ? -1 : 1 };
      if ((train.dir > 0 && s > S[n - 1] - 30) || (train.dir < 0 && s < 30)) train.dir *= -1;
    }
    if (!train) return;
    train.s += train.dir * V * dt;
    if (dd > 600 || train.s < 0 || train.s > S[n - 1] || Math.abs(train.s - ps) > 700) { train = null; for (const c of cars) c.visible = false; return; }
    cars.forEach((c, k) => {
      const q = at(train.s - train.dir * k * GAP), q2 = at(train.s - train.dir * k * GAP + 3);
      c.position.set(q.x, q.y, q.z); c.rotation.set(0, Math.atan2(q2.x - q.x, q2.z - q.z), 0); c.visible = true;
    });
  };
  // 当たり判定: 路盤の上(高さ 0.5m 以上)は車が入れない
  const grid = new Map(), C = 10;
  for (let i = 0; i < n; i++) { if (P[i][2] < 0.5) continue; const k = Math.floor(P[i][0] / C) + ',' + Math.floor(P[i][1] / C); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
  const blocked = (x, z, r = 0.3) => {
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) for (const i of grid.get((Math.floor(x / C) + gx) + ',' + (Math.floor(z / C) + gz)) || []) {
      if (i + 1 >= n) continue;
      const [ax, az] = P[i], [bx, bz] = P[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (HALF + r) ** 2) return true;
    }
    return false;
  };
  // 線路の上(高さに関係なく)か: 柵・植え込みなどを置かない判定
  const allGrid = new Map();
  for (let i = 0; i < n; i++) { const k = Math.floor(P[i][0] / C) + ',' + Math.floor(P[i][1] / C); if (!allGrid.has(k)) allGrid.set(k, []); allGrid.get(k).push(i); }
  const onRail = (x, z, r = 0.5) => {
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) for (const i of allGrid.get((Math.floor(x / C) + gx) + ',' + (Math.floor(z / C) + gz)) || []) {
      if (i + 1 >= n) continue;
      const [ax, az] = P[i], [bx, bz] = P[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (HALF + r) ** 2) return true;
    }
    return false;
  };
  return { update, blocked, onRail };
}
