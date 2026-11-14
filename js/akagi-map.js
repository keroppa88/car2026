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
  // ---- 塗って決めた場所(tools/akagi/apply_top_paint.py): 草原(木なし)・草むら(木なし)・駐車場(平らな舗装)・トイレ ----
  const region = (pts) => { const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]); return { pts, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }; };
  const inPoly = (P, x, z) => {
    if (x < P.x0 || x > P.x1 || z < P.z0 || z > P.z1) return false;
    let c = false; const q = P.pts;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > z) !== (q[j][1] > z) && x < (q[j][0] - q[i][0]) * (z - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) c = !c;
    return c;
  };
  const edgeDist = (P, x, z) => { let best = Infinity; const q = P.pts;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) { const ax = q[j][0], az = q[j][1], dx = q[i][0] - ax, dz = q[i][1] - az, t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1); best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z)); }
    return best; };
  const meadows = (data.meadows || []).map(region), bushes = (data.bushes || []).map(region), parkings = (data.parkings || []).map(region);
  const inAny = (list, x, z) => list.some((P) => inPoly(P, x, z));
  // 駐車場の角で道から 10m 以内のものは、道の路肩まで寄せる(道と駐車場の間にすき間を作らない)
  for (const P of parkings) {
    P.pts = P.pts.map(([x, z]) => { const r = roadAt(x, z); if (!r || r.d > EDGE + 10 || r.d < 0.01) return [x, z];
      const q = route[r.i], k = (EDGE - 0.2) / r.d; return [q.x + (x - q.x) * k, q.z + (z - q.z) * k]; });
    Object.assign(P, region(P.pts));
  }
  const PARK_DROP = 0.0;       // 駐車場は道路と同じ高さ(地面側に5cmの排水勾配差のみ)
  const PARK_RAMP = 1.5;       // 道路脇から駐車場へつなぐ短いコンクリート接続帯
  for (const P of parkings) {
    let best = null;
    for (const q of P.pts) {
      const r = roadAt(q[0], q[1]);
      if (r && (!best || r.d < best.d)) best = r;
    }
    const roadY = best ? best.y : route[nearestRoute(P.pts[0][0], P.pts[0][1]).i].y;
    P.roadY = roadY;
    P.y = roadY - PARK_DROP;
  }
  const PARK_BLEND = 8;   // 駐車場のまわり 8m で元の地面へなめらかに戻す
  const parkingRampHeight = (P, x, z) => {
    const r = roadAt(x, z);
    if (!r || r.d < EDGE || r.d > EDGE + PARK_RAMP) return null;
    const t = THREE.MathUtils.smoothstep(r.d, EDGE, EDGE + PARK_RAMP);
    return THREE.MathUtils.lerp(r.y - 0.05, P.y - 0.05, t);
  };
  const H = (x, z) => {
    let h = H0(x, z);
    const lg = legsAt(x, z); if (lg.length && lg[0].d <= EDGE) return h;   // 道路面は一切変更しない
    for (const P of parkings) {
      if (x < P.x0 - PARK_BLEND || x > P.x1 + PARK_BLEND || z < P.z0 - PARK_BLEND || z > P.z1 + PARK_BLEND) continue;
      if (inPoly(P, x, z)) return parkingRampHeight(P, x, z) ?? (P.y - 0.05);
      const d = edgeDist(P, x, z); if (d < PARK_BLEND) h = THREE.MathUtils.lerp(P.y - 0.05, h, THREE.MathUtils.smoothstep(d, 0, PARK_BLEND));
    }
    return h;
  };
  const H0 = (x, z) => {
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
  const forest = [0.02, 0.035, 0.015], bush = [0.035, 0.055, 0.02];
  const MEADOW = [0.19, 0.29, 0.085], BUSHY = [0.085, 0.15, 0.04];   // 草原(赤で囲んだ所)、草むら(黄で囲んだ所)   // 道から離れた所: 森の下の暗い影(草は1本ずつ描かず、地面の色だけ)
  for (let iz = 0; iz <= lines; iz++) for (let ix = 0; ix <= cols; ix++) {
    const x = minX + ix * G.cell, z = minZ + iz * G.cell, k = iz * (cols + 1) + ix, legs = legsAt(x, z);
    const d = legs.length ? legs[0].d : 1e9;
    const h = H(x, z) - 6 * (1 - THREE.MathUtils.smoothstep(d, EDGE + STRIP - 8, EDGE + STRIP - 1));
    verts[k * 3] = x; verts[k * 3 + 1] = h; verts[k * 3 + 2] = z;
    const mix = 0.5 + 0.5 * Math.sin(x * 0.021 + Math.sin(z * 0.017) * 2.3) * Math.sin(z * 0.013 - x * 0.007);
    const area = inAny(meadows, x, z) ? MEADOW : inAny(bushes, x, z) ? BUSHY : null;
    for (let c = 0; c < 3; c++) colors[k * 3 + c] = area ? area[c] * (0.92 + 0.16 * mix) : forest[c] + (bush[c] - forest[c]) * mix * 0.7;
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

  // ---- 道の帯: 路面・路肩・センターライン(オレンジの1本線)・外側線(白) ----
  const bands = [
    { name: 'GunmaRoad', from: -R, to: R, y: 0, color: 0x4a4c4e },
    { name: 'GunmaShoulder', from: -R - SHOULDER, to: -R, y: -0.01, color: 0x55575a },
    { name: 'GunmaShoulder', from: R, to: R + SHOULDER, y: -0.01, color: 0x55575a },
    { name: 'GunmaCenterLine', from: -0.075, to: 0.075, y: 0.02, color: 0xc8782c },   // センターライン: オレンジの1本線(幅 15cm)
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
        let px = p.x + nn.x * side * EDGE, pz = p.z + nn.z * side * EDGE, py = p.y - 0.05, prevY = py, stop = false;
        for (let k = 0; k < m; k++) {
          const o = EDGE + OFF[k], x = p.x + nn.x * side * o, z = p.z + nn.z * side * o;
          const legs = legsAt(x, z);
          // ここから先へ進めない所(いちばん近い道の点がこの点ではない = カーブの内側の折り返しや、ほかの道の方が近い所・ほかの道の路面の近く)で止める。
          // 止めたら、その先は前の点に重ねる(地面が道の上へはみ出ない)
          if (k > 0 && !stop && !(legs.length && Math.abs(legs[0].i - i) <= 4 && legs.every((l) => l === legs[0] || l.d > EDGE + 1.5))) stop = true;
          if (k === 0 || !stop) { px = x; pz = z; py = k === 0 ? p.y - 0.05 : H(x, z); }
          v.push(px, py, pz); cutV.push(T(px, pz) - py);
          const slope = k ? (py - prevY) / Math.max(0.3, OFF[k] - OFF[k - 1]) : 0, far = THREE.MathUtils.smoothstep(OFF[k], 2.5, 7);
          let col = grass.map((g, j) => g + (forest[j] - g) * far);
          if (inAny(meadows, px, pz)) col = MEADOW.slice(); else if (inAny(bushes, px, pz)) col = BUSHY.slice();
          prevY = py; c.push(...col);
        }
      }
      // つづら折りの内側では、隣の道の近くまで地面が伸びて三角形が路面へかぶることがある。
      // 四隅と中心が、どの道路の路肩内にも入らない四角形だけを描く。
      const clearOfRoad = (ids) => {
        let x = 0, z = 0;
        for (const id of ids) {
          const px = v[id * 3], pz = v[id * 3 + 2];
          if (nearestRoute(px, pz).d < EDGE - 0.15) return false;
          x += px; z += pz;
        }
        return nearestRoute(x / ids.length, z / ids.length).d >= EDGE - 0.15;
      };
      for (let i = 0; i + 1 < n; i++) for (let k = 0; k + 1 < m; k++) {
        const a2 = base + i * m + k, b2 = a2 + m;
        if (!clearOfRoad([a2, b2, a2 + 1, b2 + 1])) continue;
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
    const nQuad = pos.count / 6, steepQ = new Uint8Array(nQuad), cutQ = new Float32Array(nQuad);
    for (let q = 0; q < nQuad; q++) {
      const t = q * 6, nq = triN(t).add(triN(t + 3)).normalize();
      let cut = 0; for (let j = 0; j < 6; j++) cut += cutA.getX(t + j) / 6;
      cutQ[q] = cut; steepQ[q] = Math.abs(nq.y) < 0.77 && cut > 0.4 ? 1 : 0;
    }
    // 高さ 1m 未満の崖(グレー)は作らない: 横の並び(道の 1 点 × 片側)ごとに、続いた崖の高さを測り、1m 未満なら草・茂みにする
    for (let col0 = 0; col0 < nQuad; col0 += m - 1) {
      for (let k = 0; k < m - 1;) {
        if (!steepQ[col0 + k]) { k++; continue; }
        let k2 = k, lo = Infinity, hi = -Infinity;
        while (k2 < m - 1 && steepQ[col0 + k2]) { for (let j = 0; j < 6; j++) { const y = pos.getY((col0 + k2) * 6 + j); lo = Math.min(lo, y); hi = Math.max(hi, y); } k2++; }
        if (hi - lo < 1) for (let kk = k; kk < k2; kk++) steepQ[col0 + kk] = 0;
        k = k2;
      }
    }
    for (let q = 0; q < nQuad; q++) {
      const t = q * 6, steep = steepQ[q], cut = cutQ[q];
      for (let j = 0; j < 6; j++) {
        if (steep) { const v2 = 0.85 + 0.25 * Math.sin(pos.getX(t + j) * 0.7 + pos.getY(t + j) * 1.3) * Math.sin(pos.getZ(t + j) * 0.5); C.setRGB(rock[0] * v2, rock[1] * v2, rock[2] * v2); }
        else if (cut > 0.4 || cutA.getX(t + j) > 0.4) C.setRGB(0.05, 0.085, 0.03);   // 崖の上のふち・低い切り土: 茂み
        else C.setRGB(col.getX(t + j), col.getY(t + j), col.getZ(t + j));
        col.setXYZ(t + j, C.r, C.g, C.b);
      }
    }
    const mesh = new THREE.Mesh(flat, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', vertexColors: true, side: THREE.DoubleSide }));
    mesh.name = 'akagi-roadside'; scenery.add(mesh);
  }

  // スタート・ゴール位置を示す横断白線は描画しない。

  // ---- ガードレール(白、高さ 0.8m、両側)。見えない壁(高さ 1.2m)で当たり判定 ----
  const railMat = new THREE.MeshLambertMaterial({ name: 'GunmaGuardrail', color: 0xf0f0e8, emissive: 0x303030, side: THREE.DoubleSide });
  const colliders = [];
  // 駐車場の出入口だけを短く開ける。従来の5m判定は駐車場周囲に長い欠落を作っていた。
  const nearParking = (x, z) => parkings.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 1.5);
  // 草原の例外は高所スタートから連続する草原区間だけ。森林・崖側・谷側では植生に関係なく設置する。
  const meadowAtSide = (i, side) => {
    const p = route[i], nn = tangents[i];
    for (let off = EDGE; off <= RAIL + 8; off += 2) {
      if (inAny(meadows, p.x + nn.x * side * off, p.z + nn.z * side * off)) return true;
    }
    return false;
  };
  const startIndex = clampI(data.start ?? 0);
  const startMeadowEnd = [-1, 1].map((side) => {
    let seen = false, dry = 0, end = startIndex - 1;
    for (let i = startIndex; i < n; i++) {
      if (meadowAtSide(i, side)) { seen = true; dry = 0; end = i; }
      else if (seen && ++dry >= 8) break;
    }
    return end;
  });
  const skip = (i, side) => {
    // ガードレールを一律に省略するのは高所スタート直後の草原だけ。
    // ヘアピン外側・直線の崖側/低い側・ゴール付近は通常どおり設置する。
    const sideIndex = side < 0 ? 0 : 1;
    return i <= startMeadowEnd[sideIndex] && meadowAtSide(i, side);
  };
  for (const side of [-1, 1]) {
    const wall = [], panel = [];
    for (let i = 0; i + 1 < n; i++) {
      if (skip(i, side) || skip(i + 1, side)) continue;
      const a = route[i], b = route[i + 1], na = tangents[i], nb = tangents[i + 1];
      const pa = [a.x + na.x * side * RAIL, a.z + na.z * side * RAIL], pb = [b.x + nb.x * side * RAIL, b.z + nb.z * side * RAIL];
      if (nearParking(...pa) || nearParking(...pb)) continue;   // 駐車場の入口(道と駐車場の間)はガードレールなし
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
      if (skip(i, side)) continue;
      const p = route[i], nn = tangents[i];
      if (nearParking(p.x + nn.x * side * RAIL, p.z + nn.z * side * RAIL)) continue;
      posts.setMatrixAt(c++, M.makeTranslation(p.x + nn.x * side * (RAIL + 0.08), p.y + 0.4, p.z + nn.z * side * (RAIL + 0.08)));
    }
    posts.count = c; posts.name = 'GunmaGuardrail'; posts.computeBoundingSphere(); scenery.add(posts);
  }

  // ---- 駐車場舗装。道路側は H() の高さを使ってコンクリート斜面に連続させる ----
  {
    const step = 0.75;
    for (const P of parkings) {
      const v = [], indices = [];
      const x0 = Math.floor(P.x0 / step) * step, z0 = Math.floor(P.z0 / step) * step;
      for (let x = x0; x < P.x1; x += step) for (let z = z0; z < P.z1; z += step) {
        const cx = x + step * 0.5, cz = z + step * 0.5;
        if (!inPoly(P, cx, cz)) continue;
        const base = v.length / 3;
        for (const [px, pz] of [[x,z],[x+step,z],[x,z+step],[x+step,z+step]]) v.push(px, H(px,pz) + 0.02, pz);
        indices.push(base,base+2,base+1, base+1,base+2,base+3);
      }
      if (!v.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.setIndex(indices); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x77797a, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
      m.name = 'akagi-parking'; scenery.add(m);
    }
  }
  // 駐車場の建物・常設駐車車両は配置しない。舗装面と地形接続だけを残す。

  // ---- 森(2D の木)。木陰のある所(akagiGrove。道の木陰の模様と同じ式)は、背の高い木を道のすぐ脇に並べて道にかぶせる。
  //      木陰のない所は、木は道から少し離して、日なたの草むらが見える ----
  {
    let s = 20261114; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const trees = [];
    const noTree = (x, z) => inAny(meadows, x, z) || inAny(bushes, x, z) || parkings.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 4);   // 草原・草むら・駐車場には木を立てない
    const tooSteep = (x, z) => Math.hypot(H(x + 1.5, z) - H(x - 1.5, z), H(x, z + 1.5) - H(x, z - 1.5)) / 3 > Math.tan(70 * Math.PI / 180);   // 70度より急な斜面には木が生えない
    // 道ぞいの木(3m ごとに両側を見る)
    for (let i = 0; i < n; i++) for (const side of [-1, 1]) {
      const p = route[i], nn = tangents[i], g = akagiGrove(p.x, p.z);
      if (rnd() > 0.12 + 0.55 * g) continue;
      const off = g > 0.5 ? RAIL + 1.2 + rnd() * 5 : RAIL + 7 + rnd() * 10;
      const x = p.x + nn.x * side * off + (rnd() - 0.5) * 2, z = p.z + nn.z * side * off + (rnd() - 0.5) * 2;
      const r = roadAt(x, z); if (!r || r.d < RAIL + 1 || T(x, z) - H(x, z) > 0.5 || tooSteep(x, z) || noTree(x, z)) continue;   // 崖(削った面)には立てない
      trees.push([x, groundHeightAt(x, z) - 0.3, z, g > 0.5 ? 15 + rnd() * 7 : 10 + rnd() * 6]);
    }
    // 奥の森(道から 15m〜100m)
    for (let k = 0; k < 30000 && trees.length < 6000; k++) {
      const i = Math.floor(rnd() * n), side = rnd() < 0.5 ? -1 : 1, off = RAIL + 15 + rnd() ** 1.4 * 85, p = route[i], nn = tangents[i];
      const x = p.x + nn.x * side * off + (rnd() - 0.5) * 6, z = p.z + nn.z * side * off + (rnd() - 0.5) * 6;
      const r = roadAt(x, z); if (!r || r.d < RAIL + 10 || tooSteep(x, z) || noTree(x, z)) continue;
      trees.push([x, groundHeightAt(x, z) - 0.3, z, 11 + rnd() * 8]);
    }
    for (const m of treeBillboards(trees, 'akagi-trees')) scenery.add(m);
  }

  // 道(路肩まで)の外: 草地・森(走ると砂煙、速さが落ちる)
  // 木陰の模様をかける強さ(頂点ごと)。草原・草むら・駐車場は木がないので 0
  const shadeMeshes = [ground]; group.traverse((o) => { if (o.isMesh) shadeMeshes.push(o); }); scenery.traverse((o) => { if (o.name === 'akagi-roadside') shadeMeshes.push(o); });
  for (const mesh of shadeMeshes) {
    const pos = mesh.geometry.getAttribute('position'), mask = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) { const x = pos.getX(k), z = pos.getZ(k); mask[k] = inAny(meadows, x, z) || inAny(bushes, x, z) || inAny(parkings, x, z) ? 0 : 1; }
    mesh.geometry.setAttribute('canopyMask', new THREE.BufferAttribute(mask, 1));
  }
  const softGroundAt = (x, z) => { if (parkings.some((P) => inPoly(P, x, z))) return false; const r = roadAt(x, z); return !r || r.d > R + SHOULDER + 0.3; };   // 駐車場は舗装
  const start = data.start ?? 0, goal = data.goal ?? n - 1;
  // 姫百合駐車場側の発進位置: ゴール地点に最も近い駐車場の道路側の縁から、場内へ約3m入った位置。
  const parkingStart = (() => {
    if (!parkings.length) return null;
    const target = route[goal];
    let best = null;
    for (const P of parkings) {
      for (let j = 0; j < P.pts.length; j++) {
        const a = P.pts[j], b = P.pts[(j + 1) % P.pts.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = THREE.MathUtils.clamp(((target.x - a[0]) * dx + (target.z - a[1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        const x = a[0] + dx * t, z = a[1] + dz * t, d = Math.hypot(x - target.x, z - target.z);
        if (!best || d < best.d) best = { P, x, z, d };
      }
    }
    if (!best) return null;
    const cx = best.P.pts.reduce((v, q) => v + q[0], 0) / best.P.pts.length;
    const cz = best.P.pts.reduce((v, q) => v + q[1], 0) / best.P.pts.length;
    const dx = cx - best.x, dz = cz - best.z, len = Math.hypot(dx, dz) || 1;
    let x = best.x, z = best.z;
    for (const step of [0.5, 0.8, 1.2, 1.8, 2.5]) {
      const tx = best.x + dx / len * step, tz = best.z + dz / len * step;
      if (inPoly(best.P, tx, tz)) { x = tx; z = tz; break; }
    }
    return { x, y: best.P.y, z };
  })();
  return { colliders, softGroundAt, group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb: route[0].y - route[n - 1].y, start, goal, parkingStart,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
