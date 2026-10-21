import * as THREE from '../lib/three.module.js';

// 東京駅〜日本橋のステージを three.js で組み立てる。
//  - 元の地図(map_tokyoeki.glb)は地面・線路・川・緑だけ。走行面に使い、色だけ替えて見せる。
//  - 建物の当たり判定は床の形で自前で行う(isBlocked)。
//  - 見た目は map/tokyoeki-city.json(tools/tokyoeki_city.py が地図から作ったもの)から組み立てる。
//      buildings: 建物の柱(床の形 p と高さ h、棟の番号 id)
//      main / narrow: 大通りと細い道の中心線・幅 W・車線数 lanes・歩道の幅 walk
//      asphalt: 車道(交差点を含む)の形(外周 o と穴 h)
//      nodes: 道のつながる点(交差点)   elevated: 高架の三角形
//  - 車線の幅は共通(3.25m)。建物の間に何本入るかで車線数を決め、余りは両側の歩道。
// 地図は 1単位 = 1m、Y が上(tools/prep_tokyoeki.py で整えたもの)。

const LANE = 3.25;
const GROUND = {
  M06_STEEL_SMOKE: 0x9a9b98,      // 元の大通りの路面。車道は自前で描くので、下地は歩道と同じ舗装の色
  M05_GRAPHITE_HAZE: 0x9a9b98,    // 街区の地面(歩道・広場の舗装)
  ASPHALT_06_1K: 0x6e6a64,        // 線路(東京駅の構内)
  F08_FOREST_SHADOW: 0x5f7f46,    // 緑地
  H06_OCEAN_DEPTH: 0x3d6b66,      // 川(日本橋川)
  H07_DEEP_TEAL: 0x335c58,
};
const ASPHALT = 0x3d3f42, CURB = 0xbdbbb5, CONCRETE = 0x8c8f92;

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

// ---- 道路 ----
// 中心線 pts に沿って、車道(幅 lanes×3.25m)・縁石・白線を作る。交差点では線を止め、横断歩道と停止線を引く。
function polyLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
function cutPoly(pts, s0, s1) {
  // 中心線の s0〜s1 m の部分
  const out = []; let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
    const a = Math.max(s0, s), b = Math.min(s1, s + L);
    if (b > a) {
      const p = (t) => [x0 + (x1 - x0) * (t - s) / L, z0 + (z1 - z0) * (t - s) / L];
      if (!out.length) out.push(p(a));
      out.push(p(b));
    }
    s += L;
  }
  return out;
}
function pointAt(pts, t) {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0);
    if (t <= s + L || i + 2 === pts.length) { const f = Math.min(1, Math.max(0, (t - s) / L)); return { x: x0 + (x1 - x0) * f, z: z0 + (z1 - z0) * f, tx: (x1 - x0) / L, tz: (z1 - z0) / L }; }
    s += L;
  }
}
function offsetPoly(pts, d) {
  // 進む向きの左(x,z で (tz,-tx))へ d m ずらす
  return pts.map((p, i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
    return [p[0] + tz * d, p[1] - tx * d];
  });
}
function extendPoly(pts, e) {
  // 両端を e m ずつ延ばす(細い道を大通りの車道までつなぐ)
  const q = pts.map((p) => p.slice());
  const ext = (i, j) => { const L = Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1]) || 1; q[i][0] += (q[i][0] - q[j][0]) / L * e; q[i][1] += (q[i][1] - q[j][1]) / L * e; };
  ext(0, 1); ext(q.length - 1, q.length - 2);
  return q;
}
function disc(x, z, r, y, out) {
  const N = 20;
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, b = (i + 1) / N * Math.PI * 2;
    out.push(x, y, z, x + Math.cos(b) * r, y, z + Math.sin(b) * r, x + Math.cos(a) * r, y, z + Math.sin(a) * r);
  }
}
// 向きを持った箱を、まとめて描くための配列へ足す(ang は y 軸まわり、+z が前)。
const _BOX = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  return { p: g.getAttribute('position').array, n: g.getAttribute('normal').array };
})();
function boxInto(out, cx, cy, cz, sx, sy, sz, ang = 0) {
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let i = 0; i < _BOX.p.length; i += 3) {
    const x = _BOX.p[i] * sx, y = _BOX.p[i + 1] * sy, z = _BOX.p[i + 2] * sz;
    out.p.push(cx + x * c + z * s, cy + y, cz - x * s + z * c);
    const nx = _BOX.n[i], ny = _BOX.n[i + 1], nz = _BOX.n[i + 2];
    out.n.push(nx * c + nz * s, ny, -nx * s + nz * c);
  }
}
function solidMesh(o, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
  const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; return m;
}
const distToSeg = (x, z, a, b) => {
  const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
  return Math.hypot(a[0] + ex * t - x, a[1] + ez * t - z);
};

