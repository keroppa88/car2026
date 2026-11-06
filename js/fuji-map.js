import * as THREE from '../lib/three.module.js';

// 富士スピードウェイ(本コース)。map/fuji-course.json(tools/fuji/make_fuji.py)から組み立てる。
// コースの線は OpenStreetMap、起伏は PLATEAU 小山町の地形、建物は OpenStreetMap。
// 閉じた輪なので、つなぎ目(seam)はずらしなし。
export const FUJI_ROAD_HALF = 7.5;   // 本コースの幅 15m

export function buildFujiMap(data) {
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
  const runLs = smooth(smooth(runL)), runRs = smooth(smooth(runR));
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
  const verts = new Float32Array((cols + 1) * (lines + 1) * 3);
  const colors = new Float32Array(verts.length);
  const grass = [0.20, 0.30, 0.11], dry = [0.30, 0.31, 0.14];
  for (let iz = 0; iz <= lines; iz++) {
    for (let ix = 0; ix <= cols; ix++) {
      const x = minX + ix * G.cell, z = minZ + iz * G.cell, k = iz * (cols + 1) + ix;
      let h = G.h[k] / 10;
      const near = nearestRoute(x, z);
      if (near.i >= 0 && near.d < 90) {
        const ry = route[near.i].y - 0.6, wide = FUJI_ROAD_HALF + 1.2 + Math.max(runLs[near.i], runRs[near.i]);
        const t = THREE.MathUtils.smoothstep(near.d, wide + 4, wide + 30);
        h = THREE.MathUtils.lerp(ry, h, t);
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
      fv.push(x, G.h[Math.min(lines, fz) * (cols + 1) + Math.min(cols, fx)] / 10 - (inside ? 3 : 0.3), z);
      fc.push(grass[0], grass[1], grass[2]);
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
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }));   // 地面は少し奥へ(ランオフに出てこない)
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
  ];
  const runAt = (i, side) => (side < 0 ? runLs : runRs)[ring(extIndices[i])];
  const red = new THREE.Color(0xc0302a), white = new THREE.Color(0xeeeeea);
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
        if (col) { const c = (i % 2) ? red : white; col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b; }
      }
      if (i + 1 < ext.length) ind.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(ind); geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ name: band.name, color: col ? 0xffffff : band.color, vertexColors: !!col, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat); mesh.name = band.name; group.add(mesh);
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
  for (const b of data.buildings) {
    const shape = new THREE.Shape(b.p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const depth = b.roof ? 0.6 : b.h;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, [roofMat, wallMat]);
    m.position.y = b.roof ? b.y + b.h - 0.6 : b.y;
    scenery.add(m);
  }

  const terrainHeightAt = (x, z) => (x < minX || x > maxX || z < minZ || z > maxZ ? -Infinity : groundHeightAt(x, z));
  const climb = Math.max(...route.map((p) => p.y)) - Math.min(...route.map((p) => p.y));
  const startPoint = route[data.start], startNext = route[ring(data.start + 1)];
  const start = { x: startPoint.x, z: startPoint.z, heading: Math.atan2(startNext.x - startPoint.x, startNext.z - startPoint.z) };
  return { group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb, start,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
