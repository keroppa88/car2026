import * as THREE from '../lib/three.module.js';

// 東京駅〜日本橋の地図(map_tokyoeki.glb)の見た目を整える。
//  - 地図の形(当たり判定・走行面に使うメッシュ)はそのまま。材質と、模様を貼るための座標だけ替える。
//  - 建物: つながった面ごとに1棟と数え、棟ごとに色と窓の種類を変える。壁は窓の模様、屋上は単色。
//  - 路面・地面・川・緑はそれらしい色にする。
// 地図は 1単位 = 1m、Y が上(tools/prep_tokyoeki.py で整えたもの)。

const GROUND = {
  M06_STEEL_SMOKE: 0x3d3f42,      // 大通りの路面(高架の道路も同じ材質)
  M05_GRAPHITE_HAZE: 0x9a9b98,    // 街区の地面(歩道・広場の舗装)
  ASPHALT_06_1K: 0x6e6a64,        // 線路(東京駅の構内)
  F08_FOREST_SHADOW: 0x5f7f46,    // 緑地
  H06_OCEAN_DEPTH: 0x3d6b66,      // 川(日本橋川)
  H07_DEEP_TEAL: 0x335c58,
};

// 壁の色(昼)。白・ベージュ・灰色・薄茶が中心。
const WALL_COLORS = [
  0xe8e4da, 0xd9d3c4, 0xcfc8b8, 0xbfc5c9, 0xb4b8bb, 0xa9a49a, 0xd6cfbe,
  0xc9bfae, 0x9fa6ab, 0xe2dccd, 0xb9ab95, 0x8f9498, 0xcfd3d6, 0xa3988a,
];
const GLASS_COLORS = [0x9fb4c4, 0x8ea6b8, 0xa9bccb, 0x7f97aa, 0xb3c3cf];

// 窓の模様の種類。1枚の絵 = 横 bays 区画 × 縦 floors 階。tileW・tileH はその実寸(m)。
const STYLES = [
  { name: 'band', bays: 4, floors: 4, tileW: 12, tileH: 14.4 },     // 横長の帯窓(オフィス)
  { name: 'punch', bays: 4, floors: 4, tileW: 12, tileH: 14.0 },    // 四角い窓が並ぶ
  { name: 'curtain', bays: 4, floors: 4, tileW: 8, tileH: 16.0 },   // ガラス張り(高層)
  { name: 'house', bays: 4, floors: 4, tileW: 12, tileH: 11.6 },    // 小さな窓とベランダ(低層)
  { name: 'slit', bays: 4, floors: 4, tileW: 8, tileH: 14.4 },      // 縦長の細い窓
];

