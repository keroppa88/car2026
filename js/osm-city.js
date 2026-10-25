import * as THREE from '../lib/three.module.js';

// 日本橋ステージ: OpenStreetMap のデータ(map/nihonbashi-city.json、tools/osm_to_city.py で作る)から街を組み立てる。
//  - 道路: OSM の道の中心線に、車線数 × 3.25m の幅で路面を敷く。上下線が別の道(一方通行の片側)はそのまま並ぶ。
//  - 白線: 車線の境(白の破線)、外側線。対面通行の道は中央線(片側2車線以上は黄、それ以外は白の破線)。
//    一方通行の片側の道は、進む向きの右の端(中央分離側)を黄色にする。交差点の中は線を引かない。
//  - 建物: OSM の建物の形を立ち上げる。高さは階数(×3.5m)、無ければ広さから決める。窓の模様は棟ごと。
//  - 水: 川の面。橋の道の上は走れ、それ以外の水には入れない。
//  - 首都高: 高さ9.5mの高架(見た目だけ)。
// 地図データ © OpenStreetMap contributors (ODbL)

const LANE = 3.25;
const ASPHALT = 0x3d3f42, WALK = 0xa7a8a4, GRASS = 0x6f9a4f, WATER = 0x3d6b66, CONCRETE = 0x8e9196;
const WALL_COLORS = [
  0xe8e4da, 0xd9d3c4, 0xcfc8b8, 0xbfc5c9, 0xb4b8bb, 0xa9a49a, 0xd6cfbe,
  0xc9bfae, 0x9fa6ab, 0xe2dccd, 0xb9ab95, 0x8f9498, 0xcfd3d6, 0xa3988a,
];
// ニューヨーク: れんが・砂岩・石灰岩。香港: 白・クリーム・淡い色のマンション。
const NY_COLORS = [0x8a5a44, 0xa0654c, 0xb98a6a, 0xc9b79c, 0xb8a58a, 0x9b8b7a, 0x7d5242];
const HK_COLORS = [0xe9e3d3, 0xd8e2e6, 0xe6d6c8, 0xcfd8c4, 0xe3d9e6, 0xf0ece2, 0xc9d3db];
const GLASS_COLORS = [0x9fb4c4, 0x8ea6b8, 0xa9bccb, 0x7f97aa, 0xb3c3cf];

