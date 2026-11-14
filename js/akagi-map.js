import * as THREE from '../lib/three.module.js';
import { treeBillboards } from './osm-city.js?v=20261112-fuji-6';

// 赤城山(県道4号 前橋赤城線、赤城山総合観光案内所の前 → 姫百合駐車場の前)。
// map/akagi-course.json(tools/akagi/make_akagi.py)から組み立てる。
// 道の線は OpenStreetMap、起伏は PLATEAU 前橋市の地形。はじめと終わりがある1本道(つなぎ目なし)。
export const AKAGI_ROAD_HALF = 3.6;     // 片側1車線ずつ、幅 7.2m
const SHOULDER = 0.9;                    // 白線の外の路肩(舗装)
const RAIL = AKAGI_ROAD_HALF + SHOULDER + 0.35;   // ガードレールの位置(道の中心から)

// 木陰のある所(1)とない所(0)。道の木陰の模様(createCanopyShade の grove)と同じ式で、木の並びもこれに合わせる
export const akagiGrove = (x, z) => THREE.MathUtils.smoothstep(Math.sin(x * 0.035 + Math.sin(z * 0.048)), -0.4, 0.65);

export function buildAkagiMap(data) {
  const route = data.route.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const n = route.length;
  const clampI = (i) => Math.max(0, Math.min(n - 1, i));
  const at = (i) => route[clampI(i)].clone();
  // 進む向きの左(gunma・富士と同じ約束: (dz, -dx))
  const normalAt = (i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: dz / l, z: -dx / l };
  };
  const tangents = route.map((_, i) => normalAt(i));
  const extIndices = route.map((_, i) => i);
  const ext = route.map((p) => p.clone());
  const extTangents = tangents;
  const seam = { offset: { x: 0, z: 0 }, startX: -Infinity, endX: Infinity };   // 1本道: 端で反対側へ移さない
  const ringPosition = (x, z) => [x, z];
  const group = new THREE.Group(); group.name = 'akagi_route4';
  const scenery = new THREE.Group(); scenery.name = 'akagi_scenery';

  // ---- 近くの道の点を速く探す(32m の升目) ----
  const B = 32, bucket = new Map();
  route.forEach((p, i) => { const k = Math.floor(p.x / B) + ',' + Math.floor(p.z / B); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(i); });
  const nearestRoute = (x, z, reach = 2) => {
    const bx = Math.floor(x / B), bz = Math.floor(z / B);
    let best = Infinity, bi = -1;
    for (let a = -reach; a <= reach; a++) for (let b = -reach; b <= reach; b++) {
      for (const i of bucket.get((bx + a) + ',' + (bz + b)) || []) { const d = (route[i].x - x) ** 2 + (route[i].z - z) ** 2; if (d < best) { best = d; bi = i; } }
    }
    return { i: bi, d: Math.sqrt(best) };
  };
  // 道の中心線までの距離と、そこでの路面の高さ(前後の点の間でなめらかに)
  const roadAt = (x, z) => {
    const k = nearestRoute(x, z); if (k.i < 0) return null; let best = null;
    for (const [a, b] of [[clampI(k.i - 1), k.i], [k.i, clampI(k.i + 1)]]) {
      if (a === b) continue;
      const A = route[a], Bq = route[b], dx = Bq.x - A.x, dz = Bq.z - A.z, t = THREE.MathUtils.clamp(((x - A.x) * dx + (z - A.z) * dz) / (dx * dx + dz * dz || 1), 0, 1), d = Math.hypot(A.x + dx * t - x, A.z + dz * t - z);
      if (!best || d < best.d) best = { d, y: A.y + (Bq.y - A.y) * t, i: k.i };
    }
    return best;
  };

  // ---- 地面。元の地形(T)を、道ごとに「切り土(山側: 側溝の先はグレーの崖)」と「盛り土(谷側: ゆるい草の斜面)」で削る・盛る(H) ----
  const G = data.ground, cols = G.nx - 1, lines = G.nz - 1;
  const minX = G.x0, minZ = G.z0, maxX = G.x0 + cols * G.cell, maxZ = G.z0 + lines * G.cell;
  const R = AKAGI_ROAD_HALF, EDGE = R + SHOULDER, STRIP = 30;   // STRIP: 道の両わきの細かい地面の幅(路肩の外から)
  const T = (x, z) => {
    const fx = THREE.MathUtils.clamp((x - minX) / G.cell, 0, cols - 1e-6), fz = THREE.MathUtils.clamp((z - minZ) / G.cell, 0, lines - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz, k = iz * (cols + 1) + ix;
    return (G.h[k] * (1 - tx) + G.h[k + 1] * tx) * (1 - tz) + (G.h[k + cols + 1] * (1 - tx) + G.h[k + cols + 2] * tx) * tz;
  };
  // 近くを通る道の「区間」ごとの、いちばん近い所(つづら折りでは 2〜3 本の道が近くを通る)
  const legsAt = (x, z) => {
    const bx = Math.floor(x / B), bz = Math.floor(z / B), cand = [];
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const i of bucket.get((bx + a) + ',' + (bz + b)) || []) cand.push([(route[i].x - x) ** 2 + (route[i].z - z) ** 2, i]);
    cand.sort((p, q) => p[0] - q[0]);
    const legs = [];
    for (const [, i] of cand) {
      if (legs.some((l) => Math.abs(l.i - i) < 25)) continue;
      let best = null;
      for (const [a, b] of [[clampI(i - 1), i], [i, clampI(i + 1)]]) {
        if (a === b) continue;
        const A = route[a], Bq = route[b], dx = Bq.x - A.x, dz = Bq.z - A.z, t = THREE.MathUtils.clamp(((x - A.x) * dx + (z - A.z) * dz) / (dx * dx + dz * dz || 1), 0, 1), d = Math.hypot(A.x + dx * t - x, A.z + dz * t - z);
        if (!best || d < best.d) best = { d, y: A.y + (Bq.y - A.y) * t, i };
      }
      legs.push(best); if (legs.length >= 3) break;
    }
    return legs;
  };
  const CUT = 2.2, FILL = 0.75, DITCH = 1.2;   // 崖の傾き(高さ/横)、盛り土の傾き、崖の下の側溝・草の幅
  const H = (x, z) => {
    let h = T(x, z);
    const legs = legsAt(x, z);
    for (let k = legs.length - 1; k >= 0; k--) {   // 近い道ほどあとで(強く)効かせる
      const { d, y } = legs[k], e = d - EDGE;
      if (e <= 0) return y - 0.05;
      h = THREE.MathUtils.clamp(h, y - 0.1 - FILL * Math.max(0, e - 0.3), y - 0.1 + CUT * Math.max(0, e - DITCH));
    }
    return h;
  };
  // 粗い地面(6m 升目)。道の両わき(細かい地面の下)は少し下げて、細かい地面から突き出ないように
  const verts = new Float32Array((cols + 1) * (lines + 1) * 3), colors = new Float32Array(verts.length);
  const forest = [0.02, 0.035, 0.015], bush = [0.035, 0.055, 0.02];   // 道から離れた所: 森の下の暗い影(草は1本ずつ描かず、地面の色だけ)
  for (let iz = 0; iz <= lines; iz++) for (let ix = 0; ix <= cols; ix++) {
    const x = minX + ix * G.cell, z = minZ + iz * G.cell, k = iz * (cols + 1) + ix, legs = legsAt(x, z);
    const d = legs.length ? legs[0].d : 1e9;
    const h = H(x, z) - 6 * (1 - THREE.MathUtils.smoothstep(d, EDGE + STRIP - 8, EDGE + STRIP - 1));
    verts[k * 3] = x; verts[k * 3 + 1] = h; verts[k * 3 + 2] = z;
    const mix = 0.5 + 0.5 * Math.sin(x * 0.021 + Math.sin(z * 0.017) * 2.3) * Math.sin(z * 0.013 - x * 0.007);
    for (let c = 0; c < 3; c++) colors[k * 3 + c] = forest[c] + (bush[c] - forest[c]) * mix * 0.7;
  }
  const idx = [];
  for (let iz = 0; iz < lines; iz++) for (let ix = 0; ix < cols; ix++) { const a = iz * (cols + 1) + ix, b = a + cols + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.setIndex(idx); groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));
  ground.name = 'AkagiGround';
  // 地面の高さ(車・木の置き場所)は H をそのまま使う(道のわきの崖・斜面も正しい高さ)
  const groundHeightAt = (x, z) => H(x, z);
  const groundNormalAt = (x, z) => new THREE.Vector3(H(x - 1, z) - H(x + 1, z), 2, H(x, z - 1) - H(x, z + 1)).normalize();
  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ ? -Infinity : H(x, z));

  // 地図の外の遠い地面(60m 升目、半径 6km)。高さは地形の端のまま。内側と重なる所は下げる
  {
    const C = 60, Rr = 6000, m = Math.ceil(Rr / C), fv = [], fi = [], fc = [];
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (let j = -m; j <= m; j++) for (let i = -m; i <= m; i++) {
      const x = cx + i * C, z = cz + j * C, inside = x > minX + C && x < maxX - C && z > minZ + C && z < maxZ - C;
      fv.push(x, groundHeightAt(x, z) - (inside ? 40 : 0.3), z); fc.push(forest[0], forest[1], forest[2]);
    }
    const w = 2 * m + 1;
    for (let j = 0; j < w - 1; j++) for (let i = 0; i < w - 1; i++) { const a = j * w + i; fi.push(a, a + w, a + 1, a + 1, a + w, a + w + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(fv, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3)); g.setIndex(fi); g.computeVertexNormals();
    const far = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })); far.name = 'AkagiFarGround'; scenery.add(far);
  }

  // ---- 道の帯: 路面・路肩・センターライン(黄色)・外側線(白) ----
  const bands = [
    { name: 'GunmaRoad', from: -R, to: R, y: 0, color: 0x4a4c4e },
    { name: 'GunmaShoulder', from: -R - SHOULDER, to: -R, y: -0.01, color: 0x55575a },
    { name: 'GunmaShoulder', from: R, to: R + SHOULDER, y: -0.01, color: 0x55575a },
    { name: 'GunmaCenterLine', from: -0.2, to: -0.07, y: 0.02, color: 0xd9a628 },
    { name: 'GunmaCenterLine', from: 0.07, to: 0.2, y: 0.02, color: 0xd9a628 },
    { name: 'GunmaEdgeLine', from: -R + 0.1, to: -R + 0.25, y: 0.02, color: 0xe6e6e0 },
    { name: 'GunmaEdgeLine', from: R - 0.25, to: R - 0.1, y: 0.02, color: 0xe6e6e0 },
  ];
  for (const band of bands) {
    const v = new Float32Array(n * 2 * 3), ind = [];
    for (let i = 0; i < n; i++) {
      const p = route[i], nn = tangents[i];
      for (let s = 0; s < 2; s++) { const across = s ? band.to : band.from, o = (i * 2 + s) * 3; v[o] = p.x + nn.x * across; v[o + 1] = p.y + band.y; v[o + 2] = p.z + nn.z * across; }
      if (i + 1 < n) ind.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(v, 3)); geo.setIndex(ind); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: band.name, color: band.color, side: THREE.DoubleSide })); mesh.name = band.name; group.add(mesh);
  }
  // ---- 道の両わきの細かい地面(路肩の外から 30m)。山側の崖はグレー(吹き付けのコンクリート)、崖の下と谷側の斜面は草、奥は森の暗い影 ----
  {
    const OFF = [0, 0.4, DITCH, DITCH + 0.6, DITCH + 1.5, DITCH + 3, DITCH + 5, DITCH + 7.5, 11, 15, 20, 25, STRIP];
    const m = OFF.length, v = [], c = [], ind = [];
    const grass = [0.17, 0.26, 0.08], rock = [0.15, 0.155, 0.15], C = new THREE.Color(), cutV = [];   // cutV: 削った深さ(元の地形 - 地面)
    for (const side of [-1, 1]) {
      const base = v.length / 3;
      for (let i = 0; i < n; i++) {
        const p = route[i], nn = tangents[i];
        let px = p.x + nn.x * side * EDGE, pz = p.z + nn.z * side * EDGE, py = p.y - 0.05, prevY = py;
        for (let k = 0; k < m; k++) {
          const o = EDGE + OFF[k], x = p.x + nn.x * side * o, z = p.z + nn.z * side * o;
          const legs = legsAt(x, z);
          if (k === 0 || (legs.length && Math.abs(legs[0].i - i) < 25)) { px = x; pz = z; py = k === 0 ? p.y - 0.05 : H(x, z); }   // ほかの道の方が近い所(つづら折りの間)では止める
          v.push(px, py, pz); cutV.push(T(px, pz) - py);
          const slope = k ? (py - prevY) / Math.max(0.3, OFF[k] - OFF[k - 1]) : 0, far = THREE.MathUtils.smoothstep(OFF[k], 2.5, 7);
          let col = grass.map((g, j) => g + (forest[j] - g) * far);
          prevY = py; c.push(...col);
        }
      }
      for (let i = 0; i + 1 < n; i++) for (let k = 0; k + 1 < m; k++) {
        const a2 = base + i * m + k, b2 = a2 + m;
        ind.push(a2, b2, a2 + 1, a2 + 1, b2, b2 + 1);
      }
    }
    // 崖の色は面ごとにくっきり(上の点が崖なら、その面は崖の色)
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3)); geo.setAttribute('cut', new THREE.Float32BufferAttribute(cutV, 1)); geo.setIndex(ind);
    const flat = geo.toNonIndexed(); flat.computeVertexNormals();
    const pos = flat.getAttribute('position'), col = flat.getAttribute('color'), cutA = flat.getAttribute('cut');
    // 削った所(切り土)の急な面(40度より急)だけ崖のグレー。四角(三角 2 枚)ごとに決める(ふちをギザギザにしない)。
    // 崖の上(元の山の斜面)は、草と木の茂る暗い緑
    const triN = (t) => { const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t); return new THREE.Vector3(pos.getX(t + 1) - ax, pos.getY(t + 1) - ay, pos.getZ(t + 1) - az).cross(new THREE.Vector3(pos.getX(t + 2) - ax, pos.getY(t + 2) - ay, pos.getZ(t + 2) - az)); };
    for (let t = 0; t < pos.count; t += 6) {
      const nq = triN(t).add(triN(t + 3)).normalize();
      let cut = 0; for (let j = 0; j < 6; j++) cut += cutA.getX(t + j) / 6;
      const steep = Math.abs(nq.y) < 0.77 && cut > 0.4;
      for (let j = 0; j < 6; j++) {
        if (steep) { const q = 0.85 + 0.25 * Math.sin(pos.getX(t + j) * 0.7 + pos.getY(t + j) * 1.3) * Math.sin(pos.getZ(t + j) * 0.5); C.setRGB(rock[0] * q, rock[1] * q, rock[2] * q); }
        else if (cut > 0.4 || cutA.getX(t + j) > 0.4) C.setRGB(0.05, 0.085, 0.03);   // 崖の上のふち: 茂み
        else C.setRGB(col.getX(t + j), col.getY(t + j), col.getZ(t + j));
        col.setXYZ(t + j, C.r, C.g, C.b);
      }
    }
    const mesh = new THREE.Mesh(flat, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide }));
    mesh.name = 'akagi-roadside'; scenery.add(mesh);
  }

  // ---- スタート・ゴールの線(道を横切る白い帯 0.6m) ----
  for (const i of [data.start, data.goal]) {
    if (i == null) continue;
    const p = route[i], nn = tangents[i], f = { x: -nn.z, z: nn.x }, v = [];
    for (const [a, b] of [[-R, -0.3], [R, -0.3], [R, 0.3], [-R, -0.3], [R, 0.3], [-R, 0.3]]) v.push(p.x + nn.x * a + f.x * b, p.y + 0.03, p.z + nn.z * a + f.z * b);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: 'GunmaEdgeLine', color: 0xf2f2ee, side: THREE.DoubleSide })); mesh.name = 'GunmaEdgeLine'; group.add(mesh);
  }

  // ---- ガードレール(白、高さ 0.8m、両側)。見えない壁(高さ 1.2m)で当たり判定 ----
  const railMat = new THREE.MeshLambertMaterial({ name: 'GunmaGuardrail', color: 0xf0f0e8, emissive: 0x303030, side: THREE.DoubleSide });
  const colliders = [];
  const skip = (i) => (data.start != null && Math.abs(i - data.start) < 12) || (data.goal != null && Math.abs(i - data.goal) < 12);   // 駐車場の出入口のあたりは切る
  for (const side of [-1, 1]) {
    const wall = [], panel = [];
    for (let i = 0; i + 1 < n; i++) {
      if (skip(i) || skip(i + 1)) continue;
      const a = route[i], b = route[i + 1], na = tangents[i], nb = tangents[i + 1];
      const pa = [a.x + na.x * side * RAIL, a.z + na.z * side * RAIL], pb = [b.x + nb.x * side * RAIL, b.z + nb.z * side * RAIL];
      const quad = (P, y0, y1) => P.push(pa[0], a.y + y0, pa[1], pb[0], b.y + y0, pb[1], pb[0], b.y + y1, pb[1], pa[0], a.y + y0, pa[1], pb[0], b.y + y1, pb[1], pa[0], a.y + y1, pa[1]);
      quad(panel, 0.45, 0.8); quad(wall, -0.1, 1.1);
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(panel, 3)); pg.computeVertexNormals();
    const pm = new THREE.Mesh(pg, railMat); pm.name = 'GunmaGuardrail'; scenery.add(pm);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'akagi-guardrail'; scenery.add(wm); colliders.push(wm);
    // 支柱(6m ごと)
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), railMat, Math.ceil(n / 2) + 1), M = new THREE.Matrix4();
    let c = 0;
    for (let i = 0; i < n; i += 2) {
      if (skip(i)) continue;
      const p = route[i], nn = tangents[i];
      posts.setMatrixAt(c++, M.makeTranslation(p.x + nn.x * side * (RAIL + 0.08), p.y + 0.4, p.z + nn.z * side * (RAIL + 0.08)));
    }
    posts.count = c; posts.name = 'GunmaGuardrail'; posts.computeBoundingSphere(); scenery.add(posts);
  }

  // ---- 森(2D の木)。木陰のある所(akagiGrove。道の木陰の模様と同じ式)は、背の高い木を道のすぐ脇に並べて道にかぶせる。
  //      木陰のない所は、木は道から少し離して、日なたの草むらが見える ----
  {
    let s = 20261114; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const trees = [];
    const tooSteep = (x, z) => Math.hypot(H(x + 1.5, z) - H(x - 1.5, z), H(x, z + 1.5) - H(x, z - 1.5)) / 3 > Math.tan(70 * Math.PI / 180);   // 70度より急な斜面には木が生えない
    // 道ぞいの木(3m ごとに両側を見る)
    for (let i = 0; i < n; i++) for (const side of [-1, 1]) {
      const p = route[i], nn = tangents[i], g = akagiGrove(p.x, p.z);
      if (rnd() > 0.12 + 0.55 * g) continue;
      const off = g > 0.5 ? RAIL + 1.2 + rnd() * 5 : RAIL + 7 + rnd() * 10;
      const x = p.x + nn.x * side * off + (rnd() - 0.5) * 2, z = p.z + nn.z * side * off + (rnd() - 0.5) * 2;
      const r = roadAt(x, z); if (!r || r.d < RAIL + 1 || T(x, z) - H(x, z) > 0.5 || tooSteep(x, z)) continue;   // 崖(削った面)には立てない
      trees.push([x, groundHeightAt(x, z) - 0.3, z, g > 0.5 ? 15 + rnd() * 7 : 10 + rnd() * 6]);
    }
    // 奥の森(道から 15m〜100m)
    for (let k = 0; k < 30000 && trees.length < 6000; k++) {
      const i = Math.floor(rnd() * n), side = rnd() < 0.5 ? -1 : 1, off = RAIL + 15 + rnd() ** 1.4 * 85, p = route[i], nn = tangents[i];
      const x = p.x + nn.x * side * off + (rnd() - 0.5) * 6, z = p.z + nn.z * side * off + (rnd() - 0.5) * 6;
      const r = roadAt(x, z); if (!r || r.d < RAIL + 10 || tooSteep(x, z)) continue;
      trees.push([x, groundHeightAt(x, z) - 0.3, z, 11 + rnd() * 8]);
    }
    for (const m of treeBillboards(trees, 'akagi-trees')) scenery.add(m);
  }

  // 道(路肩まで)の外: 草地・森(走ると砂煙、速さが落ちる)
  const softGroundAt = (x, z) => { const r = roadAt(x, z); return !r || r.d > R + SHOULDER + 0.3; };
  const start = data.start ?? 0;
  return { colliders, softGroundAt, group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb: route[0].y - route[n - 1].y, start,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