function seeded(n) {
  let s = (Math.abs(n | 0) * 9301 + 49297) % 233280 || 7;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

// 窓の絵(色)と、夜に光る窓の絵(発光)。壁は白で描き、棟の色は頂点の色で掛ける。
function makeStyleTextures(style, index) {
  const W = 256, H = 256, bw = W / style.bays, fh = H / style.floors;
  const color = document.createElement('canvas'); color.width = W; color.height = H;
  const glow = document.createElement('canvas'); glow.width = W; glow.height = H;
  const g = color.getContext('2d'), e = glow.getContext('2d');
  const R = seeded(1000 + index * 77);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  e.fillStyle = '#000000'; e.fillRect(0, 0, W, H);
  const glass = '#2f3946', frame = '#8b9096';
  const lit = () => R() < 0.42;
  const litColor = () => (R() < 0.7 ? '#ffe2b0' : '#fff4dc');
  for (let f = 0; f < style.floors; f++) {
    const y0 = f * fh;
    if (style.name === 'band') {
      g.fillStyle = glass; g.fillRect(0, y0 + fh * 0.28, W, fh * 0.46);
      g.fillStyle = frame; for (let b = 0; b <= style.bays * 2; b++) g.fillRect(b * bw / 2 - 1, y0 + fh * 0.28, 2, fh * 0.46);
      for (let b = 0; b < style.bays; b++) if (lit()) { e.fillStyle = litColor(); e.fillRect(b * bw, y0 + fh * 0.28, bw, fh * 0.46); }
    } else if (style.name === 'curtain') {
      g.fillStyle = '#5d7386'; g.fillRect(0, y0, W, fh);
      g.fillStyle = '#c9d3db'; g.fillRect(0, y0 + fh - 3, W, 3);
      for (let b = 0; b <= style.bays; b++) g.fillRect(b * bw - 1, y0, 2, fh);
      for (let b = 0; b < style.bays; b++) if (lit()) { e.fillStyle = litColor(); e.fillRect(b * bw + 2, y0 + 2, bw - 4, fh - 6); }
    } else if (style.name === 'house') {
      for (let b = 0; b < style.bays; b++) {
        const x0 = b * bw;
        g.fillStyle = glass; g.fillRect(x0 + bw * 0.2, y0 + fh * 0.22, bw * 0.6, fh * 0.48);
        g.fillStyle = '#9a9690'; g.fillRect(x0 + bw * 0.08, y0 + fh * 0.7, bw * 0.84, fh * 0.12);   // ベランダの手すり
        if (lit()) { e.fillStyle = litColor(); e.fillRect(x0 + bw * 0.2, y0 + fh * 0.22, bw * 0.6, fh * 0.48); }
      }
    } else if (style.name === 'slit') {
      for (let b = 0; b < style.bays * 2; b++) {
        const x0 = b * bw / 2;
        g.fillStyle = glass; g.fillRect(x0 + bw * 0.12, y0 + fh * 0.12, bw * 0.24, fh * 0.72);
        if (lit()) { e.fillStyle = litColor(); e.fillRect(x0 + bw * 0.12, y0 + fh * 0.12, bw * 0.24, fh * 0.72); }
      }
    } else {
      for (let b = 0; b < style.bays; b++) {
        const x0 = b * bw;
        g.fillStyle = frame; g.fillRect(x0 + bw * 0.16, y0 + fh * 0.24, bw * 0.68, fh * 0.5);
        g.fillStyle = glass; g.fillRect(x0 + bw * 0.19, y0 + fh * 0.27, bw * 0.62, fh * 0.44);
        if (lit()) { e.fillStyle = litColor(); e.fillRect(x0 + bw * 0.19, y0 + fh * 0.27, bw * 0.62, fh * 0.44); }
      }
    }
    // 階の境の目地
    if (style.name !== 'curtain') { g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(0, y0, W, 2); }
  }
  const mk = (canvas, srgb) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: mk(color, true), emissiveMap: mk(glow, true) };
}

// 三角形のつながり(頂点の位置を共有する面どうし)で棟を分ける。
function buildingIds(pos) {
  const triCount = pos.count / 3;
  const parent = new Int32Array(triCount).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const owner = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      const key = `${Math.round(pos.getX(i) * 20)},${Math.round(pos.getY(i) * 20)},${Math.round(pos.getZ(i) * 20)}`;
      const o = owner.get(key);
      if (o === undefined) owner.set(key, t);
      else { const a = find(o), b = find(t); if (a !== b) parent[a] = b; }
    }
  }
  const ids = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) ids[t] = find(t);
  return ids;
}