// 窓の模様の種類。1枚の絵 = 横 bays 区画 × 縦 floors 階。tileW・tileH はその実寸(m)。
const STYLES = [
  { name: 'band', bays: 4, floors: 4, tileW: 12, tileH: 14.4 },     // 横長の帯窓(オフィス)
  { name: 'punch', bays: 4, floors: 4, tileW: 12, tileH: 14.0 },    // 四角い窓が並ぶ
  { name: 'curtain', bays: 4, floors: 4, tileW: 8, tileH: 16.0 },   // ガラス張り(高層)
  { name: 'house', bays: 4, floors: 4, tileW: 12, tileH: 11.6 },    // 小さな窓とベランダ(低層)
  { name: 'slit', bays: 4, floors: 4, tileW: 8, tileH: 14.4 },      // 縦長の細い窓
  { name: 'grid', bays: 6, floors: 4, tileW: 10.8, tileH: 15.6 },   // 石の格子に四角い窓(丸の内のビル)
  { name: 'classic', bays: 4, floors: 4, tileW: 12, tileH: 19.2 },  // 縦長の大きな窓と軒の帯(戦前の石造り)
  { name: 'fin', bays: 8, floors: 4, tileW: 9.6, tileH: 16.0 },     // ガラスに縦のルーバー(新しい高層)
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
    } else if (style.name === 'grid') {
      for (let b = 0; b < style.bays; b++) {
        const x0 = b * bw;
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x0 + bw * 0.14, y0 + fh * 0.18, bw * 0.72, fh * 0.6);   // 彫りの影
        g.fillStyle = glass; g.fillRect(x0 + bw * 0.2, y0 + fh * 0.24, bw * 0.6, fh * 0.52);
        g.fillStyle = frame; g.fillRect(x0 + bw * 0.49, y0 + fh * 0.24, bw * 0.03, fh * 0.52);
        if (lit()) { e.fillStyle = litColor(); e.fillRect(x0 + bw * 0.2, y0 + fh * 0.24, bw * 0.6, fh * 0.52); }
      }
    } else if (style.name === 'classic') {
      g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, y0 + fh * 0.9, W, fh * 0.1);   // 軒の帯
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, y0 + fh * 0.88, W, fh * 0.03);
      for (let b = 0; b < style.bays; b++) {
        const x0 = b * bw;
        g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(x0 + bw * 0.24, y0 + fh * 0.08, bw * 0.52, fh * 0.74);   // 窓の縁取り
        g.fillStyle = glass; g.fillRect(x0 + bw * 0.29, y0 + fh * 0.12, bw * 0.42, fh * 0.66);
        g.fillStyle = frame; g.fillRect(x0 + bw * 0.49, y0 + fh * 0.12, bw * 0.02, fh * 0.66); g.fillRect(x0 + bw * 0.29, y0 + fh * 0.5, bw * 0.42, fh * 0.02);
        if (lit()) { e.fillStyle = litColor(); e.fillRect(x0 + bw * 0.29, y0 + fh * 0.12, bw * 0.42, fh * 0.66); }
      }
    } else if (style.name === 'fin') {
      g.fillStyle = '#4f6274'; g.fillRect(0, y0, W, fh);
      g.fillStyle = '#c4ccd2'; g.fillRect(0, y0 + fh - 4, W, 4);
      for (let b = 0; b < style.bays; b++) {
        if (lit()) { e.fillStyle = litColor(); e.fillRect(b * bw + 6, y0 + 2, bw - 12, fh - 8); }
        g.fillStyle = '#e4e7e9'; g.fillRect(b * bw - 3, y0, 6, fh);   // 縦のルーバー
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
    if (style.name !== 'curtain' && style.name !== 'fin') { g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(0, y0, W, 2); }
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
  // 三角形の向きを上向きにそろえる(裏向きだと両面表示で暗く塗られる)
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ux = positions[i + 3] - positions[i], uz = positions[i + 5] - positions[i + 2];
    const vx = positions[i + 6] - positions[i], vz = positions[i + 8] - positions[i + 2];
    if (uz * vx - ux * vz < 0) {
      for (let k = 0; k < 3; k++) { const a = positions[i + 3 + k]; positions[i + 3 + k] = positions[i + 6 + k]; positions[i + 6 + k] = a; }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const n = new Float32Array(positions.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(g, m); mesh.matrixAutoUpdate = false; mesh.name = 'tokyoeki-markings';
  return mesh;
}

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



function polyFill(rings, y, color) {
  // rings: [{o, h}] → 上向きの面
  const shapes = rings.map(({ o, h }) => {
    const sh = new THREE.Shape(o.map(([x, z]) => new THREE.Vector2(x, -z)));
    (h || []).forEach((hh) => sh.holes.push(new THREE.Path(hh.map(([x, z]) => new THREE.Vector2(x, -z)))));
    return sh;
  });
  const g = new THREE.ShapeGeometry(shapes);
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);       // (x, y) → (x, 0, -y) なので z = z
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  m.matrixAutoUpdate = false; return m;
}
function disc(x, z, r, y, out) {
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
    out.push(x, y, z, x + Math.sin(b) * r, y, z + Math.cos(b) * r, x + Math.sin(a) * r, y, z + Math.cos(a) * r);
  }
}
const roadWidth = (r) => (r.lanes === 1 && !r.oneway ? 4.5 : r.lanes * LANE);
function polyLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; }
function cumLen(p) { const s = [0]; for (let i = 1; i < p.length; i++) s.push(s[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1])); return s; }
function cut(p, s, a, b) {
  const out = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const A = Math.max(a, s[i]), B = Math.min(b, s[i + 1]); if (B <= A) continue;
    const L = s[i + 1] - s[i] || 1, at = (t) => [p[i][0] + (p[i + 1][0] - p[i][0]) * (t - s[i]) / L, p[i][1] + (p[i + 1][1] - p[i][1]) * (t - s[i]) / L];
    if (!out.length) out.push(at(A)); out.push(at(B));
  }
  return out;
}
function offset(p, d) {
  return p.map((q, i) => {
    const a = p[Math.max(i - 1, 0)], b = p[Math.min(i + 1, p.length - 1)], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [q[0] + (b[1] - a[1]) / L * d, q[1] - (b[0] - a[0]) / L * d];     // 進む向きの左へ d
  });
}