function buildRoads(data, group) {
  const white = [], yellow = [], curb = [];
  // 車道(交差点を含めた全体の形)は多角形で受け取る。縁石はその縁。
  const shapes = data.asphalt.map((a) => {
    const sh = new THREE.Shape(a.o.map(([x, z]) => new THREE.Vector2(x, z)));
    a.h.forEach((h) => sh.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z)))));
    ribbon([...a.o, a.o[0]], 0.3, 0.03, curb);
    a.h.forEach((h) => ribbon([...h, h[0]], 0.3, 0.03, curb));
    return sh;
  });
  const ag = new THREE.ShapeGeometry(shapes);
  ag.rotateX(Math.PI / 2);                       // (x, y) → (x, 0, y)
  ag.translate(0, 0.012, 0);
  // 交差点: 3本以上の大通りが集まる点。半径はそこに来る車道の半幅の大きい方。
  const inc = new Map();
  for (const s of data.main) for (const n of [s.a, s.b]) if (n) inc.set(n, [...(inc.get(n) || []), s]);
  const radius = new Map();
  for (const [n, list] of inc) if (list.length >= 3) radius.set(n, Math.max(...list.map((s) => Math.max(1, s.lanes) * LANE / 2)) + 0.5);
  for (const s of data.main) {
    const n = Math.max(1, s.lanes), cw = n * LANE, half = cw / 2, L = polyLength(s.pts);
    const ra = radius.get(s.a) || 0, rb = radius.get(s.b) || 0;
    const CW = 4;                                    // 横断歩道の幅
    let s0 = ra ? ra + CW + 2.5 : 0, s1 = L - (rb ? rb + CW + 2.5 : 0);
    const cross = s.lanes >= 2;                       // 横断歩道は片側1車線以上の道だけ(細い道には引かない)
    const crossA = cross && ra && s1 - s0 > 8, crossB = cross && rb && s1 - s0 > 8;
    if (!cross) { s0 = ra; s1 = L - rb; }
    if (!(s1 - s0 > 8)) { s0 = ra; s1 = L - rb; }
    if (s1 - s0 < 3) continue;
    const body = cutPoly(s.pts, s0, s1);
    if (s.lanes >= 2) {
      ribbon(body, 0.15, 0.03, yellow);                                      // 中央線(黄)
      for (let k = 1; k < n / 2; k++) for (const sd of [-1, 1]) ribbon(offsetPoly(body, sd * k * LANE), 0.12, 0.03, white, [5, 5]);   // 車線境界(破線)
    }
    for (const sd of [-1, 1]) ribbon(offsetPoly(body, sd * (half - 0.25)), 0.15, 0.03, white);   // 外側線
    for (const [has, r, atStart] of [[crossA, ra, true], [crossB, rb, false]]) {
      if (!has) continue;
      const sc = atStart ? r + CW / 2 + 0.5 : L - (r + CW / 2 + 0.5);
      const P = pointAt(s.pts, sc), ang = Math.atan2(P.tx, P.tz), nx = P.tz, nz = -P.tx;
      for (let k = -half + 0.8; k < half - 0.6; k += 0.9) rect(P.x + nx * k, P.z + nz * k, ang, CW, 0.45, 0.035, white);
      // 停止線: 交差点へ向かう車線(その向きの左側)。始点側の交差点へは中心線と逆向きに進む。
      const ss = atStart ? sc + CW / 2 + 1.2 : sc - CW / 2 - 1.2;
      const Q = pointAt(s.pts, ss), dx = atStart ? -Q.tx : Q.tx, dz = atStart ? -Q.tz : Q.tz;
      const lx = dz, lz = -dx, w = half - 0.4;
      if (s.lanes >= 2) rect(Q.x + lx * w / 2, Q.z + lz * w / 2, Math.atan2(dx, dz), 0.45, w, 0.035, white);
    }
  }
  // ---- 歩道の柵(片側2車線以上の大通り) ----
  // 縁石のすぐ内側(歩道側)に高さ0.9mの柵。交差点・横断歩道の所と、細い道の入口は空ける。
  const fence = { p: [], n: [] };
  const nearNarrow = (x, z) => data.narrow.some((n) => { for (let i = 0; i + 1 < n.pts.length; i++) if (distToSeg(x, z, n.pts[i], n.pts[i + 1]) < 4.5) return true; return false; });
  for (const s of data.main) {
    if (s.lanes < 4) continue;
    const half = s.lanes * LANE / 2, L = polyLength(s.pts);
    const ra = radius.get(s.a) || 0, rb = radius.get(s.b) || 0;
    const f0 = ra ? ra + 4 + 1.5 : 0, f1 = L - (rb ? rb + 4 + 1.5 : 0);
    if (f1 - f0 < 6) continue;
    for (const sd of [-1, 1]) {
      const line = offsetPoly(cutPoly(s.pts, f0, f1), sd * (half + 0.6));
      const Lf = polyLength(line), n = Math.max(1, Math.round(Lf / 2));
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const P = pointAt(line, Lf * k / n);
        const ok = !nearNarrow(P.x, P.z);
        if (ok) boxInto(fence, P.x, 0.45, P.z, 0.07, 0.9, 0.07);          // 支柱
        if (ok && prev) {                                                   // 上と下の横棒
          const mx = (P.x + prev.x) / 2, mz = (P.z + prev.z) / 2, len = Math.hypot(P.x - prev.x, P.z - prev.z), ang = Math.atan2(P.x - prev.x, P.z - prev.z);
          boxInto(fence, mx, 0.85, mz, 0.06, 0.06, len, ang); boxInto(fence, mx, 0.4, mz, 0.04, 0.04, len, ang);
        }
        prev = ok ? P : null;
      }
    }
  }
  // ---- 信号機(片側2車線以上の道が来る交差点) ----
  // 来る道ごとに、交差点の向こう側の左の角に柱を立て、腕を車線の上へ出して灯を来る車へ向ける。
  // 灯は来る車から見て左から青・黄・赤。交差点の中で向きの近い道どうしを同じ組にし、2組を交互に青にする。
  const sig = { pole: { p: [], n: [] }, head: { p: [], n: [] }, lamps: [0, 1].map(() => [0, 1, 2].map(() => ({ p: [], n: [] }))) };
  let signalCount = 0;
  for (const [node, list] of inc) {
    // 片側2車線以上の道と、片側1車線以上の道が交わる所だけ(細い道との交差には付けない)
    if (list.length < 3 || !list.some((s) => s.lanes >= 4) || list.filter((s) => s.lanes >= 2).length < 3) continue;
    const [cx, cz] = data.nodes[node - 1], r = radius.get(node);
    // 交差点へ向かう向き(道の端の接線)
    let app = list.map((s) => {
      const atStart = s.a === node, L = polyLength(s.pts);
      const P = pointAt(s.pts, atStart ? Math.min(L, r + 8) : Math.max(0, L - r - 8));
      const dx = atStart ? -P.tx : P.tx, dz = atStart ? -P.tz : P.tz;
      return { s, dx, dz };
    });
    // 中央分離帯で2本に分かれた道は、同じ向きの道として1つにまとめる(車線の多い方を残す)。
    app.sort((p, q) => q.s.lanes - p.s.lanes);
    for (let i = app.length - 1; i > 0; i--) if (app.slice(0, i).some((B) => B.dx * app[i].dx + B.dz * app[i].dz > 0.93)) app.splice(i, 1);
    if (app.length < 3) continue;
    const ax = app[0];
    for (const A of app) {
      const grp = Math.abs(A.dx * ax.dx + A.dz * ax.dz) > 0.7 ? 0 : 1;
      const halfA = Math.max(1, A.s.lanes) * LANE / 2;
      const lx = A.dz, lz = -A.dx;                       // 来る車の左
      // 柱は交差点の向こう側の左の歩道。まっすぐ先に続く道があればその歩道、無ければ(丁字路)突き当たりの歩道。
      let B = null, best = -0.7;
      for (const C of app) { const d = A.dx * C.dx + A.dz * C.dz; if (C !== A && d < best) { best = d; B = C; } }
      let px, pz, side;
      if (B) {
        const halfB = Math.max(1, B.s.lanes) * LANE / 2;
        side = halfB + 1.0;
        px = cx + A.dx * (r + 4) + lx * side; pz = cz + A.dz * (r + 4) + lz * side;
      } else {
        const halfC = Math.max(...app.filter((C) => C !== A).map((C) => Math.max(1, C.s.lanes) * LANE / 2));
        side = halfA * 0.5 + 0.5;
        px = cx + A.dx * (halfC + 1.5) + lx * side; pz = cz + A.dz * (halfC + 1.5) + lz * side;
      }
      const reach = Math.max(1.2, Math.min(8, side - halfA / 2));   // 腕: 来る車線(左半分)の真ん中の上まで
      const ang = Math.atan2(lx, lz);
      boxInto(sig.pole, px, 2.8, pz, 0.22, 5.6, 0.22);
      boxInto(sig.pole, px - lx * reach / 2, 5.45, pz - lz * reach / 2, 0.12, 0.12, reach, ang);
      const hx = px - lx * reach, hz = pz - lz * reach;
      const faceAng = Math.atan2(-A.dx, -A.dz);          // 灯の面は来る車の方
      boxInto(sig.head, hx, 5.15, hz, 0.32, 0.45, 1.35, ang);   // 灯の箱(来る車から見て横長)
      for (let k = 0; k < 3; k++) {                       // 左から青・黄・赤
        const off = 0.42 * (1 - k);
        const qx = hx + lx * off - A.dx * 0.18, qz = hz + lz * off - A.dz * 0.18;
        boxInto(sig.lamps[grp][k], qx, 5.15, qz, 0.3, 0.3, 0.05, faceAng);
      }
      signalCount++;
    }
  }
  // 細い道: 両端は大通りの中まで延びているので、線は端から12m内側だけに引く。
  // 1車線は路側帯の線だけ、片側1車線は白の破線の中央線も。
  for (const s of data.narrow) {
    const n = Math.max(1, s.lanes), cw = Math.min(n, 2) * LANE, L = polyLength(s.pts);
    if (L < 30) continue;
    const body = cutPoly(s.pts, 12, L - 12);
    for (const sd of [-1, 1]) ribbon(offsetPoly(body, sd * (cw / 2 - 0.25)), 0.12, 0.03, white);
    if (n >= 2) ribbon(body, 0.12, 0.03, white, [3, 3]);
  }
  const g = new THREE.Group(); g.name = 'tokyoeki-roads';
  const road = new THREE.Mesh(ag, new THREE.MeshLambertMaterial({ color: ASPHALT, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  road.matrixAutoUpdate = false;
  g.add(road, flatMesh(curb, CURB), flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a));
  if (fence.p.length) g.add(solidMesh(fence, new THREE.MeshLambertMaterial({ color: 0xe8ebee })));
  const lampMats = [0, 1].map(() => [0x2fd28a, 0xffc23a, 0xff3a2a].map((c) => new THREE.MeshLambertMaterial({ color: 0x2b2f35, emissive: c, emissiveIntensity: 0 })));
  if (sig.pole.p.length) {
    g.add(solidMesh(sig.pole, new THREE.MeshLambertMaterial({ color: 0x8a8f96 })), solidMesh(sig.head, new THREE.MeshLambertMaterial({ color: 0x4f555c })));
    sig.lamps.forEach((grp, i) => grp.forEach((o, k) => { if (o.p.length) g.add(solidMesh(o, lampMats[i][k])); }));
  }
  group.add(g);
  document.body.dataset.tokyoEkiSignals = String(signalCount);
  // 信号の切り替え(全部の交差点で同じ周期): 組0 青0-14 黄14-17 赤17-32 / 組1 赤0-17 青17-29 黄29-32
  let phase = '';
  return {
    update(t) {
      const c = t % 32;
      const st = [c < 14 ? 0 : c < 17 ? 1 : 2, c >= 17 && c < 29 ? 0 : c >= 29 ? 1 : 2];
      const key = st.join();
      if (key === phase) return; phase = key;
      lampMats.forEach((mats, i) => mats.forEach((m, k) => { m.emissiveIntensity = k === st[i] ? 1.6 : 0; m.color.setHex(k === st[i] ? 0xffffff : 0x2b2f35); }));
    },
  };
}

// 建物の当たり判定: 床の形(多角形)を 16m 角の升目に登録し、点の周り半径 R に建物があるかを調べる。
function makeBlocker(buildings) {
  const CELL = 16, grid = new Map();
  const polys = buildings.map((b) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of b.p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    return { p: b.p, x0, z0, x1, z1 };
  });
  polys.forEach((P, i) => {
    for (let gx = Math.floor(P.x0 / CELL); gx <= Math.floor(P.x1 / CELL); gx++)
      for (let gz = Math.floor(P.z0 / CELL); gz <= Math.floor(P.z1 / CELL); gz++) {
        const k = gx + ',' + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const inside = (p, x, z) => {
    let c = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, zi] = p[i], [xj, zj] = p[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const nearEdge = (p, x, z, r) => {
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [ax, az] = p[j], [bx, bz] = p[i], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
      if (Math.hypot(ax + ex * t - x, az + ez * t - z) < r) return true;
    }
    return false;
  };
  return (x, z, r = 0.3) => {
    const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!list) return false;
    for (const i of list) {
      const P = polys[i];
      if (x < P.x0 - r || x > P.x1 + r || z < P.z0 - r || z > P.z1 + r) continue;
      if (inside(P.p, x, z) || nearEdge(P.p, x, z, r)) return true;
    }
    return false;
  };
}

// ---- 建物 ----
// 床の形 p を高さ h まで立ち上げた柱。壁は窓の模様(棟ごとに種類と色)、屋上は少し暗い単色。
function buildBuildings(data, group, wallMats, roofMat) {
  const tallest = new Map();
  for (const b of data.buildings) tallest.set(b.id, Math.max(tallest.get(b.id) || 0, b.h));
  const look = new Map();
  const lookOf = (id) => {
    if (look.has(id)) return look.get(id);
    const R = seeded(id * 131 + 17), h = tallest.get(id);
    let style;
    if (h > 70) style = R() < 0.75 ? 2 : 0;
    else if (h > 30) style = [0, 0, 1, 1, 4, 2][Math.floor(R() * 6)];
    else style = [1, 1, 3, 3, 4, 0][Math.floor(R() * 6)];
    const base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
    const L = { style, color: new THREE.Color(base), roof: new THREE.Color(base).multiplyScalar(0.72) };
    look.set(id, L); return L;
  };
  const walls = STYLES.map(() => ({ p: [], u: [], c: [], n: [] }));
  const roofs = { p: [], c: [], n: [] };
  for (const b of data.buildings) {
    const L = lookOf(b.id), S = STYLES[L.style], W = walls[L.style], h = b.h, pts = b.p;
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[(i + 1) % pts.length], len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
      const u0 = s / S.tileW, u1 = (s + len) / S.tileW, v1 = h / S.tileH;
      W.p.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, 0, z0, x1, h, z1, x0, h, z0);
      W.u.push(u0, 0, u1, 0, u1, v1, u0, 0, u1, v1, u0, v1);
      for (let k = 0; k < 6; k++) { W.c.push(L.color.r, L.color.g, L.color.b); W.n.push(nx, 0, nz); }
      s += len;
    }
    // 屋上
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
    const sg = new THREE.ShapeGeometry(shape);
    const sp = sg.getAttribute('position'), idx = sg.index ? sg.index.array : null;
    const cnt = idx ? idx.length : sp.count;
    for (let k = 0; k < cnt; k++) {
      const v = idx ? idx[k] : k;
      roofs.p.push(sp.getX(v), h, sp.getY(v)); roofs.c.push(L.roof.r, L.roof.g, L.roof.b); roofs.n.push(0, 1, 0);
    }
    sg.dispose();
  }
  const mk = (o, mat, uv) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
    if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(o.u, 2));
    const m = new THREE.Mesh(g, mat); m.matrixAutoUpdate = false; return m;
  };
  const g = new THREE.Group(); g.name = 'tokyoeki-buildings';
  walls.forEach((w, i) => { if (w.p.length) g.add(mk(w, wallMats[i], true)); });
  g.add(mk(roofs, roofMat, false));
  group.add(g);
  return look.size;
}