// ---- 路面の白線・横断歩道・縁石 ----
// map/tokyoeki-markings.json は tools/tokyoeki_markings.py が地図の道路の形から作ったもの。
//  lines: 線(中央線は黄、車線境界は白の破線、外側線は白)  stripes: 横断歩道の縞と停止線
//  curbs: 大通りの縁(歩道との境)
function ribbon(pts, width, y, out, dash) {
  // 折れ線に沿った帯。dash=[塗る長さ, 空ける長さ] なら破線。
  const seg = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
    const L = Math.hypot(x1 - x0, z1 - z0); if (L < 1e-3) continue;
    seg.push([x0, z0, x1, z1, L]);
  }
  let s = 0;
  for (const [x0, z0, x1, z1, L] of seg) {
    const tx = (x1 - x0) / L, tz = (z1 - z0) / L, nx = tz * width / 2, nz = -tx * width / 2;
    const pieces = [];
    if (!dash) pieces.push([0, L]);
    else {
      const per = dash[0] + dash[1];
      let t = 0;
      while (t < L) {
        const ph = (s + t) % per;
        if (ph < dash[0]) { const e = Math.min(L, t + dash[0] - ph); pieces.push([t, e]); t = e; }
        else t += per - ph;
      }
    }
    for (const [a, b] of pieces) {
      const ax = x0 + tx * a, az = z0 + tz * a, bx = x0 + tx * b, bz = z0 + tz * b;
      out.push(ax + nx, y, az + nz, ax - nx, y, az - nz, bx + nx, y, bz + nz,
        bx + nx, y, bz + nz, ax - nx, y, az - nz, bx - nx, y, bz - nz);
    }
    s += L;
  }
}
function rect(x, z, ang, len, wid, y, out) {
  const tx = Math.sin(ang), tz = Math.cos(ang), hx = tx * len / 2, hz = tz * len / 2, nx = tz * wid / 2, nz = -tx * wid / 2;
  const p = (a, b) => [x + hx * a + nx * b, y, z + hz * a + nz * b];
  out.push(...p(-1, 1), ...p(-1, -1), ...p(1, 1), ...p(1, 1), ...p(-1, -1), ...p(1, -1));
}
function flatMesh(positions, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const n = new Float32Array(positions.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, m); mesh.matrixAutoUpdate = false; mesh.name = 'tokyoeki-markings';
  return mesh;
}
async function addMarkings(parent, url) {
  const data = await (await fetch(url)).json();
  const white = [], yellow = [], curb = [];
  for (const l of data.lines) ribbon(l.pts, l.w, 0.03, l.c === 'y' ? yellow : white, l.dash);
  for (const [x, z, a, L, w] of data.stripes) rect(x, z, a, L, w, 0.035, white);
  for (const c of data.curbs) ribbon(c, 0.35, 0.025, curb);
  const group = new THREE.Group(); group.name = 'tokyoeki-markings';
  group.add(flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a), flatMesh(curb, 0xbdbbb5));
  parent.add(group);
  document.body.dataset.tokyoEkiMarkings = String(data.lines.length + data.stripes.length);
  return group;
}