function buildRoads(data, g) {
  const asphalt = [], white = [], yellow = [], placedCw = [], deck = [];
  // 交差点の点と、その半径(集まる道の半幅の最大)
  const J = new Map();
  for (const r of data.roads) for (const i of r.junctions) {
    const k = r.pts[i].join(','); J.set(k, Math.max(J.get(k) || 0, roadWidth(r) / 2));
  }
  for (const r of data.roads) {
    const w = roadWidth(r), half = w / 2, p = r.pts;
    if (r.bridge) ribbon(p, w + 6, 0.05, deck);   // 橋の床(上下線のすき間と歩道)
    ribbon(p, w, r.bridge ? 0.06 : 0.04, asphalt);
    for (let i = 1; i + 1 < p.length; i++) disc(p[i][0], p[i][1], half, r.bridge ? 0.06 : 0.04, asphalt);   // 折れ目のすき間を埋める
    // 線を引く区間: 交差点の点のまわり(半径 + 1.5m)を除く
    const s = cumLen(p), L = s.at(-1), holes = [];
    for (const i of r.junctions) { const R = (J.get(p[i].join(',')) || half) + 1.5; holes.push([s[i] - R, s[i] + R]); }
    holes.sort((a, b) => a[0] - b[0]);
    const spans = []; let x = 0;
    for (const [a, b] of holes) { if (a > x) spans.push([x, a]); x = Math.max(x, b); }
    if (L > x) spans.push([x, L]);
    for (const [a, b] of spans) {
      if (b - a < 3) continue;
      const body = cut(p, s, a, b);
      if (body.length < 2) continue;
      if (r.oneway) {
        for (let k = 1; k < r.lanes; k++) ribbon(offset(body, half - k * LANE), 0.12, 0.08, white, [5, 5]);
        ribbon(offset(body, half - 0.25), 0.15, 0.08, white);              // 左の外側線
        ribbon(offset(body, -(half - 0.25)), 0.15, 0.08, r.lanes >= 2 ? yellow : white);   // 右(中央分離側)
      } else if (r.lanes >= 2) {
        const per = Math.floor(r.lanes / 2);
        ribbon(body, 0.15, 0.08, per >= 2 ? yellow : white, per >= 2 ? null : [5, 5]);
        for (let k = 1; k < per; k++) for (const sd of [-1, 1]) ribbon(offset(body, sd * k * LANE), 0.12, 0.08, white, [5, 5]);
        for (const sd of [-1, 1]) ribbon(offset(body, sd * (half - 0.25)), 0.15, 0.08, white);
      } else {
        for (const sd of [-1, 1]) ribbon(offset(body, sd * (half - 0.4)), 0.12, 0.08, white);   // 路側帯
      }
    }
    // 横断歩道(橋の上には置かない): 片側2車線以上の道(一方通行の片側は2車線以上)の、交差点の手前
    if (!r.bridge && (r.oneway ? r.lanes >= 2 : r.lanes >= 4)) {
      for (const i of r.junctions) {
        const R = (J.get(p[i].join(',')) || half) + 1.5;
        for (const sc of [s[i] - R - 2.2, s[i] + R + 2.2]) {
          if (sc < 4 || sc > L - 4) continue;
          const seg = cut(p, s, sc - 0.01, sc + 0.01); if (seg.length < 2) continue;
          const [[ax, az], [bx, bz]] = seg, dl = Math.hypot(bx - ax, bz - az) || 1, tx = (bx - ax) / dl, tz = (bz - az) / dl;
          const ang = Math.atan2(tx, tz);
          // 同じ向きの横断歩道が近くにあれば作らない
          if (placedCw.some(c => {
            const dx = c[0] - ax, dz = c[1] - az;
            return Math.abs(Math.sin(c[2] - ang)) < 0.3 && Math.abs(dx * tx + dz * tz) < 30 && Math.abs(dx * tz - dz * tx) < half;
          })) continue;
          placedCw.push([ax, az, ang]);
          for (let o = -half + 0.6; o < half - 0.4; o += 0.9) rect(ax + tz * o, az - tx * o, ang, 4, 0.45, 0.085, white);
        }
      }
    }
  }
  g.add(flatMesh(deck, 0xb4b4ae), flatMesh(asphalt, ASPHALT), flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a));
}

