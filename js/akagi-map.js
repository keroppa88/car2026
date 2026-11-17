import * as THREE from '../lib/three.module.js';
import { treeBillboards } from './osm-city.js?v=20261117-piers-3';

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
  // ふもと側の終わりに、まっすぐな道を 150m 足す(ループの暗転 2 秒のあいだに道が終わらないように)。向きと下りの傾きは、終わりの 30m と同じ
  {
    const e = route[route.length - 1], q = route[route.length - 11], dx = (e.x - q.x) / 10, dz = (e.z - q.z) / 10, dy = THREE.MathUtils.clamp((e.y - q.y) / 10, -0.2, 0);
    for (let k = 1; k <= 50; k++) route.push(new THREE.Vector3(e.x + dx * k, e.y + dy * k, e.z + dz * k));
  }
  const akagiNightLights = []; // [発光材質, 光だまり]
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
  const routeS = new Float64Array(n);
  for (let i = 1; i < n; i++) routeS[i] = routeS[i - 1] + route[i].distanceTo(route[i - 1]);
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
  // (読み込みを速く: 候補を並べ替えず、近い順に 3 本だけ選ぶ。同じ点を続けて聞かれたら前の答えを返す)
  const candD = new Float64Array(4096), candI = new Int32Array(4096);
  let memoX = NaN, memoZ = NaN, memoLegs = null;
  const legsAt = (x, z) => {
    if (x === memoX && z === memoZ) return memoLegs;
    const bx = Math.floor(x / B), bz = Math.floor(z / B); let m = 0;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const list = bucket.get((bx + a) + ',' + (bz + b)); if (!list) continue;
      for (let k = 0; k < list.length && m < 4096; k++) { const i = list[k], p = route[i], dx = p.x - x, dz = p.z - z; candD[m] = dx * dx + dz * dz; candI[m++] = i; }
    }
    const legs = [];
    while (legs.length < 3) {
      let bi = -1, bd = Infinity;
      for (let k = 0; k < m; k++) {
        if (candD[k] >= bd) continue;
        const i = candI[k]; let near = false;
        for (let q = 0; q < legs.length; q++) if (Math.abs(legs[q].i - i) < 25) { near = true; break; }
        if (!near) { bd = candD[k]; bi = i; }
      }
      if (bi < 0) break;
      const i = bi; let best = null;
      for (let e = 0; e < 2; e++) {
        const a = e ? i : clampI(i - 1), b = e ? clampI(i + 1) : i;
        if (a === b) continue;
        const A = route[a], Bq = route[b], dx = Bq.x - A.x, dz = Bq.z - A.z, t = THREE.MathUtils.clamp(((x - A.x) * dx + (z - A.z) * dz) / (dx * dx + dz * dz || 1), 0, 1), d = Math.hypot(A.x + dx * t - x, A.z + dz * t - z);
        if (!best || d < best.d) best = { d, y: A.y + (Bq.y - A.y) * t, i };
      }
      legs.push(best);
    }
    memoX = x; memoZ = z; memoLegs = legs;
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
  // 姫百合駐車場だけの境界線。道路側を舗装として残し、反対側を森林へ戻す。
  const parkingBoundaryA = [-1560, 1770], parkingBoundaryB = [-1537, 1818];
  const boundarySide = (x, z) => (parkingBoundaryB[0] - parkingBoundaryA[0]) * (z - parkingBoundaryA[1])
    - (parkingBoundaryB[1] - parkingBoundaryA[1]) * (x - parkingBoundaryA[0]);
  const roadSideSign = Math.sign(boundarySide(route[data.goal ?? n - 1].x, route[data.goal ?? n - 1].z)) || -1;
  const clipParkingToRoadSide = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const da = boundarySide(a[0], a[1]) * roadSideSign, db = boundarySide(b[0], b[1]) * roadSideSign;
      const ina = da >= 0, inb = db >= 0;
      if (ina) out.push(a);
      if (ina !== inb) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  for (const P of parkings) { P.pts = clipParkingToRoadSide(P.pts); Object.assign(P, region(P.pts)); }
  // 北側を直線で切る(絵の赤線。おおまかな位置)。線の南側(駐車場のまん中の側)だけ残す
  {
    const A = [-1563.7, 1785.9], B = [-1499.3, 1762.9], sideOf = (x, z) => (B[0] - A[0]) * (z - A[1]) - (B[1] - A[1]) * (x - A[0]), keep = Math.sign(sideOf(-1520, 1795));
    for (const P of parkings) {
      const out = [];
      for (let i = 0; i < P.pts.length; i++) {
        const a = P.pts[i], b = P.pts[(i + 1) % P.pts.length], da = sideOf(a[0], a[1]) * keep, db = sideOf(b[0], b[1]) * keep;
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      if (out.length >= 3) { P.pts = out; Object.assign(P, region(P.pts)); }
    }
  }
  // 既存2棟を撤去し、指定座標に新しい木造トイレを1棟だけ設置。
  const toiletPts = [[-1538.5, 1796]];   // 絵の赤丸の位置
  const inAny = (list, x, z) => list.some((P) => inPoly(P, x, z));
  // 駐車場の角で道から 10m 以内のものは、道の路肩まで寄せる(道と駐車場の間にすき間を作らない)
  for (const P of parkings) {
    P.pts = P.pts.map(([x, z]) => { const r = roadAt(x, z); if (!r || r.d > EDGE + 10 || r.d < 0.01) return [x, z];
      const q = route[r.i], k = (EDGE - 0.2) / r.d; return [q.x + (x - q.x) * k, q.z + (z - q.z) * k]; });
    Object.assign(P, region(P.pts));
  }
  const PARK_DROP = 0;         // 駐車場の高さ = いちばん近い所の道の高さ(そこが出入口のスロープ)
  const PARK_RAMP_ANGLE = 15;
  const PARK_RAMP = PARK_DROP / Math.tan(PARK_RAMP_ANGLE * Math.PI / 180); // 15度の直線スロープ(約0.93m)
  for (const P of parkings) {
    let best = null;
    for (const q of P.pts) {
      const r = roadAt(q[0], q[1]);
      if (r && (!best || r.d < best.d)) best = r;
    }
    const roadY = best ? best.y : route[nearestRoute(P.pts[0][0], P.pts[0][1]).i].y;
    P.roadY = roadY;
    P.y = roadY - PARK_DROP;
    // ゴール(姫百合側)に最も近い道路境界を、駐車場の出入口とする。
    const target = route[data.goal ?? n - 1];
    let entrance = null;
    for (const q of P.pts) {
      const r = roadAt(q[0], q[1]);
      if (!r) continue;
      const d = Math.hypot(q[0] - target.x, q[1] - target.z);
      if (!entrance || d < entrance.d) entrance = { d, s: routeS[r.i] };
    }
    P.rampS = entrance ? entrance.s : routeS[nearestRoute(P.pts[0][0], P.pts[0][1]).i];
    // 出入口: 駐車場が道に接している区間の北の端。駐車場の高さは、そこの道の高さに合わせる(スロープの所で段差なし)
    const touch = [];
    for (let i = 0; i < n; i++) for (const sd of [-1, 1]) if (inPoly(P, route[i].x + tangents[i].x * sd * (EDGE + 0.8), route[i].z + tangents[i].z * sd * (EDGE + 0.8))) { touch.push(i); break; }
    // 絵の赤枠: 接している区間の北の端(下り側の端)。幅 6m ぶんが入るよう、端から 2 点(6m)手前をまん中にする
    if (touch.length) P.touchEnd = touch[touch.length - 1];
    if (touch.length) { const mid = touch[Math.max(0, touch.length - 3)]; P.rampS = routeS[mid]; P.roadY = route[mid].y; P.y = P.roadY - PARK_DROP; }
  }
  const PARK_ENTRANCE_HALF_LENGTH = 3;  // 出入口のスロープの幅は車 2 台ぶん(6m)。それ以外は段差(コンクリートの壁)
  const PARK_MAX_STEP = 0.75; // 姫百合駐車場の黄色指定区間。ここより段差が大きい箇所は閉鎖
  const rampInfo = (P, x, z) => {
    const r = roadAt(x, z);
    if (!r || Math.abs(routeS[r.i] - P.rampS) > PARK_ENTRANCE_HALF_LENGTH) return null;
    // 姫百合駐車場に面した黄色指定区間だけ。反対側・離れた道路は対象外。
    if (edgeDist(P, x, z) > 2.5) return null;
    const rise = Math.abs(r.y - P.y);
    const length = rise / Math.tan(PARK_RAMP_ANGLE * Math.PI / 180);
    return { r, length };
  };
  const nearParkingEntrance = (x, z) => parkings.some((P) => !!rampInfo(P, x, z));
  const PARK_BLEND = 8;   // 駐車場のまわり 8m で元の地面へなめらかに戻す
  const parkingRampHeight = (P, x, z) => {
    const info = rampInfo(P, x, z);
    if (!info || info.length < 0.02 || info.r.d < EDGE || info.r.d > EDGE + info.length) return null;
    // 低い段差だけ、実際の高低差に応じた15度スロープで接続。
    const t = THREE.MathUtils.clamp((info.r.d - EDGE) / info.length, 0, 1);
    return THREE.MathUtils.lerp(info.r.y - 0.05, P.y - 0.05, t);
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
  const nearParking = (x, z) => nearParkingEntrance(x, z);
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
  // 絵で決めたガードレール(tools/akagi/apply_rail_paint.py の railL / railR: 1 = ある、0 = なし、-1 = 絵に写っていない → 従来の決め方)
  const painted = (i, side) => { const f = side > 0 ? data.railL : data.railR; return f ? f[i] : -1; };
  const railAt = (i, side) => {
    const p = route[i], nn = tangents[i];
    // 駐車場の出入口(スロープ、幅 6m)は、絵のガードレールがあっても開ける
    if (parkings.some((P) => Math.abs(routeS[i] - P.rampS) < PARK_ENTRANCE_HALF_LENGTH + 0.5 && inPoly(P, p.x + nn.x * side * (EDGE + 0.8), p.z + nn.z * side * (EDGE + 0.8)))) return false;
    const f = painted(i, side); if (f >= 0) return f === 1;
    return !skip(i, side) && !nearParking(p.x + nn.x * side * RAIL, p.z + nn.z * side * RAIL);
  };
  for (const side of [-1, 1]) {
    const wall = [], panel = [], has = route.map((_, i) => railAt(i, side));
    const railPt = (i, along = 0) => { const p = route[i], nn = tangents[i], fx = -nn.z, fz = nn.x; return [p.x + nn.x * side * RAIL + fx * along, p.y, p.z + nn.z * side * RAIL + fz * along]; };
    const quad = (P, A, Bq, y0, y1) => P.push(A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y0, Bq[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y1, A[2]);
    for (let i = 0; i + 1 < n; i++) {
      if (!has[i] || !has[i + 1]) continue;
      const A = railPt(i), Bq = railPt(i + 1);
      quad(panel, A, Bq, 0.45, 0.8); quad(wall, A, Bq, -0.1, 1.1);
    }
    // 途切れる所は支柱の所。レールは端の支柱から 0.4m だけ先へ出す(写真のように)
    for (let i = 0; i < n; i++) {
      if (!has[i]) continue;
      if (i === 0 || !has[i - 1]) { const A = railPt(i, -0.4), Bq = railPt(i); quad(panel, A, Bq, 0.45, 0.8); quad(wall, A, Bq, -0.1, 1.1); }
      if (i === n - 1 || !has[i + 1]) { const A = railPt(i), Bq = railPt(i, 0.4); quad(panel, A, Bq, 0.45, 0.8); quad(wall, A, Bq, -0.1, 1.1); }
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(panel, 3)); pg.computeVertexNormals();
    const pm = new THREE.Mesh(pg, railMat); pm.name = 'GunmaGuardrail'; scenery.add(pm);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'akagi-guardrail'; scenery.add(wm); colliders.push(wm);
    // 支柱(6m ごと = 偶数の点)。レールの端にも必ず立てる
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), railMat, n + 1), M = new THREE.Matrix4();
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (!has[i]) continue;
      const end = i === 0 || !has[i - 1] || i === n - 1 || !has[i + 1];
      if (i % 2 && !end) continue;
      const p = route[i], nn = tangents[i];
      posts.setMatrixAt(c++, M.makeTranslation(p.x + nn.x * side * (RAIL + 0.08), p.y + 0.4, p.z + nn.z * side * (RAIL + 0.08)));
    }
    posts.count = c; posts.name = 'GunmaGuardrail'; posts.computeBoundingSphere(); scenery.add(posts);
  }

  // ---- 駐車場の舗装: 多角形そのままの平らな板 1 枚(ふちはまっすぐ。升目のギザギザを出さない)。色はコースの路面と同じ ----
  const ROAD_COLOR = 0x4a4c4e;
  for (const P of parkings) {
    const v = [];
    for (const t of THREE.ShapeUtils.triangulateShape(P.pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) for (const k of t) v.push(P.pts[k][0], P.y - 0.03, P.pts[k][1]);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: ROAD_COLOR, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.name = 'akagi-parking'; scenery.add(m);
  }
  // ---- 出入口(スロープ)のつなぎ: 白線の外から駐車場の中 1.6m まで、コースの路面と同じ色の帯で覆う(路肩の色・段・白線の外の継ぎ目を隠す) ----
  {
    const v = [], OFFS = [R - 0.02, EDGE, EDGE + 0.3, EDGE + 0.6, EDGE + 1.0, EDGE + 1.6];
    for (const P of parkings) for (const side of [-1, 1]) {
      const idxs = []; for (let i = 0; i < n; i++) if (Math.abs(routeS[i] - P.rampS) <= PARK_ENTRANCE_HALF_LENGTH + 0.5 && inPoly(P, route[i].x + tangents[i].x * side * (EDGE + 0.8), route[i].z + tangents[i].z * side * (EDGE + 0.8))) idxs.push(i);
      if (idxs.length < 2) continue;
      // 3m おきの点の間を 0.5m に割る
      const row = (i, t) => { const a = route[i], b = route[Math.min(n - 1, i + 1)], na = tangents[i], nb = tangents[Math.min(n - 1, i + 1)];
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t, nx = na.x + (nb.x - na.x) * t, nz = na.z + (nb.z - na.z) * t;
        return OFFS.map((o) => { const px = x + nx * side * o, pz = z + nz * side * o; return [px, (o <= EDGE ? y : Math.max(H(px, pz) + 0.05, o < EDGE + 0.5 ? Math.min(y, P.y) - 0.02 : -1e9)) + 0.03, pz]; }); };
      const rows = []; for (let k = 0; k + 1 < idxs.length; k++) for (let t = 0; t < 6; t++) rows.push(row(idxs[k], t / 6)); rows.push(row(idxs[idxs.length - 1], 0));
      for (let a = 0; a + 1 < rows.length; a++) for (let o = 0; o + 1 < OFFS.length; o++) { const A = rows[a][o], Bq = rows[a + 1][o], C2 = rows[a + 1][o + 1], D2 = rows[a][o + 1]; v.push(...A, ...Bq, ...C2, ...A, ...C2, ...D2); }
    }
    if (v.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: ROAD_COLOR, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
      m.name = 'akagi-parking-apron'; scenery.add(m);
    }
  }
  // ---- 駐車場の車 7 台: 金網の辺に頭を向けて並べる(トイレ・出入口のそばは空ける)。当たり判定あり ----
  {
    let seed = 20261117; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const cars = [];
    for (const P of parkings) {
      let ri = 0; for (let i = 1; i < n; i++) if (Math.abs(routeS[i] - P.rampS) < Math.abs(routeS[ri] - P.rampS)) ri = i;
      const cand = [];
      for (let i = 0, j = P.pts.length - 1; i < P.pts.length; j = i++) {
        const a = P.pts[j], b = P.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 6) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L; let nx = -tz, nz = tx;
        if (!inPoly(P, (a[0] + b[0]) / 2 + nx * 2, (a[1] + b[1]) / 2 + nz * 2)) { nx = -nx; nz = -nz; }   // 内向き
        for (let s2 = 2.2; s2 < L - 2.2; s2 += 2.7) {
          const x = a[0] + tx * s2 + nx * 3.2, z = a[1] + tz * s2 + nz * 3.2, r = roadAt(x, z);
          if (!inPoly(P, x, z) || (r && r.d < EDGE + 9)) continue;                        // 道のそばには置かない
          if (Math.hypot(x - route[ri].x, z - route[ri].z) < 16) continue;                 // 出入口の前は空ける
          if (toiletPts.some(([qx, qz]) => Math.hypot(qx - x, qz - z) < 7)) continue;      // トイレの前は空ける
          let clear = true; for (const o of [1.2, 2.6, 4.2]) if (!inPoly(P, x + nx * o * 0.5 - nx * 2.4, z + nz * o * 0.5 - nz * 2.4)) clear = false;
          if (clear) cand.push([x, z, Math.atan2(-nx, -nz)]);                               // 頭を金網の方へ
        }
      }
      for (let k = cand.length - 1; k > 0; k--) { const q = Math.floor(rnd() * (k + 1)); [cand[k], cand[q]] = [cand[q], cand[k]]; }
      for (const c of cand) { if (cars.length >= 7) break; if (cars.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) > 2.6)) cars.push([...c, P.y]); }
    }
    if (cars.length) {
      const palette = [0xf4f4f2, 0xc9ccce, 0x2a2c2f, 0x7d8286, 0xc8232c, 0x1f4fa8, 0xe0e0d8];
      const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1.75, 0.85, 4.3), new THREE.MeshLambertMaterial({ color: 0xffffff }), cars.length);
      const cab = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 0.6, 2.3), new THREE.MeshLambertMaterial({ color: 0x30363c }), cars.length);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S1 = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
      cars.forEach(([x, z, ang, y], i) => {
        const tall = i === 3 ? 1.18 : 1; Q.setFromAxisAngle(Y, ang);
        body.setMatrixAt(i, M.compose(V.set(x, y + 0.6, z), Q, S1.set(1, tall, 1))); body.setColorAt(i, C.setHex(palette[i % palette.length]));
        cab.setMatrixAt(i, M.compose(V.set(x, y + 1.025 * tall, z), Q, S1.set(1, 1, tall > 1 ? 1.4 : 1)));
        const hit = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.6, 4.3), new THREE.MeshBasicMaterial({ visible: false }));
        hit.position.set(x, y + 0.8, z); hit.rotation.y = ang; hit.name = 'akagi-parked-car-hit'; scenery.add(hit); hit.updateMatrixWorld(); colliders.push(hit);
      });
      body.frustumCulled = cab.frustumCulled = false; body.name = cab.name = 'akagi-parked-cars'; scenery.add(body, cab);
    }
  }
  // ---- 駐車場と道の間の段差: コンクリート色の壁(出入口のスロープの所は除く)。高い側の上面にふたをして、土手の斜面を隠す。当たり判定あり ----
  {
    const v = [], W0 = EDGE + 0.02, W1 = EDGE + 0.45;
    const quad = (a, b, c, d2) => v.push(...a, ...b, ...c, ...a, ...c, ...d2);
    for (const P of parkings) for (const side of [-1, 1]) for (let i = 0; i + 1 < n; i++) {
      const at = (k, off) => [route[k].x + tangents[k].x * side * off, route[k].z + tangents[k].z * side * off];
      const m0 = at(i, EDGE + 0.8), m1 = at(i + 1, EDGE + 0.8);
      if (!inPoly(P, m0[0], m0[1]) || !inPoly(P, m1[0], m1[1])) continue;
      if (Math.abs(routeS[i] - P.rampS) <= PARK_ENTRANCE_HALF_LENGTH && Math.abs(routeS[i + 1] - P.rampS) <= PARK_ENTRANCE_HALF_LENGTH) continue;   // スロープ
      const ya = route[i].y, yb = route[i + 1].y, py = P.y - 0.03;
      const up = (ya + yb) / 2 < py;                 // 駐車場の方が高い → 壁は道ぎわ。道の方が高い → 壁は駐車場ぎわ
      const off = up ? W0 : W1, a = at(i, off), b = at(i + 1, off);
      quad([a[0], Math.min(ya, py) - 0.05, a[1]], [b[0], Math.min(yb, py) - 0.05, b[1]], [b[0], Math.max(yb, py), b[1]], [a[0], Math.max(ya, py), a[1]]);
      const c0 = at(i, W0), c1 = at(i + 1, W0), e0 = at(i, W1), e1 = at(i + 1, W1);   // 上面のふた
      quad([c0[0], Math.max(ya, py), c0[1]], [c1[0], Math.max(yb, py), c1[1]], [e1[0], Math.max(yb, py), e1[1]], [e0[0], Math.max(ya, py), e0[1]]);
    }
    if (v.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: ROAD_COLOR, side: THREE.DoubleSide })); m.name = 'akagi-parking-step';   // 段差もコースの路面と同じ色 scenery.add(m); colliders.push(m);
    }
  }

  // ---- 駐車場の囲い: 道に面した辺は道のガードレール(スロープの所だけ開く)。それ以外の辺は緑の金網(高さ 1.5m、支柱 2m ごと)。当たり判定あり ----
  {
    const net = [], uvs = [], wall = [], postAt = [], HN = 1.5;
    for (const P of parkings) {
      const y = P.y - 0.03;
      for (let i = 0, j = P.pts.length - 1; i < P.pts.length; j = i++) {
        const a = P.pts[j], b = P.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.round(L / 2));
        for (let t = 0; t < k; t++) {
          const p0 = [a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k], p1 = [a[0] + (b[0] - a[0]) * (t + 1) / k, a[1] + (b[1] - a[1]) * (t + 1) / k];
          const r0 = roadAt(p0[0], p0[1]), r1 = roadAt(p1[0], p1[1]);
          if ((r0 && r0.d < EDGE + 2.5) || (r1 && r1.d < EDGE + 2.5)) continue;   // 道に面した所はガードレール
          const l = L / k, u0 = t * l / 0.5, u1 = (t + 1) * l / 0.5;
          net.push(p0[0], y, p0[1], p1[0], y, p1[1], p1[0], y + HN, p1[1], p0[0], y, p0[1], p1[0], y + HN, p1[1], p0[0], y + HN, p0[1]);
          uvs.push(u0, 0, u1, 0, u1, HN / 0.5, u0, 0, u1, HN / 0.5, u0, HN / 0.5);
          wall.push(p0[0], y - 0.2, p0[1], p1[0], y - 0.2, p1[1], p1[0], y + 1.3, p1[1], p0[0], y - 0.2, p0[1], p1[0], y + 1.3, p1[1], p0[0], y + 1.3, p0[1]);
          postAt.push([p0[0], y, p0[1]], [p1[0], y, p1[1]]);
        }
      }
    }
    if (net.length) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64; const cx = cv.getContext('2d');
      cx.strokeStyle = 'rgba(40,120,80,0.95)'; cx.lineWidth = 2.2;
      for (let k = -64; k < 128; k += 16) { cx.beginPath(); cx.moveTo(k, 0); cx.lineTo(k + 64, 64); cx.stroke(); cx.beginPath(); cx.moveTo(k + 64, 0); cx.lineTo(k, 64); cx.stroke(); }
      const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(net, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, emissive: 0x0a2416 })); m.name = 'akagi-parking-fence'; scenery.add(m);
      const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
      const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'akagi-parking-fence-wall'; scenery.add(wm); colliders.push(wm);
      const postMat = new THREE.MeshLambertMaterial({ color: 0x1f8a5a });
      const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, HN + 0.05, 0.07), postMat, postAt.length), M4 = new THREE.Matrix4();
      postAt.forEach(([x, y, z], k) => posts.setMatrixAt(k, M4.makeTranslation(x, y + (HN + 0.05) / 2, z)));
      posts.name = 'akagi-parking-fence-posts'; posts.frustumCulled = false; scenery.add(posts);
      // 上と下の横の棒
      const bars = [];
      for (let k = 0; k < net.length; k += 18) for (const [h0, h1] of [[HN - 0.05, HN], [0.03, 0.08]]) {
        const ax = net[k], ay = net[k + 1], az = net[k + 2], bx = net[k + 3], bz = net[k + 5];
        bars.push(ax, ay + h0, az, bx, ay + h0, bz, bx, ay + h1, bz, ax, ay + h0, az, bx, ay + h1, bz, ax, ay + h1, az);
      }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(bars, 3)); bg.computeVertexNormals();
      const bm = new THREE.Mesh(bg, new THREE.MeshLambertMaterial({ color: 0x1f8a5a, side: THREE.DoubleSide })); bm.name = 'akagi-parking-fence-bars'; scenery.add(bm);
    }
  }

  for (const [tx, tz] of toiletPts) {
    const P = parkings.find((q) => inPoly(q, tx, tz) || edgeDist(q, tx, tz) < 6);
    let ang = 0;   // 向き: 駐車場のいちばん長い辺にそろえる
    if (P) { let L = 0; for (let i = 0, j = P.pts.length - 1; i < P.pts.length; j = i++) { const dx = P.pts[i][0] - P.pts[j][0], dz = P.pts[i][1] - P.pts[j][1], l = Math.hypot(dx, dz); if (l > L) { L = l; ang = Math.atan2(-dz, dx); } } }
    ang += Math.PI / 2;   // 90度回す
    const y = P ? P.y : H(tx, tz);
    const body = new THREE.Mesh(new THREE.BoxGeometry(6, 3.2, 4), new THREE.MeshLambertMaterial({ color: 0x59351f }));
    body.position.set(tx, y + 1.6, tz); body.rotation.y = ang; body.name = 'akagi-toilet'; scenery.add(body);
    // 駐車場の出入口(スロープ)の方を向く壁に、左右 2 つの黒い入口
    if (P) {
      let ri = 0; for (let i = 1; i < n; i++) if (Math.abs(routeS[i] - P.rampS) < Math.abs(routeS[ri] - P.rampS)) ri = i;
      body.updateMatrixWorld();
      const l = body.worldToLocal(new THREE.Vector3(route[ri].x, y + 1.6, route[ri].z));   // スロープの位置(建物から見て)
      const doorMat = new THREE.MeshBasicMaterial({ color: 0x08090a, side: THREE.DoubleSide });
      const onX = Math.abs(l.x) / 3 >= Math.abs(l.z) / 2, half = onX ? 2 : 3;   // 向く壁: x の面(幅 4m)か z の面(幅 6m)
      for (const sd of [-1, 1]) {
        const door = new THREE.Mesh(onX ? new THREE.BoxGeometry(0.035, 2.1, 1.0) : new THREE.BoxGeometry(1.0, 2.1, 0.035), doorMat);
        if (onX) door.position.set(Math.sign(l.x) * 3.025, -1.6 + 1.05, sd * half * 0.55);
        else door.position.set(sd * half * 0.55, -1.6 + 1.05, Math.sign(l.z) * 2.025);
        door.name = 'akagi-toilet-entrance'; body.add(door);
      }
    }
    const roofGeo = new THREE.BufferGeometry();
    roofGeo.setAttribute('position', new THREE.Float32BufferAttribute([
      -3.3,3.15,-2.3, 0,4.45,-2.3, 0,4.45,2.3, -3.3,3.15,-2.3, 0,4.45,2.3, -3.3,3.15,2.3,
       0,4.45,-2.3, 3.3,3.15,-2.3, 3.3,3.15,2.3, 0,4.45,-2.3, 3.3,3.15,2.3, 0,4.45,2.3,
      -3.3,3.15,-2.3, -3.3,3.15,2.3, 3.3,3.15,-2.3, 3.3,3.15,-2.3, -3.3,3.15,2.3, 3.3,3.15,2.3,
      -3.3,3.15,-2.3, 3.3,3.15,-2.3, 0,4.45,-2.3, -3.3,3.15,2.3, 0,4.45,2.3, 3.3,3.15,2.3
    ], 3));
    roofGeo.computeVertexNormals();
    const roof = new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({ color: 0x493024, side: THREE.DoubleSide }));
    roof.position.set(tx, y, tz); roof.rotation.y = ang; roof.name = 'akagi-toilet-roof'; scenery.add(roof);
    body.updateMatrixWorld(); colliders.push(body);

  }

  // 実際に描画される地面メッシュ(地形・道わき・駐車場舗装)へ上からRaycastし、
  // いちばん上の面に支柱の根元を合わせる。H() の補間値だけで決めない。
  const lampGroundMeshes = [ground, ...scenery.children.filter(o =>
    o.isMesh && (o.name === 'akagi-roadside' || o.name === 'akagi-parking')
  )];
  for (const mesh of lampGroundMeshes) mesh.updateMatrixWorld(true);
  const lampRaycaster = new THREE.Raycaster();
  const lampRayOrigin = new THREE.Vector3();
  const lampRayDown = new THREE.Vector3(0, -1, 0);
  // 読み込みを速く: 街灯のまわり(半径 r)の三角形だけを抜き出した小さな形に Raycast する(大きな地面ぜんぶには当てない)
  let lampLocal = null;
  const localGround = (x, z, r) => lampGroundMeshes.map((mesh) => {
    const pos = mesh.geometry.getAttribute('position'), idx = mesh.geometry.index, cnt = idx ? idx.count : pos.count, out = [];
    for (let t = 0; t < cnt; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      const ax = pos.getX(a), az = pos.getZ(a);
      if (Math.abs(ax - x) > r + 14 || Math.abs(az - z) > r + 14) continue;
      const bx = pos.getX(b), bz = pos.getZ(b), cx = pos.getX(c), cz = pos.getZ(c);
      if (Math.min(ax, bx, cx) > x + r || Math.max(ax, bx, cx) < x - r || Math.min(az, bz, cz) > z + r || Math.max(az, bz, cz) < z - r) continue;
      out.push(ax, pos.getY(a), az, bx, pos.getY(b), bz, cx, pos.getY(c), cz);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); m.updateMatrixWorld(true); return m;
  });
  const lampSurfaceY = (x, z) => {
    const terrainY = H(x, z);
    lampRayOrigin.set(x, terrainY + 10000, z);
    lampRaycaster.set(lampRayOrigin, lampRayDown);
    const hit = lampRaycaster.intersectObjects(lampLocal || lampGroundMeshes, false)[0];
    // 地面から 1.5cm 上げ、埋没と地面とのちらつきを防ぐ。
    return (hit ? hit.point.y : terrainY) + 0.015;
  };
  // 円形の光だまり用テクスチャ。中心から外周へ滑らかに透明化する。
  const lampGlowCanvas = document.createElement('canvas');
  lampGlowCanvas.width = lampGlowCanvas.height = 128;
  const lampGlowCtx = lampGlowCanvas.getContext('2d');
  const lampGlowGradient = lampGlowCtx.createRadialGradient(64, 64, 2, 64, 64, 63);
  lampGlowGradient.addColorStop(0, 'rgba(255, 218, 153, 0.30)');
  lampGlowGradient.addColorStop(0.28, 'rgba(255, 211, 139, 0.23)');
  lampGlowGradient.addColorStop(0.62, 'rgba(255, 199, 119, 0.10)');
  lampGlowGradient.addColorStop(0.88, 'rgba(255, 190, 105, 0.025)');
  lampGlowGradient.addColorStop(1, 'rgba(255, 190, 105, 0)');
  lampGlowCtx.fillStyle = lampGlowGradient;
  lampGlowCtx.fillRect(0, 0, 128, 128);
  const lampGlowTexture = new THREE.CanvasTexture(lampGlowCanvas);
  lampGlowTexture.colorSpace = THREE.SRGBColorSpace;

  // 円形パッチの頂点ごとに実際の地表高を取得し、斜面でも地面に沿わせる。
  const makeLampPoolGeometry = (x, z, baseY, radius) => {
    const rings = 5, segments = 32;
    const positions = [0, lampSurfaceY(x, z) - baseY + 0.025, 0];
    const uvs = [0.5, 0.5];
    const indices = [];
    for (let ring = 1; ring <= rings; ring++) {
      const r = radius * ring / rings;
      for (let i = 0; i < segments; i++) {
        const angle = i / segments * Math.PI * 2;
        const dx = Math.cos(angle) * r, dz = Math.sin(angle) * r;
        positions.push(dx, lampSurfaceY(x + dx, z + dz) - baseY + 0.025, dz);
        uvs.push(0.5 + dx / (2 * radius), 0.5 + dz / (2 * radius));
      }
    }
    // 中心から最初のリング。
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      indices.push(0, 1 + next, 1 + i);
    }
    // 各リング間を三角形で接続。
    for (let ring = 1; ring < rings; ring++) {
      const inner = 1 + (ring - 1) * segments;
      const outer = 1 + ring * segments;
      for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        const a = inner + i, b = inner + next, c = outer + i, d = outer + next;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };

  const addAkagiLamp = (x, z, name) => {
    lampLocal = localGround(x, z, 15);
    const ly = lampSurfaceY(x, z);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x17191b });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 5.4, 10), poleMat);
    pole.position.set(x, ly + 2.7, z); pole.name = name + '-pole'; scenery.add(pole);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.34, 0.13, 20), poleMat);
    cap.position.set(x, ly + 5.43, z); cap.name = name + '-head'; scenery.add(cap);
    const diffuserMat = new THREE.MeshBasicMaterial({ color: 0x665b42 });
    const diffuser = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.13, 20), diffuserMat);
    diffuser.position.set(x, ly + 5.31, z); diffuser.name = name + '-diffuser'; scenery.add(diffuser);

    // 直径27.5mの円形光だまり。四角い板を使わず、地表の凹凸に合わせて変形させる。
    const haloMat = new THREE.MeshBasicMaterial({
      map: lampGlowTexture, color: 0xffd98a, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const halo = new THREE.Mesh(makeLampPoolGeometry(x, z, ly, 13.75), haloMat);
    halo.position.set(x, ly, z);
    halo.name = name + '-pool';
    halo.renderOrder = 3;
    scenery.add(halo);

    const light = new THREE.PointLight(0xffd98a, 5, 27.5, 2);
    light.position.set(x, ly + 5.25, z);
    light.visible = false;
    light.name = name + '-point-light';
    scenery.add(light);
    akagiNightLights.push({ diffuserMat, haloMat, light });
  };
  // 姫百合駐車場内の既存街灯は撤去。
  // D：ユーザー指定座標（X=-265, Z=162）。符号を保持して固定配置。
  addAkagiLamp(-233, 261, 'akagi-lamp-D');

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
  const setNight = (on) => { for (const { diffuserMat, haloMat, light } of akagiNightLights) { diffuserMat.color.setHex(on ? 0xffe7a6 : 0x665b42); haloMat.opacity = on ? 1 : 0; light.visible = on; } };
  setNight(false);
  let meadowFrom = null; for (let i = 0; i < n && meadowFrom == null; i++) if (inAny(meadows, route[i].x, route[i].z)) meadowFrom = i;   // 道が草原に入る最初の点(山の上の側)
  const parkingEnd = Math.max(-1, ...parkings.map((P) => P.touchEnd ?? -1));   // 駐車場が道に接する最後の点(ふもと側)
  return { parkingEnd, meadowFrom, setNight, colliders, softGroundAt, group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb: route[0].y - route[n - 1].y, start, goal, parkingStart,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
