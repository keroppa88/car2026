import * as THREE from '../lib/three.module.js';
import { treeBillboards } from './osm-city.js?v=20261111-fuji-9';

// 富士スピードウェイ(本コース)。map/fuji-course.json(tools/fuji/make_fuji.py)から組み立てる。
// コースの線は OpenStreetMap、起伏は PLATEAU 小山町の地形、建物は OpenStreetMap。
// 閉じた輪なので、つなぎ目(seam)はずらしなし。
export const FUJI_ROAD_HALF = 7.5;   // 本コースの幅 15m

export function buildFujiMap(data, landcover = null) {   // landcover: 地面の塗り分け図(Image)
  const route = data.route.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const n = route.length;
  const ring = (i) => ((i % n) + n) % n;
  const at = (i) => route[ring(i)].clone();
  // 進む向きの左(gunma と同じ向きの約束: (dz, -dx))
  const normalAt = (i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: dz / l, z: -dx / l };
  };
  const tangents = route.map((_, i) => normalAt(i));
  // ---- コースの両側のアスファルトのランオフの幅(縁石の外から)。直線は細く、カーブの外側は広く、内側は少し ----
  // 曲がり具合は前後 ±24m の向きの変わり方から。左に曲がる所は右(外)を広げる
  const K = 8, curv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - K), b = at(i), c = at(i + K);
    const h1 = Math.atan2(b.x - a.x, b.z - a.z), h2 = Math.atan2(c.x - b.x, c.z - b.z);
    const turn = Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1));
    curv[i] = turn / (Math.hypot(c.x - a.x, c.z - a.z) / 2 || 1);   // 1/半径(左回りが正)
  }
  const runL = new Float32Array(n), runR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = curv[i], radius = Math.abs(k) > 1e-5 ? 1 / Math.abs(k) : 1e5;
    const outer = THREE.MathUtils.clamp(10 + 2600 / radius, 10, 42);            // 外側: 直線 10m、半径 100m で 36m
    const inner = Math.min(THREE.MathUtils.clamp(9 + 500 / radius, 9, 16), Math.max(2, radius * 0.6 - FUJI_ROAD_HALF - 1.2));
    // 左の法線は左回りの内側。k > 0(左に曲がる)なら左が内、右が外
    runL[i] = k > 0 ? inner : outer; runR[i] = k > 0 ? outer : inner;
  }
  // 前後 ±45m でならし(広い所はカーブの前後にも続く)、さらに広い方へ寄せる
  const smooth = (w) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) { let m = 0, s = 0; for (let j = -15; j <= 15; j++) { m = Math.max(m, w[ring(i + j)]); s += w[ring(i + j)]; } o[i] = 0.5 * m + 0.5 * s / 31; } return o; };
  let runLs = smooth(smooth(runL)), runRs = smooth(smooth(runR));
  // 空撮から測った実際の幅があればそれを使う(tools/fuji/measure_runoff.py)。カーブの内側は曲がる半径より広げない
  if (data.runL && data.runR) {
    const cap = (i, inner) => { const k = Math.abs(curv[i]); return inner && k > 1e-5 ? Math.max(1.5, 0.9 / k - FUJI_ROAD_HALF - 1.2) : 1e9; };
    runLs = Float32Array.from(data.runL, (w, i) => Math.min(w, cap(i, curv[i] > 0)));
    runRs = Float32Array.from(data.runR, (w, i) => Math.min(w, cap(i, curv[i] < 0)));
  }
  // 帯は輪を一周 + 1点で閉じる
  const extIndices = Array.from({ length: n + 1 }, (_, j) => j);
  const ext = extIndices.map(at);
  const extTangents = extIndices.map(normalAt);
  const seam = { offset: { x: 0, z: 0 }, startX: -Infinity, endX: Infinity };
  const ringPosition = (x, z) => [x, z];

  const group = new THREE.Group();
  group.name = 'fuji_speedway';

  // ---- 地面(地形の升目)。コースのすぐ近くはコースの高さより少し下にそろえる ----
  const G = data.ground, cols = G.nx - 1, lines = G.nz - 1;
  const minX = G.x0, minZ = G.z0, maxX = G.x0 + cols * G.cell, maxZ = G.z0 + lines * G.cell;
  // 近くのコースの点を速く探すための升目(32m)
  const B = 32, bucket = new Map();
  route.forEach((p, i) => {
    const k = Math.floor(p.x / B) + ',' + Math.floor(p.z / B);
    if (!bucket.has(k)) bucket.set(k, []);
    bucket.get(k).push(i);
  });
  const nearestRoute = (x, z) => {
    const bx = Math.floor(x / B), bz = Math.floor(z / B);
    let best = Infinity, bi = -1;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      for (const i of bucket.get((bx + a) + ',' + (bz + b)) || []) {
        const d = (route[i].x - x) ** 2 + (route[i].z - z) ** 2;
        if (d < best) { best = d; bi = i; }
      }
    }
    return { i: bi, d: Math.sqrt(best) };
  };
  // 近道(幅の広い分かれ道)の路面: 両端のコースの高さをまっすぐ結ぶ坂。地面もこれに合わせる(路面から地面が突き出ないように)
  const wideBranches = (data.branches || []).filter((b) => b.w > 9).map((b) => {
    const P = b.pts, acc = [0]; for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    return { P, acc, total: acc[acc.length - 1] || 1, ya: route[b.from].y, yb: route[b.to].y, half: b.w / 2 };
  });
  const branchNear = (x, z) => {
    let best = null;
    for (const b of wideBranches) for (let k = 0; k + 1 < b.P.length; k++) {
      const [ax, az] = b.P[k], [bx, bz] = b.P[k + 1], dx = bx - ax, dz = bz - az, t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (!best || d < best.d) best = { d, half: b.half, y: THREE.MathUtils.lerp(b.ya, b.yb, (b.acc[k] + (b.acc[k + 1] - b.acc[k]) * t) / b.total) };
    }
    return best;
  };
  const verts = new Float32Array((cols + 1) * (lines + 1) * 3);
  const colors = new Float32Array(verts.length);
  const grass = [0.20, 0.30, 0.11], dry = [0.30, 0.31, 0.14];
  for (let iz = 0; iz <= lines; iz++) {
    for (let ix = 0; ix <= cols; ix++) {
      const x = minX + ix * G.cell, z = minZ + iz * G.cell, k = iz * (cols + 1) + ix;
      let h = G.h[k] / 10;
      const near = nearestRoute(x, z);
      if (near.i >= 0 && near.d < 120) {
        // 路面と同じ高さ(5cm 下)にそろえて、コースとコースの外に段差を作らない。高さは近い2点の間で補う
        const a = route[near.i], b2 = route[ring(near.i + 1)], c2 = route[ring(near.i - 1)];
        const seg = (q) => { const dx = q.x - a.x, dz = q.z - a.z, l2 = dx * dx + dz * dz || 1; return THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1); };
        const tb = seg(b2), tc = seg(c2);
        const ry = (tb >= tc ? a.y + (b2.y - a.y) * tb : a.y + (c2.y - a.y) * tc) - 0.05, wide = FUJI_ROAD_HALF + 1.2 + Math.max(runLs[near.i], runRs[near.i]);
        const t = THREE.MathUtils.smoothstep(near.d, wide + 2 * G.cell, wide + 2 * G.cell + 30);   // 升目(6m)2つぶんは平らに(斜めの三角が路面へかぶらない)
        h = THREE.MathUtils.lerp(ry, h, t);
      }
      const bq = branchNear(x, z);
      if (bq && bq.d < bq.half + 2 * G.cell + 30) {   // 近道のまわり: 近道の坂に合わせ、コースの近くではコースの高さとなめらかに混ぜる
        const hb = THREE.MathUtils.lerp(bq.y - 0.05, G.h[k] / 10, THREE.MathUtils.smoothstep(bq.d, bq.half + 2 * G.cell, bq.half + 2 * G.cell + 30));
        const wc = near.i >= 0 && near.d < 120 ? 1 / (1 + Math.max(0, near.d - FUJI_ROAD_HALF - 1.2)) ** 4 : 0, wb = 1 / (1 + Math.max(0, bq.d - bq.half)) ** 4;
        const f = wc ? THREE.MathUtils.smoothstep(near.d, FUJI_ROAD_HALF + 7.7, FUJI_ROAD_HALF + 17.7) : 1;   // コースの路面とそのすぐ外はコースの高さのまま(地面が路面の上に出ない)
        h = THREE.MathUtils.lerp(h, (h * wc + hb * wb) / (wc + wb), f);
      }
      verts[k * 3] = x; verts[k * 3 + 1] = h; verts[k * 3 + 2] = z;
      const mix = 0.5 + 0.5 * Math.sin(x * 0.013 + Math.sin(z * 0.009) * 2);
      const shade = 1;
      for (let c = 0; c < 3; c++) colors[k * 3 + c] = (grass[c] + (dry[c] - grass[c]) * mix * 0.6) * shade;
    }
  }
  const idx = [];
  for (let iz = 0; iz < lines; iz++) for (let ix = 0; ix < cols; ix++) {
    const a = iz * (cols + 1) + ix, b = a + cols + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  // 地図の外の遠くの地面(60m 升目、半径 6km)。高さは地形の端のまま。内側の地形と重なる所は少し下げる
  const far = (() => {
    const C = 60, Rr = 6000, m = Math.ceil(Rr / C), fv = [], fi = [], fc = [];
    for (let j = -m; j <= m; j++) for (let i = -m; i <= m; i++) {
      const x = i * C, z = j * C, inside = x > minX + C && x < maxX - C && z > minZ + C && z < maxZ - C;
      const xc = THREE.MathUtils.clamp(x, minX, maxX), zc = THREE.MathUtils.clamp(z, minZ, maxZ);
      const k = (iz) => (iz * (cols + 1));
      const fx = Math.round((xc - minX) / G.cell), fz = Math.round((zc - minZ) / G.cell);
      fv.push(x, G.h[Math.min(lines, fz) * (cols + 1) + Math.min(cols, fx)] / 10 - (inside ? 40 : 0.3), z);
      if (landcover) fc.push(0.045, 0.19, 0.045); else fc.push(grass[0], grass[1], grass[2]);   // 塗り分け図の外は木々の深い緑
    }
    const w = 2 * m + 1;
    for (let j = 0; j < w - 1; j++) for (let i = 0; i < w - 1; i++) { const a = j * w + i; fi.push(a, a + w, a + 1, a + 1, a + w, a + w + 1); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(fv, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
    g.setIndex(fi); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })); mesh.name = 'FujiFarGround';
    return mesh;
  })();
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  groundGeo.setIndex(idx);
  groundGeo.computeVertexNormals();
  let groundTex = null;
  if (landcover && data.landcover) {
    const L = data.landcover, uv = new Float32Array((cols + 1) * (lines + 1) * 2);
    for (let k = 0; k < uv.length / 2; k++) { uv[k * 2] = (verts[k * 3] - L.x0) / (L.W * L.px); uv[k * 2 + 1] = 1 - (verts[k * 3 + 2] - L.z0) / (L.H * L.px); }
    groundGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    groundTex = new THREE.Texture(landcover); groundTex.colorSpace = THREE.SRGBColorSpace; groundTex.anisotropy = 8; groundTex.needsUpdate = true;
    colors.fill(1);
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', map: groundTex, vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));   // 地面は少し奥へ(ランオフに出てこない)
  ground.name = 'FujiGround';
  const groundHeightAt = (x, z) => {
    const fx = THREE.MathUtils.clamp((x - minX) / G.cell, 0, cols - 1e-6);
    const fz = THREE.MathUtils.clamp((z - minZ) / G.cell, 0, lines - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const i0 = (iz * (cols + 1) + ix) * 3 + 1;
    const a = verts[i0], r = verts[i0 + 3], d = verts[i0 + (cols + 1) * 3], g = verts[i0 + (cols + 2) * 3];
    return tx + tz <= 1 ? a * (1 - tx - tz) + r * tx + d * tz : r * (1 - tz) + d * (1 - tx) + g * (tx + tz - 1);
  };
  const groundNormalAt = (x, z) => new THREE.Vector3(
    groundHeightAt(x - 1, z) - groundHeightAt(x + 1, z), 2,
    groundHeightAt(x, z - 1) - groundHeightAt(x, z + 1)).normalize();

  // ---- コースの帯: 路面・白線・縁石(赤白)・ランオフ(緑) ----
  const R = FUJI_ROAD_HALF;
  const bands = [
    { name: 'GunmaRoad', from: -R, to: R, y: 0, color: 0x47494b },
    { name: 'GunmaEdgeLine', from: -R + 0.35, to: -R + 0.5, y: 0.02, color: 0xe6e6e0 },
    { name: 'GunmaEdgeLine', from: R - 0.5, to: R - 0.35, y: 0.02, color: 0xe6e6e0 },
    { name: 'GunmaShoulder', from: -R - 1.2, to: -R, y: 0.01, kerb: true },
    { name: 'GunmaShoulder', from: R, to: R + 1.2, y: 0.01, kerb: true },
    // アスファルトのランオフ(路面より明るいグレー)。幅は場所ごと(runL / runR)
    { name: 'GunmaShoulder', from: -1, to: 0, y: -0.02, color: 0x5f6163, run: -1 },
    { name: 'GunmaShoulder', from: 0, to: 1, y: -0.02, color: 0x5f6163, run: 1 },
    // その外の芝(6m)は地面へなじませる
    { name: 'GunmaGrass', from: -1, to: 0, y: -0.06, color: 0x5d7a35, grass: -1 },
    { name: 'GunmaGrass', from: 0, to: 1, y: -0.06, color: 0x5d7a35, grass: 1 },
  ].filter((b) => !(landcover && (b.run || b.grass)));   // 塗り分け図があれば、ランオフ・芝は地面の絵で描く
  // 左右: 法線 nn は進む向きの左。across > 0 が左(runL / kerbL)、across < 0 が右
  const runAt = (i, side) => (side > 0 ? runLs : runRs)[ring(extIndices[i])];
  const kerbAt = (i, side) => { const k = side > 0 ? data.kerbL : data.kerbR; return !k || k[ring(extIndices[i])]; };
  const grey = new THREE.Color(landcover ? 0x898a8c : 0x5f6163);   // 縁石のない所: 塗り分けの舗装と同じ薄いグレー
  const lineCuts = { L: [], R: [] }, roadC = new THREE.Color(0x47494b), lawnC = new THREE.Color(0x96c878), red = new THREE.Color(0xc0302a), white = new THREE.Color(0xeeeeea);
  for (const band of bands) {
    const v = new Float32Array(ext.length * 2 * 3), col = band.kerb ? new Float32Array(v.length) : null, ind = [];
    for (let i = 0; i < ext.length; i++) {
      const p = ext[i], nn = extTangents[i];
      for (let s = 0; s < 2; s++) {
        let across = s ? band.to : band.from, outerEdge = false;
        if (band.run) { const w = R + 1.2 + runAt(i, band.run); across = band.run < 0 ? (s ? -R - 1.2 : -w) : (s ? w : R + 1.2); }
        if (band.grass) { const w = R + 1.2 + runAt(i, band.grass); across = band.grass < 0 ? (s ? -w : -w - 6) : (s ? w + 6 : w); outerEdge = Math.abs(across) > w + 1; }
        const o = (i * 2 + s) * 3;
        v[o] = p.x + nn.x * across; v[o + 2] = p.z + nn.z * across;
        // 芝の外の端は地面に合わせる
        v[o + 1] = outerEdge ? Math.min(p.y - 0.06, groundHeightAt(v[o], v[o + 2]) + 0.05) : p.y + band.y;
        if (col) { const c = !kerbAt(i, band.from < 0 ? -1 : 1) ? ((band.from < 0 ? data.roadR : data.roadL)?.[ring(extIndices[i])] ? roadC : (band.from < 0 ? data.lawnR : data.lawnL)?.[ring(extIndices[i])] ? lawnC : grey) : (i % 2) ? red : white; col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b; }   // 縁石のない所はランオフと同じグレー
      }
      if (i + 1 < ext.length) {
        if (band.kerb && landcover && !kerbAt(i, band.from < 0 ? -1 : 1) && !kerbAt(i + 1, band.from < 0 ? -1 : 1)) continue;   // 縁石のない所は帯を描かない(地面の塗り分けがそのまま見える)
        if (band.name === 'GunmaEdgeLine') {   // 近道の口を横切る白線は引かない
          const q = ext[i + 1], n2 = extTangents[i + 1], ac = (band.from + band.to) / 2, bm = branchNear((p.x + nn.x * ac + q.x + n2.x * ac) / 2, (p.z + nn.z * ac + q.z + n2.z * ac) / 2);
          if (bm && bm.d < bm.half - 0.1) { lineCuts[ac > 0 ? 'L' : 'R'].push(i); continue; }
        }
        ind.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(ind); geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ name: band.name, color: col ? 0xffffff : band.color, vertexColors: !!col, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat); mesh.name = band.name; group.add(mesh);
  }
  // 分かれ道(ピットレーン・ダンロップの近道。tools/fuji/apply_kerb_paint.py)。路面と両わきの白線、縁石なし
  for (const br of data.branches || []) {
    if (br.w > 9) {   // 近道: 地面に沿わせた細かい升目の路面(地面が突き出ない)。両端は 14m のばしてコースとのすき間を埋める(コースの上では路面の下にもぐる)
      const Q = br.pts, n0 = Q.length, e0 = [Q[0][0] - Q[1][0], Q[0][1] - Q[1][1]], e1 = [Q[n0 - 1][0] - Q[n0 - 2][0], Q[n0 - 1][1] - Q[n0 - 2][1]];
      const nrm = (e) => { const l = Math.hypot(e[0], e[1]) || 1; return [e[0] / l, e[1] / l]; }, u0 = nrm(e0), u1 = nrm(e1);
      const ctl = [[Q[0][0] + u0[0] * 14, Q[0][1] + u0[1] * 14], ...Q, [Q[n0 - 1][0] + u1[0] * 14, Q[n0 - 1][1] + u1[1] * 14]], line = [];
      for (let k = 0; k + 1 < ctl.length; k++) { const [ax, az] = ctl[k], [bx, bz] = ctl[k + 1], L = Math.hypot(bx - ax, bz - az), c = Math.max(1, Math.ceil(L / 2)); for (let j = 0; j < c; j++) line.push([ax + (bx - ax) * j / c, az + (bz - az) * j / c]); }
      line.push(ctl[ctl.length - 1]);
      const NS = 8, hw = br.w / 2, v = [], ind = [], onC = [], sideSign = lineCuts.L.length ? 1 : lineCuts.R.length ? -1 : 0, yAt = (x, z) => groundHeightAt(x, z) + 0.075;   // コースの近くでは縁石の帯(+1cm)より上、白線(+2cm)より下
      line.forEach((q, i) => { const a = line[Math.max(0, i - 1)], c = line[Math.min(line.length - 1, i + 1)], dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1;
        for (let j = 0; j <= NS; j++) { const o = -hw + br.w * j / NS, x = q[0] + dz / l * o, z = q[1] - dx / l * o; v.push(x, yAt(x, z), z); const k = nearestRoute(x, z), tn = tangents[k.i]; onC.push(k.d < FUJI_ROAD_HALF - 0.6); }   // のばした所: コースの上と、口の側の縁石の帯の上だけ
        if (i + 1 < line.length) for (let j = 0; j < NS; j++) { const a2 = i * (NS + 1) + j, b2 = a2 + NS + 1; if ((i < 7 || i >= line.length - 8) && !(onC[a2] && onC[a2 + 1])) continue;   // のばした所はコースの上だけ
          ind.push(a2, b2, a2 + 1, a2 + 1, b2, b2 + 1); } });
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.setIndex(ind); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x47494b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })); mesh.name = 'GunmaRoad'; group.add(mesh);
    }
    const P = br.pts, m = P.length, half = br.w / 2;
    let outerSign = 0;
    if (br.w > 9) {   // 島(本コースとの間)と反対の側 = 外側。外側の白線は、本コースの白線から途切れずにつなぐ
      const A = P[0], Bq = P[m - 1], L = Math.hypot(Bq[0] - A[0], Bq[1] - A[1]) || 1, dx = (Bq[0] - A[0]) / L, dz = (Bq[1] - A[1]) / L, nx = dz, nz = -dx;
      const far = route[Math.round((br.from + br.to) / 2)], mx = (A[0] + Bq[0]) / 2, mz = (A[1] + Bq[1]) / 2;
      outerSign = Math.hypot(mx + nx - far.x, mz + nz - far.z) > Math.hypot(mx - nx - far.x, mz - nz - far.z) ? 1 : -1;
      const side = lineCuts.L.length ? 'L' : lineCuts.R.length ? 'R' : null;
      if (side) {
        const cuts = lineCuts[side], ac = (side === 'L' ? 1 : -1) * (R - 0.425), ia = Math.min(...cuts), ib = Math.max(...cuts) + 1;
        const lp = (i) => [ext[i].x + extTangents[i].x * ac, ext[i].z + extTangents[i].z * ac], sOf = (q) => (q[0] - A[0]) * dx + (q[1] - A[1]) * dz;
        // 本コースの白線が近道の外側の線(まっすぐ)と交わる点を探し、そこで折ってまっすぐつなぐ(斜めのつなぎを作らない)
        const oo = outerSign * (half - 0.375), lat = (q) => ((q[0] - A[0]) * nx + (q[1] - A[1]) * nz) * outerSign - (half - 0.375);
        const cross = (i0, step) => { for (let k = 0; k < 12; k++) { const a = lp(i0 + k * step), b = lp(i0 + (k + 1) * step), la = lat(a), lb = lat(b); if (la >= 0 && lb < 0) { const t = la / (la - lb); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; } } return null; };
        let ends = [[lp(ia), cross(ia, 1)], [lp(ib), cross(ib, -1)]]; if (sOf(ends[0][0]) > sOf(ends[1][0])) ends.reverse();
        const [[e0, c0], [e1, c1]] = ends, ctl = [e0]; if (c0) ctl.push(c0);
        for (let t = (c0 ? sOf(c0) + 1 : sOf(e0) + 6); t < (c1 ? sOf(c1) - 1 : sOf(e1) - 6); t += 2) ctl.push([A[0] + dx * t + nx * oo, A[1] + dz * t + nz * oo]);
        if (c1) ctl.push(c1); ctl.push(e1);
        const v = [], yy = (x, z) => { const k = nearestRoute(x, z); return Math.max(groundHeightAt(x, z) + 0.085, k.i >= 0 && k.d < R + 1.5 ? route[k.i].y + 0.035 : -1e9); };
        const pts = []; for (let k = 0; k + 1 < ctl.length; k++) { const [ax, az] = ctl[k], [bx, bz] = ctl[k + 1], c = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az))); for (let j = 0; j < c; j++) pts.push([ax + (bx - ax) * j / c, az + (bz - az) * j / c]); }
        pts.push(ctl[ctl.length - 1]);
        const off = pts.map((q, i) => { const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)], ex = c[0] - a[0], ez = c[1] - a[1], el = Math.hypot(ex, ez) || 1; return [ez / el * 0.075, -ex / el * 0.075]; });
        for (let i = 0; i + 1 < pts.length; i++) {
          const c4 = [[pts[i][0] - off[i][0], pts[i][1] - off[i][1]], [pts[i + 1][0] - off[i + 1][0], pts[i + 1][1] - off[i + 1][1]], [pts[i + 1][0] + off[i + 1][0], pts[i + 1][1] + off[i + 1][1]], [pts[i][0] + off[i][0], pts[i][1] + off[i][1]]];
          for (const k of [0, 1, 2, 0, 2, 3]) v.push(c4[k][0], yy(c4[k][0], c4[k][1]), c4[k][1]);
        }
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: 'GunmaEdgeLine', color: 0xe6e6e0, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 })); mesh.name = 'GunmaEdgeLine'; group.add(mesh);
      }
    }
    const ya = route[br.from].y, yb = route[br.to].y;
    let total = 0; const acc = [0];
    for (let i = 1; i < m; i++) { total += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); acc.push(total); }
    for (const [o0, o1, col, dy] of [[-half, half, 0x47494b, 0.0], [-half + 0.3, -half + 0.45, 0xe6e6e0, 0.02], [half - 0.45, half - 0.3, 0xe6e6e0, 0.02]].filter((q) => !(br.w > 9 && (!q[3] || Math.sign(q[0]) === outerSign)))) {
      const v = [], ind = [];
      for (let i = 0; i < m; i++) {
        const a = P[Math.max(0, i - 1)], c = P[Math.min(m - 1, i + 1)], dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1, nx = dz / l, nz = -dx / l;
        const y = Math.max(THREE.MathUtils.lerp(ya, yb, acc[i] / (total || 1)), groundHeightAt(P[i][0], P[i][1]) + 0.04) - 0.01 + dy;
        for (const o of [o0, o1]) v.push(P[i][0] + nx * o, br.w > 9 ? groundHeightAt(P[i][0] + nx * o, P[i][1] + nz * o) + 0.085 : y, P[i][1] + nz * o);
        // 白線は本コースの路面の上には引かない(分かれ目・合流の所)
        const onCourse = (k) => { const a2 = P[Math.max(0, k - 1)], c2 = P[Math.min(m - 1, k + 1)], ex = c2[0] - a2[0], ez = c2[1] - a2[1], el = Math.hypot(ex, ez) || 1, om = (o0 + o1) / 2; return nearestRoute(P[k][0] + ez / el * om, P[k][1] - ex / el * om).d < FUJI_ROAD_HALF + 2.2; };   // 線そのものの位置で見る(縁石の帯の上にも引かない)
        if (i + 1 < m && !(dy && (onCourse(i) || onCourse(i + 1)))) ind.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.setIndex(ind); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: dy ? 'GunmaEdgeLine' : 'GunmaRoad', color: col, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }));
      mesh.name = dy ? 'GunmaEdgeLine' : 'GunmaRoad'; group.add(mesh);
    }
  }
  // ピットレーンの青い線(ピット棟の側の縁、幅 0.8m)。コースから離れて並ぶ所だけ
  {
    const pit = (data.branches || []).find((b) => b.w <= 9);
    if (pit) {
      const PP = pit.pts, v = [];
      for (let i = 0; i + 1 < PP.length; i++) {
        const a = PP[i], b2 = PP[i + 1], l = Math.hypot(b2[0] - a[0], b2[1] - a[1]); if (l < 0.1) continue;
        const nx = (b2[1] - a[1]) / l, nz = -(b2[0] - a[0]) / l, mx = (a[0] + b2[0]) / 2, mz = (a[1] + b2[1]) / 2;
        const ca = nearestRoute(mx, mz); if (ca.d < 13) continue;
        const r0 = route[ca.i], sg = ((mx - r0.x) * nx + (mz - r0.z) * nz) > 0 ? 1 : -1;   // コースから離れる側
        const o0 = sg * (pit.w / 2 - 1.3), o1 = sg * (pit.w / 2 - 0.5), y = Math.max(groundHeightAt(mx, mz) + 0.04, r0.y + 0.0) + 0.0;
        const ya = Math.max(groundHeightAt(a[0], a[1]) + 0.04, route[nearestRoute(a[0], a[1]).i].y) - 0.01 + 0.025, yb = Math.max(groundHeightAt(b2[0], b2[1]) + 0.04, route[nearestRoute(b2[0], b2[1]).i].y) - 0.01 + 0.025;
        v.push(a[0] + nx * o0, ya, a[1] + nz * o0, b2[0] + nx * o0, yb, b2[1] + nz * o0, b2[0] + nx * o1, yb, b2[1] + nz * o1, a[0] + nx * o0, ya, a[1] + nz * o0, b2[0] + nx * o1, yb, b2[1] + nz * o1, a[0] + nx * o1, ya, a[1] + nz * o1);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaEdgeLine', color: 0x2f7fd6, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 })); m.name = 'GunmaEdgeLine'; group.add(m);
    }
  }
  // スターティンググリッド: スタートラインの後ろに、左右交互・8m おきに 20 台分の白い枠(コの字)
  {
    const v = [], seg = (i, along0, along1, o0, o1) => {   // コースの点 i から along(m) 進んだ所の、横 o0〜o1 の四角
      const p = route[ring(i)], t = tangents[ring(i)], fx = -t.z, fz = t.x;
      const c = (al, o) => [p.x + fx * al + t.x * o, p.y + 0.03, p.z + fz * al + t.z * o];
      const q0 = c(along0, o0), q1 = c(along1, o0), q2 = c(along1, o1), q3 = c(along0, o1); v.push(...q0, ...q1, ...q2, ...q0, ...q2, ...q3);
    };
    const step = (n > 1 ? Math.hypot(route[1].x - route[0].x, route[1].z - route[0].z) : 3) || 3;
    for (let k = 0; k < 20; k++) {
      const back = 12 + k * 8, i = data.start - Math.round(back / step), side = k % 2 ? -1 : 1, oc = side * 3.4;
      seg(i, 0, 0.2, oc - 1.4, oc + 1.4);                 // 前の横線
      seg(i, -1.2, 0.2, oc - 1.4, oc - 1.25); seg(i, -1.2, 0.2, oc + 1.25, oc + 1.4);   // 両わきの短い縦線
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaEdgeLine', color: 0xf2f2ee, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 })); m.name = 'GunmaEdgeLine'; group.add(m);
  }
  // スタート・フィニッシュの白線(コースの幅いっぱい、幅 1m)
  {
    const p = route[data.start], nn = tangents[data.start], tx = -nn.z, tz = nn.x;
    const geo = new THREE.PlaneGeometry(2 * R, 1); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: 'GunmaEdgeLine', color: 0xf2f2ee }));
    m.position.set(p.x, p.y + 0.03, p.z); m.rotation.y = Math.atan2(tx, tz); m.name = 'GunmaEdgeLine';   // 板の横(x)がコースを横切る向き
    group.add(m);
  }

  // ---- 建物(当たり判定なし。見た目だけなので地図の外に置く) ----
  const scenery = new THREE.Group(); scenery.name = 'fuji-buildings';
  scenery.add(far);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xe4e4e0 }), roofMat = new THREE.MeshLambertMaterial({ color: 0xb8bbbd });
  // ---- 細部の絵(看板・窓)と、壁に貼る板 ----
  const canvasTex = (w, h, draw, rep = true) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (rep) t.wrapS = THREE.RepeatWrapping; t.anisotropy = 4; return t; };
  // 看板の帯: 色と文字の板を並べる(1枚 = uv 1)
  const sponsorTex = (boards, h = 64) => canvasTex(160 * boards.length, h, (x, w) => {
    boards.forEach(([bg, fg, text], k) => { x.fillStyle = bg; x.fillRect(k * 160, 0, 160, h); x.fillStyle = fg; x.font = `bold ${Math.round(h * 0.55)}px Arial, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, k * 160 + 80, h / 2 + 2); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(k * 160 + 158, 0, 2, h); });
  });
  const BOARDS = [['#d71e28', '#ffffff', 'TOYOTA'], ['#1d4f9c', '#ffffff', 'TTDC'], ['#ffffff', '#1d4f9c', 'AISIN'], ['#f2c400', '#1a1a1a', 'DUNLOP'], ['#1d4f9c', '#ffffff', 'SUBARU'], ['#ffffff', '#c8102e', 'DENSO'], ['#0b2f6b', '#ffffff', 'GOODYEAR'], ['#ffffff', '#d71e28', 'FUJI SPEEDWAY']];
  // 線分 a→b に沿った縦の板(y0〜y1)。法線 (nx, nz) へ少し出す。uv の横は len / per
  const panel = (list, uv, a, b, ya, yb, h, per, off = 0.05) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.01) return; const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L, nx = -dz * off, nz = dx * off, u0 = list.u || 0, u1 = u0 + L / per;   // 文字の向き: 外から見て読める向きにするには a→b を外向き法線の左回りに
    list.push(a[0] + nx, ya, a[1] + nz, b[0] + nx, yb, b[1] + nz, b[0] + nx, yb + h, b[1] + nz, a[0] + nx, ya, a[1] + nz, b[0] + nx, yb + h, b[1] + nz, a[0] + nx, ya + h, a[1] + nz);
    uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1); list.u = u1;
  };
  const meshUV = (P, U, tex, extra = {}) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals(); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide, ...extra })); scenery.add(m); return m; };
  const _BX = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const boxInto = (out, cx, cy, cz, sx, sy, sz, ang = 0) => {   // 箱(横 sx・高さ sy・奥 sz、y 軸まわりに ang)を out に足す
    const P = _BX.getAttribute('position').array, N = _BX.getAttribute('normal').array, c = Math.cos(ang), s2 = Math.sin(ang);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i] * sx, y = P[i + 1] * sy, z = P[i + 2] * sz;
      out.p.push(cx + x * c + z * s2, cy + y, cz - x * s2 + z * c); out.n.push(N[i] * c + N[i + 2] * s2, N[i + 1], -N[i] * s2 + N[i + 2] * c);
    }
  };
  // ---- ホームストレートの観客席(グランドスタンド)。コースの側から: 芝生 → 白いガードレール(1.5m)と金網 → 幅2mの通路 → 観客席(コースへ向かって下る段々) ----
  const grandstand = (b, opt = {}) => {
    // 長方形の長い辺のうち、コースに近い方が前
    const q = b.p; let best = null;
    const near = (x, z) => { const k = nearestRoute(x, z); return k.i < 0 ? 1e9 : k.d; };
    for (let k = 0; k < q.length; k++) {
      const A = q[k], B = q[(k + 1) % q.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (!best || L > best.L + 1 || (Math.abs(L - best.L) <= 1 && near((A[0] + B[0]) / 2, (A[1] + B[1]) / 2) < best.d)) best = { A, B, L, d: near((A[0] + B[0]) / 2, (A[1] + B[1]) / 2) };
    }
    const { A, B, L } = best, tx = (B[0] - A[0]) / L, tz = (B[1] - A[1]) / L;
    // 奥行きの向き(コースから離れる向き)と奥行き
    let ox = -tz, oz = tx; const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    if (near(mid[0] + ox * 5, mid[1] + oz * 5) < near(...mid)) { ox = -ox; oz = -oz; }
    let depth = 0; for (const [x, z] of q) depth = Math.max(depth, (x - A[0]) * ox + (z - A[1]) * oz);
    const ang = Math.atan2(tx, tz), gy = (x, z) => groundHeightAt(x, z);
    const y0 = Math.min(gy(A[0], A[1]), gy(B[0], B[1]), gy(mid[0], mid[1]));
    const conc = new THREE.MeshLambertMaterial({ color: 0xb4b5b2 }), seat = new THREE.MeshLambertMaterial({ color: 0xc8cacb }), seat2 = new THREE.MeshLambertMaterial({ color: 0xa9abad });
    const slab = (mat, off, d, h, yb) => {   // 前の辺と平行な、長さ L の箱。off: 前の辺からの奥行きの位置(中心)
      const m = new THREE.Mesh(new THREE.BoxGeometry(d, h, L), mat);
      m.position.set(mid[0] + ox * off, yb + h / 2, mid[1] + oz * off); m.rotation.y = ang + Math.PI / 2 * 0; m.rotation.y = Math.atan2(tx, tz);
      scenery.add(m);
    };
    // 前の壁(高さ 2.5m)、そこから奥へ段々に上がる(1段 奥行き 0.85m・高さ 0.42m)、いちばん奥は背の壁
    const WALL = 2.5, STEP = 0.85, RISE = 0.42, rows = Math.max(4, Math.floor((depth - 1) / STEP));
    slab(conc, 0.4, 0.8, WALL + 0.3, y0);
    const red1 = new THREE.MeshLambertMaterial({ color: 0xb04a44 }), red2 = new THREE.MeshLambertMaterial({ color: 0x9c3d38 });
    for (let k = 0; k < rows; k++) slab(k >= rows * 0.62 ? (k % 2 ? red1 : red2) : (k % 2 ? seat : seat2), 0.8 + (k + 0.5) * STEP, STEP + 0.02, WALL + (k + 1) * RISE, y0);   // 上の方は赤い席
    { // 前の壁に看板の帯(高さ 1m、壁の上の方)
      const P2 = [], U2 = [], a = [A[0] - ox * 0.02, A[1] - oz * 0.02], b2 = [B[0] - ox * 0.02, B[1] - oz * 0.02];
      const flip = ((b2[0] - a[0]) * -oz + (b2[1] - a[1]) * ox) < 0;   // 板の表をコースの側へ
      panel(P2, U2, flip ? b2 : a, flip ? a : b2, y0 + WALL - 1.2, y0 + WALL - 1.2, 1.0, 8, 0.03);
      meshUV(P2, U2, sponsorTex(BOARDS)).name = 'stand-boards';
    }
    slab(conc, 0.8 + rows * STEP + 0.4, 0.8, WALL + rows * RISE + 1.6, y0);   // 背の壁(手すり)
    if (opt.roof) {   // 白いギザギザ(折り板)の屋根: 席の奥半分の上。山は前へとがって少し上がる。奥に柱
      const yT = y0 + WALL + rows * RISE + 7, back = depth + 9, front = depth * 0.5, PITCH = 13, cnt = Math.max(1, Math.round(L / PITCH)), pw = L / cnt, V = [], col = { p: [], n: [] };
      const pt = (s, o, y) => [A[0] + tx * s + ox * o, y, A[1] + tz * s + oz * o], quad = (a, b2, c, d2) => V.push(...a, ...b2, ...c, ...a, ...c, ...d2);
      for (let k = 0; k < cnt; k++) {
        const s0 = k * pw, sm = s0 + pw / 2, s1 = s0 + pw;
        quad(pt(s0, back, yT - 2.6), pt(sm, back, yT), pt(sm, front - 7, yT + 1.6), pt(s0, front, yT - 1.6));
        quad(pt(sm, back, yT), pt(s1, back, yT - 2.6), pt(s1, front, yT - 1.6), pt(sm, front - 7, yT + 1.6));
        V.push(...pt(s0, back, yT - 2.6), ...pt(s1, back, yT - 2.6), ...pt(sm, back, yT));   // 奥の三角の壁
        boxInto(col, ...pt(s0, back - 0.5, (y0 + yT - 2.6) / 2), 0.7, yT - 2.6 - y0, 0.7, ang);
      }
      boxInto(col, ...pt(L, back - 0.5, (y0 + yT - 2.6) / 2), 0.7, yT - 2.6 - y0, 0.7, ang);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(V, 3)); g.computeVertexNormals();
      scenery.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xf2f3f1, emissive: 0x555555, side: THREE.DoubleSide })));
      const cg = new THREE.BufferGeometry(); cg.setAttribute('position', new THREE.Float32BufferAttribute(col.p, 3)); cg.setAttribute('normal', new THREE.Float32BufferAttribute(col.n, 3)); scenery.add(new THREE.Mesh(cg, new THREE.MeshLambertMaterial({ color: 0xc9cbca })));
    }
    if (opt.front === false) return;
    // 前: 通路(2m)・柵・芝生。前の辺に沿って 2m ごと
    const path = [], lawn = [], rail = [], railUv = [], net = [], netUv = [], posts = { p: [], n: [] };
    const quadH = (P, a, b2, ya, yb) => P.push(a[0], ya, a[1], b2[0], yb, b2[1], b2[0], yb, b2[1]);
    const flat = (P, p0, p1, p2, p3) => { const y = (pt) => gy(pt[0], pt[1]) + 0.03; P.push(p0[0], y(p0), p0[1], p1[0], y(p1), p1[1], p2[0], y(p2), p2[1], p0[0], y(p0), p0[1], p2[0], y(p2), p2[1], p3[0], y(p3), p3[1]); };
    const wallQ = (P, U, a, b2, y0a, y0b, h, u0, u1, vmax) => { P.push(a[0], y0a, a[1], b2[0], y0b, b2[1], b2[0], y0b + h, b2[1], a[0], y0a, a[1], b2[0], y0b + h, b2[1], a[0], y0a + h, a[1]); U.push(u0, 0, u1, 0, u1, vmax, u0, 0, u1, vmax, u0, vmax); };
    const FENCE = 2.2;   // 柵は観客席の前から 2.2m 手前(通路 2m)
    for (let s0 = 0; s0 < L - 0.01; s0 += 2) {
      const s1 = Math.min(L, s0 + 2), at = (s, o) => [A[0] + tx * s - ox * o, A[1] + tz * s - oz * o];
      flat(path, at(s0, 0.1), at(s1, 0.1), at(s1, FENCE - 0.1), at(s0, FENCE - 0.1));
      // 芝生: 柵からコースの縁石の外まで
      const reach = (s) => { const pt = at(s, FENCE), k = nearestRoute(...pt); return Math.max(FENCE, FENCE + k.d - (FUJI_ROAD_HALF + 1.25)); };
      flat(lawn, at(s0, FENCE), at(s1, FENCE), at(s1, reach(s1)), at(s0, reach(s0)));
      const fa = at(s0, FENCE), fb = at(s1, FENCE), ya = gy(...fa) - 0.05, yb = gy(...fb) - 0.05;
      wallQ(rail, railUv, fa, fb, ya, yb, 1.5, s0 / 4, s1 / 4, 1);
      wallQ(net, netUv, fa, fb, ya + 1.5, yb + 1.5, 2.6, s0 / 1.2, s1 / 1.2, 2.6 / 1.2);
      if (Math.round(s0) % 4 === 0) { const pg = new THREE.CylinderGeometry(0.05, 0.05, 2.7, 6).toNonIndexed(); pg.translate(fa[0], ya + 1.5 + 1.35, fa[1]); posts.p.push(...pg.getAttribute('position').array); posts.n.push(...pg.getAttribute('normal').array); }
    }
    const mesh = (P, mat, U) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); if (U) g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals(); const m = new THREE.Mesh(g, mat); scenery.add(m); return m; };
    mesh(path, new THREE.MeshLambertMaterial({ color: 0x55575a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    mesh(lawn, new THREE.MeshLambertMaterial({ color: 0x8fb35e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    // 白いガードレール(3段の波板)
    const rc = document.createElement('canvas'); rc.width = 64; rc.height = 64; const r2 = rc.getContext('2d');
    for (let k = 0; k < 3; k++) { const y = k * 21, gr = r2.createLinearGradient(0, y, 0, y + 21); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.45, '#eef0ef'); gr.addColorStop(0.55, '#c9cccb'); gr.addColorStop(1, '#f7f8f7'); r2.fillStyle = gr; r2.fillRect(0, y, 64, 21); }
    const rt = new THREE.CanvasTexture(rc); rt.wrapS = THREE.RepeatWrapping; rt.colorSpace = THREE.SRGBColorSpace;
    mesh(rail, new THREE.MeshLambertMaterial({ map: rt, side: THREE.DoubleSide, emissive: 0x222222 }), railUv).name = 'fuji-guardrail';
    // 金網(ひし形の網目)
    const nc = document.createElement('canvas'); nc.width = 64; nc.height = 64; const n2 = nc.getContext('2d');
    n2.strokeStyle = 'rgba(60,64,66,0.95)'; n2.lineWidth = 1.5;
    for (let k = -64; k < 128; k += 10) { n2.beginPath(); n2.moveTo(k, 0); n2.lineTo(k - 64, 64); n2.stroke(); n2.beginPath(); n2.moveTo(k - 64, 0); n2.lineTo(k, 64); n2.stroke(); }
    const nt = new THREE.CanvasTexture(nc); nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    mesh(net, new THREE.MeshLambertMaterial({ map: nt, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }), netUv).name = 'fuji-catchfence';
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(posts.p, 3)); pg.setAttribute('normal', new THREE.Float32BufferAttribute(posts.n, 3));
    scenery.add(new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: 0x5a5e60 })));
  };
  // ---- ホームストレートの内側(ピット側): 白線の外に幅 2.5m のコースのアスファルト、その外に高さ 1m のコンクリート壁と金網。内側はピットレーン ----
  const pitWall = () => {
    const pit = (data.branches || []).find((b) => b.w <= 9);   // ピットレーン(幅 8m)
    if (!pit) return;
    const PP = pit.pts, distPit = (x, z) => { let best = Infinity; for (let k = 0; k + 1 < PP.length; k++) { const [ax, az] = PP[k], [bx, bz] = PP[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1); best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z)); } return best; };
    const OUT = FUJI_ROAD_HALF + 2.5, half = pit.w / 2;
    // ピットレーンがコースの横を並んで走る所(壁を立てる余地がある所)を、コースの点ごとに調べる
    const on = new Uint8Array(n); let side = 0;
    for (let i = 0; i < n; i++) {
      const p = route[i], t = tangents[i], d0 = distPit(p.x, p.z);
      if (d0 > 40) continue;
      const dl = distPit(p.x + t.x * 12, p.z + t.z * 12), dr = distPit(p.x - t.x * 12, p.z - t.z * 12);
      const sgn = dl < dr ? 1 : -1;   // ピットのある側(左が +)
      if (d0 - half >= OUT + 0.8) { on[i] = 1; side = sgn; }
    }
    if (!side) return;
    const asp = [], wall = [], wallTop = [], net = [], netUv = [], posts = { p: [], n: [] };
    const P = (i, o, dy = 0) => { const p = route[i], t = tangents[i]; return [p.x + t.x * o * side, p.y + dy, p.z + t.z * o * side]; };
    const quad = (arr, a, b, c, d) => arr.push(...a, ...b, ...c, ...a, ...c, ...d);
    let run = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n; if (!on[i] || !on[j]) { run = 0; continue; }
      quad(asp, P(i, FUJI_ROAD_HALF - 0.02, 0.0), P(j, FUJI_ROAD_HALF - 0.02, 0.0), P(j, OUT, 0.0), P(i, OUT, 0.0));   // コースと同じアスファルト
      quad(wall, P(i, OUT, -0.1), P(j, OUT, -0.1), P(j, OUT, 1.0), P(i, OUT, 1.0));                                   // 壁の表
      quad(wall, P(i, OUT + 0.3, -0.1), P(j, OUT + 0.3, -0.1), P(j, OUT + 0.3, 1.0), P(i, OUT + 0.3, 1.0));         // 壁の裏
      quad(wallTop, P(i, OUT, 1.0), P(j, OUT, 1.0), P(j, OUT + 0.3, 1.0), P(i, OUT + 0.3, 1.0));                     // 壁の上
      const a = P(i, OUT + 0.15, 1.0), b2 = P(j, OUT + 0.15, 1.0), l = Math.hypot(b2[0] - a[0], b2[2] - a[2]);
      net.push(a[0], a[1], a[2], b2[0], b2[1], b2[2], b2[0], b2[1] + 2.6, b2[2], a[0], a[1], a[2], b2[0], b2[1] + 2.6, b2[2], a[0], a[1] + 2.6, a[2]);
      netUv.push(run / 1.2, 0, (run + l) / 1.2, 0, (run + l) / 1.2, 2.6 / 1.2, run / 1.2, 0, (run + l) / 1.2, 2.6 / 1.2, run / 1.2, 2.6 / 1.2);
      if (Math.floor(run / 4) !== Math.floor((run + l) / 4) || run === 0) { const pg = new THREE.CylinderGeometry(0.05, 0.05, 2.7, 6).toNonIndexed(); pg.translate(a[0], a[1] + 1.35, a[2]); posts.p.push(...pg.getAttribute('position').array); posts.n.push(...pg.getAttribute('normal').array); }
      run += l;
    }
    const mesh = (arr, mat, uv, parent = scenery) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals(); const m = new THREE.Mesh(g, mat); parent.add(m); return m; };
    mesh(asp, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x47494b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }), null, group).name = 'GunmaRoad';   // 走れる路面
    mesh(wall, new THREE.MeshLambertMaterial({ color: 0xc4c5c2, side: THREE.DoubleSide }));
    { // 壁のコース側の面に看板(赤・青の板)
      const P2 = [], U2 = []; let u = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; if (!on[i] || !on[j]) continue; const a = P(i, OUT - 0.03), b2 = P(j, OUT - 0.03), l = Math.hypot(b2[0] - a[0], b2[2] - a[2]);
        P2.push(a[0], a[1] - 0.05, a[2], b2[0], b2[1] - 0.05, b2[2], b2[0], b2[1] + 0.95, b2[2], a[0], a[1] - 0.05, a[2], b2[0], b2[1] + 0.95, b2[2], a[0], a[1] + 0.95, a[2]);
        const k = side > 0 ? 1 : -1; U2.push(k * u / 10, 0, k * (u + l) / 10, 0, k * (u + l) / 10, 1, k * u / 10, 0, k * (u + l) / 10, 1, k * u / 10, 1); u += l; }   // 文字が裏返らない向き
      meshUV(P2, U2, sponsorTex([['#1d4f9c', '#ffffff', 'TTDC'], ['#d71e28', '#ffffff', 'TOYOTA'], ['#1d4f9c', '#ffffff', 'TTDC'], ['#ffffff', '#d71e28', 'DENSO']])).name = 'pitwall-boards';
    }
    mesh(wallTop, new THREE.MeshLambertMaterial({ color: 0xd2d3d0, side: THREE.DoubleSide }));
    const nc = document.createElement('canvas'); nc.width = 64; nc.height = 64; const n2 = nc.getContext('2d');
    n2.strokeStyle = 'rgba(60,64,66,0.95)'; n2.lineWidth = 1.5;
    for (let k = -64; k < 128; k += 10) { n2.beginPath(); n2.moveTo(k, 0); n2.lineTo(k - 64, 64); n2.stroke(); n2.beginPath(); n2.moveTo(k - 64, 0); n2.lineTo(k, 64); n2.stroke(); }
    const nt = new THREE.CanvasTexture(nc); nt.wrapS = nt.wrapT = THREE.RepeatWrapping;
    mesh(net, new THREE.MeshLambertMaterial({ map: nt, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide }), netUv).name = 'fuji-pitfence';
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(posts.p, 3)); pg.setAttribute('normal', new THREE.Float32BufferAttribute(posts.n, 3));
    scenery.add(new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: 0x5a5e60 })));
  };
  pitWall();
  // ---- パドックのピット棟(白い3階建て)。1階はピットレーンへ向いて、車2台分(幅 5.6m)の開口が並ぶ。
  //      ピットレーンと建物の間は作業スペース(コースより少し薄いグレー) ----
  const pitLane = (data.branches || []).find((b) => b.w <= 9);
  const distPL = (x, z) => { if (!pitLane) return 1e9; const PP = pitLane.pts; let best = 1e9; for (let k = 0; k + 1 < PP.length; k++) { const [ax, az] = PP[k], [bx, bz] = PP[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1); best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z)); } return best; };
  const pitBuilding = (b) => {
    const H = 10.5, y0 = b.y;
    const shape = new THREE.Shape(b.p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, [new THREE.MeshLambertMaterial({ color: 0xe6e7e6 }), new THREE.MeshLambertMaterial({ color: 0xf4f4f2, emissive: 0x8c8c8a })]); m.position.y = y0; scenery.add(m);
    // ピットレーンに向いた面: 外周の辺のうち、真ん中がピットレーンに近く、ある程度長い辺
    const q = b.p, open = { p: [], n: [] }, band = { p: [], n: [] }, canopy = { p: [], n: [] }, work = [], facG = { P: [], U: [] }, facS = { P: [], U: [] }, facT = { P: [], U: [] };
    let cx = 0, cz = 0; for (const [x, z] of q) { cx += x / q.length; cz += z / q.length; }
    for (let k = 0; k < q.length; k++) {
      const A = q[k], B = q[(k + 1) % q.length], L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 8) continue;
      const tx = (B[0] - A[0]) / L, tz = (B[1] - A[1]) / L; let nx = -tz, nz = tx;
      const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
      if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }   // 外向き
      if (distPL(mx + nx * 3, mz + nz * 3) > distPL(mx, mz) || distPL(mx, mz) > 30) continue;   // ピットレーンの方を向いた辺だけ
      const ang = Math.atan2(nx, nz), W = 5.6, PITCH = 6.4, cnt = Math.floor((L - 1) / PITCH), s0 = (L - cnt * PITCH) / 2;
      for (let j = 0; j < cnt; j++) {   // 開口(暗い奥)
        const s = s0 + (j + 0.5) * PITCH;
        boxInto(open, A[0] + tx * s + nx * 0.03, y0 + 1.7, A[1] + tz * s + nz * 0.03, W, 3.4, 0.06, ang);
      }
      boxInto(band, mx + nx * 0.04, y0 + 3.6, mz + nz * 0.04, L, 0.25, 0.06, ang);
      boxInto(canopy, mx + nx * 2.2, y0 + H + 0.9, mz + nz * 2.2, L + 4, 0.5, 9, ang);   // 大きく張り出したグレーの屋根   // 1階と2階の間の帯
      // 外向きの面に、2階のガラス窓・3階のテラス(柱と手すり)・3階の下の看板の帯
      const fa = [A[0] + nx * 0.08, A[1] + nz * 0.08], fb = [B[0] + nx * 0.08, B[1] + nz * 0.08];   // 壁の外へ 8cm
      panel(facG.P, facG.U, fa, fb, y0 + 4.2, y0 + 4.2, 2.6, 4, 0);
      panel(facS.P, facS.U, fa, fb, y0 + 6.95, y0 + 6.95, 0.75, 9, 0);
      panel(facT.P, facT.U, fa, fb, y0 + 7.8, y0 + 7.8, 2.4, 6, 0);
      // 作業スペース: 建物の前からピットレーンの端まで、2m ごと
      for (let s = 0; s < L - 0.01; s += 2) {
        const e = Math.min(L, s + 2), p0 = [A[0] + tx * s, A[1] + tz * s], p1 = [A[0] + tx * e, A[1] + tz * e];
        const reach = (pt) => Math.max(0, distPL(...pt) - pitLane.w / 2 + 0.3);
        const r0 = reach(p0), r1 = reach(p1), a2 = [p0[0] + nx * r0, p0[1] + nz * r0], b2 = [p1[0] + nx * r1, p1[1] + nz * r1];
        const yy = (pt) => Math.max(groundHeightAt(...pt) + 0.03, y0 + 0.02);
        work.push(p0[0], yy(p0), p0[1], p1[0], yy(p1), p1[1], b2[0], yy(b2), b2[1], p0[0], yy(p0), p0[1], b2[0], yy(b2), b2[1], a2[0], yy(a2), a2[1]);
      }
    }
    const mk = (o, color) => { if (!o.p.length) return; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3)); scenery.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }))); };
    mk(open, 0x2c2e31); mk(band, 0xd0d1d0); mk(canopy, 0xa9acae);
    // 2階: 濃い色のガラスと細い窓枠(4m ごと)。3階: 明るい窓と太い柱(6m ごと)
    if (facG.P.length) meshUV(facG.P, facG.U, canvasTex(128, 64, (x, w, h) => { x.fillStyle = '#3c4650'; x.fillRect(0, 0, w, h); x.fillStyle = '#5a6672'; x.fillRect(0, 0, w, 10); x.fillStyle = '#d9dbdb'; x.fillRect(0, 0, 6, h); x.fillRect(0, h - 5, w, 5); x.fillRect(62, 0, 3, h); }));
    if (facS.P.length) meshUV(facS.P, facS.U, sponsorTex(BOARDS.slice(0, 4)));
    if (facT.P.length) meshUV(facT.P, facT.U, canvasTex(128, 64, (x, w, h) => { x.fillStyle = '#9aa7b0'; x.fillRect(0, 0, w, h); x.fillStyle = '#e8e9e8'; x.fillRect(0, 0, 16, h); x.fillRect(0, 0, w, 8); x.fillStyle = '#c9cccc'; x.fillRect(0, h - 22, w, 4); x.fillStyle = '#6f7a82'; for (let k = 24; k < w; k += 18) x.fillRect(k, 14, 2, h - 30); }));
    if (work.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(work, 3)); g.computeVertexNormals(); const wm = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaShoulder', color: 0x6a6c6f, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 })); wm.name = 'pit-work-area'; scenery.add(wm); }
  };
  // ---- コントロールセンター(DENSO の建物): グレーの5階建て、窓の帯、屋上に赤い看板 ----
  const controlCentre = (b) => {
    const H = 19, y0 = b.y, q = b.p, shape = new THREE.Shape(q.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, [new THREE.MeshLambertMaterial({ color: 0x9a9da0 }), new THREE.MeshLambertMaterial({ color: 0xc4c7c9, emissive: 0x333333 })]); m.position.y = y0; scenery.add(m);
    let cx = 0, cz = 0; for (const [x, z] of q) { cx += x / q.length; cz += z / q.length; }
    const win = { P: [], U: [] }, sign = { P: [], U: [] };
    for (let k = 0; k < q.length; k++) {
      let A = q[k], B = q[(k + 1) % q.length]; const L = Math.hypot(B[0] - A[0], B[1] - A[1]); if (L < 4) continue;
      let nx = -(B[1] - A[1]) / L, nz = (B[0] - A[0]) / L;
      if (((A[0] + B[0]) / 2 - cx) * nx + ((A[1] + B[1]) / 2 - cz) * nz < 0) { nx = -nx; nz = -nz; [A, B] = [B, A]; }   // 外向き。板の表(a→b の左)が外
      const fa = [A[0] + nx * 0.08, A[1] + nz * 0.08], fb = [B[0] + nx * 0.08, B[1] + nz * 0.08];
      win.P.u = 0; panel(win.P, win.U, fa, fb, y0 + 3.5, y0 + 3.5, 14, 6, 0);
      sign.P.u = 0; panel(sign.P, sign.U, fa, fb, y0 + H, y0 + H, 2.6, L / Math.max(1, Math.round(L / 14)), 0);
    }
    const wt = canvasTex(64, 256, (x, w, h) => { x.fillStyle = '#c4c7c9'; x.fillRect(0, 0, w, h); x.fillStyle = '#39434d'; for (let f = 0; f < 4; f++) x.fillRect(3, 14 + f * 64, w - 6, 34); });
    meshUV(win.P, win.U, wt); meshUV(sign.P, sign.U, sponsorTex([['#d71e28', '#ffffff', 'DENSO']]), { emissive: 0x220000 });
  };
  // ---- ピット出口の横の高いタワー(格子の塔に色の板)と、ホームストレートの監視小屋 ----
  {
    const o = { p: [], n: [] }, add = (out, ...a) => boxInto(out, ...a);
    const cols = {}, put = (color, ...a) => boxInto(cols[color] || (cols[color] = { p: [], n: [] }), ...a);
    const cv = (data.chevrons || [])[0];
    if (cv) {
      let cx = 0, cz = 0; for (const [x, z] of cv.p) { cx += x / cv.p.length; cz += z / cv.p.length; }
      const k = nearestRoute(cx, cz), rp = route[k.i]; let dx = cx - rp.x, dz = cz - rp.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      let dist = l + 14; while (dist < l + 60 && distPL(rp.x + dx * dist, rp.z + dz * dist) < 9) dist += 2;
      const tx = rp.x + dx * (dist + 3), tz = rp.z + dz * (dist + 3), gy0 = groundHeightAt(tx, tz), ang = Math.atan2(cv.dir[0], cv.dir[1]);
      put(0x4a4f54, tx, gy0 + 21, tz, 3.4, 42, 3.4, ang);                                   // 塔
      [[0x1d4fb0, 39.5, 5], [0x4a4f54, 35, 4], [0xd71e28, 30.5, 3.4], [0xf2f2f0, 25.5, 6.2], [0x15803d, 20.8, 2.6]].forEach(([c, y, h]) => put(c, tx, gy0 + y, tz, 4.4, h, 4.4, ang));
    }
    // 監視小屋: ゴールの橋の手前、ピット側の壁ぎわ。柱の上にグレーの箱と赤い屋根
    for (const i of [1296, 1386]) {
      const p = route[ring(i)], t = tangents[ring(i)], sg = distPL(p.x + t.x * 12, p.z + t.z * 12) < distPL(p.x - t.x * 12, p.z - t.z * 12) ? 1 : -1;
      const x = p.x + t.x * sg * (R + 4.6), z = p.z + t.z * sg * (R + 4.6), ang = Math.atan2(-t.z, t.x);
      put(0x8a8e90, x, p.y + 1.5, z, 0.5, 3, 0.5, ang); put(0xc9cccd, x, p.y + 4.2, z, 2.6, 2.4, 2.6, ang); put(0x39434d, x, p.y + 4.5, z, 2.7, 1.0, 2.7, ang); put(0xa0303a, x, p.y + 5.55, z, 3.2, 0.3, 3.2, ang);
    }
    for (const [c, g0] of Object.entries(cols)) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(g0.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(g0.n, 3)); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: Number(c), emissive: Number(c) === 0xf2f2f0 ? 0x444444 : 0 })); m.name = 'fuji-tower'; scenery.add(m); }
  }
  for (const b of data.buildings) {
    if (b.name === 'グランドスタンド') { grandstand(b, { roof: true }); continue; }
    if (b.kind === 'stand') { grandstand(b, { front: false }); continue; }
    if (/^ピットビル/.test(b.name || '')) { pitBuilding(b); continue; }
    if (b.name === 'コントロールセンター') { controlCentre(b); continue; }
    const shape = new THREE.Shape(b.p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const depth = b.roof ? 0.6 : b.h;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, [roofMat, wallMat]);
    m.position.y = b.roof ? b.y + b.h - 0.6 : b.y;
    scenery.add(m);
  }

  // ---- コースの両側の柵: 白いガードレール(高さ 1m、3段の波板)の上に金網(2m)。見た目だけ(当たり判定なし) ----
  if (data.fences) {
    const rail = [], railU = [], net = [], netU = [], posts = { p: [], n: [] };
    for (const line of data.fences) { let u = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const a = line[k], b = line[k + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]), ya = groundHeightAt(a[0], a[1]) - 0.1, yb = groundHeightAt(b[0], b[1]) - 0.1;
        const q = (P, U, y0, h, per) => { P.push(a[0], ya + y0, a[1], b[0], yb + y0, b[1], b[0], yb + y0 + h, b[1], a[0], ya + y0, a[1], b[0], yb + y0 + h, b[1], a[0], ya + y0 + h, a[1]); U.push(u / per, 0, (u + l) / per, 0, (u + l) / per, h / per, u / per, 0, (u + l) / per, h / per, u / per, h / per); };
        q(rail, railU, 0, 1.1, 1.1);
        // 金網はガードレールの後ろ(コースの外側へ 1.5m)。地面から高さ 3m
        let ox = -(b[1] - a[1]) / (l || 1) * 1.5, oz = (b[0] - a[0]) / (l || 1) * 1.5;
        if (nearestRoute(a[0] + ox, a[1] + oz).d < nearestRoute(a[0] - ox, a[1] - oz).d) { ox = -ox; oz = -oz; }
        const a2 = [a[0] + ox, a[1] + oz], b2 = [b[0] + ox, b[1] + oz], y2a = groundHeightAt(a2[0], a2[1]) - 0.1, y2b = groundHeightAt(b2[0], b2[1]) - 0.1, hN = 3.0;
        net.push(a2[0], y2a, a2[1], b2[0], y2b, b2[1], b2[0], y2b + hN, b2[1], a2[0], y2a, a2[1], b2[0], y2b + hN, b2[1], a2[0], y2a + hN, a2[1]);
        netU.push(u / 1.2, 0, (u + l) / 1.2, 0, (u + l) / 1.2, hN / 1.2, u / 1.2, 0, (u + l) / 1.2, hN / 1.2, u / 1.2, hN / 1.2);
        if (k % 2 === 0) boxInto(posts, a2[0], y2a + hN / 2, a2[1], 0.1, hN, 0.1);
        u += l;
      } }
    const rt = canvasTex(64, 64, (x) => { for (let k = 0; k < 3; k++) { const y = k * 21.4, gr = x.createLinearGradient(0, y, 0, y + 21.4); gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.45, '#eef0ef'); gr.addColorStop(0.55, '#c3c7c6'); gr.addColorStop(1, '#f7f8f7'); x.fillStyle = gr; x.fillRect(0, y, 64, 21.4); } });
    meshUV(rail, railU, rt, { emissive: 0x8a8a8a }).name = 'fuji-fence-rail';   // 白く見えるように明るく
    // 柵の切れ目(出入口)の印: 柵の端にオレンジ赤のブロック(長さ 2.5m)
    const mark = { p: [], n: [] };
    for (const line of data.fences) for (const [e, f] of [[line[0], line[1]], [line[line.length - 1], line[line.length - 2]]]) {
      const l = Math.hypot(f[0] - e[0], f[1] - e[1]) || 1, dx = (f[0] - e[0]) / l, dz = (f[1] - e[1]) / l;
      boxInto(mark, e[0] + dx * 1.25, groundHeightAt(e[0], e[1]) + 0.55, e[1] + dz * 1.25, 2.5, 1.2, 0.6, Math.atan2(-dz, dx));
    }
    const mg = new THREE.BufferGeometry(); mg.setAttribute('position', new THREE.Float32BufferAttribute(mark.p, 3)); mg.setAttribute('normal', new THREE.Float32BufferAttribute(mark.n, 3)); scenery.add(new THREE.Mesh(mg, new THREE.MeshLambertMaterial({ color: 0xe8552a, emissive: 0x401000 })));
    const nt = canvasTex(64, 64, (x) => { x.strokeStyle = 'rgba(70,74,76,0.95)'; x.lineWidth = 1.5; for (let k = -64; k < 128; k += 10) { x.beginPath(); x.moveTo(k, 0); x.lineTo(k - 64, 64); x.stroke(); x.beginPath(); x.moveTo(k - 64, 0); x.lineTo(k, 64); x.stroke(); } }); nt.wrapT = THREE.RepeatWrapping;
    meshUV(net, netU, nt, { transparent: true, alphaTest: 0.3 }).name = 'fuji-fence-net';
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(posts.p, 3)); pg.setAttribute('normal', new THREE.Float32BufferAttribute(posts.n, 3)); scenery.add(new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: 0x8a8e90 })));
  }
  // ---- 森の木(湘南と同じ 2D の木。コースの近くは1本ずつ、奥は大きな塊)と、駐車場の車(色いろいろの箱) ----
  if (data.trees) for (const m of treeBillboards(data.trees.map(([x, z, sz]) => [x, groundHeightAt(x, z) - 0.3, z, sz]), 'fuji-trees')) scenery.add(m);
  if (data.cars && data.cars.length) {
    const PAL = [0xf4f4f2, 0xf4f4f2, 0xc9ccce, 0xc9ccce, 0x2a2c2f, 0x2a2c2f, 0x7d8286, 0xc8232c, 0x1f4fa8, 0x2b7a4b, 0xe0b020, 0x8a5a2b, 0x5aa0d8];
    const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1.75, 0.85, 4.3), new THREE.MeshLambertMaterial({ color: 0xffffff }), data.cars.length);
    const cab = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.6, 2.3), new THREE.MeshLambertMaterial({ color: 0x30363c }), data.cars.length);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P3 = new THREE.Vector3(), S1 = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
    data.cars.forEach(([x, z, deg], i) => {
      const y = groundHeightAt(x, z), k = Math.abs(Math.round(x * 7.3 + z * 3.1 + i * 5)) % PAL.length, tall = (i * 7) % 5 === 0 ? 1.25 : 1;
      Q.setFromAxisAngle(Y, deg * Math.PI / 180);
      body.setMatrixAt(i, M.compose(P3.set(x, y + 0.6, z), Q, S1.set(1, tall, 1))); body.setColorAt(i, C.setHex(PAL[k]));
      cab.setMatrixAt(i, M.compose(P3.set(x, y + 0.6 + 0.425 * tall + 0.3, z), Q, S1.set(1, 1, tall > 1 ? 1.4 : 1)));
    });
    body.frustumCulled = cab.frustumCulled = false; body.name = cab.name = 'fuji-parked-cars'; scenery.add(body, cab);
  }
  // ---- 遠景: 富士山(ほぼ真西・わずかに南 = ホームストレートを逆にたどった最終コーナーの方向。緯度経度から。実際は約 20km 先なので、近くに小さく置いて同じ見え方にする)と、まわりの山並み(適当) ----
  {
    const D = 5600, bx = -0.998 * D, bz = 0.068 * D, prof = [[0, 900], [110, 892], [260, 800], [520, 640], [900, 470], [1500, 300], [2300, 160], [3300, 60], [4200, 0]];
    const P = [], C = [], FP = [], FU = [], SEG = 96, col = (y, a) => { const snow = 640 + 70 * Math.sin(a * 7) + 40 * Math.sin(a * 13 + 1); return y > snow ? [0.97, 0.97, 0.98] : y > 330 ? [0.42, 0.44, 0.60] : y > 120 ? [0.36, 0.48, 0.52] : [0.22, 0.44, 0.24]; };
    for (let k = 0; k + 1 < prof.length; k++) for (let j = 0; j < SEG; j++) {
      const a0 = j / SEG * Math.PI * 2 + Math.PI, a1 = (j + 1) / SEG * Math.PI * 2 + Math.PI, [r0, y0] = prof[k], [r1, y1] = prof[k + 1];   // つなぎ目は見えない西側
      const v = (r, y, a) => [bx + Math.cos(a) * r, y - 60, bz + Math.sin(a) * r];
      for (const [r, y, a] of [[r0, y0, a0], [r1, y1, a0], [r1, y1, a1], [r0, y0, a0], [r1, y1, a1], [r0, y0, a1]]) { FP.push(...v(r, y, a)); FU.push(a, y); }
    }
    { // 富士山だけ写実風: 暗めの青い山肌、谷すじに沿って細かく入り組む雪、すそのもや
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(FP, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(FU, 2));
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ side: THREE.DoubleSide, fog: false,
        vertexShader: 'varying vec2 vU; void main() { vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `varying vec2 vU;
          float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float ns(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
          float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * ns(p); p = p * 2.03 + 7.1; a *= 0.5; } return v; }
          void main() {
            float a = vU.x, h = vU.y;
            float gul = fbm(vec2(a * 13.0, h * 0.0045));                    // 谷すじ(上下に長い)
            float fine = fbm(vec2(a * 48.0, h * 0.02));                   // 細かい岩と雪のまだら
            float ridge = abs(fbm(vec2(a * 9.0, h * 0.004 + 3.0)) - 0.5) * 2.0;
            float line = 330.0 + 120.0 * (fbm(vec2(a * 6.0, 1.7)) - 0.5);   // 雪の下の端(方角でゆれる)
            float sv = h + (gul - 0.5) * 330.0 + (fine - 0.5) * 110.0;       // 谷には雪が下まで残る
            float snow = smoothstep(line - 14.0, line + 14.0, sv);
            snow *= 1.0 - smoothstep(0.44, 0.34, fine + (h - 480.0) * 0.0009) * 0.85;   // 雪の中に岩が顔を出す
            float lit = 0.5 + 0.5 * cos(a - 6.1);                            // 南東から日が当たる
            float shade = clamp(0.35 + 0.65 * lit + (gul - 0.5) * 0.9 + (ridge - 0.5) * 0.35, 0.0, 1.0);
            vec3 snowC = mix(vec3(0.50, 0.60, 0.86), vec3(1.0, 1.0, 1.0), shade);
            vec3 rock = mix(vec3(0.055, 0.085, 0.22), vec3(0.13, 0.18, 0.38), clamp(0.25 + 0.6 * lit + (fine - 0.5) * 0.7 + (gul - 0.5) * 0.5, 0.0, 1.0));
            vec3 c = mix(rock, snowC, snow);
            c = mix(c, vec3(0.34, 0.45, 0.70), 0.22);                         // 遠くの青み
            float haze = smoothstep(380.0, 40.0, h + (fbm(vec2(a * 9.0, 0.3)) - 0.5) * 90.0);
            c = mix(c, vec3(0.70, 0.79, 0.90), haze * 0.92);                  // すそのもや
            gl_FragColor = vec4(c, 1.0);
          }` }));
      m.name = 'fuji-san'; m.frustumCulled = false; scenery.add(m);
    }
    // 山並み: 半径 5.2km の輪。高さは波の重ね合わせ(北と西が高い)
    const RR = 5200, N2 = 180, hh = (a) => 150 + 110 * Math.sin(a * 3 + 1) + 70 * Math.sin(a * 7 + 2) + 40 * Math.sin(a * 17) + 120 * Math.max(0, -Math.sin(a));
    for (let j = 0; j < N2; j++) {
      const a0 = j / N2 * Math.PI * 2, a1 = (j + 1) / N2 * Math.PI * 2, q = (a, y, r = RR) => [Math.cos(a) * r, y, Math.sin(a) * r];
      for (const pt of [q(a0, -80), q(a1, -80), q(a1, hh(a1), RR + 500), q(a0, -80), q(a1, hh(a1), RR + 500), q(a0, hh(a0), RR + 500)]) { P.push(...pt); C.push(0.50, 0.57, 0.54); }   // もやの向こう: 淡いグレーに少し緑
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })); m.name = 'fuji-mountains'; scenery.add(m);
  }
  // ---- コースをまたぐ看板の橋: 支柱1本から腕がのびるL字(side 0 は両側に支柱)。[コースの点, 文字, 支柱の側] ----
  {
    const fr = { p: [], n: [] }, signT = (text, bg = '#1d2f6b', fg = '#ffffff') => canvasTex(512, 64, (x, w, h) => { x.fillStyle = bg; x.fillRect(0, 0, w, h); x.fillStyle = fg; x.font = 'bold 40px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, w / 2, h / 2 + 2, w - 24); }, false);
    const BG = ['#b4141e', '#1d2f6b', '#f2c400', '#d71e28', '#111111', '#1d4f9c', '#1d2f6b', '#d71e28'];
    (data.gantries || []).forEach(([i, text, side, bg0], gi) => {
      const p = route[ring(i)], t = tangents[ring(i)], ang = Math.atan2(-t.z, t.x), OUT = R + 3.5, Hc = 6.2, BH = 1.7;
      const o0 = side > 0 ? -R - 0.5 : -OUT, o1 = side < 0 ? R + 0.5 : OUT, len = o1 - o0, oc = (o0 + o1) / 2, at = (o) => [p.x + t.x * o, p.z + t.z * o];
      for (const o of side === 0 ? [-OUT, OUT] : [side * OUT]) { const [x, z] = at(o), gy0 = Math.min(groundHeightAt(x, z), p.y) - 0.3; boxInto(fr, x, (gy0 + p.y + Hc + BH) / 2, z, 0.9, p.y + Hc + BH - gy0, 0.9, ang); }
      const [cx, cz] = at(oc); boxInto(fr, cx, p.y + Hc + BH / 2, cz, len, BH, 0.7, ang);
      const bgc = bg0 || BG[gi % BG.length], tex = signT(text, bgc, bgc === '#f2c400' ? '#111111' : '#ffffff'), sw = side === 0 ? len - 1.2 : Math.min(len - 2, 16);
      for (const k of [0, 1]) { const a = ang + k * Math.PI, m = new THREE.Mesh(new THREE.PlaneGeometry(sw, BH - 0.2), new THREE.MeshLambertMaterial({ map: tex, emissive: 0x222222 })); m.rotation.y = a; m.position.set(cx + Math.sin(a) * 0.37, p.y + Hc + BH / 2, cz + Math.cos(a) * 0.37); scenery.add(m); }
    });
    if (fr.p.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(fr.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(fr.n, 3)); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0xd9dadb })); m.name = 'fuji-gantries'; scenery.add(m); }
  }
  // ---- 地面に貼る絵: 範囲(x0〜x1, z0〜z1)を 1m 升目の板にして地面の高さに沿わせ、絵(1m = 8画素、透明の所は抜く)を貼る。
  //      draw(ctx): 地図の座標 (x, z) のまま描ける ----
  const groundDecal = (x0, x1, z0, z1, draw, name) => {
    x0 = Math.floor(x0) - 1; z0 = Math.floor(z0) - 1; x1 = Math.ceil(x1) + 1; z1 = Math.ceil(z1) + 1;
    const PX = 8, tex = canvasTex((x1 - x0) * PX, (z1 - z0) * PX, (c) => { c.setTransform(PX, 0, 0, PX, -x0 * PX, -z0 * PX); draw(c); }, false);
    const P = [], U = [], yy = (x, z) => { const k = nearestRoute(x, z); return Math.max(groundHeightAt(x, z), k.i >= 0 && k.d < R + 3 ? route[k.i].y : -1e9) + 0.045; };
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++)
      for (const [a, b2] of [[x, z], [x, z + 1], [x + 1, z + 1], [x, z], [x + 1, z + 1], [x + 1, z]]) { P.push(a, yy(a, b2), b2); U.push((a - x0) / (x1 - x0), 1 - (b2 - z0) / (z1 - z0)); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 })); m.name = name; scenery.add(m);
  };
  // ピット出入口の赤白の縞(V字)。p: 外形、dir: 縞の向き(V の開く向き)
  for (const cv of data.chevrons || []) {
    const q = cv.p, [dx, dz] = cv.dir, xs = q.map((v) => v[0]), zs = q.map((v) => v[1]);
    const al = q.map(([x, z]) => x * dx + z * dz), ac = q.map(([x, z]) => -x * dz + z * dx), mid = (Math.min(...ac) + Math.max(...ac)) / 2, Wd = (Math.max(...ac) - Math.min(...ac)) / 2 + 1, PER = Wd > 6 ? 5 : 3, TH = PER * 0.62;
    groundDecal(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), (c) => {
      c.beginPath(); q.forEach(([x, z], k) => (k ? c.lineTo(x, z) : c.moveTo(x, z))); c.closePath(); c.clip();
      c.fillStyle = '#f5f5f2'; c.fill();
      c.transform(dx, dz, -dz, dx, 0, 0);   // ここから (沿う向き, 横)
      c.fillStyle = '#cd3237';
      for (let b0 = Math.floor((Math.min(...al) - Wd) / PER) * PER; b0 < Math.max(...al) + PER; b0 += PER) {
        c.beginPath(); c.moveTo(b0, mid); c.lineTo(b0 + Wd, mid + Wd); c.lineTo(b0 + Wd + TH, mid + Wd); c.lineTo(b0 + TH, mid); c.lineTo(b0 + Wd + TH, mid - Wd); c.lineTo(b0 + Wd, mid - Wd); c.closePath(); c.fill();
      }
    }, 'fuji-chevron');
  }
  // 路面の看板ペイント
  for (const [i, o, len, wid, bg, fg, text] of data.decals || []) {
    const p = route[ring(i)], t = tangents[ring(i)], fx = -t.z, fz = t.x, cx = p.x + t.x * o, cz = p.z + t.z * o, r = Math.hypot(len, wid) / 2;
    groundDecal(cx - r, cx + r, cz - r, cz + r, (c) => {
      c.transform(fx, fz, -fz, fx, cx, cz); c.fillStyle = bg; c.fillRect(-len / 2, -wid / 2, len, wid);
      c.fillStyle = fg; c.font = `bold ${wid * 0.5}px Arial, sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 0, wid * 0.03, len - 2);
    }, 'fuji-decal');
  }

  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ ? -Infinity : groundHeightAt(x, z));
  const climb = Math.max(...route.map((p) => p.y)) - Math.min(...route.map((p) => p.y));
  const startPoint = route[data.start], startNext = route[ring(data.start + 1)];
  const start = { x: startPoint.x, z: startPoint.z, heading: Math.atan2(startNext.x - startPoint.x, startNext.z - startPoint.z) };
  return { group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb, start,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