function buildElevated(data, g) {
  const deck = { p: [], n: [] }, EH = data.elevH ?? 9.5;
  for (const e of data.elevated) {
    const w = e.lanes * LANE + 1.5, p = e.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.2) continue;
      const ang = Math.atan2(x1 - x0, z1 - z0);
      boxInto(deck, (x0 + x1) / 2, EH, (z0 + z1) / 2, w, 1.4, L + 0.6, ang);
      for (const sd of [-1, 1]) boxInto(deck, (x0 + x1) / 2 + Math.cos(ang) * sd * (w / 2 - 0.2), EH + 1.3, (z0 + z1) / 2 - Math.sin(ang) * sd * (w / 2 - 0.2), 0.35, 1.1, L + 0.6, ang);
    }
  }
  const m = solidMesh(deck, new THREE.MeshLambertMaterial({ color: CONCRETE })); m.name = 'shutoko'; g.add(m);
}

// ---- 線路の高架・ホーム・ホームの屋根(OSM の railway / building=roof から) ----
function slab(rings, y0, depth, out) {
  // 多角形を厚み depth の板にして y0 の高さに置く
  for (const { o, h } of rings) {
    const sh = new THREE.Shape(o.map(([x, z]) => new THREE.Vector2(x, -z)));
    (h || []).forEach((hh) => sh.holes.push(new THREE.Path(hh.map(([x, z]) => new THREE.Vector2(x, -z)))));
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false }).toNonIndexed();
    g.rotateX(-Math.PI / 2); g.translate(0, y0, 0); g.computeVertexNormals();
    out.p.push(...g.getAttribute('position').array); out.n.push(...g.getAttribute('normal').array);
    g.dispose();
  }
}
function buildRailways(data, g, onRoad) {
  const deck = { p: [], n: [] }, rail = [];
  for (const rl of data.rails || []) {
    const p = rl.pts; let acc = 0;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.2) continue;
      const H = rl.hs ? (rl.hs[i] + rl.hs[i + 1]) / 2 : rl.h;
      const ang = Math.atan2(x1 - x0, z1 - z0), tx = (x1 - x0) / L, tz = (z1 - z0) / L;
      boxInto(deck, (x0 + x1) / 2, H - 0.8, (z0 + z1) / 2, 5.4, 1.6, L + 0.5, ang);
      for (const sd of [-0.75, 0.75]) rect((x0 + x1) / 2 + tz * sd, (z0 + z1) / 2 - tx * sd, ang, L, 0.14, H + 0.04, rail);
      // 高架の下: 道路が通る所だけあけて、ほかは下までふさぐ(4m ごとに判定)
      const n = Math.max(1, Math.round(L / 4)), sl = L / n;
      for (let k = 0; k < n; k++) {
        const s = (k + 0.5) * sl, px = x0 + tx * s, pz = z0 + tz * s;
        if (!onRoad(px, pz)) boxInto(deck, px, (H - 1.6) / 2, pz, 5.0, H - 1.6, sl + 0.05, ang);
      }
      acc += L;
    }
  }
  const pf = { p: [], n: [] };
  for (const q of data.platforms || []) if (q.y > 0) slab([q], q.y, 1.1, pf);
  const roof = { p: [], n: [] };
  for (const c of data.canopies || []) slab([{ o: c.o, h: [] }], c.y, 0.5, roof);
  const m1 = solidMesh(deck, new THREE.MeshLambertMaterial({ color: 0xa3a5a4 })); m1.name = 'rail-viaduct'; g.add(m1);
  const m2 = solidMesh(pf, new THREE.MeshLambertMaterial({ color: 0xbdbcb6 })); g.add(m2);
  const m3 = solidMesh(roof, new THREE.MeshLambertMaterial({ color: 0xd6d8d9, side: THREE.DoubleSide })); m3.name = 'platform-roof'; g.add(m3);
  if (rail.length) g.add(flatMesh(rail, 0x4a4540));
}

// ---- 首都高・KK線(PLATEAU の橋梁モデルの形)。見た目だけで、下はくぐれる ----
function buildBridges(br, g) {
  const top = { p: [], n: [] }, side = { p: [], n: [] };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3();
  const put = (arr, o) => {
    for (let k = 0; k + 8 < arr.length; k += 9) {
      A.set(arr[k], arr[k + 1], arr[k + 2]); B.set(arr[k + 3], arr[k + 4], arr[k + 5]); C.set(arr[k + 6], arr[k + 7], arr[k + 8]);
      N.subVectors(B, A).cross(T.subVectors(C, A)); if (N.lengthSq() < 1e-8) continue; N.normalize();
      for (const P of [A, B, C]) { o.p.push(P.x, P.y, P.z); o.n.push(N.x, N.y, N.z); }
    }
  };
  for (const b of br.bridges) { put(b.top, top); put(b.side, side); }
  const m1 = solidMesh(top, new THREE.MeshLambertMaterial({ color: 0x5d6064, side: THREE.DoubleSide })); m1.name = 'shutoko-deck'; g.add(m1);
  const m2 = solidMesh(side, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide })); m2.name = 'shutoko'; g.add(m2);
}