export function decorateTokyoEki(root) {
  // 白線などは地図(当たり判定に使うグループ)の外、同じ親に置く。
  if (root.parent) addMarkings(root.parent, 'map/tokyoeki-markings.json?v=20261021-1').catch((e) => console.warn('[tokyoeki] markings', e));
  const styleTex = STYLES.map((s, i) => makeStyleTextures(s, i));
  const glowMaterials = [];
  const wallMats = STYLES.map((s, i) => {
    const m = new THREE.MeshLambertMaterial({
      map: styleTex[i].map, vertexColors: true, side: THREE.DoubleSide,
      emissive: 0xffffff, emissiveMap: styleTex[i].emissiveMap, emissiveIntensity: 0,
    });
    glowMaterials.push(m);
    return m;
  });
  const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const groundMats = new Map();
  const groundMat = (hex) => {
    if (!groundMats.has(hex)) groundMats.set(hex, new THREE.MeshLambertMaterial({ color: hex, side: THREE.DoubleSide }));
    return groundMats.get(hex);
  };
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  let buildingCount = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const mesh of meshes) {
    const name = (mesh.material?.name || '').trim().toUpperCase();
    if (GROUND[name] !== undefined) {
      const m = groundMat(GROUND[name]); m.name = mesh.material.name;
      mesh.material = m;
      continue;
    }
    // 建物: 面ごとに座標を持たせるため、頂点を共有しない形にする。
    const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const pos = src.getAttribute('position');
    const triCount = pos.count / 3;
    const ids = buildingIds(pos);
    // 棟ごとの高さ(一番高い所)。高い棟はガラス張りにしやすくする。
    const top = new Map();
    for (let t = 0; t < triCount; t++) {
      const id = ids[t];
      const y = Math.max(pos.getY(t * 3), pos.getY(t * 3 + 1), pos.getY(t * 3 + 2));
      if (!(top.get(id) >= y)) top.set(id, y);
    }
    const look = new Map();   // 棟 → {style, color, roof}
    const lookOf = (id) => {
      let L = look.get(id);
      if (L) return L;
      const R = seeded(id * 131 + 17);
      const h = top.get(id);
      let style;
      if (h > 70) style = R() < 0.75 ? 2 : 0;
      else if (h > 30) style = [0, 0, 1, 1, 4, 2][Math.floor(R() * 6)];
      else style = [1, 1, 3, 3, 4, 0][Math.floor(R() * 6)];
      const base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)]
        : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
      const color = new THREE.Color(base);
      const roof = new THREE.Color(base).multiplyScalar(0.72);
      L = { style, color, roof };
      look.set(id, L);
      buildingCount++;
      return L;
    };
    const uv = new Float32Array(pos.count * 2);
    const col = new Float32Array(pos.count * 3);
    const nor = new Float32Array(pos.count * 3);
    const groupOf = new Int8Array(triCount);   // 0..STYLES-1 = 壁の模様, STYLES.length = 屋上
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      const L = lookOf(ids[t]);
      const vertical = Math.abs(n.y) < 0.3;
      groupOf[t] = vertical ? L.style : STYLES.length;
      const S = STYLES[L.style];
      const tx = -n.z, tz = n.x;                     // 壁の横向き
      const tl = Math.hypot(tx, tz) || 1;
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const p = k === 0 ? a : k === 1 ? b : c;
        if (vertical) {
          uv[i * 2] = (p.x * tx + p.z * tz) / tl / S.tileW;
          uv[i * 2 + 1] = p.y / S.tileH;
        } else { uv[i * 2] = 0; uv[i * 2 + 1] = 0; }
        const cc = vertical ? L.color : L.roof;
        col[i * 3] = cc.r; col[i * 3 + 1] = cc.g; col[i * 3 + 2] = cc.b;
        nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z;
      }
    }
    // 模様の種類ごとに面を並べ替えて、まとめて描けるようにする。
    const order = [];
    for (let gi = 0; gi <= STYLES.length; gi++) for (let t = 0; t < triCount; t++) if (groupOf[t] === gi) order.push(t);
    const P = new Float32Array(pos.count * 3), U = new Float32Array(pos.count * 2), C = new Float32Array(pos.count * 3), N = new Float32Array(pos.count * 3);
    order.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const s = t * 3 + k, d = j * 3 + k;
        P[d * 3] = pos.getX(s); P[d * 3 + 1] = pos.getY(s); P[d * 3 + 2] = pos.getZ(s);
        U[d * 2] = uv[s * 2]; U[d * 2 + 1] = uv[s * 2 + 1];
        for (let q = 0; q < 3; q++) { C[d * 3 + q] = col[s * 3 + q]; N[d * 3 + q] = nor[s * 3 + q]; }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    let start = 0;
    for (let gi = 0; gi <= STYLES.length; gi++) {
      let count = 0;
      for (let t = 0; t < triCount; t++) if (groupOf[t] === gi) count++;
      if (count) geo.addGroup(start * 3, count * 3, gi);
      start += count;
    }
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const name0 = mesh.material?.name;
    const mats = [...wallMats, roofMat].map((m) => { const x = m; return x; });
    mesh.geometry.dispose();
    mesh.geometry = geo;
    mesh.material = mats;
    mesh.userData.tokyoEkiOriginalMaterialName = name0;
  }
  document.body.dataset.tokyoEkiBuildings = String(buildingCount);
  return {
    // 夜は窓を光らせる。
    setNight(on) { glowMaterials.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); },
  };
}
