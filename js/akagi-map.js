import * as THREE from '../lib/three.module.js';
import { treeBillboards } from './osm-city.js?v=20261117-tidy-1';

// 赤城山(県道4号 前橋赤城線、赤城山総合観光案内所の前 → 姫百合駐車場の前)。
// map/akagi-course.json(tools/akagi/make_akagi.py)から組み立てる。
// 道の線は OpenStreetMap、起伏は PLATEAU 前橋市の地形。はじめと終わりがある1本道(つなぎ目なし)。
export const AKAGI_ROAD_HALF = 3.6;     // 片側1車線ずつ、幅 7.2m
const SHOULDER = 0.9;                    // 白線の外の路肩(舗装)
const RAIL = AKAGI_ROAD_HALF + SHOULDER + 0.35;   // ガードレールの位置(道の中心から)

// 木陰のある所(1)とない所(0)。道の木陰の模様(createCanopyShade の grove)と同じ式で、木の並びもこれに合わせる
export const akagiGrove = (x, z) => THREE.MathUtils.smoothstep(Math.sin(x * 0.035 + Math.sin(z * 0.048)), -0.4, 0.65);

export function buildAkagiMap(data, { akagi = true } = {}) {
  // 山の地面の色。赤城山はもとの暗い森の影。ほかの峠(榛名山など)は、草地の色より少し暗いくらい(木々の色となじむ)
  const AKAGI_FOREST = akagi ? [0.02, 0.035, 0.015] : [0.09, 0.14, 0.042], AKAGI_BUSH = akagi ? [0.035, 0.055, 0.02] : [0.105, 0.16, 0.048];   // akagi=false: 筑波山など、赤城山だけの物(トイレ・自販機・街灯)を置かない
  const route = data.route.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  // ふもと側の終わりの先に、まっすぐな道を 250m 足す(のぼりのループは、この直線の上に戻ってくる)。向きと下りの傾きは、終わりの 30m と同じ
  const BOTTOM_EXT = 84;
  {
    const e = route[route.length - 1], q = route[route.length - 11], dx = (e.x - q.x) / 10, dz = (e.z - q.z) / 10, dy = THREE.MathUtils.clamp((e.y - q.y) / 10, -0.2, 0);
    for (let k = 1; k <= BOTTOM_EXT; k++) route.push(new THREE.Vector3(e.x + dx * k, e.y + dy * k, e.z + dz * k));
  }
  const bottomStraight = route.length - BOTTOM_EXT - 1;   // ふもと側のまっすぐな道のはじまり(もとの道の終わり)
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
  // 真上の絵(tools/topview/apply_paint.py)で決めた所: 道の高さのアスファルトの拡張(aprons)・木々(woods)
  const aprons = (data.aprons || []).map(region), woods = (data.woods || []).map(region);
  const sands = (data.sands || []).map(region);
  const cuts = (data.cuts || []).map(region);   // 塗って消した所: アスファルト・砂・脇道をここには作らない(地面は元のまま)
  const inCut = (x, z) => cuts.some((C) => x > C.x0 && x < C.x1 && z > C.z0 && z < C.z1 && inPoly(C, x, z));   // 砂の待避所・横道(tools/haruna/apply_quarter_paint.py)
  const slabs = (data.slabs || []).map(region);
  // 駐車場の広場(lots): 道路ではない平らなアスファルト(白線なし)。高さは背骨(spine: もとの脇道の点と高さ)のいちばん近い点。まわり 4m で元の地面へ
  const lots = (data.lots || []).map((L) => Object.assign(region(L.pts), { spine: L.spine || [] }));
  const lotY = (L, x, z) => { let bd = Infinity, y = 0; for (const [sx, sz, sy] of L.spine) { const dd = (sx - x) ** 2 + (sz - z) ** 2; if (dd < bd) { bd = dd; y = sy; } } return y; };   // 板の駐車場: 中は道と同じ高さで平ら(崖の上へ張り出してよい)。ふちはコンクリートの側面
  const flats = aprons.concat(sands);               // 道の高さにそろえる所(道から 18m より先は元の地面へ寄せる: 長い横道が浮かないように)
  // 一車線の横道(sideRoads: 中心線と幅)。本線の路面の中から始めて、奥へ。形は帯の多角形にして flats に入れる(高さの決め方は同じ)
  const sideRoads = (data.sideRoads || []).map((S) => {
    const [a, b] = [S.pts[0], S.pts[S.pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, hw = S.w / 2;
    const st = AKAGI_ROAD_HALF - 0.5, cl = []; for (let t = st; t <= L; t += 2) cl.push([a[0] + ux * t, a[1] + uz * t, t]);
    const poly = cl.map(([x, z]) => [x - uz * hw, z + ux * hw]).concat(cl.slice().reverse().map(([x, z]) => [x + uz * hw, z - ux * hw]));
    return { ...region(poly), cl, ux, uz, hw, L, a };
  });
  flats.push(...sideRoads);
  // OpenStreetMap の、本線以外の道(osmRoads: 見た目だけ。tools/haruna/osm_side_roads.py)。2m おきに区切って、近くを速く探せるように升目へ
  const osmRoads = (data.osmRoads || []).map((r) => {
    const pts = [];
    for (let k = 0; k + 1 < r.pts.length; k++) { const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 2)); for (let t = 0; t < m; t++) pts.push([ax + (bx - ax) * t / m, az + (bz - az) * t / m]); }
    pts.push(r.pts[r.pts.length - 1]);
    // 角をならす(端は動かさない)。OSM の折れ線の角が道の上に出ないように
    for (let it = 0; it < 4; it++) for (let k = 1; k + 1 < pts.length; k++) pts[k] = [(pts[k - 1][0] + 2 * pts[k][0] + pts[k + 1][0]) / 4, (pts[k - 1][1] + 2 * pts[k][1] + pts[k + 1][1]) / 4];
    return { ...r, pts };
  });
  const osmGrid = new Map();
  osmRoads.forEach((r, ri) => r.pts.forEach(([x, z], k) => { const key = Math.floor(x / 16) + ',' + Math.floor(z / 16); if (!osmGrid.has(key)) osmGrid.set(key, []); osmGrid.get(key).push([ri, k]); }));
  // (x, z) が OSM の道の上(幅の半分 + margin)なら、その道。vehicle: 車の道(アスファルト・林道)だけ
  const onOsmRoad = (x, z, margin = 0, vehicle = false) => {
    if (!osmRoads.length) return null;
    const bx = Math.floor(x / 16), bz = Math.floor(z / 16);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [ri, k] of osmGrid.get((bx + a) + ',' + (bz + b)) || []) {
      const r = osmRoads[ri]; if (vehicle && r.kind === 'trail') continue;
      const [px, pz] = r.pts[k]; if (Math.hypot(px - x, pz - z) <= r.w / 2 + margin + 1) return r;
    }
    return null;
  };
  // いちばん近い OSM の道の点(reach m 以内): { r, k, d = 中心線からの距離 }
  const osmNearest = (x, z, reach) => {
    if (!osmRoads.length) return null;
    const bx = Math.floor(x / 16), bz = Math.floor(z / 16); let best = null;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [ri, k] of osmGrid.get((bx + a) + ',' + (bz + b)) || []) {
      const r = osmRoads[ri]; if (r.kind === 'trail') continue;
      const [px, pz] = r.pts[k], dd = Math.hypot(px - x, pz - z); if (dd <= reach && (!best || dd < best.d)) best = { r, k, d: dd };
    }
    return best;
  };
  // OSM の道の高さの並び: 地形を前後 6m でならしたもの。本線の近く(12m)は本線の高さへ
  const osmProfile = (r) => {
    if (r.prof) return r.prof;
    const raw = r.pts.map(([x, z]) => H0(x, z));
    r.prof = r.pts.map(([x, z], k) => { let a = 0, c = 0; for (let j = Math.max(0, k - 6); j <= Math.min(r.pts.length - 1, k + 6); j++) { a += raw[j]; c++; }
      let y = a / c; const rd = roadAt(x, z); if (rd && rd.d < EDGE + 12) y = THREE.MathUtils.lerp(rd.y - 0.05, y, THREE.MathUtils.smoothstep(rd.d, EDGE, EDGE + 12)); return y; });
    return r.prof;
  };
  // 駐車場の拡張(駐車の向きの枠・看板があるもの)。草むら・芝生の板はここだけ
  const parkAprons = aprons.filter((A) => (data.parkGuides || []).concat(data.signs || []).some((g) => inPoly(A, g[0], g[1]) || edgeDist(A, g[0], g[1]) < 40));
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
  const toiletPts = akagi ? [[-1538.5, 1796]] : [];   // 絵の赤丸の位置
  const inAny = (list, x, z) => list.some((P) => inPoly(P, x, z));
  // 駐車場の角で道から 10m 以内のものは、道の路肩まで寄せる(道と駐車場の間にすき間を作らない)
  for (const P of parkings) {
    P.pts = P.pts.map(([x, z]) => { const r = roadAt(x, z); if (!r || r.d > EDGE + 10 || r.d < 0.01) return [x, z];
      const q = route[r.i], k = (EDGE - 0.2) / r.d; return [q.x + (x - q.x) * k, q.z + (z - q.z) * k]; });
    Object.assign(P, region(P.pts));
  }
  const PARK_DROP = 0;         // 駐車場の高さ = いちばん近い所の道の高さ(そこが出入口のスロープ)
  const PARK_RAMP_ANGLE = 15;
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
  const APRON_BLEND = 6;
  // 横道の高さの並び(2m おき): 入口は本線の高さ、奥は元の地面。坂は 10% まで、前後でならす
  const sideProfile = (S) => {
    if (S.prof) return S.prof;
    const r0 = roadAt(S.cl[0][0], S.cl[0][1]), y0 = r0 ? r0.y - 0.05 : H0(S.cl[0][0], S.cl[0][1]);
    let p = S.cl.map(([x, z, t]) => THREE.MathUtils.lerp(y0, H0(x, z), THREE.MathUtils.smoothstep(t, 8, 30)));
    for (let it = 0; it < 3; it++) {
      for (let k = 1; k < p.length; k++) p[k] = THREE.MathUtils.clamp(p[k], p[k - 1] - 0.2, p[k - 1] + 0.2);
      p = p.map((_, k) => { let s2 = 0, c = 0; for (let j = Math.max(1, k - 4); j <= Math.min(p.length - 1, k + 4); j++) { s2 += p[j]; c++; } return k === 0 ? y0 : s2 / c; });
    }
    p[0] = y0; for (let k = 1; k < p.length; k++) p[k] = THREE.MathUtils.clamp(p[k], p[k - 1] - 0.2, p[k - 1] + 0.2);
    S.prof = p; return p;
  };
  // 足した所(アスファルト・砂の板)の下の地面は少し下げる(升目の地面が板の上へ出て、板が隠れないように)
  // 待避所は「道の幅が広がった所」: 地面そのものを道の高さにする(H)ので下げない。OSM の道の下だけ少し下げる
  // アスファルトを足した所(待避所・つなぎ)の下の地面は少し下げて、板とちらつかないようにする(ほかは下げない)
  const underFlat = (x, z) => (onOsmRoad(x, z, 0.6, true) ? 0.12 : 0) || (lots.some((A) => x >= A.x0 - 1 && x <= A.x1 + 1 && z >= A.z0 - 1 && z <= A.z1 + 1 && (inPoly(A, x, z) || edgeDist(A, x, z) < 1)) ? 0.3 : slabs.some((A) => x >= A.x0 && x <= A.x1 && z >= A.z0 && z <= A.z1 && inPoly(A, x, z)) ? 0.25 : aprons.some((A) => x >= A.x0 && x <= A.x1 && z >= A.z0 && z <= A.z1 && inPoly(A, x, z)) ? 0.12 : 0);   // 板の駐車場の下の地面は 25cm 下げる
  // 歩道: 塗った紫の線を、道の点ごとの「左・右に歩道あり」に置きかえる(路肩をのばした帯として、道に沿って作る)
  const WALK = 2.0, walk = [new Uint8Array(n), new Uint8Array(n)];   // [左, 右]
  for (const line of data.sidewalks || []) for (let k = 0; k + 1 < line.length; k++) {
    const [ax, az] = line[k], [bx, bz] = line[k + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 1.5));
    for (let t = 0; t <= m; t++) { const x = ax + (bx - ax) * t / m, z = az + (bz - az) * t / m, r = nearestRoute(x, z); if (r.i < 0 || r.d > EDGE + 4) continue;
      const q = route[r.i], nn = tangents[r.i]; walk[(x - q.x) * nn.x + (z - q.z) * nn.z > 0 ? 0 : 1][r.i] = 1; }
  }
  for (const w of walk) {   // 3 点(9m)までのすき間はつなぎ、3 点より短い切れはしは消す
    for (let i = 0; i < n; i++) if (!w[i]) { let j = i; while (j < n && !w[j]) j++; if (i > 0 && j < n && j - i <= 3) for (let k = i; k < j; k++) w[k] = 1; i = j; }
    for (let i = 0; i < n; i++) if (w[i]) { let j = i; while (j < n && w[j]) j++; if (j - i < 3) for (let k = i; k < j; k++) w[k] = 0; i = j; }
  }
  const H = (x, z) => {
    let h = H0(x, z);
    const lg = legsAt(x, z); if (lg.length && lg[0].d <= EDGE) return h;   // 道路面は一切変更しない
    if (lg.length && lg[0].d < EDGE + WALK + 4) {   // 歩道: 路肩の外 2m は道の高さ(歩道の板の下)。その先 4m で元の地面へ
      const i = lg[0].i, q = route[i], nn = tangents[i], sd = (x - q.x) * nn.x + (z - q.z) * nn.z > 0 ? 0 : 1;
      if (walk[sd][i]) { const e = lg[0].d - EDGE - WALK; if (e <= 0) return lg[0].y - 0.05; h = THREE.MathUtils.lerp(lg[0].y - 0.05, h, THREE.MathUtils.smoothstep(e, 0, 4)); }
    }
    for (const L of lots) { if (x < L.x0 - 4 || x > L.x1 + 4 || z < L.z0 - 4 || z > L.z1 + 4) continue; const y = lotY(L, x, z) - 0.05; if (inPoly(L, x, z)) return y; const e = edgeDist(L, x, z); if (e < 4) h = THREE.MathUtils.lerp(y, h, THREE.MathUtils.smoothstep(e, 0, 4)); }
    for (const S of slabs) if (x >= S.x0 && x <= S.x1 && z >= S.z0 && z <= S.z1 && inPoly(S, x, z)) { const k = nearestRoute(x, z, 4); if (k.i >= 0) return route[k.i].y + 0.06; }   // 板の駐車場(切った所より先に見る)。高さは板の上面(車が埋まらないように)
    if (inCut(x, z)) return h;
    { // OSM の脇道: 道の上は道の高さ、両わき 4m で元の地面へ
      const o = osmNearest(x, z, 12);
      if (o) { const y = osmProfile(o.r)[o.k], e = o.d - o.r.w / 2 - 0.6; if (e <= 0) return y; if (e < 4) h = THREE.MathUtils.lerp(y, h, THREE.MathUtils.smoothstep(e, 0, 4)); }
    }
    for (const S of sideRoads) {   // 一車線の横道: 坂をゆるめた高さの並び(prof)に沿う。まわり 6m で元の地面へ
      if (x < S.x0 - APRON_BLEND || x > S.x1 + APRON_BLEND || z < S.z0 - APRON_BLEND || z > S.z1 + APRON_BLEND) continue;
      const t = (x - S.a[0]) * S.ux + (z - S.a[1]) * S.uz, off = Math.abs(-(x - S.a[0]) * S.uz + (z - S.a[1]) * S.ux);
      if (t < S.cl[0][2] - APRON_BLEND || t > S.L + APRON_BLEND) continue;
      const pr = sideProfile(S), f = THREE.MathUtils.clamp((t - S.cl[0][2]) / 2, 0, pr.length - 1.001), k = Math.floor(f), y = pr[k] + (pr[k + 1] - pr[k]) * (f - k);
      const e = Math.max(off - S.hw, t - S.L, S.cl[0][2] - t);
      if (e <= 0) return y;
      if (e < APRON_BLEND) h = THREE.MathUtils.lerp(y, h, THREE.MathUtils.smoothstep(e, 0, APRON_BLEND));
    }
    for (const A of flats) {   // アスファルト・砂を足した所: いちばん近い道の高さ。まわり 6m で元の地面へなめらかに戻す
      if (A.cl || x < A.x0 - APRON_BLEND || x > A.x1 + APRON_BLEND || z < A.z0 - APRON_BLEND || z > A.z1 + APRON_BLEND) continue;
      const r = roadAt(x, z); if (!r) continue;
      const flat = THREE.MathUtils.lerp(r.y - 0.05, h, THREE.MathUtils.smoothstep(r.d, 18, 32));
      if (inPoly(A, x, z)) return flat;
      const d = edgeDist(A, x, z); if (d < APRON_BLEND) h = THREE.MathUtils.lerp(flat, h, THREE.MathUtils.smoothstep(d, 0, APRON_BLEND));
    }
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
  const forest = AKAGI_FOREST, bush = AKAGI_BUSH;
  const MEADOW = [0.19, 0.29, 0.085], BUSHY = [0.085, 0.15, 0.04];   // 草原(赤で囲んだ所)、草むら(黄で囲んだ所)   // 道から離れた所: 森の下の暗い影(草は1本ずつ描かず、地面の色だけ)
  for (let iz = 0; iz <= lines; iz++) for (let ix = 0; ix <= cols; ix++) {
    const x = minX + ix * G.cell, z = minZ + iz * G.cell, k = iz * (cols + 1) + ix, legs = legsAt(x, z);
    const d = legs.length ? legs[0].d : 1e9;
    // 2 本の道(つづら折りの上と下)の間は、道わきの細かい地面がとちゅうで止まってすき間ができるので、粗い地面を下げない(地面の下が見えないように)
    const between = !akagi && legs.length > 1 && legs[1].d < EDGE + STRIP + 4;
    const h = H(x, z) - 6 * (1 - (between ? THREE.MathUtils.smoothstep(d, EDGE + 6, EDGE + 12) : THREE.MathUtils.smoothstep(d, EDGE + STRIP - 8, EDGE + STRIP - 1))) - underFlat(x, z);   // 間の所は道の近く(12m まで)だけ下げる
    verts[k * 3] = x; verts[k * 3 + 1] = h; verts[k * 3 + 2] = z;
    const mix = 0.5 + 0.5 * Math.sin(x * 0.021 + Math.sin(z * 0.017) * 2.3) * Math.sin(z * 0.013 - x * 0.007);
    const area = inAny(meadows, x, z) ? MEADOW : inAny(bushes, x, z) ? BUSHY : null;
    for (let c = 0; c < 3; c++) colors[k * 3 + c] = area ? area[c] * (0.92 + 0.16 * mix) : forest[c] + (bush[c] - forest[c]) * mix * (akagi ? 0.7 : 0.2);
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

  // 地図の外の遠い地面。data.far(80m 升目、tools/haruna/make_far.py)があれば、その本当の高さ。なければ 60m 升目・半径 6km で地形の端のまま。内側と重なる所は下げる
  if (data.far) {
    const F = data.far, fv = [], fi = [], fc = [], C1 = new THREE.Color();
    for (let j = 0; j < F.nz; j++) for (let i = 0; i < F.nx; i++) {
      const x = F.x0 + i * F.cell, z = F.z0 + j * F.cell, inside = x > minX + 60 && x < maxX - 60 && z > minZ + 60 && z < maxZ - 60;
      const y = F.h[j * F.nx + i];
      fv.push(x, inside ? groundHeightAt(x, z) - 40 : y - 0.3, z);
      const hi = THREE.MathUtils.smoothstep(y, 300, 800), n = 0.5 + 0.5 * Math.sin(x * 0.013 + Math.sin(z * 0.011) * 2);
      const kk = akagi ? 1.2 : 0.85, kn = akagi ? 0.5 : 0.06; C1.setRGB(forest[0] * (kk + kn * n) + 0.02 * hi, forest[1] * (kk + kn * n) + 0.015 * hi, forest[2] * (kk + kn * n) + 0.01 * hi); fc.push(C1.r, C1.g, C1.b);
    }
    for (let j = 0; j < F.nz - 1; j++) for (let i = 0; i < F.nx - 1; i++) { const a = j * F.nx + i, b = a + F.nx; fi.push(a, b, a + 1, a + 1, b, b + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(fv, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3)); g.setIndex(fi); g.computeVertexNormals();
    // 遠くほどモヤでかすませて、遠景の 2D の山並み(かすんだ青灰色)に近づける。重なる山並みが見分けられるよう 4 段階(2km・4km・6km・8.5km)
    const farMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    farMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vHazeD;').replace('#include <project_vertex>', '#include <project_vertex>\nvHazeD = length(mvPosition.xyz);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHazeD;').replace('#include <dithering_fragment>', '#include <dithering_fragment>\nfloat hz = 0.22 * smoothstep(1800.0, 2400.0, vHazeD) + 0.22 * smoothstep(3500.0, 4200.0, vHazeD) + 0.22 * smoothstep(5500.0, 6300.0, vHazeD) + 0.2 * smoothstep(8000.0, 9000.0, vHazeD);\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.49, 0.56, 0.62), hz);');
    };
    const far = new THREE.Mesh(g, farMat); far.name = 'AkagiFarGround'; scenery.add(far);
    // 湖(榛名湖など): 平らな水面
    for (const W of F.water || []) {
      const shape = new THREE.Shape(W.pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const wm = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshLambertMaterial({ color: 0x3f6f86, side: THREE.DoubleSide }));
      wm.rotation.x = -Math.PI / 2; wm.position.y = W.y + 1.6; wm.name = 'AkagiFarLake'; scenery.add(wm);
    }
    // (遠くの 2D の山並みの輪は、大きすぎて不自然なのでやめた)
  } else {
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
  // 横道が本線に合流する所は、その側の外側線(白)を切る(横道の幅 + 前後 3m)
  // 待避所など、足した所(アスファルト・砂)が道にじかに接している所も、その側の外側線を切る(つなぎ目なしで続く)
  const edgeGap = (i, side) => {
    if ((data.keepEdge || []).some(([a, b]) => i >= a && i <= b)) return false;   // 座標で決めた所は白線・路肩をふつうどおり続ける
    const p = route[i], nn = tangents[i];
    if (sideRoads.some((S) => Math.hypot(p.x - S.a[0], p.z - S.a[1]) <= S.hw + 6 && (S.ux * nn.x + S.uz * nn.z) * side > 0)) return true;
    for (const o of [EDGE + 0.8, EDGE + 2]) if (onOsmRoad(p.x + nn.x * side * o, p.z + nn.z * side * o, 1.5, true)) return true;   // OSM の車の道が合流する所
    // 待避所(アスファルト・砂の広がり)に面する所は、白線も路肩もふつうどおり(切らない)
    return false;
  };
  for (const band of bands) {
    const v = new Float32Array(n * 2 * 3), ind = [];
    // 外側線と路肩は、脇道・待避所がつながる所では切る(その下の舗装がつながって見える)
    const bandSide = band.name === 'GunmaEdgeLine' || band.name === 'GunmaShoulder' ? Math.sign(band.from + band.to) : 0, gapInd = [];
    for (let i = 0; i < n; i++) {
      const p = route[i], nn = tangents[i];
      for (let s = 0; s < 2; s++) { const across = s ? band.to : band.from, o = (i * 2 + s) * 3; v[o] = p.x + nn.x * across; v[o + 1] = p.y + band.y; v[o + 2] = p.z + nn.z * across; }
      if (i + 1 >= n) continue;
      const gap = bandSide && (edgeGap(i, bandSide) || edgeGap(i + 1, bandSide));
      (gap ? gapInd : ind).push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(v, 3)); geo.setIndex(ind); geo.computeVertexNormals();
    const lineTop = band.name === 'GunmaEdgeLine' || band.name === 'GunmaCenterLine';   // 白線・中央線は待避所や駐車場の板より必ず手前に
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ name: band.name, color: band.color, side: THREE.DoubleSide, polygonOffset: lineTop, polygonOffsetFactor: lineTop ? -6 : 0, polygonOffsetUnits: lineTop ? -6 : 0 })); mesh.name = band.name; group.add(mesh);
    // つながる所の路肩は、路面と同じ色で描く(下にすき間を作らない)。外側線はそこだけ描かない
    if (band.name === 'GunmaShoulder' && gapInd.length) {
      const g2 = new THREE.BufferGeometry(); g2.setAttribute('position', new THREE.BufferAttribute(v, 3)); g2.setIndex(gapInd); g2.computeVertexNormals();
      const m2 = new THREE.Mesh(g2, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x4a4c4e, side: THREE.DoubleSide })); m2.name = 'GunmaRoad'; group.add(m2);
    }
  }
  // ---- 道の両わきの細かい地面(路肩の外から 30m)。山側の崖はグレー(吹き付けのコンクリート)、崖の下と谷側の斜面は草、奥は森の暗い影 ----
  {
    const OFF = [0, 0.4, DITCH, DITCH + 0.6, DITCH + 1.5, DITCH + 3, DITCH + 5, DITCH + 7.5, 11, 15, 20, 25, STRIP];
    const m = OFF.length, v = [], c = [], ind = [];
    const qInfo = [];   // 四角ごとの [側, 道の点, 横の段]
    const grass = [0.17, 0.26, 0.08], rock = [0.15, 0.155, 0.15], C = new THREE.Color(), cutV = [];   // cutV: 削った深さ(元の地形 - 地面)
    for (const side of [-1, 1]) {
      const base = v.length / 3;
      for (let i = 0; i < n; i++) {
        const p = route[i], nn = tangents[i];
        let px = p.x + nn.x * side * EDGE, pz = p.z + nn.z * side * EDGE, py = p.y - 0.05, stop = false;
        for (let k = 0; k < m; k++) {
          const o = EDGE + OFF[k], x = p.x + nn.x * side * o, z = p.z + nn.z * side * o;
          const legs = legsAt(x, z);
          // ここから先へ進めない所(いちばん近い道の点がこの点ではない = カーブの内側の折り返しや、ほかの道の方が近い所・ほかの道の路面の近く)で止める。
          // 止めたら、その先は前の点に重ねる(地面が道の上へはみ出ない)
          if (k > 0 && !stop && !(legs.length && Math.abs(legs[0].i - i) <= 4 && legs.every((l) => l === legs[0] || l.d > EDGE + 1.5))) stop = true;
          if (k === 0 || !stop) { px = x; pz = z; py = (k === 0 ? p.y - 0.05 : H(x, z)) - underFlat(x, z); }   // 道のふちの列も、アスファルトを足した所では下げる(緑がのぞかないように)
          v.push(px, py, pz); cutV.push(T(px, pz) - py);
          const far = THREE.MathUtils.smoothstep(OFF[k], 2.5, 7);
          let col = grass.map((g, j) => g + (forest[j] - g) * far);
          if (inAny(meadows, px, pz)) col = MEADOW.slice(); else if (inAny(bushes, px, pz)) col = BUSHY.slice();
          c.push(...col);
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
        if ((slabs.length || lots.length) && [a2, b2, a2 + 1, b2 + 1].some((id) => slabs.concat(lots).some((S) => inPoly(S, v[id * 3], v[id * 3 + 2]) || edgeDist(S, v[id * 3], v[id * 3 + 2]) < 1))) continue;   // 板の駐車場の上・ふちには道わきの地面を張らない(盛り上がりが板にかぶらない)
        ind.push(a2, b2, a2 + 1, a2 + 1, b2, b2 + 1); qInfo.push([side, i, k]);
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
    if (!akagi) {
      // 榛名山など: グレーの崖を小さな破片にしない。道に沿って同じ向きの急な斜面が 15m 以上続く所だけを、その段ごとまとめてグレーに。
      // 途中の 9m までの切れ目や、少しゆるい面(55度まで)もつなぐ。短いものは消す
      const key = (sd, i, k) => (sd > 0 ? 1 : 0) * n * m + i * m + k, at = new Map(), soft = new Uint8Array(nQuad);
      qInfo.forEach(([sd, i, k], q) => at.set(key(sd, i, k), q));
      for (let q = 0; q < nQuad; q++) { const t = q * 6, nq = triN(t).add(triN(t + 3)).normalize(); soft[q] = Math.abs(nq.y) < 0.82 && cutQ[q] > 0.2 ? 1 : 0; }
      for (const sd of [-1, 1]) for (let k = 0; k + 1 < m; k++) {
        const row = []; for (let i = 0; i + 1 < n; i++) row.push(at.get(key(sd, i, k)) ?? -1);
        const on = row.map((q) => q >= 0 && steepQ[q] === 1);
        for (let i = 0; i < row.length; i++) if (!on[i]) { let j = i; while (j < row.length && !on[j]) j++; if (i > 0 && j < row.length && (j - i <= 4 || (j - i <= 8 && row.slice(i, j).every((q) => q >= 0 && soft[q])))) for (let t = i; t < j; t++) on[t] = true; i = j; }   // グレーにはさまれた緑の切れはしはグレーに
        for (let i = 0; i < row.length; i++) if (on[i]) { let j = i; while (j < row.length && on[j]) j++; if (j - i < 5) for (let t = i; t < j; t++) on[t] = false; i = j; }
        row.forEach((q, i) => { if (q >= 0) steepQ[q] = on[i] ? 1 : 0; });
      }
      // 横の段: 同じ道の点で、グレーの段の間にはさまれた段もグレー(上下に分かれた破片にしない)。前後の点がグレーなら、その間の段もグレー
      for (const sd of [-1, 1]) for (let i = 0; i + 1 < n; i++) {
        const ks = []; for (let k = 0; k + 1 < m; k++) { const q = at.get(key(sd, i, k)); if (q !== undefined && steepQ[q]) ks.push(k); }
        if (ks.length >= 2) for (let k = ks[0]; k <= ks[ks.length - 1]; k++) { const q = at.get(key(sd, i, k)); if (q !== undefined) steepQ[q] = 1; }
      }
      for (let pass = 0; pass < 2; pass++) for (const sd of [-1, 1]) for (let i = 1; i + 2 < n; i++) for (let k = 0; k + 1 < m; k++) {
        const q = at.get(key(sd, i, k)); if (q === undefined || steepQ[q]) continue;
        const g = (ii, kk) => { const r = at.get(key(sd, ii, kk)); return r !== undefined && steepQ[r] === 1; };
        const around = [g(i - 1, k), g(i + 1, k), g(i, k - 1), g(i, k + 1)].filter(Boolean).length;
        if (around >= 3 || (g(i - 1, k) && g(i + 1, k)) || (g(i, k - 1) && g(i, k + 1))) steepQ[q] = 1;   // まわりがグレーの緑の破片
      }
    }
    // 塗って決めた「崖にしない所」(noRock): グレーの崖にしない
    for (const P of (data.noRock || []).map(region)) for (let q = 0; q < nQuad; q++) { if (!steepQ[q]) continue; let x = 0, z = 0; for (let j = 0; j < 6; j++) { x += pos.getX(q * 6 + j) / 6; z += pos.getZ(q * 6 + j) / 6; } if (inPoly(P, x, z)) steepQ[q] = 0; }
    // 塗って決めた「崖のグレーにする所」(rock)
    //  塗った所の四角はグレーに。さらに、塗った所を通る道の点の列(同じ側)では、削った斜面(切り土で 25 度より急)を上までグレーにそろえる
    if (data.rock?.length) {
      const rk = data.rock.map(region), cols = new Set();
      for (let q = 0; q < nQuad; q++) { let x = 0, z = 0; for (let j = 0; j < 6; j++) { x += pos.getX(q * 6 + j) / 6; z += pos.getZ(q * 6 + j) / 6; } if (rk.some((P) => inPoly(P, x, z))) { steepQ[q] = 1; const [sd, i] = qInfo[q]; cols.add(sd * 100000 + i); } }
      for (const sd of [-1, 1]) { const hit = [...cols].filter((c) => Math.sign(c) === sd || (sd > 0 && c >= 0)).map((c) => c - sd * 100000).sort((a, b) => a - b); for (let k = 0; k + 1 < hit.length; k++) if (hit[k + 1] - hit[k] <= 8) for (let i = hit[k] + 1; i < hit[k + 1]; i++) cols.add(sd * 100000 + i); }   // 塗った所の間(8 点まで)も同じ崖としてそろえる
      for (let q = 0; q < nQuad; q++) { const [sd, i] = qInfo[q]; if (steepQ[q] || !cols.has(sd * 100000 + i)) continue; const nq = triN(q * 6).add(triN(q * 6 + 3)).normalize(); if ((cutQ[q] > 0.2 && Math.abs(nq.y) < 0.9) || Math.abs(nq.y) < 0.8) steepQ[q] = 1; }
      // 高さでそろえる: 塗った崖の列ごとに、グレーのいちばん上の高さ(道から)を測り、前後 5 点の最大を「崖の高さ」に。それより下は全部グレー(緑と混ぜない)
      const top = new Map(), cy = (q) => { let y = 0; for (let j = 0; j < 6; j++) y += pos.getY(q * 6 + j) / 6; return y; };
      for (let q = 0; q < nQuad; q++) { const [sd, i] = qInfo[q], key = sd * 100000 + i; if (!steepQ[q] || !cols.has(key)) continue; let hi = -Infinity; for (let j = 0; j < 6; j++) hi = Math.max(hi, pos.getY(q * 6 + j)); top.set(key, Math.max(top.get(key) ?? -Infinity, hi - route[i].y)); }
      const topS = new Map(); for (const key of cols) { let mx = -Infinity; for (let d = -5; d <= 5; d++) mx = Math.max(mx, top.get(key + d) ?? -Infinity); if (mx > 0) topS.set(key, mx); }
      for (let q = 0; q < nQuad; q++) { const [sd, i] = qInfo[q], t = topS.get(sd * 100000 + i); if (t !== undefined && cy(q) - route[i].y < t - 0.3) steepQ[q] = 1; }
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

  // ---- 足した所(待避所・横道)のふちのガードレール(extraRails の折れ線)。2m おきに区切って地面の高さに沿わせる。支柱は 4m おき ----
  for (const [railLines, mat] of [[data.extraRails, railMat], [data.blackRails, new THREE.MeshLambertMaterial({ name: 'HarunaBlackRail', color: 0x1e1f21, side: THREE.DoubleSide })]]) if (railLines?.length) {   // blackRails: 黒いガードレール
    const panel = [], wall = [], postPts = [];
    const quad = (P, A, Bq, y0, y1) => P.push(A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y0, Bq[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y1, A[2]);
    for (const line of railLines) {
      const pts = [];
      for (let k = 0; k + 1 < line.length; k++) {
        const [ax, az] = line[k], [bx, bz] = line[k + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 2));
        for (let t = 0; t < m; t++) pts.push([ax + (bx - ax) * t / m, az + (bz - az) * t / m]);
      }
      pts.push(line[line.length - 1]);
      const P3 = pts.map(([x, z]) => [x, H(x, z), z]);
      for (let k = 0; k + 1 < P3.length; k++) { quad(panel, P3[k], P3[k + 1], 0.45, 0.8); quad(wall, P3[k], P3[k + 1], -0.1, 1.1); }
      let acc = 0; postPts.push(P3[0]);
      for (let k = 1; k < P3.length; k++) { acc += Math.hypot(P3[k][0] - P3[k - 1][0], P3[k][2] - P3[k - 1][2]); if (acc >= 4 || k === P3.length - 1) { postPts.push(P3[k]); acc = 0; } }
    }
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(panel, 3)); pg.computeVertexNormals();
    const pm = new THREE.Mesh(pg, mat); pm.name = 'GunmaGuardrail'; scenery.add(pm);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'akagi-guardrail'; scenery.add(wm); colliders.push(wm);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.12, 0.8, 0.12), mat, postPts.length), M = new THREE.Matrix4();
    postPts.forEach(([x, y, z], i) => posts.setMatrixAt(i, M.makeTranslation(x, y + 0.4, z)));
    posts.name = 'GunmaGuardrail'; posts.computeBoundingSphere(); scenery.add(posts);
  }
  // ---- 展望台のウッドデッキと木の柵(decks: 塗った黄緑の線)。線から道と反対の側へ奥行き 4m の板張り。奥のふちに柵(柱・笠木・縦の格子)。
  //      車は入れない(デッキのまわりに見えない壁) ----
  for (const D of data.decks || []) {
    const line = Array.isArray(D) ? D : D.pts, opt = Array.isArray(D) ? {} : D;   // opt: { depth, pillars } pillars = 奥が浮いていて柱で支える
    if (line.length < 2) continue;
    const pts = [];
    for (let k = 0; k + 1 < line.length; k++) { const [ax, az] = line[k], [bx, bz] = line[k + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 1)); for (let t = 0; t < m; t++) pts.push([ax + (bx - ax) * t / m, az + (bz - az) * t / m]); }
    pts.push(line[line.length - 1]);
    const mid = pts[pts.length >> 1], r0 = nearestRoute(mid[0], mid[1]), rp = route[Math.max(0, r0.i)];
    const DEPTH = opt.depth ?? 4, deckY = Math.max(...pts.map(([x, z]) => H(x, z))) + 0.22;
    const side = (k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; let nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l; if (nx * (pts[k][0] - rp.x) + nz * (pts[k][1] - rp.z) < 0) { nx = -nx; nz = -nz; } return [nx, nz]; };   // 道から離れる向き
    const front = pts.map(([x, z]) => [x, z]), back = pts.map(([x, z], k) => { const [nx, nz] = side(k); return [x + nx * DEPTH, z + nz * DEPTH]; });
    const wood = new THREE.MeshLambertMaterial({ color: 0x7a5a3c }), dark = new THREE.MeshLambertMaterial({ color: 0x3b2a1e });
    // 板張り(上面と、前・横の立ち上がり)
    const v = [], quad = (A, B, C, D) => v.push(...A, ...B, ...C, ...A, ...C, ...D);
    for (let k = 0; k + 1 < pts.length; k++) {
      const f0 = [front[k][0], deckY, front[k][1]], f1 = [front[k + 1][0], deckY, front[k + 1][1]], b0 = [back[k][0], deckY, back[k][1]], b1 = [back[k + 1][0], deckY, back[k + 1][1]];
      quad(f0, f1, b1, b0);
      quad([f0[0], deckY - 0.6, f0[2]], [f1[0], deckY - 0.6, f1[2]], f1, f0);
      quad([b0[0], deckY - (opt.pillars ? 0.3 : 2), b0[2]], [b1[0], deckY - (opt.pillars ? 0.3 : 2), b1[2]], b1, b0);
    }
    for (const k of [0, pts.length - 1]) { const f = [front[k][0], deckY, front[k][1]], b = [back[k][0], deckY, back[k][1]]; quad([f[0], deckY - (opt.pillars ? 0.3 : 1.5), f[2]], [b[0], deckY - (opt.pillars ? 0.3 : 1.5), b[2]], b, f); }
    if (opt.pillars) {   // 柱: 2m おき・3 列、デッキの下から崖の斜面に食い込むまで(地面の 0.6m 下まで)
      const pv = [];
      for (let k = 0; k < pts.length; k += 2) for (const t of [0.15, 0.55, 0.95]) { const x = front[k][0] + (back[k][0] - front[k][0]) * t, z = front[k][1] + (back[k][1] - front[k][1]) * t, g = H(x, z) - 0.6; if (g > deckY - 0.35) continue; pv.push([x, z, g]); }
      const pg = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 1, 0.22), new THREE.MeshLambertMaterial({ color: 0x5a4030 }), pv.length), Mp = new THREE.Matrix4();
      pv.forEach(([x, z, g], i) => { const h = deckY - 0.3 - g; Mp.makeScale(1, h, 1).setPosition(x, g + h / 2, z); pg.setMatrixAt(i, Mp); });
      pg.name = 'akagi-deck-pillars'; scenery.add(pg);
    }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); dg.computeVertexNormals();
    const deck = new THREE.Mesh(dg, new THREE.MeshLambertMaterial({ color: 0x8c6a48, side: THREE.DoubleSide })); deck.name = 'akagi-deck'; scenery.add(deck);
    // 板の継ぎ目(細い暗い線、奥行きの向き 0.5m おき)
    const seams = [];
    for (let k = 0; k + 1 < pts.length; k++) for (let t = 1; t < 8; t++) { const a = front[k], b = back[k], q1 = [a[0] + (b[0] - a[0]) * t / 8, a[1] + (b[1] - a[1]) * t / 8], c = front[k + 1], d = back[k + 1], q2 = [c[0] + (d[0] - c[0]) * t / 8, c[1] + (d[1] - c[1]) * t / 8]; seams.push(q1[0], deckY + 0.005, q1[1], q2[0], deckY + 0.005, q2[1]); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(seams, 3));
    const sl = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x5a4430 })); sl.name = 'akagi-deck-seams'; scenery.add(sl);
    // 柵: 奥のふちと両はし。柱 2m おき、笠木・下の横木、縦の格子 0.2m おき
    const fence = back.slice(); const ends = [[front[0], back[0]], [front[front.length - 1], back[back.length - 1]]];
    const posts = [], bars = [], rails = [];
    const addRun = (a, b) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) return;
      const ang = Math.atan2(b[0] - a[0], b[1] - a[1]);
      rails.push([(a[0] + b[0]) / 2, deckY + 1.08, (a[1] + b[1]) / 2, ang, L, 0.12]);
      rails.push([(a[0] + b[0]) / 2, deckY + 0.15, (a[1] + b[1]) / 2, ang, L, 0.08]);
      for (let t = 0.2; t < L; t += 0.2) bars.push([a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L]);
    };
    let acc = 2;
    for (let k = 0; k < fence.length; k++) { if (k) { addRun(fence[k - 1], fence[k]); acc += Math.hypot(fence[k][0] - fence[k - 1][0], fence[k][1] - fence[k - 1][1]); } if (acc >= 2 || k === fence.length - 1) { posts.push(fence[k]); acc = 0; } }
    for (const [a, b] of ends) { addRun(a, b); posts.push(a); }
    const M = new THREE.Matrix4(), Qn = new THREE.Quaternion(), V = new THREE.Vector3(), S1 = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
    const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 1.3, 0.2), dark, posts.length);
    posts.forEach(([x, z], i) => pm.setMatrixAt(i, M.makeTranslation(x, deckY + 0.65, z)));
    const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.9, 0.06), dark, bars.length);
    bars.forEach(([x, z], i) => bm.setMatrixAt(i, M.makeTranslation(x, deckY + 0.6, z)));
    const rm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1, 1), dark, rails.length);
    rails.forEach(([x, y, z, ang, L, h], i) => { Qn.setFromAxisAngle(Y, ang); rm.setMatrixAt(i, M.compose(V.set(x, y, z), Qn, S1.set(1, h, L))); });
    for (const m of [pm, bm, rm]) { m.name = 'akagi-deck-fence'; m.computeBoundingSphere(); scenery.add(m); }
    // 車が入らないよう、デッキのまわり(前・奥・両はし)に見えない壁
    const wall = []; const wq = (a, b) => wall.push(a[0], deckY - 1.5, a[1], b[0], deckY - 1.5, b[1], b[0], deckY + 1.3, b[1], a[0], deckY - 1.5, a[1], b[0], deckY + 1.3, b[1], a[0], deckY + 1.3, a[1]);
    for (let k = 0; k + 1 < pts.length; k++) { wq(front[k], front[k + 1]); wq(back[k], back[k + 1]); }
    for (const [a, b] of ends) wq(a, b);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'akagi-deck-wall'; scenery.add(wm); colliders.push(wm);
  }
  // ---- 一車線の横道: 路面(奥ほど暗く)と、奥の暗がり(黒いぼかしの板) ----
  for (const S of sideRoads) {
    const v = [], col = [], base = new THREE.Color(0x4a4c4e);   // コースの路面と同じ色
    const row = ([x, z, t]) => { const k = THREE.MathUtils.smoothstep(t, S.L * 0.2, S.L * 0.6); return [[x - S.uz * S.hw, z + S.ux * S.hw], [x + S.uz * S.hw, z - S.ux * S.hw]].map(([px, pz]) => [px, H(px, pz) + 0.03, pz, 1 - 0.85 * k]); };
    const rows = S.cl.map(row);
    for (let k = 0; k + 1 < rows.length; k++) {
      if (k === 0 && S.cl[0][2] < EDGE) { /* 本線の路面の上は描かない(本線と重ねない) */ }
      const [a0, a1] = rows[k], [b0, b1] = rows[k + 1];
      for (const q of [a0, b0, b1, a0, b1, a1]) { v.push(q[0], q[1], q[2]); col.push(base.r * q[3], base.g * q[3], base.b * q[3]); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', vertexColors: true, fog: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.name = 'akagi-side-road'; scenery.add(m);
    // 奥の暗がり: 道をまたぐ黒い板を 4 枚、奥ほど濃く(下から上へぼかす)
    const cv = document.createElement('canvas'); cv.width = 4; cv.height = 64; const c2 = cv.getContext('2d');
    const gr = c2.createLinearGradient(0, 64, 0, 0); gr.addColorStop(0, 'rgba(6,8,6,1)'); gr.addColorStop(0.7, 'rgba(6,8,6,0.85)'); gr.addColorStop(1, 'rgba(6,8,6,0)'); c2.fillStyle = gr; c2.fillRect(0, 0, 4, 64);
    const tex = new THREE.CanvasTexture(cv);
    [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].forEach((f, j) => {
      const t = S.L * f, x = S.a[0] + S.ux * t, z = S.a[1] + S.uz * t;
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(S.hw * 2 + 20, 14), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: Math.min(1, 0.3 + j * 0.13), depthWrite: false, side: THREE.DoubleSide, fog: false }));
      pl.position.set(x, H(x, z) + 6.5, z); pl.rotation.y = Math.atan2(S.ux, S.uz); pl.name = 'akagi-side-road-dark'; pl.renderOrder = 5; scenery.add(pl);
    });
  }
  // ---- OSM の脇道: 本線と同じ作り(路面・路肩・白い外側線、2 車線の道はオレンジのセンターライン)。木もれ日も本線と同じにかかる(group に入れる)。
  //      本線とつながる所(本線から 4m)は線を描かず、路面は本線の路面の下までのばす ----
  {
    const bands = { GunmaRoad: [], GunmaShoulder: [], GunmaEdgeLine: [], GunmaCenterLine: [] };
    const COL = { GunmaRoad: 0x4a4c4e, GunmaShoulder: 0x55575a, GunmaEdgeLine: 0xe6e6e0, GunmaCenterLine: 0xc8782c };
    for (const r of osmRoads) {
      if (r.kind !== 'asphalt') continue;
      const P = r.pts, hw = r.w / 2, ys = osmProfile(r), SH = 0.5;
      const rows = P.map(([x, z], k) => {
        const a = P[Math.max(0, k - 2)], b = P[Math.min(P.length - 1, k + 2)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / l, nz = (b[0] - a[0]) / l;
        const rd = roadAt(x, z);
        return { x, z, nx, nz, y: rd && rd.d < EDGE ? rd.y - 0.06 : ys[k] + 0.02, main: rd ? rd.d : 1e9 };
      });
      const strip = (list, from, to, dy, ok) => { for (let k = 0; k + 1 < rows.length; k++) { const A = rows[k], B = rows[k + 1]; if (!ok(A, B)) continue;
        const q = [[A.x + A.nx * from, A.y + dy, A.z + A.nz * from], [A.x + A.nx * to, A.y + dy, A.z + A.nz * to], [B.x + B.nx * to, B.y + dy, B.z + B.nz * to], [B.x + B.nx * from, B.y + dy, B.z + B.nz * from]];
        list.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]); } };
      const notOnMain = (A, B) => A.main > R * 0.5 && B.main > R * 0.5 && !inCut((A.x + B.x) / 2, (A.z + B.z) / 2);
      const away = (A, B) => A.main > EDGE + 4 && B.main > EDGE + 4 && !inCut((A.x + B.x) / 2, (A.z + B.z) / 2);
      if (r.plain) { strip(bands.GunmaRoad, -hw - SH, hw + SH, 0, notOnMain); continue; }   // plain: 1 枚だけ(重ねるとちらつく)
      strip(bands.GunmaRoad, -hw, hw, 0, notOnMain);   // plain: 白線・オレンジ線・路肩の色違いなし(アスファルト色だけ)
      strip(bands.GunmaShoulder, -hw - SH, -hw, -0.01, away); strip(bands.GunmaShoulder, hw, hw + SH, -0.01, away);
      // 榛名山: 指定された行き止まりの脇道(953,-1354 ～ 854,-1130)は
      // 路面を残し、センターラインと両側の白い外側線だけを描かない。
      const nearTarget = (x, z) => P.some(([px, pz]) => Math.hypot(px - x, pz - z) < 18);
      const removeRoadMarkings = nearTarget(953, -1354) && nearTarget(854, -1130);
      if (!removeRoadMarkings) {
        if (r.w >= 4.5) { strip(bands.GunmaEdgeLine, -hw + 0.1, -hw + 0.25, 0.02, away); strip(bands.GunmaEdgeLine, hw - 0.25, hw - 0.1, 0.02, away); }
        if (r.w >= 6) strip(bands.GunmaCenterLine, -0.075, 0.075, 0.02, away);
      }
    }
    for (const [name, v] of Object.entries(bands)) {
      if (!v.length) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name, color: COL[name], side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.name = 'akagi-osm-road'; group.add(m);
    }
  }
  // ---- 歩道(上面は道と同じ色): 路肩の外へ幅 2m、道の路面より 15cm 高いコンクリートの帯(道の点に沿うので波打たない)。道ぎわは縁石の立ち上がり ----
  {
    const v = [], top = [], quad = (A, B, C, D) => v.push(...A, ...B, ...C, ...A, ...C, ...D), quadT = (A, B, C, D) => top.push(...A, ...B, ...C, ...A, ...C, ...D);
    for (const [si, side] of [[0, 1], [1, -1]]) for (let i = 0; i + 1 < n; i++) {
      if (!walk[si][i] || !walk[si][i + 1]) continue;
      const P = (j, o, dy) => { const p = route[j], nn = tangents[j]; return [p.x + nn.x * side * o, p.y + dy, p.z + nn.z * side * o]; };
      quadT(P(i, EDGE, 0.15), P(i + 1, EDGE, 0.15), P(i + 1, EDGE + WALK, 0.15), P(i, EDGE + WALK, 0.15));   // 上面: 薄いアスファルト色
      quad(P(i, EDGE, -0.02), P(i + 1, EDGE, -0.02), P(i + 1, EDGE, 0.15), P(i, EDGE, 0.15));                  // 横(縁石): 白っぽいコンクリート
      quad(P(i, EDGE + WALK, 0.15), P(i + 1, EDGE + WALK, 0.15), P(i + 1, EDGE + WALK, -0.1), P(i, EDGE + WALK, -0.1));
    }
    for (const [list, name, color] of [[v, 'GunmaShoulder', 0x9b9b95], [top, 'GunmaRoad', 0x4a4c4e]]) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name, color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }));   // 歩道は板に負けないよう手前に
      m.name = 'akagi-sidewalk'; (list === top ? group : scenery).add(m);   // 上面は木もれ日がかかるよう道と同じ group へ
    }
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
  // ---- アスファルトの拡張(aprons): 塗った形の板を 2m 以下の三角に割って、道の高さに沿わせる。道の上(路肩まで)には描かない ----
  // 拡張の近くの芝生(meadows)も、塗った形のまま板で重ねる(地面の 6m 升目の色だけだと、ふちがギザギザになるため)
  const nearAnyApron = (P) => parkAprons.some((A) => P.x1 > A.x0 - 25 && P.x0 < A.x1 + 25 && P.z1 > A.z0 - 25 && P.z0 < A.z1 + 25);
  for (const P of meadows.filter(nearAnyApron)) {
    const v = [], MAXE = 2;
    const put = (a, b, c) => {
      const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
      if (L > MAXE) { const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; put(a, ab, ca); put(ab, b, bc); put(ca, bc, c); put(ab, bc, ca); return; }
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3, r = roadAt(cx, cz);
      if (!r || r.d < EDGE - 0.05) return;
      for (const q of [a, b, c]) v.push(q[0], H(q[0], q[1]) + 0.03, q[1]);
    };
    for (const t of THREE.ShapeUtils.triangulateShape(P.pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) put(...t.map((k) => P.pts[k]));
    if (!v.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaGrass', color: new THREE.Color(...MEADOW), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    m.name = 'akagi-meadow-patch'; scenery.add(m);
  }
  for (const [list, color, nm, mname] of [[aprons, ROAD_COLOR, 'akagi-apron', 'GunmaRoad'], [sands, new THREE.Color(forest[0] * 0.9 + 0.45 * 0.1, forest[1] * 0.9 + 0.32 * 0.1, forest[2] * 0.9 + 0.1 * 0.1), 'akagi-sand', 'GunmaGrass']]) {   // 砂の所: 草地の暗い方の色 9 割 + 黄土色 1 割
    if (!list.length) continue;
    const v = [], MAXE = 2;
    const put = (a, b, c) => {
      const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
      if (L > MAXE) { const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2]; put(a, ab, ca); put(ab, b, bc); put(ca, bc, c); put(ab, bc, ca); return; }
      const cx = (a[0] + b[0] + c[0]) / 3, cz = (a[1] + b[1] + c[1]) / 3, r = roadAt(cx, cz);
      // 道の路面の下までのばして描く(道の帯が上にかぶさるので、道とのさかいめがギザギザにならない)。芝生の帯(緑地)には描かない
      if (!r || r.d < R - 0.3 || inAny(meadows, cx, cz) || inCut(cx, cz)) return;
      for (const q of [a, b, c]) { const rq = roadAt(q[0], q[1]); v.push(q[0], rq && rq.d < EDGE ? rq.y - 0.06 : H(q[0], q[1]) + 0.03, q[1]); }   // 路肩の下は路肩より低く(路肩の帯が上にかぶさる)
    };
    for (const A of list) for (const t of THREE.ShapeUtils.triangulateShape(A.pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) put(...t.map((k) => A.pts[k]));
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: mname, color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.name = nm; scenery.add(m);
  }
  // ---- 草むら(拡張のまわり): 拡張の近くの芝生の帯と、拡張の外まわり(外へ 3m)に、草の株を生やす。株は交差した 3 枚の板 ----
  if (parkAprons.length || data.grassAreas?.length) {
    let sd = 3; const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
    const nearApron = (x, z) => parkAprons.some((A) => x > A.x0 - 25 && x < A.x1 + 25 && z > A.z0 - 25 && z < A.z1 + 25 && (inPoly(A, x, z) || edgeDist(A, x, z) < 25));
    const spots = [];
    const noTuft = (data.noTrees || []).map(region);   // 脇道(塗った所)には草の株を生やさない
    const tryAt = (x, z) => { const r = roadAt(x, z); if (!r || r.d < EDGE + 0.3 || aprons.some((A) => inPoly(A, x, z)) || noTuft.some((P) => inPoly(P, x, z))) return; spots.push([x, H(x, z) - 0.02, z]); };
    for (const P of meadows) {   // 芝生の帯(拡張の近くのものだけ)
      if (!nearApron((P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2)) continue;
      for (let x = P.x0; x <= P.x1; x += 0.9) for (let z = P.z0; z <= P.z1; z += 0.9) { const tx = x + (rnd() - 0.5) * 0.8, tz = z + (rnd() - 0.5) * 0.8; if (inPoly(P, tx, tz)) tryAt(tx, tz); }
    }
    for (const P of noTuft) for (let k = 0; k < P.pts.length; k++) {   // 脇道(塗った所)のまわり 1〜5m に、まばらに草の株(脇道の上には一切生やさない)
      const [ax, az] = P.pts[k], [bx, bz] = P.pts[(k + 1) % P.pts.length], L = Math.hypot(bx - ax, bz - az); if (L < 6) continue;   // 短い辺(脇道の入口・奥の端)には生やさない
      let nx = -(bz - az) / L, nz = (bx - ax) / L; if (inPoly(P, (ax + bx) / 2 + nx, (az + bz) / 2 + nz)) { nx = -nx; nz = -nz; }
      for (let t = 0; t < L; t += 1.4) for (let o = 0.8; o < 5; o += 1.4) { if (rnd() < 0.7) continue; const x = ax + (bx - ax) * t / L + nx * (o + rnd() * 0.4), z = az + (bz - az) * t / L + nz * (o + rnd() * 0.4), r = roadAt(x, z); if (r && r.d < EDGE + 5) continue; tryAt(x, z); }   // 道から脇道へ入る所(道ぎわ 5m)は空ける
    }
    for (const G of data.grassAreas || []) {   // 座標で決めた草地: 中はぎっしり、外へ fade m かけて、だんだんまばらに
      const P = region(G.pts), fade = G.fade ?? 3;
      for (let x = P.x0 - fade; x <= P.x1 + fade; x += 0.8) for (let z = P.z0 - fade; z <= P.z1 + fade; z += 0.8) {
        const tx = x + (rnd() - 0.5) * 0.7, tz = z + (rnd() - 0.5) * 0.7;
        if (inPoly(P, tx, tz)) { tryAt(tx, tz); continue; }
        const e = edgeDist(P, tx, tz); if (e < fade && rnd() > 0.15 + 0.85 * e / fade) tryAt(tx, tz);
      }
    }
    for (const A of parkAprons) for (let k = 0; k < A.pts.length; k++) {   // 拡張の外まわり
      const [ax, az] = A.pts[k], [bx, bz] = A.pts[(k + 1) % A.pts.length], L = Math.hypot(bx - ax, bz - az); if (L < 0.3) continue;
      let nx = -(bz - az) / L, nz = (bx - ax) / L; if (inPoly(A, (ax + bx) / 2 + nx, (az + bz) / 2 + nz)) { nx = -nx; nz = -nz; }
      for (let t = 0; t < L; t += 0.8) for (let o = 0.1; o < 3; o += 0.9) { if (rnd() < o / 4) continue; tryAt(ax + (bx - ax) * t / L + nx * (o + rnd() * 0.5), az + (bz - az) * t / L + nz * (o + rnd() * 0.5)); }
    }
    if (spots.length) {
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128; const c2 = cv.getContext('2d');
      // 草の葉: 細い線がたくさん立っている形(かたまりにしない)。色は草地の地面とほぼ同じ(画面で rgb(138,168,95) くらい)
      for (let k = 0; k < 90; k++) {
        const x = 3 + Math.random() * 122, h = 40 + Math.random() * 86, lean = (Math.random() - 0.5) * 18;
        // 草地の色に、木々の葉の色を 3 種類まぜる(濃い緑・緑・黄みの緑)
        const pal = [[138, 168, 95], [138, 168, 95], [48, 112, 32], [62, 138, 40], [118, 150, 46]], [cr, cg, cb] = pal[Math.floor(Math.random() * pal.length)];
        const v = 0.9 + Math.random() * 0.2;
        c2.strokeStyle = `rgb(${Math.round(cr * v)},${Math.round(cg * v)},${Math.round(cb * v)})`;
        c2.lineWidth = 0.6 + Math.random() * 0.5;
        c2.beginPath(); c2.moveTo(x, 128); c2.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h); c2.stroke();
      }
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const pos = [], uv = [];
      for (let k = 0; k < 3; k++) { const a = k * Math.PI / 3, cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
        pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 0, -cz, cx, 1, cz, -cx, 1, -cz); uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.3, side: THREE.DoubleSide }), spots.length);   // 光の当たり方で暗くならないよう、色そのまま
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
      spots.forEach(([x, y, z], i) => { const w = 0.7 + rnd() * 0.7; Q.setFromAxisAngle(Y, rnd() * Math.PI); im.setMatrixAt(i, M.compose(V.set(x, y, z), Q, S.set(w, 0.35 + rnd() * 0.45, w))); im.setColorAt(i, C.setHSL(0, 0, 0.95 + rnd() * 0.05)); });   // 色は絵のまま、明るさだけ少しばらつかせる
      im.name = 'akagi-grass-tufts'; im.frustumCulled = false; scenery.add(im);
    }
  }
  const parkedCars = [];   // 駐車場に停まっている車の位置と向き(main.js が CPU 車の模型を置く)
  // ---- 拡張の駐車(parkGuides の黄色い枠の向き): 枠の並びの線を拡張の中でのばし、2.7m おきに車を並べる(ところどころ空ける) ----
  if (data.parkGuides?.length && aprons.length) {
    let sd = 20261120; const rnd = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296);
    const Gd = data.parkGuides, heading = Math.atan2(Gd.reduce((a, g) => a + Math.sin(g[2]), 0), Gd.reduce((a, g) => a + Math.cos(g[2]), 0));
    let cx = Gd.reduce((a, g) => a + g[0], 0) / Gd.length, cz = Gd.reduce((a, g) => a + g[1], 0) / Gd.length;
    let ux = Gd[Gd.length - 1][0] - Gd[0][0], uz = Gd[Gd.length - 1][1] - Gd[0][1]; const ul = Math.hypot(ux, uz);
    if (ul > 0.5) { ux /= ul; uz /= ul; } else { ux = -Math.cos(heading); uz = Math.sin(heading); }   // 並ぶ向き(枠が 1 つなら車の横の向き)
    const A = aprons.find((P) => inPoly(P, cx, cz)) || aprons[0];
    const hx = Math.sin(heading), hz = Math.cos(heading);
    if (data.parkRowShift) {   // 車の列を、車の長さの向きに道路の側へずらす(奥の斜面で浮かないように)
      const rp = route[Math.max(0, nearestRoute(cx, cz, 6).i)], sg = Math.sign((rp.x - cx) * hx + (rp.z - cz) * hz) || 1;
      cx += hx * sg * data.parkRowShift; cz += hz * sg * data.parkRowShift;
    }
    const fits = (x, z) => [[2.3, 1], [2.3, -1], [-2.3, 1], [-2.3, -1]].every(([f, sdd]) => { const px = x + hx * f + ux * sdd, pz = z + hz * f + uz * sdd, r = roadAt(px, pz); return (inPoly(A, px, pz) || aprons.some((P) => inPoly(P, px, pz))) && !inAny(meadows, px, pz) && r && r.d > EDGE + 1.2; });   // 緑地にかかる所には停めない
    for (let k = -80; k <= 80; k++) {
      const x = cx + ux * k * 2.7, z = cz + uz * k * 2.7;
      if (!fits(x, z) || rnd() < 0.61) continue;   // 半分くらいは空ける
      const y = H(x, z) + 0.05;
      const hit = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.6, 4.3), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(x, y + 0.8, z); hit.rotation.y = heading + (rnd() < 0.5 ? 0 : Math.PI); hit.name = 'akagi-parked-car-hit'; scenery.add(hit); hit.updateMatrixWorld(); colliders.push(hit);
      parkedCars.push({ x, z, y, heading: hit.rotation.y });
    }
  }
  // ---- 板の駐車場(slabs)のふち: 板の高さから元の地面の下までコンクリートの側面 ----
  if (slabs.length) {
    const v = [];
    for (const S of slabs) for (let i = 0, j = S.pts.length - 1; i < S.pts.length; j = i++) {
      const a = S.pts[j], b = S.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(L / 1.5));
      for (let t = 0; t < k; t++) {
        const p0 = [a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k], p1 = [a[0] + (b[0] - a[0]) * (t + 1) / k, a[1] + (b[1] - a[1]) * (t + 1) / k];
        const r0 = roadAt(p0[0], p0[1]), r1 = roadAt(p1[0], p1[1]); if (r0 && r1 && Math.min(r0.d, r1.d) < EDGE + 0.5) continue;   // 道に面した辺は作らない
        const sy = (q) => { const k = nearestRoute(q[0], q[1], 4); return route[Math.max(0, k.i)].y - 0.03; }, y0 = sy(p0), y1 = sy(p1), g0 = Math.min(H0(p0[0], p0[1]), y0 - 0.3) - 1, g1 = Math.min(H0(p1[0], p1[1]), y1 - 0.3) - 1;
        v.push(p0[0], g0, p0[1], p1[0], g1, p1[1], p1[0], y1, p1[1], p0[0], g0, p0[1], p1[0], y1, p1[1], p0[0], y0, p0[1]);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'HarunaSlabSide', color: 0x8c8b86, side: THREE.DoubleSide })); m.name = 'haruna-slab-side'; scenery.add(m);
    // 上面: 路面の色の平らな板(細かく割って、各点を近い道の点の高さに)
    const tv = [];
    for (const S of slabs) {
      const sy = (x, z) => { const k = nearestRoute(x, z, 4); return route[Math.max(0, k.i)].y + 0.06; };
      for (let x = S.x0; x < S.x1; x += 1.5) for (let z = S.z0; z < S.z1; z += 1.5) {
        const cs = [[x, z], [x + 1.5, z], [x + 1.5, z + 1.5], [x, z + 1.5]];
        if (!cs.some(([cx, cz]) => inPoly(S, cx, cz))) continue;
        // 升目をふちで切る(三角形の重心が中にあるものだけ。ふちの欠けは下の多角形の三角形で埋める)
        for (const tri of [[0, 1, 2], [0, 2, 3]]) { const P3 = tri.map((t) => cs[t]); const gx = (P3[0][0] + P3[1][0] + P3[2][0]) / 3, gz = (P3[0][1] + P3[1][1] + P3[2][1]) / 3; if (inPoly(S, gx, gz) && P3.every(([px, pz]) => inPoly(S, px, pz))) for (const [px, pz] of P3) tv.push(px, sy(px, pz), pz); }
      }
      for (const t of THREE.ShapeUtils.triangulateShape(S.pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) for (const k of t) tv.push(S.pts[k][0], sy(S.pts[k][0], S.pts[k][1]) - 0.01, S.pts[k][1]);
    }
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tv, 3)); tg.computeVertexNormals();
    const tm = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x4a4c4e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })); tm.name = 'haruna-slab-top'; group.add(tm);
  }
  // ---- 駐車場の広場(lots)の舗装: 1.5m の升目を地面の高さに沿わせる。ふちの外の点は、ふちのいちばん近い所へ寄せる(ギザギザにしない) ----
  if (lots.length) {
    const v = [];
    const onEdge = (P, x, z) => { let best = Infinity, bx = x, bz = z; const q = P.pts; for (let i = 0, j = q.length - 1; i < q.length; j = i++) { const ax = q[j][0], az = q[j][1], dx = q[i][0] - ax, dz = q[i][1] - az, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)), px = ax + dx * t, pz = az + dz * t, dd = (px - x) ** 2 + (pz - z) ** 2; if (dd < best) { best = dd; bx = px; bz = pz; } } return [bx, bz]; };
    for (const P of lots) for (let x = P.x0 - 1.5; x < P.x1 + 1.5; x += 1.5) for (let z = P.z0 - 1.5; z < P.z1 + 1.5; z += 1.5) {
      const cs = [[x, z], [x + 1.5, z], [x + 1.5, z + 1.5], [x, z + 1.5]], ins = cs.map(([a, b]) => inPoly(P, a, b));
      if (!ins.some(Boolean)) continue;
      const q = cs.map(([a, b], k) => (ins[k] ? [a, b] : onEdge(P, a, b)));
      for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const k of tri) { const [a, b] = q[k]; v.push(a, H(a, b) + 0.04, b); }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ name: 'GunmaRoad', color: 0x4a4c4e, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })); m.name = 'haruna-lot'; group.add(m);
  }
  // ---- 塗って決めた緑の金網(nets の折れ線)。高さ 1.5m、支柱 2m おき。当たり判定あり ----
  if (data.nets?.length) {
    const net = [], uvs = [], wall = [], postAt = [], HN = 1.5;
    for (const line of data.nets) for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.round(L / 2));
      for (let t = 0; t < k; t++) {
        const p0 = [a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k], p1 = [a[0] + (b[0] - a[0]) * (t + 1) / k, a[1] + (b[1] - a[1]) * (t + 1) / k], y0 = H(p0[0], p0[1]), y1 = H(p1[0], p1[1]), l = L / k, u0 = t * l / 0.5, u1 = (t + 1) * l / 0.5;
        net.push(p0[0], y0, p0[1], p1[0], y1, p1[1], p1[0], y1 + HN, p1[1], p0[0], y0, p0[1], p1[0], y1 + HN, p1[1], p0[0], y0 + HN, p0[1]);
        uvs.push(u0, 0, u1, 0, u1, HN / 0.5, u0, 0, u1, HN / 0.5, u0, HN / 0.5);
        wall.push(p0[0], y0 - 0.2, p0[1], p1[0], y1 - 0.2, p1[1], p1[0], y1 + 1.3, p1[1], p0[0], y0 - 0.2, p0[1], p1[0], y1 + 1.3, p1[1], p0[0], y0 + 1.3, p0[1]);
        postAt.push([p0[0], y0, p0[1]]); if (t === k - 1) postAt.push([p1[0], y1, p1[1]]);
      }
    }
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const cx = cv.getContext('2d');
    cx.strokeStyle = 'rgba(40,120,80,0.95)'; cx.lineWidth = 2.2;
    for (let k = -64; k < 128; k += 16) { cx.beginPath(); cx.moveTo(k, 0); cx.lineTo(k + 64, 64); cx.stroke(); cx.beginPath(); cx.moveTo(k + 64, 0); cx.lineTo(k, 64); cx.stroke(); }
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(net, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, emissive: 0x0a2416 })); m.name = 'haruna-net'; scenery.add(m);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'haruna-net-wall'; scenery.add(wm); colliders.push(wm);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, HN + 0.05, 0.07), new THREE.MeshLambertMaterial({ color: 0x1f8a5a }), postAt.length), M4 = new THREE.Matrix4();
    postAt.forEach(([x, y, z], k) => posts.setMatrixAt(k, M4.makeTranslation(x, y + (HN + 0.05) / 2, z))); posts.name = 'haruna-net'; posts.computeBoundingSphere(); scenery.add(posts);
  }
  // ---- 塗って決めた建物(houses: { type, r: 長方形の4隅 })。写真をもとにした簡単な形 ----
  for (const Hs of data.houses || []) {
    const r = Hs.r, e01 = Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]), e12 = Math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]);
    const Q = e01 >= e12 ? r : [r[1], r[2], r[3], r[0]], len = Math.max(e01, e12), wid = Math.min(e01, e12);
    const cx = (Q[0][0] + Q[2][0]) / 2, cz = (Q[0][1] + Q[2][1]) / 2, ux = (Q[1][0] - Q[0][0]) / len, uz = (Q[1][1] - Q[0][1]) / len;
    const ys = r.map(([x, z]) => H(x, z)).concat([H(cx, cz)]), y0 = Math.min(...ys), yTop = Math.max(...ys);
    // 道(いちばん近い道の点)の向きを正面(+z の側)にする
    const k0 = nearestRoute(cx, cz, 6), rp = route[Math.max(0, k0.i)], fx = rp.x - cx, fz = rp.z - cz;
    let ang = Math.atan2(-uz, ux); const nzx = Math.sin(ang), nzz = Math.cos(ang); if (nzx * fx + nzz * fz < 0) ang += Math.PI;   // 箱の +z が道を向く
    const g = new THREE.Group(); g.position.set(cx, y0, cz); g.rotation.y = ang; g.name = 'haruna-house-' + Hs.type;
    const lam = (c, o = {}) => new THREE.MeshLambertMaterial(Object.assign({ color: c, side: THREE.DoubleSide }, o));
    const box = (w, h, d, mat, x = 0, y = 0, z = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y + h / 2, z); g.add(b); return b; };
    const plate = (w, h, mat, x, y, z, ry = 0) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); p.position.set(x, y, z); p.rotation.y = ry; g.add(p); return p; };
    const textTex = (lines, w, h, bg, fg, vertical = false) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h); x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
      if (vertical) { const ch = [...lines[0]], fs = Math.min(w * 0.8, h / (ch.length + 0.5)); x.font = `bold ${fs}px sans-serif`; ch.forEach((t, i) => x.fillText(t, w / 2, (i + 0.75) * h / (ch.length + 0.5))); }
      else { const fs = h / (lines.length + 0.6); x.font = `bold ${fs}px sans-serif`; lines.forEach((t, i) => x.fillText(t, w / 2, (i + 0.8) * h / (lines.length + 0.6))); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide }); };
    const dark = lam(0x2a2f35), base = yTop - y0;   // 斜面では床を高い方にそろえ、下は土台で埋める
    const windows = (w, d, h0, rows, cols, mat = dark, ww = 1.0, wh = 0.9) => { for (let rr = 0; rr < rows; rr++) for (let c = 0; c < cols; c++) { const x = -w / 2 + (c + 0.5) * w / cols, y = base + h0 + rr * 3 + 1.6; plate(ww, wh, mat, x, y, d / 2 + 0.03); plate(ww, wh, mat, x, y, -d / 2 - 0.03, Math.PI); } };
    let body = null;
    if (base > 0.05) box(len, base, wid, lam(0x6f6a62));
    if (Hs.type === 'hotel') {   // A: 5 階建てのホテル。うすい桃色の壁、緑の屋根
      const W = len * 0.92, D = wid * 0.92, FL = 5;
      body = box(W, FL * 3, D, lam(0xd9b9b2), 0, base, 0); windows(W, D, 0, FL, Math.max(4, Math.round(W / 3)), dark, 1.6, 1.2);
      const rv = [], hw = W / 2 + 0.4, hd = D / 2 + 0.4, yR = base + FL * 3, rise = 2.2, ix = Math.max(0.5, hw - hd * 0.6), iz = hd * 0.4;
      const q = (a, b2, c, d2) => rv.push(...a, ...b2, ...c, ...a, ...c, ...d2);
      q([-hw, yR, hd], [hw, yR, hd], [ix, yR + rise, iz], [-ix, yR + rise, iz]); q([hw, yR, -hd], [-hw, yR, -hd], [-ix, yR + rise, -iz], [ix, yR + rise, -iz]);
      q([hw, yR, hd], [hw, yR, -hd], [ix, yR + rise, -iz], [ix, yR + rise, iz]); q([-hw, yR, -hd], [-hw, yR, hd], [-ix, yR + rise, iz], [-ix, yR + rise, -iz]); q([-ix, yR + rise, iz], [ix, yR + rise, iz], [ix, yR + rise, -iz], [-ix, yR + rise, -iz]);
      const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3)); rg.computeVertexNormals(); g.add(new THREE.Mesh(rg, lam(0x3e7a68)));
    } else if (Hs.type === 'busoffice') {   // B: 群馬バスの営業所。1 階は白い箱、2 階は少し小さい箱、平らな屋根、看板
      const W = len * 0.9, D = wid * 0.85;
      body = box(W, 3.2, D, lam(0xe8e8e4), 0, base, 0); box(W + 0.6, 0.35, D + 0.6, lam(0x55585c), 0, base + 3.2, 0);
      box(W * 0.75, 2.8, D * 0.7, lam(0xdcdcd6), -W * 0.08, base + 3.55, -D * 0.1); box(W * 0.75 + 0.4, 0.25, D * 0.7 + 0.4, lam(0x8c8f93), -W * 0.08, base + 6.35, -D * 0.1);
      plate(Math.min(5, W * 0.6), 0.9, textTex(['群馬バス'], 512, 96, '#3a3d42', '#ffffff'), 0, base + 3.0, D / 2 + 0.32);
      plate(1.8, 2.2, dark, -W * 0.25, base + 1.1, D / 2 + 0.03); plate(2.4, 1.2, dark, W * 0.2, base + 1.7, D / 2 + 0.03); windows(W * 0.75, D * 0.7, 3.55, 1, 3, dark, 1.2, 0.9);
    } else if (Hs.type === 'house') {   // C: 2 階建て。ベージュの壁、灰色の切妻屋根、1 階に庇
      const W = len * 0.9, D = wid * 0.9;
      body = box(W, 6, D, lam(0xd9d3c6), 0, base, 0); windows(W, D, 0.2, 2, 3, dark, 1.1, 0.9);
      const RISE = Math.min(2, D * 0.3), hw = D / 2 + 0.5, hl = W / 2 + 0.5, rv = [];
      for (const sd of [-1, 1]) rv.push(-hl, base + 6, sd * hw, hl, base + 6, sd * hw, hl, base + 6 + RISE, 0, -hl, base + 6, sd * hw, hl, base + 6 + RISE, 0, -hl, base + 6 + RISE, 0);
      for (const sx of [-1, 1]) rv.push(sx * W / 2, base + 6, -D / 2, sx * W / 2, base + 6, D / 2, sx * W / 2, base + 6 + RISE * (D / 2) / hw, 0);
      const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3)); rg.computeVertexNormals(); g.add(new THREE.Mesh(rg, lam(0x5d6166)));
      box(W, 0.12, 1.2, lam(0xeeeeea), 0, base + 2.8, D / 2 + 0.6);
    } else if (Hs.type === 'toilet') {   // E: 公衆トイレ。上は白壁、下は濃い灰色、黒い瓦の切妻屋根
      const W = len * 0.9, D = wid * 0.85;
      body = box(W, 1.2, D, lam(0x3a3d41), 0, base, 0); box(W, 1.8, D, lam(0xf0efe9), 0, base + 1.2, 0);
      const RISE = Math.min(1.6, D * 0.3), hw = D / 2 + 0.6, hl = W / 2 + 0.6, rv = [], y = base + 3;
      for (const sd of [-1, 1]) rv.push(-hl, y, sd * hw, hl, y, sd * hw, hl, y + RISE, 0, -hl, y, sd * hw, hl, y + RISE, 0, -hl, y + RISE, 0);
      for (const sx of [-1, 1]) rv.push(sx * W / 2, y, -D / 2, sx * W / 2, y, D / 2, sx * W / 2, y + RISE * (D / 2) / hw, 0);
      const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3)); rg.computeVertexNormals(); g.add(new THREE.Mesh(rg, lam(0x2c3036)));
      plate(1.0, 2.0, lam(0x6d5a48), -W * 0.25, base + 1.0, D / 2 + 0.03); plate(1.0, 2.0, lam(0x6d5a48), W * 0.25, base + 1.0, D / 2 + 0.03); plate(1.4, 1.0, lam(0xcfc6a8), 0, base + 1.8, D / 2 + 0.03);
    } else if (Hs.type === 'busSign') {   // D: バスのりばの看板(白い板 3 枚と、緑の頭の青い縦長の板)
      const wood = lam(0x8a8a86);
      for (const x of [-1.3, 0.2, 1.4]) box(0.12, 4.2, 0.12, wood, x, base, 0);
      plate(1.4, 1.1, textTex(['かのうや', 'この先300m'], 256, 200, '#f4f4f0', '#5a2a1a'), -0.55, base + 3.3, 0.08); plate(1.4, 1.1, textTex(['福一', 'この先150m'], 256, 200, '#f4f4f0', '#3a1a10'), -0.55, base + 2.1, 0.08);
      plate(1.4, 1.0, lam(0xf4f4f0), -0.55, base + 0.95, 0.08);
      plate(0.9, 3.4, textTex(['バスのりば'], 96, 360, '#ffffff', '#1f5fb8', true), 0.85, base + 1.9, 0.1); plate(0.9, 0.9, textTex(['榛名湖', '水沢観音', '方面'], 160, 160, '#7ed957', '#1a3a10'), 0.85, base + 4.0, 0.1);
      for (const p of [[-0.55, 3.3], [-0.55, 2.1], [-0.55, 0.95], [0.85, 1.9], [0.85, 4.0]]) plate(p[0] < 0 ? 1.4 : 0.9, p[0] < 0 ? 1.1 : (p[1] > 3 ? 0.9 : 3.4), lam(0xdedede), p[0], base + p[1], 0.06, Math.PI);
    } else if (Hs.type === 'booth') {   // F: 駐車場の管理人の小さな小屋
      body = box(1.8, 2.3, 2.2, lam(0xd8d8d2), 0, base, 0); box(2.2, 0.15, 2.6, lam(0x6b6f74), 0, base + 2.3, 0);
      plate(1.2, 0.8, lam(0x86a7b8), 0, base + 1.5, 1.13); plate(1.2, 0.8, lam(0x86a7b8), 0.92, base + 1.5, 0, Math.PI / 2); plate(0.8, 1.9, lam(0x9a9a94), -0.92, base + 0.95, 0, -Math.PI / 2);
    }
    scenery.add(g); g.updateMatrixWorld(true); if (body) colliders.push(body);
  }
  // ---- 座標で決めた木陰(shadeAreas: { pts, fade, opacity }): まわりの木陰と同じ色味・模様(暗い所に光の斑点)を地面に重ね、外へだんだん薄く ----
  if (data.shadeAreas?.length) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c2 = cv.getContext('2d');
    c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, 128, 128);
    let sd = 20260924; const rr = () => ((sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0) / 4294967296);
    c2.filter = 'blur(1.2px)';
    for (let i = 0; i < 120; i++) { const x = rr() * 128, y = rr() * 128, rx = 1.5 + rr() * 7, ry = 1 + rr() * 4, an = rr() * Math.PI; c2.fillStyle = `rgba(0,0,0,${0.55 + rr() * 0.45})`; for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) { c2.beginPath(); c2.ellipse(x + dx, y + dy, rx, ry, an, 0, Math.PI * 2); c2.fill(); } }
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const v = [], uv = [], col = [];
    // 座標の範囲の中はその色、外へ fade m かけて少しずつ薄く(まわりの木陰と同じ色・模様のグラデーション)
    for (const S of data.shadeAreas) {
      const A = region(S.pts || S), fade = S.fade ?? 0, op = S.opacity ?? 0.3;
      const al = (x, z) => (inPoly(A, x, z) ? 1 : fade > 0 ? 1 - THREE.MathUtils.smoothstep(edgeDist(A, x, z), 0, fade) : 0);
      for (let x = A.x0 - fade; x < A.x1 + fade; x += 1) for (let z = A.z0 - fade; z < A.z1 + fade; z += 1) {
        const cs = [[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]], aa = cs.map(([a, b]) => al(a, b) * op);
        if (aa.every((t) => t <= 0.001)) continue;
        for (const tri of [[0, 1, 2], [0, 2, 3]]) for (const k of tri) { const [a, b] = cs[k], r = roadAt(a, b); v.push(a, H(a, b) + 0.12, b); uv.push(a * 0.07, b * 0.07); col.push(0, 0, 0, r && r.d < EDGE + 0.5 ? 0 : aa[k]); }   // 道の上にはかけない
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, alphaMap: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    m.name = 'haruna-shade-area'; m.renderOrder = 2; scenery.add(m);
  }
  // ---- 塗って決めた駐車(parkCars: [x, z, 向き])。車の見た目は main.js、ここは当たり判定 ----
  for (const [x, z, ang] of data.parkCars || []) {
    const y = H(x, z) + 0.05, hit = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.6, 4.3), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(x, y + 0.8, z); hit.rotation.y = ang; hit.name = 'akagi-parked-car-hit'; scenery.add(hit); hit.updateMatrixWorld(); colliders.push(hit);
    parkedCars.push({ x, z, y, heading: ang });
  }
  // ---- 案内看板(signs、伊香保温泉): 木の柱 2 本に白い板、青い屋根 ----
  for (const [sx, sz] of data.signs || []) {
    // 板の両面に「伊香保温泉」。板は道に沿う向き(両方向から来る車に面が見える)。大きさは 1.5 倍
    const r = nearestRoute(sx, sz), q = route[Math.max(0, r.i)], face = Math.atan2(q.x - sx, q.z - sz) + Math.PI / 2, y = H(sx, sz);
    const sg = new THREE.Group(); sg.name = 'akagi-sign'; sg.position.set(sx, y, sz); sg.rotation.y = face; sg.scale.setScalar(1.5);
    const wood = new THREE.MeshLambertMaterial({ color: 0x3a2618 });
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 320; const c2 = cv.getContext('2d');
    c2.fillStyle = '#e9e6dc'; c2.fillRect(0, 0, 128, 320); c2.strokeStyle = '#3a2618'; c2.lineWidth = 6; c2.strokeRect(3, 3, 122, 314);
    c2.fillStyle = '#111'; c2.textAlign = 'center'; c2.font = 'bold 44px serif'; '伊香保温泉'.split('').forEach((ch, k) => c2.fillText(ch, 74, 56 + k * 50));
    c2.font = 'bold 16px sans-serif'; 'Uターン7km先'.split('').forEach((ch, k) => c2.fillText(ch, 24, 84 + k * 18));
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const add = (geo, mat, x, yy, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, yy, z); sg.add(m); return m; };
    for (const px of [-0.5, 0.5]) add(new THREE.BoxGeometry(0.14, 3.3, 0.14), wood, px, 1.65, 0);
    add(new THREE.BoxGeometry(0.86, 2.15, 0.22), [wood, wood, wood, wood, new THREE.MeshLambertMaterial({ map: tex }), new THREE.MeshLambertMaterial({ map: tex })], 0, 2.05, 0);
    for (let k = 0; k < 6; k++) add(new THREE.BoxGeometry(0.06, 0.65, 0.06), wood, -0.4 + k * 0.16, 0.45, 0);   // 下の格子
    add(new THREE.BoxGeometry(1.0, 0.06, 0.06), wood, 0, 0.78, 0);
    const roof = add(new THREE.BoxGeometry(1.35, 0.08, 0.6), new THREE.MeshLambertMaterial({ color: 0x2f6f8a }), 0, 3.36, 0); roof.rotation.z = 0;
    scenery.add(sg); sg.updateMatrixWorld(true); colliders.push(sg);
  }
  // ---- 駐車場の車 7 台: 駐車場の中に散らばるように置く(奥にかたまらないように。トイレ・出入口のそばは空ける)。当たり判定あり ----
  {
    let seed = 20261117; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const cars = [];
    for (const P of parkings) {
      let ri = 0; for (let i = 1; i < n; i++) if (Math.abs(routeS[i] - P.rampS) < Math.abs(routeS[ri] - P.rampS)) ri = i;
      // 置ける所: 駐車場の中を 3m おきに見て、ふちから 3m 以上内側・道のそば・出入口の前・トイレの前を除く。
      // 向きは駐車場のいちばん長い辺にそろえる(少しだけばらつかせる)
      let longest = 0, baseAng = 0;
      for (let i = 0, j = P.pts.length - 1; i < P.pts.length; j = i++) { const dx = P.pts[i][0] - P.pts[j][0], dz = P.pts[i][1] - P.pts[j][1], l = Math.hypot(dx, dz); if (l > longest) { longest = l; baseAng = Math.atan2(dx, dz); } }
      const cand = [];
      for (let x = P.x0; x <= P.x1; x += 3) for (let z = P.z0; z <= P.z1; z += 3) {
        const r = roadAt(x, z);
        if (!inPoly(P, x, z) || edgeDist(P, x, z) < 3.2 || (r && r.d < EDGE + 9)) continue;
        if (Math.hypot(x - route[ri].x, z - route[ri].z) < 16) continue;                 // 出入口の前は空ける
        if (toiletPts.some(([qx, qz]) => Math.hypot(qx - x, qz - z) < 7)) continue;      // トイレの前は空ける
        cand.push([x, z, baseAng + (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.12]);
      }
      // 散らばるように選ぶ: 1 台目はランダム、そのあとは、もう置いた車からいちばん遠い候補(少しだけ乱数を混ぜる)
      while (cars.length < 7 && cand.length) {
        let bi = 0;
        if (cars.length) { let bd = -1; cand.forEach((c, k) => { const d = Math.min(...cars.map((o) => Math.hypot(o[0] - c[0], o[1] - c[1]))) * (0.75 + 0.5 * rnd()); if (d > bd) { bd = d; bi = k; } }); }
        else bi = Math.floor(rnd() * cand.length);
        const [c] = cand.splice(bi, 1);
        if (cars.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1]) > 5)) cars.push([...c, P.y]);
      }
    }
    // 車の見た目は main.js が CPU 車の模型で置く(parkedCars)。ここでは当たり判定だけ
    cars.forEach(([x, z, ang, y]) => {
      const hit = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.6, 4.3), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(x, y + 0.8, z); hit.rotation.y = ang; hit.name = 'akagi-parked-car-hit'; scenery.add(hit); hit.updateMatrixWorld(); colliders.push(hit);
      parkedCars.push({ x, z, y, heading: ang });
    });
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
      // 自動販売機: 入口の壁に向かって左の横に、同じ向きで 1 台。白い箱に、商品の窓・取り出し口だけのシンプルな形。
      // 建物の子にするので、当たり判定(colliders の建物)もいっしょに効く
      const fx = onX ? Math.sign(l.x) : 0, fz = onX ? 0 : Math.sign(l.z);   // 入口の壁が向く向き(建物から見て)
      const faceHalf = onX ? 3 : 2, wallHalf = onX ? 2 : 3;               // 入口の壁までの距離 / 壁の幅の半分
      const lx = -fz, lz = fx;                                            // 入口に向かって立った人の左
      const vm = new THREE.Group(); vm.name = 'akagi-vending-machine';
      const white = new THREE.MeshLambertMaterial({ color: 0xf2f3f1 });
      const VW = 1.0, VH = 1.83, VD = 0.75;
      const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); vm.add(m); return m; };
      box(VW, VH, VD, white, 0, VH / 2, 0);                                                               // 本体(白)
      box(0.84, 0.78, 0.02, new THREE.MeshLambertMaterial({ color: 0xdfe8ee }), 0, 1.36, VD / 2 + 0.006);    // 商品の窓
      const goods = [0xd23a2a, 0x2f6fc4, 0xe8b830, 0x3a9a4a, 0xf0f0f0, 0x6a3b22, 0xe86f2a, 0x1c1c1c];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 8; c++) {                                          // 見本の缶・ボトル 3 段
        box(0.07, 0.15, 0.03, new THREE.MeshLambertMaterial({ color: goods[(r * 3 + c * 5) % goods.length] }), -0.35 + c * 0.1, 1.1 + r * 0.25, VD / 2 + 0.025);
        box(0.08, 0.025, 0.03, new THREE.MeshLambertMaterial({ color: 0x222222 }), -0.35 + c * 0.1, 1.0 + r * 0.25, VD / 2 + 0.025);   // 押しボタン
      }
      box(0.6, 0.2, 0.03, new THREE.MeshLambertMaterial({ color: 0x2a2d30 }), -0.08, 0.42, VD / 2 + 0.01);   // 取り出し口
      box(0.12, 0.18, 0.03, new THREE.MeshLambertMaterial({ color: 0x5a5f63 }), 0.36, 0.82, VD / 2 + 0.01);  // 硬貨・お札を入れる所
      vm.position.set(fx * (faceHalf - VD / 2) + lx * (wallHalf + 0.2 + VW / 2), -1.6, fz * (faceHalf - VD / 2) + lz * (wallHalf + 0.2 + VW / 2));
      vm.rotation.y = Math.atan2(fx, fz);
      body.add(vm);
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
  if (akagi) addAkagiLamp(-233, 261, 'akagi-lamp-D');

  // ---- 塗った白い柵(fences の折れ線)。高さ 1.1m、支柱 2m おき、横木 2 本。当たり判定あり ----
  if (data.fences?.length) {
    const bar = [], wall = [], postPts = [];
    const quad = (P, A, Bq, y0, y1) => P.push(A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y0, Bq[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y0, A[2], Bq[0], Bq[1] + y1, Bq[2], A[0], A[1] + y1, A[2]);
    for (const line of data.fences) {
      const pts = [];
      for (let k = 0; k + 1 < line.length; k++) { const [ax, az] = line[k], [bx, bz] = line[k + 1], L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / 2)); for (let t = 0; t < m; t++) pts.push([ax + (bx - ax) * t / m, az + (bz - az) * t / m]); }
      pts.push(line[line.length - 1]);
      const P3 = pts.map(([x, z]) => [x, H(x, z), z]);
      for (let k = 0; k + 1 < P3.length; k++) { quad(bar, P3[k], P3[k + 1], 0.96, 1.06); quad(bar, P3[k], P3[k + 1], 0.52, 0.6); quad(wall, P3[k], P3[k + 1], -0.1, 1.2); }
      postPts.push(...P3);
    }
    const white = new THREE.MeshLambertMaterial({ name: 'HarunaFence', color: 0xf2f2ee, emissive: 0x2a2a2a, side: THREE.DoubleSide });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(bar, 3)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, white); m.name = 'haruna-fence'; scenery.add(m);
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wall, 3)); wg.computeVertexNormals();
    const wm = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })); wm.name = 'haruna-fence-wall'; scenery.add(wm); colliders.push(wm);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.1, 1.15, 0.1), white, postPts.length), M4 = new THREE.Matrix4();
    postPts.forEach(([x, y, z], k) => posts.setMatrixAt(k, M4.makeTranslation(x, y + 0.575, z)));
    posts.name = 'haruna-fence'; posts.computeBoundingSphere(); scenery.add(posts);
  }
  // ---- 石垣の台地(terraces): 道の高さより h(1.5m) 高い平らな台。ふちは石垣。上に建物(瓦屋根・白壁)、道の側に階段 ----
  for (const T of data.terraces || []) {
    const pts = T.pts, cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cz = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const r0 = nearestRoute(cx, cz, 60), yRef = route[Math.max(0, r0 ? r0.i : 0)].y, top = yRef + (T.h ?? 1.5);
    // 石垣の模様(灰色の石、目地は暗い)
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c2 = cv.getContext('2d');
    c2.fillStyle = '#4a4a46'; c2.fillRect(0, 0, 128, 128);
    let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let row = 0; row < 4; row++) for (let x = -(row % 2) * 16; x < 128; x += 26 + rnd() * 12) { const g = 120 + rnd() * 50 | 0; c2.fillStyle = `rgb(${g},${g - 4},${g - 10})`; c2.fillRect(x + 2, row * 32 + 2, 22 + rnd() * 10, 28); }
    const stoneTex = new THREE.CanvasTexture(cv); stoneTex.wrapS = stoneTex.wrapT = THREE.RepeatWrapping; stoneTex.colorSpace = THREE.SRGBColorSpace;
    const stone = new THREE.MeshLambertMaterial({ name: 'HarunaStoneWall', map: stoneTex, side: THREE.DoubleSide });
    const v = [], uv = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ya = H(a[0], a[1]) - 0.5, yb = H(b[0], b[1]) - 0.5;
      v.push(a[0], ya, a[1], b[0], yb, b[1], b[0], top, b[1], a[0], ya, a[1], b[0], top, b[1], a[0], top, a[1]);
      uv.push(0, (ya - top) / 2, L / 2, (yb - top) / 2, L / 2, 0, 0, (ya - top) / 2, L / 2, 0, 0, 0);
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); wg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); wg.computeVertexNormals();
    const wall = new THREE.Mesh(wg, stone); wall.name = 'haruna-terrace-wall'; scenery.add(wall); colliders.push(wall);
    const tv = []; for (const t of THREE.ShapeUtils.triangulateShape(pts.map(([x, z]) => new THREE.Vector2(x, z)), [])) for (const k of t) tv.push(pts[k][0], top, pts[k][1]);
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(tv, 3)); tg.computeVertexNormals();
    const tm = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ name: 'HarunaTerraceTop', color: 0x8a8578, side: THREE.DoubleSide })); tm.name = 'haruna-terrace-top'; scenery.add(tm);
    // 階段: 長方形のうち、台の中心から遠い辺が下(地面)、近い辺が上(台の上)
    for (const R4 of T.stairs || []) {
      const mids = [0, 1, 2, 3].map((k) => { const a = R4[k], b = R4[(k + 1) % 4]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; });
      const far = mids.map((m) => Math.hypot(m[0] - cx, m[1] - cz)), lo = T.stairsLowFirst ? 0 : far.indexOf(Math.max(...far)), hi = (lo + 2) % 4;   // stairsLowFirst: 1 辺目(0→1)が下の辺
      const A0 = R4[lo], A1 = R4[(lo + 1) % 4], B0 = R4[(hi + 1) % 4], B1 = R4[hi];   // A0-A1 下の辺、B0-B1 上の辺(A0 と B0 が同じ側)
      const yLo = Math.min(H(mids[lo][0], mids[lo][1]), top - 0.2), N = T.steps || Math.max(3, Math.round((top - yLo) / 0.18)), sv = [];
      const lerp = (P, Q, t) => [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
      const q4 = (a, b, c, d) => sv.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let k = 0; k < N; k++) {
        const t0 = k / N, t1 = (k + 1) / N, y0 = yLo + (top - yLo) * k / N, y1 = yLo + (top - yLo) * (k + 1) / N;
        const p0 = lerp(A0, B0, t0), p1 = lerp(A1, B1, t0), p2 = lerp(A1, B1, t1), p3 = lerp(A0, B0, t1);
        q4([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]);   // 蹴上げ
        q4([p0[0], y1, p0[1]], [p1[0], y1, p1[1]], [p2[0], y1, p2[1]], [p3[0], y1, p3[1]]);   // 踏み面
        for (const [a, b] of [[p0, p3], [p1, p2]]) q4([a[0], yLo - 0.3, a[1]], [b[0], yLo - 0.3, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]);   // 横
      }
      const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sv, 3)); sg.computeVertexNormals();
      const sm = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ name: 'HarunaStairs', color: 0x9a968c, side: THREE.DoubleSide })); sm.name = 'haruna-stairs'; scenery.add(sm);
    }
    // 日本風の塀(T.wall): 台のふちに沿って白い壁(高さ 1.6m、厚さ 0.3m)と黒い瓦の小さな三角屋根。階段の所は開ける
    if (T.wall) {
      const st = (T.stairs || []).map(region), wv = [], rv = [], bv = [], HW = 1.6, TH = 0.15;
      const q4 = (arr, a, b, c, dd) => arr.push(...a, ...b, ...c, ...a, ...c, ...dd);
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.05) continue;
        const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, nx = -uz, nz = ux, k = Math.max(1, Math.round(L / 1));
        for (let t = 0; t < k; t++) {
          const p0 = [a[0] + ux * L * t / k, a[1] + uz * L * t / k], p1 = [a[0] + ux * L * (t + 1) / k, a[1] + uz * L * (t + 1) / k], mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
          if (st.some((P) => inPoly(P, mx, mz) || edgeDist(P, mx, mz) < 0.6)) continue;   // 階段の上り口は開ける
          const y0 = top, y1 = top + HW;
          for (const sd of [-1, 1]) { const o = sd * TH; q4(wv, [p0[0] + nx * o, y0, p0[1] + nz * o], [p1[0] + nx * o, y0, p1[1] + nz * o], [p1[0] + nx * o, y1, p1[1] + nz * o], [p0[0] + nx * o, y1, p0[1] + nz * o]);
            q4(bv, [p0[0] + nx * o * 1.05, y0, p0[1] + nz * o * 1.05], [p1[0] + nx * o * 1.05, y0, p1[1] + nz * o * 1.05], [p1[0] + nx * o * 1.05, y0 + 0.25, p1[1] + nz * o * 1.05], [p0[0] + nx * o * 1.05, y0 + 0.25, p0[1] + nz * o * 1.05]);
            const e = sd * (TH + 0.18); q4(rv, [p0[0] + nx * e, y1 - 0.02, p0[1] + nz * e], [p1[0] + nx * e, y1 - 0.02, p1[1] + nz * e], [p1[0], y1 + 0.28, p1[1]], [p0[0], y1 + 0.28, p0[1]]); }
          q4(wv, [p0[0] - nx * TH, y1, p0[1] - nz * TH], [p1[0] - nx * TH, y1, p1[1] - nz * TH], [p1[0] + nx * TH, y1, p1[1] + nz * TH], [p0[0] + nx * TH, y1, p0[1] + nz * TH]);
        }
      }
      for (const [arr, mat, nm] of [[wv, new THREE.MeshLambertMaterial({ name: 'HarunaWhiteWall', color: 0xf3f1ea, side: THREE.DoubleSide }), 'haruna-wall'], [bv, new THREE.MeshLambertMaterial({ color: 0x3a3a38, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 'haruna-wall-base'], [rv, new THREE.MeshLambertMaterial({ name: 'HarunaKawara', color: 0x22262b, side: THREE.DoubleSide }), 'haruna-wall-roof']]) {
        if (!arr.length) continue; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); g.computeVertexNormals();
        const m = new THREE.Mesh(g, mat); m.name = nm; scenery.add(m); if (nm === 'haruna-wall') colliders.push(m);
      }
    }
    // 建物: 白い壁(高さ 3m)、瓦屋根(切妻、棟は長い向き、軒は 0.6m 出す)
    const rcv = document.createElement('canvas'); rcv.width = 64; rcv.height = 64; const r2 = rcv.getContext('2d');
    r2.fillStyle = '#3c434b'; r2.fillRect(0, 0, 64, 64); r2.fillStyle = '#272c32'; for (let x = 0; x < 64; x += 8) r2.fillRect(x, 0, 2, 64); r2.fillStyle = '#4a525b'; for (let y = 0; y < 64; y += 16) r2.fillRect(0, y, 64, 2);
    const roofTex = new THREE.CanvasTexture(rcv); roofTex.wrapS = roofTex.wrapT = THREE.RepeatWrapping; roofTex.colorSpace = THREE.SRGBColorSpace;
    const roofMat = new THREE.MeshLambertMaterial({ name: 'HarunaKawara', map: roofTex, side: THREE.DoubleSide });
    const wallMat = new THREE.MeshLambertMaterial({ name: 'HarunaWhiteWall', color: 0xf3f1ea, side: THREE.DoubleSide });
    for (const B of T.buildings || []) {
      const e01 = Math.hypot(B[1][0] - B[0][0], B[1][1] - B[0][1]), e12 = Math.hypot(B[2][0] - B[1][0], B[2][1] - B[1][1]);
      const Q = e01 >= e12 ? B : [B[1], B[2], B[3], B[0]];   // Q0-Q1 が長い辺(棟の向き)
      const bx = (Q[0][0] + Q[2][0]) / 2, bz = (Q[0][1] + Q[2][1]) / 2, len = Math.max(e01, e12), wid = Math.min(e01, e12);
      const ux = (Q[1][0] - Q[0][0]) / len, uz = (Q[1][1] - Q[0][1]) / len, ang = Math.atan2(-uz, ux);
      const g = new THREE.Group(); g.position.set(bx, top, bz); g.rotation.y = ang;
      const body = new THREE.Mesh(new THREE.BoxGeometry(len, 3, wid), wallMat); body.position.y = 1.5; g.add(body);
      const base = new THREE.Mesh(new THREE.BoxGeometry(len + 0.05, 0.35, wid + 0.05), new THREE.MeshLambertMaterial({ color: 0x5a4a3a })); base.position.y = 0.17; g.add(base);
      const OV = 0.6, RISE = Math.min(2.2, wid * 0.32), hw = wid / 2 + OV, hl = len / 2 + OV, rv = [], ru = [];
      for (const sd of [-1, 1]) { rv.push(-hl, 3, sd * hw, hl, 3, sd * hw, hl, 3 + RISE, 0, -hl, 3, sd * hw, hl, 3 + RISE, 0, -hl, 3 + RISE, 0); ru.push(0, 0, len / 1.5, 0, len / 1.5, hw / 1.5, 0, 0, len / 1.5, hw / 1.5, 0, hw / 1.5); }
      const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(rv, 3)); rg.setAttribute('uv', new THREE.Float32BufferAttribute(ru, 2)); rg.computeVertexNormals();
      g.add(new THREE.Mesh(rg, roofMat));
      const gv = []; for (const sx of [-1, 1]) gv.push(sx * len / 2, 3, -wid / 2, sx * len / 2, 3, wid / 2, sx * len / 2, 3 + RISE * (wid / 2) / hw, 0);   // 妻の三角(白壁)
      const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gv, 3)); gg.computeVertexNormals(); g.add(new THREE.Mesh(gg, wallMat));
      // 窓と戸(暗い色の板を壁の少し外に)
      const dark = new THREE.MeshLambertMaterial({ color: 0x2a2f33 });
      for (const sd of [-1, 1]) for (let k = -1; k <= 1; k++) { const w = new THREE.Mesh(new THREE.PlaneGeometry(k === 0 ? 1.2 : 0.9, k === 0 ? 2.1 : 0.9), dark); w.position.set(k * len * 0.3, k === 0 ? 1.05 : 1.8, sd * (wid / 2 + 0.02)); if (sd < 0) w.rotation.y = Math.PI; g.add(w); }
      g.name = 'haruna-building'; scenery.add(g); g.updateMatrixWorld(true); colliders.push(body);
    }
  }
  // ---- 森(2D の木)。木陰のある所(akagiGrove。道の木陰の模様と同じ式)は、背の高い木を道のすぐ脇に並べて道にかぶせる。
  //      木陰のない所は、木は道から少し離して、日なたの草むらが見える ----
  {
    let s = 20261114; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const trees = [];
    const terr = (data.terraces || []).map((T) => region(T.pts));
    const noTr = (data.noTrees || []).map(region);   // 塗って決めた「木も草も生やさない所」
    const noTree = (x, z) => noTr.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 3.5) || terr.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 3) || lots.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 2) || (data.houses || []).some((Hs) => { const c = Hs.r.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]); return Math.hypot(c[0] - x, c[1] - z) < 14; }) || inAny(meadows, x, z) || inAny(bushes, x, z) || parkings.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 4) || flats.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 2) || (data.decks || []).some((l) => (Array.isArray(l) ? l : l.pts).some(([dx, dz]) => Math.hypot(dx - x, dz - z) < 8)) || !!onOsmRoad(x, z, 1.2) || (data.sidewalks || []).some((l) => l.some(([sx, sz]) => Math.abs(sx - x) < 6 && Math.abs(sz - z) < 6));   // 草原・草むら・駐車場・アスファルト・砂には木を立てない
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
    // 塗った木々(woods): 中に 3.5m おきくらいでぎっしり
    for (const P of woods) for (let x = P.x0; x <= P.x1; x += 3.5) for (let z = P.z0; z <= P.z1; z += 3.5) {
      const tx = x + (rnd() - 0.5) * 2.5, tz = z + (rnd() - 0.5) * 2.5, r = roadAt(tx, tz);
      if (!inPoly(P, tx, tz) || !r || r.d < RAIL + 0.8 || flats.some((A) => inPoly(A, tx, tz))) continue;
      trees.push([tx, groundHeightAt(tx, tz) - 0.3, tz, 10 + rnd() * 8]);
    }
    // 一車線の横道の両わき: 背の高い木をぎっしり(道に覆いかぶさる)
    for (const S of sideRoads) for (const [x, z, t] of S.cl) for (const sd of [-1, 1]) for (let o = S.hw + 1.2; o < S.hw + 16; o += 2.6 + rnd() * 1.5) {
      if (t < EDGE + 6 || rnd() < 0.25) continue;
      const tx = x + S.uz * sd * o + (rnd() - 0.5) * 1.5, tz = z - S.ux * sd * o + (rnd() - 0.5) * 1.5, r = roadAt(tx, tz);
      if (!r || r.d < RAIL + 2 || flats.some((A) => inPoly(A, tx, tz))) continue;
      trees.push([tx, groundHeightAt(tx, tz) - 0.3, tz, 15 + rnd() * 8]);
    }
    // 塗って決めた木(trees: [x, z, 高さ])
    for (const [x, z, h] of data.trees || []) { const r = roadAt(x, z); if ((r && r.d < RAIL + 1.5) || noTr.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 3.5)) continue; trees.push([x, groundHeightAt(x, z) - 0.3, z, h]); }
    // 木もれ日の木・奥の森などで、道の上・脇道(塗った所)の上にかかったものは外す
    const noSpot = data.noTreeSpots || [];   // 座標で「木を排除」と決めた所
    const noTreeA = (data.noTreeAreas || []).map(region);   // 座標で「この中の木を消す」と決めた範囲
    for (let k = trees.length - 1; k >= 0; k--) { const [x, , z] = trees[k], r = roadAt(x, z); if (noSpot.some(([sx, sz, sr]) => Math.hypot(sx - x, sz - z) < sr) || noTreeA.some((P) => inPoly(P, x, z)) || (r && r.d < RAIL + 0.8) || noTr.some((P) => inPoly(P, x, z) || edgeDist(P, x, z) < 3.5)) trees.splice(k, 1); }
    for (const [x, z, h] of data.treesExact || []) trees.push([x, groundHeightAt(x, z) - 0.3, z, h]);   // 座標で決めた木(その場所にそのまま)
    for (const m of treeBillboards(trees, 'akagi-trees')) scenery.add(m);
  }

  // 道(路肩まで)の外: 草地・森(走ると砂煙、速さが落ちる)
  // 木陰の模様をかける強さ(頂点ごと)。草原・草むら・駐車場は木がないので 0
  const shadeMeshes = [ground]; group.traverse((o) => { if (o.isMesh) shadeMeshes.push(o); }); scenery.traverse((o) => { if (o.name === 'akagi-roadside') shadeMeshes.push(o); });
  for (const mesh of shadeMeshes) {
    const pos = mesh.geometry.getAttribute('position'), mask = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) { const x = pos.getX(k), z = pos.getZ(k); mask[k] = inAny(meadows, x, z) || inAny(bushes, x, z) || inAny(parkings, x, z) || inAny(flats, x, z) ? 0 : 1; }
    mesh.geometry.setAttribute('canopyMask', new THREE.BufferAttribute(mask, 1));
  }
  const softGroundAt = (x, z) => { if (parkings.some((P) => inPoly(P, x, z)) || aprons.some((P) => inPoly(P, x, z)) || sideRoads.some((P) => inPoly(P, x, z))) return false; const r = roadAt(x, z); return !r || r.d > R + SHOULDER + 0.3; };   // 駐車場は舗装
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
  // くだりの暗転を始める所(fadeAt の近くの道の点。榛名山: 駐車場B)
  const fadeIndex = data.fadeAt ? nearestRoute(data.fadeAt[0], data.fadeAt[1], 4).i : null;
  return { fadeIndex, parkedCars, bottomStraight, parkingEnd, meadowFrom, setNight, colliders, softGroundAt, group, ground, scenery, route, tangents, ext, extTangents, extIndices, seam, climb: route[0].y - route[n - 1].y, start, goal, parkingStart,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 }, groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition,
    gridBounds: { minX, maxX, minZ, maxZ } };
}