const SMALL_AREA = 150;   // これより小さい建物(m²)は出入口・小屋などの構築物とみなす
function buildBuildings(data, g, wallMats, roofMat) {
  const walls = STYLES.map(() => ({ p: [], u: [], c: [], n: [], f: [] }));
  const plain = { p: [], u: [], c: [], n: [], f: [] };   // 小さい構築物: 窓なしのグレー一色
  const roofShapes = [];
  data.buildings.forEach((b, i) => {
    const R = seeded(i * 131 + 17);
    const pts = b.p; let a = 0;
    for (let k = 0; k < pts.length; k++) { const [x0, z0] = pts[k], [x1, z1] = pts[(k + 1) % pts.length]; a += x0 * z1 - x1 * z0; }
    const area = Math.abs(a) / 2;
    // 高さが分からない建物: 小さいもの(出入口・小屋・住宅)は低く
    let h = b.h ?? (area < 400 ? 4 + R() * 5 : Math.min(70, 10 + Math.sqrt(area) * 0.9 * (0.6 + R() * 0.8)));
    h = Math.max(4, h);
    const lk = b.look;
    let style = h > 50 ? [0, 0, 1, 2, 4][Math.floor(R() * 5)] : [1, 1, 3, 4, 0][Math.floor(R() * 5)];
    const base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
    if (lk && lk.style != null) style = lk.style;
    const small = area < SMALL_AREA && !lk;
    const col = new THREE.Color(small ? 0x9a9c9e : (lk?.wall ?? base)), S = STYLES[style], W = small ? plain : walls[style];
    // 高さで色を分ける帯: [下, 上, 色, 1階の出入口を描くか]
    const bands = lk
      ? [[0, lk.base ? lk.baseH : 0, new THREE.Color(lk.base ?? 0), 0], [lk.base ? lk.baseH : 0, lk.top ? h - lk.topH : h, col, 0], [lk.top ? h - lk.topH : h, h, new THREE.Color(lk.top ?? 0), 0]].filter((x) => x[1] > x[0])
      : [[0, h, col, 1]];
    const ccw = a > 0;      // x-z 平面での向き
    const wall = (ring) => {
      let s = 0;
      for (let k = 0; k < ring.length; k++) {
        const [x0, z0] = ring[k], [x1, z1] = ring[(k + 1) % ring.length], len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.05) continue;
        let nx = (z1 - z0) / len, nz = -(x1 - x0) / len; if (ccw) { nx = -nx; nz = -nz; }
        const u0 = s / S.tileW, u1 = (s + len) / S.tileW;
        for (const [ya, yb, bc, sf] of bands) {
          const va = ya / S.tileH, vb = yb / S.tileH;
          W.p.push(x0, ya, z0, x1, ya, z1, x1, yb, z1, x0, ya, z0, x1, yb, z1, x0, yb, z0);
          W.u.push(u0, va, u1, va, u1, vb, u0, va, u1, vb, u0, vb);
          for (let q = 0; q < 6; q++) { W.c.push(bc.r, bc.g, bc.b); W.n.push(nx, 0, nz); W.f.push(sf); }
        }
        s += len;
      }
    };
    wall(pts); (b.holes || []).forEach(wall);
    roofShapes.push({ o: pts, h: b.holes || [], y: h, col: col.clone().multiplyScalar(0.72) });
  });
  const mk = (o, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.u, 2));
    geo.setAttribute('sf', new THREE.Float32BufferAttribute(o.f, 1));
    const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; return m;
  };
  walls.forEach((w, i) => { if (w.p.length) g.add(mk(w, wallMats[i])); });
  if (plain.p.length) g.add(mk(plain, roofMat));
  // 屋上: 形ごとに作って1つにまとめる
  const P = [], C = [];
  for (const r of roofShapes) {
    const sh = new THREE.Shape(r.o.map(([x, z]) => new THREE.Vector2(x, -z)));
    r.h.forEach((hh) => sh.holes.push(new THREE.Path(hh.map(([x, z]) => new THREE.Vector2(x, -z)))));
    const sg = new THREE.ShapeGeometry(sh); sg.rotateX(-Math.PI / 2);
    const pos = sg.getAttribute('position'), idx = sg.index ? sg.index.array : null, n = idx ? idx.length : pos.count;
    for (let k = 0; k < n; k++) { const v = idx ? idx[k] : k; P.push(pos.getX(v), r.y, pos.getZ(v)); C.push(r.col.r, r.col.g, r.col.b); }
    sg.dispose();
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); rg.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  rg.computeVertexNormals();
  const rm = new THREE.Mesh(rg, roofMat); rm.matrixAutoUpdate = false; g.add(rm);
}