// 高架(高速道路)は元の地図の三角形をそのまま、コンクリートの色で描く。
function buildElevated(data, group) {
  const p = [];
  for (const t of data.elevated) for (const v of t) p.push(v[0], v[1], v[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide }));
  m.name = 'tokyoeki-elevated'; m.matrixAutoUpdate = false;
  group.add(m);
}

export function decorateTokyoEki(root) {
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
  // 元の地図: 地面などは色を替えて見せ、建物は隠す(当たり判定には残る)。
  const groundMats = new Map();
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const name = (mesh.material?.name || '').trim().toUpperCase();
    if (name === 'F08_FOREST_SHADOW') { mesh.visible = false; return; }   // 元の植え込みは道路と重なるので見せない
    if (GROUND[name] !== undefined) {
      if (!groundMats.has(name)) { const m = new THREE.MeshLambertMaterial({ color: GROUND[name], side: THREE.DoubleSide }); m.name = mesh.material.name; groundMats.set(name, m); }
      mesh.material = groundMats.get(name);
    } else {
      mesh.visible = false;
    }
  });
  const city = new THREE.Group(); city.name = 'tokyoeki-city';
  let blocked = () => false;
  let roads = null, clock = 0;
  (root.parent || root).add(city);
  fetch('map/tokyoeki-city.json?v=20261022-6').then((r) => r.json()).then((data) => {
    // 地面の下地(元の地図の地面には建物の跡の穴があるので、その下を舗装の色で埋める)
    const lg = new THREE.ShapeGeometry(new THREE.Shape(data.land.map(([x, z]) => new THREE.Vector2(x, z))));
    lg.rotateX(Math.PI / 2); lg.translate(0, -0.03, 0);
    const land = new THREE.Mesh(lg, new THREE.MeshLambertMaterial({ color: GROUND.M05_GRAPHITE_HAZE, side: THREE.DoubleSide }));
    land.matrixAutoUpdate = false; city.add(land);
    roads = buildRoads(data, city);
    blocked = makeBlocker(data.buildings);
    const n = buildBuildings(data, city, wallMats, roofMat);
    buildElevated(data, city);
    document.body.dataset.tokyoEkiBuildings = String(n);
    document.body.dataset.tokyoEkiRoads = String(data.main.length + data.narrow.length);
  }).catch((e) => console.warn('[tokyoeki] city', e));
  return {
    // 建物にぶつかるか(半径 R の円)。データを読み込むまでは何も無い。
    isBlocked: (x, z, R) => blocked(x, z, R),
    // 信号を進める
    update(dt) { clock += dt; roads?.update(clock); },
    // 夜は窓を光らせる。
    setNight(on) { glowMaterials.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); },
  };
}