// ---- 1階は窓ではなく出入口(ガラス戸と看板の帯) ----
// 壁の絵の上から、高さ 4.2m より下だけ描き替える。横方向の位置は uv.x × 絵の幅(m)。
function addStorefront(mat, tileW) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTileW = { value: tileW };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY; varying float vWX; varying float vSF;\nuniform float uTileW;\nattribute float sf;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y; vWX = uv.x * uTileW; vSF = sf;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY; varying float vWX; varying float vSF;\nfloat sfGlass = 0.0;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (vWY < 4.2 && vSF > 0.5) {
          vec3 wallC = diffuseColor.rgb;
          #ifdef USE_COLOR
          wallC = vColor.rgb;
          #endif
          if (vWY < 0.35) diffuseColor.rgb = wallC * 0.55;                       // 足元の石
          else if (vWY > 3.35) diffuseColor.rgb = wallC * 0.78;                   // 看板の帯
          else {
            float bay = fract(vWX / 2.4);                                          // 2.4m ごとの扉・ガラス
            float edge = step(bay, 0.04) + step(0.96, bay);
            float transom = step(2.55, vWY) * step(vWY, 2.65);
            diffuseColor.rgb = mix(vec3(0.20, 0.25, 0.30), vec3(0.62, 0.64, 0.66), clamp(edge + transom, 0.0, 1.0));
            sfGlass = 1.0 - clamp(edge + transom, 0.0, 1.0);
          }
          if (vSF > 1.5 && vWY > 2.6 && vWY < 3.6) {                              // 赤い日よけ(百貨店)
            diffuseColor.rgb = vec3(0.78, 0.09, 0.12) * (0.9 + 0.1 * step(0.5, fract(vWX / 2.4)));
            sfGlass = 0.0;
          }
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vWY < 4.2 && vSF > 0.5) totalEmissiveRadiance = emissive * vec3(1.0, 0.86, 0.62) * sfGlass;   // 夜は店の明かり`);
  };
}

// ---- ランドマーク(PLATEAU の本物の形) ----
// walls/roofs は三角形の頂点(x, y, z)の並び。窓の模様は面の向きから横方向と高さで貼る。
function buildLandmarks(lm, g, wallMats, roofMat) {
  const walls = STYLES.map(() => ({ p: [], n: [], c: [], u: [], f: [] }));
  const RP = [], RC = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3();
  lm.landmarks.forEach((L, i) => {
    const R = seeded(i * 977 + 5);
    let top = 0; for (let k = 1; k < L.walls.length; k += 3) top = Math.max(top, L.walls[k]);
    const style = L.style ?? (top > 80 ? [0, 2, 2, 4][Math.floor(R() * 4)] : [1, 3, 4, 0][Math.floor(R() * 4)]);
    const base = L.color ?? (style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)]);
    const col = new THREE.Color(base), S = STYLES[style], W = walls[style], w = L.walls;
    const rcol = L.roofColor ? new THREE.Color(L.roofColor) : col.clone().multiplyScalar(0.72);
    for (let k = 0; k + 8 < w.length; k += 9) {
      A.set(w[k], w[k + 1], w[k + 2]); B.set(w[k + 3], w[k + 4], w[k + 5]); C.set(w[k + 6], w[k + 7], w[k + 8]);
      N.subVectors(B, A).cross(T.subVectors(C, A)); if (N.lengthSq() < 1e-8) continue; N.normalize();
      if (Math.abs(N.y) > 0.5) {   // 傾いた面・水平な面は窓を貼らず屋根の色で
        for (const P of [A, B, C]) { RP.push(P.x, P.y, P.z); RC.push(rcol.r, rcol.g, rcol.b); }
        continue;
      }
      // 横方向(面に沿った水平の向き)
      let hx = -N.z, hz = N.x; const hl = Math.hypot(hx, hz); if (hl < 1e-3) { hx = 1; hz = 0; } else { hx /= hl; hz /= hl; }
      for (const P of [A, B, C]) {
        W.p.push(P.x, P.y, P.z); W.n.push(N.x, N.y, N.z); W.c.push(col.r, col.g, col.b);
        W.u.push((P.x * hx + P.z * hz) / S.tileW, P.y / S.tileH); W.f.push(L.awning ? 2 : 1);
      }
    }
    for (let k = 0; k < L.roofs.length; k += 3) { RP.push(L.roofs[k], L.roofs[k + 1], L.roofs[k + 2]); RC.push(rcol.r, rcol.g, rcol.b); }
  });
  walls.forEach((o, i) => {
    if (!o.p.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.u, 2));
    geo.setAttribute('sf', new THREE.Float32BufferAttribute(o.f, 1));
    const m = new THREE.Mesh(geo, wallMats[i]); m.matrixAutoUpdate = false; m.name = 'plateau-landmarks'; g.add(m);
  });
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(RP, 3)); rg.setAttribute('color', new THREE.Float32BufferAttribute(RC, 3));
  rg.computeVertexNormals();
  const rm = new THREE.Mesh(rg, roofMat); rm.matrixAutoUpdate = false; g.add(rm);
}

// ---- 当たり判定 ----
const pointIn = (ring, x, z) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, zi] = ring[i], [xj, zj] = ring[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
const inPoly = (o, holes, x, z) => pointIn(o, x, z) && !(holes || []).some((h) => pointIn(h, x, z));
function makeBlocker(data) {
  const [X0, Z0, X1, Z1] = data.bounds, C = 25, grid = new Map();
  const items = [];
  const add = (o, h, kind) => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, z] of o) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
    const it = { o, h, kind, box: [a, b, c, d] }; items.push(it);
    for (let gx = Math.floor(a / C); gx <= Math.floor(c / C); gx++) for (let gz = Math.floor(b / C); gz <= Math.floor(d / C); gz++) {
      const k = gx + ',' + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(it);
    }
  };
  data.buildings.forEach((b) => add(b.p, b.holes, 'b'));
  data.water.forEach((w) => add(w.o, w.h, 'w'));
  // 線で描かれた川: 線分ごとに幅つきで登録
  for (const rv of data.rivers || []) for (let i = 0; i + 1 < rv.pts.length; i++) {
    const [ax, az] = rv.pts[i], [bx, bz] = rv.pts[i + 1], h = rv.w / 2;
    add([[Math.min(ax, bx) - h, Math.min(az, bz) - h], [Math.max(ax, bx) + h, Math.max(az, bz) + h]], [ax, az, bx, bz, h], 'r');
  }
  // 線路の高架・ホーム: 道路の上(高架下をくぐる所)以外は通れない
  for (const rl of data.rails || []) for (let i = 0; i + 1 < rl.pts.length; i++) {
    const [ax, az] = rl.pts[i], [bx, bz] = rl.pts[i + 1], h = 2.6;
    add([[Math.min(ax, bx) - h, Math.min(az, bz) - h], [Math.max(ax, bx) + h, Math.max(az, bz) + h]], [ax, az, bx, bz, h], 'r');
  }
  (data.platforms || []).forEach((pf) => { if (pf.y > 0) add(pf.o, pf.h, 'w'); });
  const area = data.area;
  // 道路(橋の上を走れるように): 1m 角の升目に印
  const RW = Math.ceil(X1 - X0), RH = Math.ceil(Z1 - Z0), road = new Uint8Array(RW * RH);
  for (const r of data.roads) {
    const half = roadWidth(r) / 2 + 0.5, p = r.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 0.7);
      for (let k = 0; k <= n; k++) {
        const cx = x0 + (x1 - x0) * k / n - X0, cz = z0 + (z1 - z0) * k / n - Z0;
        for (let dz = -half; dz <= half; dz += 0.7) for (let dx = -half; dx <= half; dx += 0.7) {
          if (dx * dx + dz * dz > half * half) continue;
          const ix = Math.floor(cx + dx), iz = Math.floor(cz + dz);
          if (ix >= 0 && iz >= 0 && ix < RW && iz < RH) road[iz * RW + ix] = 1;
        }
      }
    }
  }
  const onRoad = (x, z) => { const ix = Math.floor(x - X0), iz = Math.floor(z - Z0); return ix >= 0 && iz >= 0 && ix < RW && iz < RH && road[iz * RW + ix] === 1; };
  const fn = (x, z, r = 0.3) => {
    if (x < X0 + r || x > X1 - r || z < Z0 + r || z > Z1 - r) return true;
    if (area && !pointIn(area, x, z)) return true;   // 走れる範囲(川や幹線道路で区切った多角形)の外
    const list = grid.get(Math.floor(x / C) + ',' + Math.floor(z / C));
    if (!list) return false;
    const road_ = onRoad(x, z);
    for (const it of list) {
      const [a, b, c, d] = it.box;
      if (x < a - r || x > c + r || z < b - r || z > d + r) continue;
      if (it.kind === 'r') {
        if (road_) continue;
        const [ax, az, bx, bz, h] = it.h, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        if (Math.hypot(x - ax - dx * u, z - az - dz * u) < h) return true;
        continue;
      }
      if (it.kind === 'w') { if (!road_ && inPoly(it.o, it.h, x, z)) return true; continue; }
      if (inPoly(it.o, it.h, x, z) || [[r, 0], [-r, 0], [0, r], [0, -r]].some(([ox, oz]) => inPoly(it.o, it.h, x + ox, z + oz))) return true;
    }
    return false;
  };
  fn.onRoad = onRoad;
  return fn;
}

export function decorateOsmCity(root, url, landmarkUrl, bridgeUrl) {
  root.traverse((o) => { if (o.isMesh) o.visible = false; });
  const styleTex = STYLES.map((s, i) => makeStyleTextures(s, i));
  const glow = [];
  const wallMats = STYLES.map((s, i) => { const m = new THREE.MeshLambertMaterial({ map: styleTex[i].map, vertexColors: true, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: styleTex[i].emissiveMap, emissiveIntensity: 0 }); addStorefront(m, s.tileW); glow.push(m); return m; });
  const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const city = new THREE.Group(); city.name = 'osm-city';
  (root.parent || root).add(city);
  let blocked = () => false, night = false;
  const lmFetch = landmarkUrl ? fetch(landmarkUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  const brFetch = bridgeUrl ? fetch(bridgeUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  Promise.all([fetch(url).then((r) => r.json()), lmFetch, brFetch]).then(([data, lm, br]) => {
    const [X0, Z0, X1, Z1] = data.bounds;
    const ground = []; ribbon([[X0 - 300, (Z0 + Z1) / 2], [X1 + 300, (Z0 + Z1) / 2]], Z1 - Z0 + 600, -0.3, ground);
    const gm = flatMesh(ground, WALK);   // 地面は他の面より奥に描く(遠くで水面や公園が地面に負けないように)
    gm.material.polygonOffsetFactor = 4; gm.material.polygonOffsetUnits = 4;
    city.add(gm);
    city.add(polyFill(data.parks, 0.02, GRASS));
    city.add(polyFill(data.water, 0.03, WATER));
    const riv = [];
    for (const rv of data.rivers || []) {
      ribbon(rv.pts, rv.w, 0.022, riv);
      for (let i = 1; i + 1 < rv.pts.length; i++) disc(rv.pts[i][0], rv.pts[i][1], rv.w / 2, 0.022, riv);
    }
    city.add(flatMesh(riv, WATER));
    buildRoads(data, city);
    buildElevated(data, city);
    if (br) buildBridges(br, city);
    buildBuildings(data, city, wallMats, roofMat);
    if (lm) {
      buildLandmarks(lm, city, wallMats, roofMat);
      // 当たり判定は足元の形で
      for (const L of lm.landmarks) for (const r of L.fp) data.buildings.push({ p: r, holes: [] });
      document.body.dataset.osmLandmarks = String(lm.landmarks.length);
    }
    blocked = makeBlocker(data);
    buildRailways(data, city, blocked.onRoad);
    document.body.dataset.osmBuildings = String(data.buildings.length);
    document.body.dataset.osmRoads = String(data.roads.length);
  }).catch((e) => console.warn('[osm-city]', e));
  return {
    isBlocked: (x, z, R) => blocked(x, z, R),
    update() {},
    setNight(on) { if (on === night) return; night = on; glow.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); },
  };
}
