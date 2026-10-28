import * as THREE from '../lib/three.module.js';
import { loadNativeSurfaces, loadFoam, loadWalls, loadLamps, updateWaterTime, setSeaNight } from './native-surfaces.js?v=20261028-pool-1';

// 日本橋ステージ: OpenStreetMap のデータ(map/nihonbashi-city.json、tools/osm_to_city.py で作る)から街を組み立てる。
//  - 道路: OSM の道の中心線に、車線数 × 3.25m の幅で路面を敷く。上下線が別の道(一方通行の片側)はそのまま並ぶ。
//  - 白線: 車線の境(白の破線)、外側線。対面通行の道は中央線(片側2車線以上は黄、それ以外は白の破線)。
//    一方通行の片側の道は、進む向きの右の端(中央分離側)を黄色にする。交差点の中は線を引かない。
//  - 建物: OSM の建物の形を立ち上げる。高さは階数(×3.5m)、無ければ広さから決める。窓の模様は棟ごと。
//  - 水: 川の面。橋の道の上は走れ、それ以外の水には入れない。
//  - 首都高: 高さ9.5mの高架(見た目だけ)。
// 地図データ © OpenStreetMap contributors (ODbL)

const LANE = 3.25;
const ASPHALT = 0x3d3f42, SIDEWALK_COLOR = 0x45474a, WALK = 0x8d8c88, GRASS = 0x6f9a4f, WATER = 0x3d6b66, CONCRETE = 0x8e9196;
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
  const lit = () => true;   // 発光の絵には全部の窓を描く。点いているかは窓ごとにシェーダーで決める(建物ごとに2〜5割)
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
// 上向きの面: 上から見て三角形の向きを揃える(裏向きだと DoubleSide で法線が反転して暗くなる)。末尾から1回だけ見ればよいよう、済んだ位置を覚える
function upward(p) {
  for (let k = p._up || 0; k + 8 < p.length; k += 9) {
    const ax = p[k], az = p[k + 2], bx = p[k + 3], bz = p[k + 5], cx = p[k + 6], cz = p[k + 8];
    if ((bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0) for (let q = 0; q < 3; q++) { const t = p[k + 3 + q]; p[k + 3 + q] = p[k + 6 + q]; p[k + 6 + q] = t; }
  }
  p._up = p.length - (p.length % 9);
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

// 2つ以上の道路が重なる所(合流・並走・短い取り付け道路)を調べる升目(2m)。そこには線を引かない
function makeCoverage(data) {
  const [X0, Z0, X1, Z1] = data.bounds, C = 2, W = Math.ceil((X1 - X0) / C), H = Math.ceil((Z1 - Z0) / C);
  const m = new Uint16Array(W * H);   // 0=なし / 1..=道路番号+1 / 65535=重なり
  data.roads.forEach((r, id) => {
    const half = roadWidth(r) / 2, p = r.pts, me = id + 1;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 1.5);
      for (let k = 0; k <= n; k++) {
        const cx = x0 + (x1 - x0) * k / n, cz = z0 + (z1 - z0) * k / n;
        for (let dz = -half; dz <= half; dz += 1.5) for (let dx = -half; dx <= half; dx += 1.5) {
          if (dx * dx + dz * dz > half * half) continue;
          const ix = Math.floor((cx + dx - X0) / C), iz = Math.floor((cz + dz - Z0) / C);
          if (ix < 0 || iz < 0 || ix >= W || iz >= H) continue;
          const v = m[iz * W + ix];
          m[iz * W + ix] = v === 0 || v === me ? me : 65535;
        }
      }
    }
  });
  return (x, z, id) => {
    const ix = Math.floor((x - X0) / C), iz = Math.floor((z - Z0) / C);
    if (ix < 0 || iz < 0 || ix >= W || iz >= H) return false;
    const v = m[iz * W + ix]; return v !== 0 && v !== id + 1;
  };
}

function buildRoads(data, g, surfaceSink = null) {
  const shonanLines = (data.water || []).some((w) => w.sea);   // 湘南: 中央分離帯に接する線は白
  const shared = makeCoverage(data);
  const asphalt = [], white = [], yellow = [], placedCw = [], deck = [], walk = [], curb = [], parapet = { p: [], n: [] }, median = { p: [], n: [] };
  // 交差点の点と、その半径(集まる道の半幅の最大)
  const J = new Map();
  for (const r of data.roads) for (const i of r.junctions) {
    const k = r.pts[i].join(','); J.set(k, Math.max(J.get(k) || 0, roadWidth(r) / 2));
  }
  data.roads.forEach((r, rid) => {
    const w = roadWidth(r), half = w / 2, p = r.pts;
    if (r.bridge && r.pair) {
      // 上下線が並んだ橋: 外側の欄干から真ん中までを1枚の床に。真ん中にグレーの壁
      const s = r.pair.side, outer = half + 3.2, inner = r.pair.gap / 2 + 0.3;
      ribbon(offset(p, s * (inner - outer) / 2), inner + outer, 0.05, deck);
      ribbon(offset(p, s * (inner - outer) / 2), inner + outer - 0.6, 0.055, asphalt);
      const e = offset(p, -s * outer);
      if (!r.flat) for (let i = 0; i + 1 < e.length; i++) {
        const [x0, z0] = e[i], [x1, z1] = e[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.1) continue;
        const ang = Math.atan2(x1 - x0, z1 - z0);
        boxInto(parapet, (x0 + x1) / 2, 0.6, (z0 + z1) / 2, 0.55, 1.2, L + 0.3, ang);
        boxInto(parapet, (x0 + x1) / 2, 1.27, (z0 + z1) / 2, 0.7, 0.14, L + 0.3, ang);
      }
      if (r.pair.wall && !r.flat) {
        const mline = offset(p, s * r.pair.gap / 2);
        for (let i = 0; i + 1 < mline.length; i++) {
          const [x0, z0] = mline[i], [x1, z1] = mline[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.1) continue;
          boxInto(median, (x0 + x1) / 2, 0.5, (z0 + z1) / 2, 0.6, 1.0, L + 0.3, Math.atan2(x1 - x0, z1 - z0));
        }
      }
    } else if (r.bridge) {
      ribbon(p, w + 6, 0.05, deck);   // 橋の床(上下線のすき間と歩道)
      if (!r.flat) for (const sd of [-1, 1]) {      // 両側に石の欄干(厚めの低い壁)
        const e = offset(p, sd * (half + 3.2));
        const far = offset(p, sd * (half + 6));   // 欄干の外側: ここが別の車道(上下線が並んだ橋)なら欄干は作らない
        for (let i = 0; i + 1 < e.length; i++) {
          const [x0, z0] = e[i], [x1, z1] = e[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.1) continue;
          const fm = [(far[i][0] + far[i + 1][0]) / 2, (far[i][1] + far[i + 1][1]) / 2];
          if (shared(fm[0], fm[1], rid) || shared((x0 + x1) / 2, (z0 + z1) / 2, rid)) continue;
          const ang = Math.atan2(x1 - x0, z1 - z0);
          boxInto(parapet, (x0 + x1) / 2, 0.6, (z0 + z1) / 2, 0.55, 1.2, L + 0.3, ang);
          boxInto(parapet, (x0 + x1) / 2, 1.27, (z0 + z1) / 2, 0.7, 0.14, L + 0.3, ang);   // 笠石
        }
      }
    }
    else {
      const sw = data.sidewalk ?? 4.5;
      ribbon(p, w + sw * 2, 0.012, walk);                                    // 歩道(アスファルト色)
      for (let i = 1; i + 1 < p.length; i++) disc(p[i][0], p[i][1], half + sw, 0.012, walk);
    }
    ribbon(p, w, r.bridge ? 0.06 : 0.04, asphalt);
    for (let i = 1; i + 1 < p.length; i++) disc(p[i][0], p[i][1], half, r.bridge ? 0.06 : 0.04, asphalt);   // 折れ目のすき間を埋める
    // 線を引く区間: 交差点の点のまわり(半径 + 1.5m)を除く
    const s = cumLen(p), L = s.at(-1), holes = [];
    for (const i of r.junctions) { const R = (J.get(p[i].join(',')) || half) + 1.5; holes.push([s[i] - R, s[i] + R]); }
    // ほかの道路と重なる区間(と短い道路)は線を引かない
    if (L < 20 || /_link$/.test(r.kind)) holes.push([-1, L + 1]);
    else {
      let st = null;
      for (let d = 0; d <= L; d += 2) {
        const q = cut(p, s, Math.max(0, d - 0.01), Math.min(L, d + 0.01))[0] || p[0];
        const sh = shared(q[0], q[1], rid);
        if (sh && st === null) st = d - 3;
        if (!sh && st !== null) { holes.push([st, d + 3]); st = null; }
      }
      if (st !== null) holes.push([st, L + 1]);
    }
    holes.sort((a, b) => a[0] - b[0]);
    const spans = []; let x = 0;
    for (const [a, b] of holes) { if (a > x) spans.push([x, a]); x = Math.max(x, b); }
    if (L > x) spans.push([x, L]);
    for (const [a, b] of spans) {
      if (b - a < 3) continue;
      const body = cut(p, s, a, b);
      if (body.length < 2) continue;
      if (!r.bridge) for (const sd of [-1, 1]) ribbon(offset(body, sd * (half + 0.12)), 0.24, 0.03, curb);   // 縁石
      if (r.oneway) {
        for (let k = 1; k < r.lanes; k++) ribbon(offset(body, half - k * LANE), 0.12, 0.08, white, [5, 5]);
        ribbon(offset(body, half - 0.25), 0.15, 0.08, white);              // 左の外側線
        ribbon(offset(body, -(half - 0.25)), 0.15, 0.08, r.lanes >= 2 && !shonanLines ? yellow : white);   // 右(中央分離側)。湘南は白
      } else if (r.lanes >= 2) {
        const per = Math.floor(r.lanes / 2);
        ribbon(body, 0.15, 0.08, per >= 2 ? yellow : white, per >= 2 ? null : [5, 5]);
        for (let k = 1; k < per; k++) for (const sd of [-1, 1]) ribbon(offset(body, sd * k * LANE), 0.12, 0.08, white, [5, 5]);
        for (const sd of [-1, 1]) ribbon(offset(body, sd * (half - 0.25)), 0.15, 0.08, white);
      } else {
        for (const sd of [-1, 1]) ribbon(offset(body, sd * (half - 0.4)), 0.12, 0.08, white);   // 路側帯
      }
    }
  });
  placeCrosswalks(data, shared, J, white);
  const surface = (p, color, kind) => surfaceSink ? surfaceSink(p, color, kind) : g.add(flatMesh(p, color));
  surface(walk, SIDEWALK_COLOR, 'sidewalk'); surface(curb, 0x9d9e9b, 'curb');
  if (parapet.p.length) g.add(solidMesh(parapet, new THREE.MeshLambertMaterial({ color: 0xb3ada1 })));
  if (median.p.length) g.add(solidMesh(median, new THREE.MeshLambertMaterial({ color: 0x8e9196 })));   // 橋の真ん中の壁(グレー)
  surface(deck, SIDEWALK_COLOR, 'deck'); surface(asphalt, ASPHALT, 'road');
  surface(white, 0xe9e9e6, 'white'); surface(yellow, 0xd9b23a, 'yellow');
}

// ---- 横断歩道: 地図の線からではなく、決まりで置き直す ----
//  候補: (1) 交差点の手前(交差点の半径 + 4m)、(2) 交差点のない長い直線(200m 以上)の真ん中。
//  置く条件: 道路を真横に切った線で、車道の端から端まで(中央分離帯をはさむ上下線もまとめて)一直線に渡り切れること。
//   - 両端の先が歩道(車道でない)
//   - 横断歩道の幅(前後 ±3m)の所が全部まっすぐな車道(交差点の角・合流にかからない)
//   - 同じ道の近く(40m 以内)に、もう横断歩道がない
function placeCrosswalks(data, shared, J, white) {
  const road = (x, z) => shared(x, z, -1);
  const placed = [];
  const cands = [];
  const brEnds = []; for (const r of data.roads) if (r.bridge && r.pts.length > 1) brEnds.push(r.pts[0], r.pts.at(-1));
  data.roads.forEach((r) => {
    if (r.bridge || !(r.oneway ? r.lanes >= 2 : r.lanes >= 4) || /_link$/.test(r.kind)) return;
    const p = r.pts, s = cumLen(p), L = s.at(-1); if (L < 30) return;
    const js = r.junctions.map((i) => s[i]).sort((a, b) => a - b);
    for (const i of r.junctions) {
      const R = (J.get(p[i].join(',')) || roadWidth(r) / 2) + 4;
      for (const sd of [-1, 1]) cands.push({ p, s, tries: [0, 4, 8, 12, 16, 20].map((k) => s[i] + sd * (R + k)).filter((sc) => sc > 3 && sc < L - 3), pri: 0 });
    }
    // 長い直線の真ん中
    const stops = [0, ...js, L];
    for (let k = 0; k + 1 < stops.length; k++) if (stops[k + 1] - stops[k] > 200) cands.push({ p, s, tries: [(stops[k] + stops[k + 1]) / 2], pri: 1 });
  });
  cands.sort((a, b) => a.pri - b.pri);
  for (const c of cands) for (const sc of c.tries) {   // 交差点から少しずつ離して、最初に置けた所に置く
    const seg = cut(c.p, c.s, sc - 1, sc + 1); if (seg.length < 2) continue;
    const [ax0, az0] = seg[0], [bx, bz] = seg.at(-1), dl = Math.hypot(bx - ax0, bz - az0) || 1, tx = (bx - ax0) / dl, tz = (bz - az0) / dl;
    const ax = (ax0 + bx) / 2, az = (az0 + bz) / 2, nx = tz, nz = -tx;
    const at = (o, d) => road(ax + nx * o + tx * d, az + nz * o + tz * d);
    const edge = (sd) => { let last = 0, d = 0; while (d < 45) { d += 0.5; if (at(d * sd, 0)) last = d; else if (d - last > 8) break; } return last; };
    const e1 = edge(1), e2 = edge(-1), W = e1 + e2;
    if (W < 6 || W > 45) continue;
    // 両端の先は歩道
    let ok = true;
    for (const d of [-3, 0, 3]) if (at(e1 + 2.5, d) || at(-e2 - 2.5, d)) ok = false;
    if (!ok) continue;
    // 車道の所は前後 ±3m もまっすぐ車道
    const stripes = []; let bad = 0;
    for (let o = -e2 + 0.5; o <= e1 - 0.3; o += 0.9) {
      if (!at(o, 0)) continue;
      if (!at(o, 3) || !at(o, -3)) bad++;
      stripes.push(o);
    }
    if (stripes.length < 4 || bad > stripes.length * 0.12) continue;
    const mo = (e1 - e2) / 2, cx = ax + nx * mo, cz = az + nz * mo, ang = Math.atan2(tx, tz);
    if (placed.some((q) => Math.abs(Math.sin(q[2] - ang)) < 0.35 && Math.abs((q[0] - cx) * tx + (q[1] - cz) * tz) < 40 && Math.abs((q[0] - cx) * nx + (q[1] - cz) * nz) < W / 2 + 10)) continue;
    if (brEnds.some(([x, z]) => Math.hypot(x - cx, z - cz) < 35)) continue;   // 橋のたもとには置かない
    if ((data.noCrosswalks || []).some(([x, z]) => Math.hypot(x - cx, z - cz) < 25)) continue;   // 指示で横断歩道を置かない所
    placed.push([cx, cz, ang]);
    for (const o of stripes) rect(ax + nx * o, az + nz * o, ang, 4, 0.45, 0.085, white);
    break;
  }
}

// ---- 高速道路の下を道路がくぐる所: 道路の両側だけに橋脚(厚み 2m × くぐる長さ) ----
function buildUnderPiers(data, br, g) {
  const [X0, Z0, X1, Z1] = data.bounds, C = 2, W = Math.ceil((X1 - X0) / C), H = Math.ceil((Z1 - Z0) / C);
  const deckY = new Float32Array(W * H);   // 0 = 高架なし
  const mark = (x, z, y) => { const i = Math.floor((x - X0) / C), j = Math.floor((z - Z0) / C); if (i < 0 || j < 0 || i >= W || j >= H) return; const k = j * W + i; if (!deckY[k] || y < deckY[k]) deckY[k] = y; };
  // PLATEAU の首都高: 上面の三角形を升目に塗る
  for (const b of (br && br.bridges) || []) {
    const t = b.top;
    for (let k = 0; k + 8 < t.length; k += 9) {
      const ax = t[k], ay = t[k + 1], az = t[k + 2], bx = t[k + 3], by = t[k + 4], bz = t[k + 5], cx = t[k + 6], cy = t[k + 7], cz = t[k + 8];
      const y = Math.min(ay, by, cy); if (y < 4) continue;
      const n = Math.ceil(Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - ax, cz - az)) / 1.5) + 1;
      for (let u = 0; u <= n; u++) for (let v = 0; u + v <= n; v++) mark(ax + (bx - ax) * u / n + (cx - ax) * v / n, az + (bz - az) * u / n + (cz - az) * v / n, y);
    }
  }
  // OSM の首都高(板)
  const EH = data.elevH ?? 9.5;
  for (const e of data.elevated || []) {
    const hs = e.hs || e.pts.map(() => EH), w = e.lanes * LANE / 2 + 0.75;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const [x0, z0] = e.pts[i], [x1, z1] = e.pts[i + 1], L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 1.5);
      for (let k = 0; k <= n; k++) {
        const y = hs[i] + (hs[i + 1] - hs[i]) * k / n; if (y < 4) continue;
        const cx = x0 + (x1 - x0) * k / n, cz = z0 + (z1 - z0) * k / n;
        for (let d = -w; d <= w; d += 1.5) mark(cx + (z1 - z0) / L * d, cz - (x1 - x0) / L * d, y - 0.7);
      }
    }
  }
  const at = (x, z) => { const i = Math.floor((x - X0) / C), j = Math.floor((z - Z0) / C); return i < 0 || j < 0 || i >= W || j >= H ? 0 : deckY[j * W + i]; };
  const out = { p: [], n: [] };
  const box = (x, z, ang, len, wid, h) => {   // 中心 x,z、向き ang(進む向き)、長さ len、厚み wid、高さ h
    const geo = new THREE.BoxGeometry(wid, h, len).toNonIndexed();
    geo.rotateY(ang); geo.translate(x, h / 2, z);
    out.p.push(...geo.getAttribute('position').array); out.n.push(...geo.getAttribute('normal').array); geo.dispose();
  };
  for (const r of data.roads) {
    if (r.bridge || r.pts.length < 2) continue;
    const half = roadWidth(r) / 2, p = r.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 1) continue;
      const tx = (x1 - x0) / L, tz = (z1 - z0) / L, nx = tz, nz = -tx, ang = Math.atan2(tx, tz);
      // 道路の中心がデッキの下にある区間(連続した所)ごとに、両側へ橋脚
      let s0 = null, ymin = 1e9;
      const flush = (s1) => {
        if (s0 === null) return;
        const len = s1 - s0;
        if (len >= 2) {
          const mx = x0 + tx * (s0 + s1) / 2, mz = z0 + tz * (s0 + s1) / 2, h = ymin - 0.8;
          if (h > 2) for (const sd of [-1, 1]) {
            const ox = mx + nx * sd * (half + 2.0), oz = mz + nz * sd * (half + 2.0);
            if (at(ox, oz)) box(ox, oz, ang, len, 2, h);   // 橋脚の所もデッキの下の時だけ
          }
        }
        s0 = null; ymin = 1e9;
      };
      for (let s = 0; s <= L; s += 1) {
        const y = at(x0 + tx * s, z0 + tz * s);
        if (y) { if (s0 === null) s0 = s; ymin = Math.min(ymin, y); } else flush(s);
      }
      flush(L);
    }
  }
  if (out.p.length) { const m = solidMesh(out, new THREE.MeshLambertMaterial({ color: CONCRETE })); m.name = 'under-piers'; g.add(m); }
}

// ---- 橋のアーチ(飾り。道路の両わきに弓なりの桁と吊り材) ----
function buildArches(data, g) {
  const out = { p: [], n: [] };
  const beam = (x0, y0, z0, x1, y1, z1, r) => {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.hypot(dx, dy, dz); if (len < 0.05) return;
    const geo = new THREE.BoxGeometry(r, len, r).toNonIndexed(), m = new THREE.Matrix4(), q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    m.compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), q, new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(m); out.p.push(...geo.getAttribute('position').array); out.n.push(...geo.getAttribute('normal').array); geo.dispose();
  };
  let color = 0x8fb7d8;
  for (const A of data.arches || []) {
    color = new THREE.Color(A.color).getHex();
    const [ax, az] = A.a, [bx, bz] = A.b, L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L, nx = tz, nz = -tx;
    const N = 24, base = 1.2;
    for (const sd of [-1, 1]) {
      const P = (u) => { const y = base + A.h * 4 * u * (1 - u); return [ax + tx * L * u + nx * sd * A.w, y, az + tz * L * u + nz * sd * A.w]; };
      for (let i = 0; i < N; i++) { const p0 = P(i / N), p1 = P((i + 1) / N); beam(...p0, ...p1, 1.4); }
      // 下の桁(道路の高さ)
      beam(ax + nx * sd * A.w, base, az + nz * sd * A.w, bx + nx * sd * A.w, base, bz + nz * sd * A.w, 1.0);
      for (let i = 2; i < N - 1; i += 2) { const p = P(i / N); beam(p[0], base, p[2], p[0], p[1], p[2], 0.35); }   // 吊り材
    }
  }
  if (out.p.length) { const m = solidMesh(out, new THREE.MeshLambertMaterial({ color })); m.name = 'bridge-arches'; g.add(m); }
}

function buildElevated(data, g) {
  // 首都高(OSM の線から作る板)。点ごとの高さ hs で坂にする(上り下り口は地面まで下りる)
  const deck = { p: [], n: [] }, EH = data.elevH ?? 9.5;
  const quad = (a, b, c, d, nx, ny, nz) => { deck.p.push(...a, ...b, ...c, ...a, ...c, ...d); for (let q = 0; q < 6; q++) deck.n.push(nx, ny, nz); };
  for (const e of data.elevated) {
    const w = e.lanes * LANE + 1.5, p = e.pts, hs = e.hs || p.map(() => EH);
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.2) continue;
      const h0 = hs[i], h1 = hs[i + 1]; if (h0 < 0.3 && h1 < 0.3) continue;   // 地面と同じ高さの所は描かない
      const tx = (x1 - x0) / L, tz = (z1 - z0) / L, nx = -tz, nz = tx, ex = tx * 0.3, ez = tz * 0.3;
      const P = (x, z, y, sd, k) => [x + nx * sd * w / 2 + (k ? ex : -ex), y, z + nz * sd * w / 2 + (k ? ez : -ez)];
      const T0 = h0 + 0.7, T1 = h1 + 0.7, B0 = Math.max(0, h0 - 0.7), B1 = Math.max(0, h1 - 0.7);
      quad(P(x0, z0, T0, -1, 0), P(x1, z1, T1, -1, 1), P(x1, z1, T1, 1, 1), P(x0, z0, T0, 1, 0), 0, 1, 0);        // 路面
      quad(P(x0, z0, B0, 1, 0), P(x1, z1, B1, 1, 1), P(x1, z1, B1, -1, 1), P(x0, z0, B0, -1, 0), 0, -1, 0);      // 裏
      for (const sd of [-1, 1]) {
        quad(P(x0, z0, B0, sd, 0), P(x1, z1, B1, sd, 1), P(x1, z1, T1 + 1.1, sd, 1), P(x0, z0, T0 + 1.1, sd, 0), nx * sd, 0, nz * sd);   // 側面と壁高欄
      }
    }
  }
  const m = solidMesh(deck, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide })); m.name = 'shutoko'; g.add(m);
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
// れんがの壁の絵(1枚 = 横 4m × 縦 2m)
function makeBrickTexture() {
  const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), R = seeded(4242);
  g.fillStyle = '#b8aa98'; g.fillRect(0, 0, W, H);                  // 目地
  const rows = 16, bh = H / rows, bw = W / 8;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw / 2;
    for (let k = -1; k < 9; k++) {
      const v = 0.82 + R() * 0.3;
      g.fillStyle = `rgb(${Math.round(150 * v)},${Math.round(74 * v)},${Math.round(52 * v)})`;
      g.fillRect(k * bw + off + 1.5, r * bh + 1.5, bw - 3, bh - 3);
    }
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
// 面の向きから、横方向の位置と高さで UV を付ける(箱を並べた形用)
function addWallUV(o, tileW, tileH) {
  const u = [];
  for (let i = 0; i < o.p.length; i += 3) {
    const nx = o.n[i], nz = o.n[i + 2];
    const along = Math.abs(nx) > Math.abs(nz) ? o.p[i + 2] : o.p[i];
    u.push(along / tileW, o.p[i + 1] / tileH);
  }
  o.u = u;
}
function makeWaterMask(data, margin) {
  const vs = data.viaducts || []; if (!vs.length) return () => false;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const v of vs) for (const r of v.rings) for (const [x, z] of r) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const C = 2, pad = margin + 4; x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
  const W = Math.ceil((x1 - x0) / C), H = Math.ceil((z1 - z0) / C), m = new Uint8Array(W * H);
  const paint = (ax, az, bx, bz, test) => {
    const i0 = Math.max(0, Math.floor((ax - x0) / C)), i1 = Math.min(W - 1, Math.floor((bx - x0) / C));
    const j0 = Math.max(0, Math.floor((az - z0) / C)), j1 = Math.min(H - 1, Math.floor((bz - z0) / C));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (m[j * W + i]) continue;
      if (test(x0 + (i + 0.5) * C, z0 + (j + 0.5) * C)) m[j * W + i] = 1;
    }
  };
  // 水の多角形は横の行ごとに塗る(行と辺の交わりの間を塗る。穴も同じ交わりに入れれば偶奇で抜ける)
  for (const w of data.water) {
    const rings = [w.o, ...(w.h || [])];
    let b = Infinity, d = -Infinity;
    for (const [, z] of w.o) { b = Math.min(b, z); d = Math.max(d, z); }
    const j0 = Math.max(0, Math.floor((b - z0) / C)), j1 = Math.min(H - 1, Math.floor((d - z0) / C));
    for (let j = j0; j <= j1; j++) {
      const z = z0 + (j + 0.5) * C, xs = [];
      for (const r of rings) for (let k = 0, l = r.length - 1; k < r.length; l = k++) {
        const [ax, az] = r[k], [bx, bz] = r[l];
        if ((az > z) !== (bz > z)) xs.push(ax + (z - az) / (bz - az) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / C - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[k + 1] - x0) / C - 0.5));
        for (let i = i0; i <= i1; i++) m[j * W + i] = 1;
      }
    }
  }
  for (const rv of data.rivers || []) for (let k = 0; k + 1 < rv.pts.length; k++) {
    const [ax, az] = rv.pts[k], [bx, bz] = rv.pts[k + 1], hw = rv.w / 2 + 1, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    paint(Math.min(ax, bx) - hw, Math.min(az, bz) - hw, Math.max(ax, bx) + hw, Math.max(az, bz) + hw, (x, z) => {
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      return Math.hypot(x - ax - dx * u, z - az - dz * u) < hw;
    });
  }
  // margin ぶん広げる(縦横に)
  const r = Math.ceil(margin / C), tmp = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (m[j * W + i]) for (let k = Math.max(0, i - r); k <= Math.min(W - 1, i + r); k++) tmp[j * W + k] = 1;
  const out = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (tmp[j * W + i]) for (let k = Math.max(0, j - r); k <= Math.min(H - 1, j + r); k++) out[k * W + i] = 1;
  return (x, z) => {
    const i = Math.floor((x - x0) / C), j = Math.floor((z - z0) / C);
    return i >= 0 && j >= 0 && i < W && j < H && out[j * W + i] === 1;
  };
}
function buildRailways(data, g, onRoad) {
  // 川・濠の上とそのまわり 8m には柱・壁を立てない。高架のまわりだけ 2m 角の升目に水を塗っておく(速さのため)
  const overWater = makeWaterMask(data, 8);
  const deck = { p: [], n: [] }, rail = [], conc = { p: [], n: [] };
  const grey = { p: [], n: [] }, yr = data.yaesu, lid = { p: [], n: [] }, lidTop = { p: [], n: [] };   // lid: 下面(茶)、lidTop: 上面(グレー)。模様なしの一枚板
  const onYaesu = (x, z) => {
    if (!yr) return false;
    const [ax, az] = yr.a, [bx, bz] = yr.b, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const u = ((x - ax) * dx + (z - az) * dz) / L2; if (u < -0.01 || u > 1.01) return false;
    return Math.hypot(ax + dx * u - x, az + dz * u - z) < 1.5;
  };
  // まとめた高架: 上面と、まわりの壁(道路・水の上は壁なし)
  for (const v of data.viaducts || []) {
    const tp = v.top;
    if (v.ceil) {   // れんがのトンネル・橋の天井: 上面と下面だけ(まわりの壁はとなりのれんがの塊が持つ)
      for (let k = 0; k < tp.length; k += 3) { lidTop.p.push(tp[k], tp[k + 1], tp[k + 2]); lidTop.n.push(0, 1, 0); }
      upward(lidTop.p);
      for (let k = 0; k < tp.length; k += 3) { lid.p.push(tp[k], tp[k + 1] - 1.6, tp[k + 2]); lid.n.push(0, -1, 0); }
      for (const ring of v.rings) for (let i = 0; i < ring.length; i++) {   // 外側の縁(桁の厚み)
        const [ax, az, ah] = ring[i], [bx, bz, bh] = ring[(i + 1) % ring.length], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const nx = (bz - az) / L, nz = -(bx - ax) / L;
        deck.p.push(ax, ah - 1.6, az, bx, bh - 1.6, bz, bx, bh, bz, ax, ah - 1.6, az, bx, bh, bz, ax, ah, az);
        for (let q = 0; q < 6; q++) deck.n.push(nx, 0, nz);
      }
      continue;
    }
    if (v.concrete) {   // 空中に浮いたコンクリートの高架: 上面・下面・厚み 1.6m の縁だけ
      for (let k = 0; k < tp.length; k += 3) { conc.p.push(tp[k], tp[k + 1], tp[k + 2]); conc.n.push(0, 1, 0); }
      for (let k = 0; k < tp.length; k += 3) { conc.p.push(tp[k], tp[k + 1] - 1.6, tp[k + 2]); conc.n.push(0, -1, 0); }
      for (const ring of v.rings) for (let i = 0; i < ring.length; i++) {
        const [ax, az, ah] = ring[i], [bx, bz, bh] = ring[(i + 1) % ring.length], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const nx = (bz - az) / L, nz = -(bx - ax) / L;
        conc.p.push(ax, ah - 1.6, az, bx, bh - 1.6, bz, bx, bh + 1.0, bz, ax, ah - 1.6, az, bx, bh + 1.0, bz, ax, ah + 1.0, az);
        for (let q = 0; q < 6; q++) conc.n.push(nx, 0, nz);
      }
      continue;
    }
    for (let k = 0; k < tp.length; k += 3) { lidTop.p.push(tp[k], tp[k + 1], tp[k + 2]); lidTop.n.push(0, 1, 0); }
    upward(lidTop.p);
    for (const ring of v.rings) {
      const segs = [];
      for (let i = 0; i < ring.length; i++) {
        const [ax, az, ah] = ring[i], [bx, bz, bh] = ring[(i + 1) % ring.length], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const nx = (bz - az) / L, nz = -(bx - ax) / L, n = Math.max(1, Math.round(L / 3)), tx = (bx - ax) / L, tz = (bz - az) / L;
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n;
          const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0, x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
          const h0 = ah + (bh - ah) * t0, h1 = ah + (bh - ah) * t1, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          let open = false;
          for (const d of [-3.5, -1.75, 0, 1.75, 3.5]) {
            const qx = mx - nx * 1.5 + tx * d, qz = mz - nz * 1.5 + tz * d;
            // 道路・川の所はあらかじめ切り抜いてあるので、れんがの塊のまわりは全部壁
          }
          segs.push({ x0, z0, x1, z1, h0, h1, nx, nz, len: L / n, open });
        }
      }
      for (const q of segs) {
        const y0 = q.open ? Math.min(q.h0, q.h1) - 1.6 : 0;   // 道路・水の上は桁の厚みだけ
        if (onYaesu((q.x0 + q.x1) / 2, (q.z0 + q.z1) / 2)) {   // 八重洲側の壁は薄いグレー
          grey.p.push(q.x0, y0, q.z0, q.x1, y0, q.z1, q.x1, q.h1, q.z1, q.x0, y0, q.z0, q.x1, q.h1, q.z1, q.x0, q.h0, q.z0);
          for (let k = 0; k < 6; k++) grey.n.push(q.nx, 0, q.nz);
          continue;
        }
        deck.p.push(q.x0, y0, q.z0, q.x1, y0, q.z1, q.x1, q.h1, q.z1, q.x0, y0, q.z0, q.x1, q.h1, q.z1, q.x0, q.h0, q.z0);
        for (let k = 0; k < 6; k++) deck.n.push(q.nx, 0, q.nz);
      }
    }
  }
  // 道路が高架の下をくぐる所: 道路の両側に壁を立ててトンネルのように囲む(中の空洞が見えないように)
  const nearWater = makeWaterMask(data, 45);
  const vsList = (data.viaducts || []).filter((v) => !v.concrete).map((v) => {
    const r0 = v.rings[0]; let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, z] of r0) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
    return { v, box: [a, b, c, d], H: r0[0][2] };
  });
  const underVia = (x, z) => {
    for (const it of vsList) {
      const [a, b, c, d] = it.box; if (x < a || x > c || z < b || z > d) continue;
      const rs = it.v.rings;
      if (pointIn(rs[0], x, z) && !rs.slice(1).some((h) => pointIn(h, x, z))) return it.H;
    }
    return 0;
  };
  for (const r of [] /* トンネルの壁は切り抜いた形の壁で足りる */) {
    if (r.bridge) continue;
    const half = roadWidth(r) / 2 + 1.6;   // 道路の印(車道 + 0.5m・1m 角)より外
    for (const sd of [-1, 1]) {
      const e = offset(r.pts, sd * half);
      for (let i = 0; i + 1 < e.length; i++) {
        const [ax, az] = e[i], [bx, bz] = e[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 0.05) continue;
        const n = Math.max(1, Math.round(L / 2));
        for (let k = 0; k < n; k++) {
          const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
          const H = underVia((x0 + x1) / 2, (z0 + z1) / 2); if (!H) continue;
          if (nearWater((x0 + x1) / 2, (z0 + z1) / 2)) continue;   // 川の近く(橋の所)は壁なし
          // 交差する別の道路の上には壁を立てない(交差点がふさがらないように)
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, nx = (z1 - z0) / (L / n), nz = -(x1 - x0) / (L / n);
          if (onRoad(mx, mz) || [1.2, 4, 8, 12].some((k) => onRoad(mx + nx * sd * k, mz + nz * sd * k))) continue;   // 中央分離帯など道路と道路のあいだには立てない(橋脚のように見えるので)
          const y1 = H - 1.6;
          deck.p.push(x0, 0, z0, x1, 0, z1, x1, y1, z1, x0, 0, z0, x1, y1, z1, x0, y1, z0);
          for (let q = 0; q < 6; q++) deck.n.push(-nx * sd, 0, -nz * sd);
        }
      }
    }
  }
  // 下面(道路の上で見上げた時)
  for (const v of data.viaducts || []) {
    if (v.concrete || v.ceil) continue;
    const tp = v.top;
    for (let k = 0; k < tp.length; k += 3) { lid.p.push(tp[k], tp[k + 1] - 1.6, tp[k + 2]); lid.n.push(0, -1, 0); }
  }
  // レール
  for (const rl of data.rails || []) {
    const p = rl.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [x0, z0] = p[i], [x1, z1] = p[i + 1], L = Math.hypot(x1 - x0, z1 - z0); if (L < 0.2) continue;
      const H = rl.hs ? (rl.hs[i] + rl.hs[i + 1]) / 2 : rl.h;
      const ang = Math.atan2(x1 - x0, z1 - z0), tx = (x1 - x0) / L, tz = (z1 - z0) / L;
      for (const sd of [-0.75, 0.75]) rect((x0 + x1) / 2 + tz * sd, (z0 + z1) / 2 - tx * sd, ang, L, 0.14, H + 0.04, rail);
    }
  }
  const pf = { p: [], n: [] };
  for (const q of data.platforms || []) if (q.y > 0) slab([q], q.y, 1.1, pf);
  const roof = { p: [], n: [] };
  for (const c of data.canopies || []) slab([{ o: c.o, h: [] }], c.y, 0.5, roof);
  // 線路の高架はれんが造り
  addWallUV(deck, 4, 2);
  const m1 = solidMesh(deck, new THREE.MeshLambertMaterial({ map: makeBrickTexture(), side: THREE.DoubleSide }));
  m1.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(deck.u, 2));
  m1.name = 'rail-viaduct'; g.add(m1);
  if (lid.p.length) { const ml = solidMesh(lid, new THREE.MeshLambertMaterial({ color: 0x7a4232, side: THREE.DoubleSide })); ml.name = 'rail-viaduct-lid'; g.add(ml); }
  if (lidTop.p.length) { const mt = solidMesh(lidTop, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide })); mt.name = 'rail-viaduct-top'; g.add(mt); }   // 線路の上面はグレー
  if (grey.p.length) g.add(solidMesh(grey, new THREE.MeshLambertMaterial({ color: 0xc9cbcc, side: THREE.DoubleSide })));
  if (yr) {   // 八重洲口の白い斜めの屋根(グランルーフ)と、斜めの柱
    const [ax, az] = yr.a, [bx, bz] = yr.b, [nx, nz] = yr.n, H = yr.h, roof = { p: [], n: [] }, mast = { p: [], n: [] };
    const I0 = 1, I1 = 20, Y0 = H + 4, Y1 = H + 10;   // 壁から 1m(高さ H+4) → 20m(高さ H+10)
    const P = (t, o, y) => [ax + (bx - ax) * t + nx * o, y, az + (bz - az) * t + nz * o];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N, a0 = P(t0, I0, Y0), a1 = P(t1, I0, Y0), b0 = P(t0, I1, Y1), b1 = P(t1, I1, Y1);
      roof.p.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
      for (let k = 0; k < 6; k++) roof.n.push(0, 1, 0);
      // 屋根の先の縁(厚み)
      const c0 = [b0[0], b0[1] - 0.6, b0[2]], c1 = [b1[0], b1[1] - 0.6, b1[2]];
      roof.p.push(...b0, ...b1, ...c1, ...b0, ...c1, ...c0);
      for (let k = 0; k < 6; k++) roof.n.push(nx, 0, nz);
    }
    const L = Math.hypot(bx - ax, bz - az), M = Math.max(2, Math.round(L / 22));
    for (let i = 0; i <= M; i++) {   // 地面(壁から 12m)から屋根の先へ斜めの細い柱
      const t = 0.03 + 0.94 * i / M, [x0, , z0] = P(t, 12, 0), [x1, , z1] = P(t, I1 - 1, 0);
      const dx = x1 - x0, dz = z1 - z0, dy = Y1 - 0.6, len = Math.hypot(dx, dy, dz);
      const geo = new THREE.CylinderGeometry(0.25, 0.35, len, 6).toNonIndexed();
      const m = new THREE.Mesh(geo); m.position.set((x0 + x1) / 2, dy / 2, (z0 + z1) / 2);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize()); m.updateMatrix();
      geo.applyMatrix4(m.matrix);
      mast.p.push(...geo.getAttribute('position').array); mast.n.push(...geo.getAttribute('normal').array);
    }
    const rm = solidMesh(roof, new THREE.MeshLambertMaterial({ color: 0xf2f2ee, side: THREE.DoubleSide })); rm.name = 'grand-roof'; g.add(rm);
    g.add(solidMesh(mast, new THREE.MeshLambertMaterial({ color: 0xd8dadb })));
  }
  if (conc.p.length) { const mc = solidMesh(conc, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide })); mc.name = 'rail-viaduct-concrete'; g.add(mc); }
  const m2 = solidMesh(pf, new THREE.MeshLambertMaterial({ color: 0xbdbcb6 })); g.add(m2);
  const m3 = solidMesh(roof, new THREE.MeshLambertMaterial({ color: 0xd6d8d9, side: THREE.DoubleSide })); m3.name = 'platform-roof'; g.add(m3);
  // レールは描かない(上空からしか見えないので)
}

// ---- 首都高・KK線(PLATEAU の橋梁モデルの形)。見た目だけで、下はくぐれる ----
function buildBridges(br, g, area) {
  const top = { p: [], n: [] }, side = { p: [], n: [] };
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3();
  const put = (arr, o) => {
    for (let k = 0; k + 8 < arr.length; k += 9) {
      A.set(arr[k], arr[k + 1], arr[k + 2]); B.set(arr[k + 3], arr[k + 4], arr[k + 5]); C.set(arr[k + 6], arr[k + 7], arr[k + 8]);
      N.subVectors(B, A).cross(T.subVectors(C, A)); if (N.lengthSq() < 1e-8) continue; N.normalize();
      for (const P of [A, B, C]) { o.p.push(P.x, P.y, P.z); o.n.push(N.x, N.y, N.z); }
    }
  };
  // 橋脚(縦に長い面)は描かない: 高さの幅が 4m 以上で、横の幅より縦が長い三角形を落とす
  const noPier = (arr) => {
    const out = [];
    for (let k = 0; k + 8 < arr.length; k += 9) {
      const ys = [arr[k + 1], arr[k + 4], arr[k + 7]], xs = [arr[k], arr[k + 3], arr[k + 6]], zs = [arr[k + 2], arr[k + 5], arr[k + 8]];
      const dy = Math.max(...ys) - Math.min(...ys), dh = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
      if (dy > 4 && dy > dh * 0.5) continue;
      for (let q = 0; q < 9; q++) out.push(arr[k + q]);
    }
    return out;
  };
  // 走れる範囲の外にぽつんとある高架(どこにもつながっていない)は描かない
  // 範囲(+30m)の外へはみ出した部分は描かない(地図の端で宙に浮く高架をなくす)
  const nearArea = (x, z) => { if (!area) return true; if (pointIn(area, x, z)) return true; for (const [dx, dz] of [[30, 0], [-30, 0], [0, 30], [0, -30]]) if (pointIn(area, x + dx, z + dz)) return true; return false; };
  const clipArea = (arr) => { const out = []; for (let k = 0; k + 8 < arr.length; k += 9) { const cx = (arr[k] + arr[k + 3] + arr[k + 6]) / 3, cz = (arr[k + 2] + arr[k + 5] + arr[k + 8]) / 3; if (nearArea(cx, cz)) for (let q = 0; q < 9; q++) out.push(arr[k + q]); } return out; };
  const inArea = (b) => !area || b.fp.some((r) => r.some(([x, z]) => pointIn(area, x, z)));
  for (const b of br.bridges) {
    if (b.kind === 'pier') { put(b.top, side); continue; }   // 水の上のコンクリートの面
    if (!inArea(b)) continue; put(clipArea(noPier(b.top)), top); put(clipArea(noPier(b.side)), side);
  }
  const m1 = solidMesh(top, new THREE.MeshLambertMaterial({ color: 0x5d6064, side: THREE.DoubleSide })); m1.name = 'shutoko-deck'; g.add(m1);
  const m2 = solidMesh(side, new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide })); m2.name = 'shutoko'; g.add(m2);
}

// ---- 地形(江の島だけ): 2m の升目の高さ。読み込んだら TERRAIN に入れ、建物・木・道路を持ち上げる ----
let TERRAIN = null;
function makeTerrain(T) {
  const { x0, z0, c, w, h } = T, d = T.d;
  const at = (x, z) => {
    const fx = (x - x0) / c, fz = (z - z0) / c;
    if (fx < 0 || fz < 0 || fx >= w - 1 || fz >= h - 1) return 0;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * w + i;
    return ((d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + w] * (1 - u) + d[k + w + 1] * u) * v) / 10;
  };
  const inBox = (x, z) => x >= x0 && z >= z0 && x <= x0 + (w - 1) * c && z <= z0 + (h - 1) * c;
  // 傾き(高さの差 / 距離)。急な所は入れないようにする
  const slope = (x, z) => Math.max(Math.abs(at(x + c, z) - at(x - c, z)), Math.abs(at(x, z + c) - at(x, z - c))) / (2 * c);
  return { at, inBox, slope, min: (pts) => Math.min(...pts.map(([x, z]) => at(x, z))), T };
}
function buildTerrainMesh(g) {
  // 16x16 升目ごとの小さなメッシュに分ける(車の真下を調べる時に、近くの小片だけを見るように)
  const { x0, z0, c, w, h, d } = TERRAIN.T, col = new THREE.Color(), out = [];
  const hv = (i, j) => d[j * w + i] / 10;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  const B = 16;
  for (let bj = 0; bj + 1 < h; bj += B) for (let bi = 0; bi + 1 < w; bi += B) {
    const P = [], C = [];
    const put = (i, j) => {
      const y = hv(i, j); P.push(x0 + i * c, y, z0 + j * c);
      if (y < 1.2) col.set(0xd8c9a3); else col.setHSL(0.24 + Math.min(0.06, y / 900), 0.32, 0.36 - Math.min(0.08, y / 600));
      C.push(col.r, col.g, col.b);
    };
    for (let j = bj; j < Math.min(bj + B, h - 1); j++) for (let i = bi; i < Math.min(bi + B, w - 1); i++) {
      if (Math.max(hv(i, j), hv(i + 1, j), hv(i, j + 1), hv(i + 1, j + 1)) < 0.05) continue;
      put(i, j); put(i, j + 1); put(i + 1, j); put(i + 1, j); put(i, j + 1); put(i + 1, j + 1);
    }
    if (!P.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.computeVertexNormals(); geo.computeBoundingSphere(); geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, mat);
    m.matrixAutoUpdate = false; m.name = 'M06_Steel_Smoke'; m.userData.noLift = true; g.add(m); out.push(m);
  }
  return out;
}
// 島の上にある平らなもの(道路・白線・敷地など)の頂点を地形の高さだけ上げる
function liftToTerrain(g) {
  const { x0, z0, c, w, h } = TERRAIN.T, X1 = x0 + (w - 1) * c, Z1 = z0 + (h - 1) * c;
  g.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.userData.noLift) return;
    const pos = o.geometry.getAttribute('position'); if (!pos) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    if (bb.max.x < x0 || bb.min.x > X1 || bb.max.z < z0 || bb.min.z > Z1) return;
    let changed = false;
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k), y = TERRAIN.at(x, z);
      if (y > 0) { pos.setY(k, pos.getY(k) + y + 0.02); changed = true; }
    }
    if (changed) { pos.needsUpdate = true; o.geometry.computeBoundingSphere(); }
  });
}

// ---- 江の島シーキャンドル: 下が細く上へ広がる白い塔(格子の窓)、上に展望台と灯台 ----
function buildSeaCandle(g, pts, gy) {
  let cx = 0, cz = 0; for (const [x, z] of pts) { cx += x; cz += z; } cx /= pts.length; cz /= pts.length;
  // 塔の形(半径, 高さ)。下から上へ
  const prof = [[2.6, 0], [2.9, 6], [3.5, 16], [4.2, 26], [4.8, 34], [5.1, 39], [5.0, 41], [4.4, 42.5], [3.9, 43], [3.9, 47], [3.2, 48], [2.6, 48.5], [2.6, 52], [1.8, 53], [0.01, 53.4]];
  const geo = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 36);
  // 白い太い格子(縦 10 本・横 13 段)と、そのすき間の青みがかったガラス
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  x.fillStyle = '#c3cbd1'; x.fillRect(0, 0, 512, 512);                 // ガラス(明るいグレー)
  x.fillStyle = 'rgba(255,255,255,0.18)'; for (let j = 0; j < 13; j++) x.fillRect(0, j * 512 / 13 + 8, 512, 10);
  x.fillStyle = '#f6f6f3';
  for (let i = 0; i < 10; i++) x.fillRect(i * 512 / 10, 0, 14, 512);    // 縦の柱
  for (let j = 0; j < 13; j++) x.fillRect(0, j * 512 / 13, 512, 9);     // 横の梁
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4;
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }));
  m.position.set(cx, gy, cz); m.updateMatrix(); m.matrixAutoUpdate = false; m.userData.noLift = true; m.name = 'sea-candle';
  g.add(m);
}

// ---- 遠くの山並み(湘南: 富士山・丹沢・箱根・伊豆): カメラのまわり遠くに立てた2次元の絵。近づいても大きさは変わらない ----
// 方位(北=0°、時計回り)と見上げる角度で描く。富士山は西北西(約290°)
function makeMountainPanorama() {
  const A0 = 215, A1 = 355, R = 4300, W = 4096, H = 512, TOP = 5.0;   // 横: 方位 A0〜A1、縦: 地平線から TOP 度まで
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const X = (deg) => (deg - A0) / (A1 - A0) * W, Y = (elev) => H * (1 - elev / TOP);
  const ridge = (pts, color) => {   // pts: [方位, 見上げる角度]
    g.beginPath(); g.moveTo(X(pts[0][0]), H);
    for (const [a, e] of pts) g.lineTo(X(a), Y(e));
    g.lineTo(X(pts[pts.length - 1][0]), H); g.closePath(); g.fillStyle = color; g.fill();
  };
  const R2 = seeded(77);
  const wiggle = (a0, a1, base, amp, step = 0.6) => { const out = []; for (let a = a0; a <= a1; a += step) out.push([a, base + (R2() - 0.4) * amp + Math.sin(a * 0.35) * amp * 0.6]); return out; };
  // 方位と高さは実際の位置から(稲村ヶ崎〜大磯から見て): 伊豆 225〜250°、箱根 250〜270°、富士山 276°、丹沢 290〜322°
  const K = 1.3;   // 少し大きめに見せる
  const k = (pts) => pts.map(([a, e]) => [a, e * K]);
  const shapes = [
    // 伊豆・箱根(奥)
    [k([[A0, 0.2], ...wiggle(222, 248, 0.9, 0.35), ...wiggle(248, 256, 1.3, 0.3), [258, 1.55], [261, 1.45], [264, 1.7], [267, 1.4], [270, 1.0], [272, 0.7]]), 'rgba(150,164,160,0.42)'],
    // 丹沢(奥・大きな山並み)
    [k([[280, 0.5], [286, 1.1], ...wiggle(290, 300, 1.8, 0.35), [302, 2.25], [305, 2.05], [308, 2.3], [311, 2.1], ...wiggle(313, 322, 1.6, 0.4), [326, 1.0], [334, 0.6], [345, 0.4], [A1, 0.3]]), 'rgba(146,160,156,0.45)'],
    // 富士山
    [k([[262, 0.6], [268, 1.2], [272, 2.1], [274.8, 2.75], [275.6, 2.9], [276.6, 2.85], [279, 2.1], [284, 1.1], [290, 0.6]]), 'rgba(140,155,152,0.5)'],
    // 手前の低い丘(大磯丘陵・湘南の内陸)
    [k([[A0, 0.15], ...wiggle(225, 285, 0.4, 0.2, 0.8), ...wiggle(285, 352, 0.7, 0.35, 0.6), [A1, 0.25]]), 'rgba(128,145,138,0.45)'],
  ];
  // 左右の端はぼかして消す(ぶつ切りにしない)。地平線の白い霞の帯は描かない
  const fade = (gc) => {
    gc.globalCompositeOperation = 'destination-in';
    const gr = gc.createLinearGradient(0, 0, W, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.12, 'rgba(0,0,0,1)'); gr.addColorStop(0.88, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    gc.fillStyle = gr; gc.fillRect(0, 0, W, H); gc.globalCompositeOperation = 'source-over';
  };
  for (const [pts, color] of shapes) ridge(pts, color);
  fade(g);
  // 夜: 暗いグレー一色(光らない)
  const cn = document.createElement('canvas'); cn.width = W; cn.height = H;
  const gn = cn.getContext('2d');
  for (const [pts] of shapes) { gn.beginPath(); gn.moveTo(X(pts[0][0]), H); for (const [a, e] of pts) gn.lineTo(X(a), Y(e)); gn.lineTo(X(pts[pts.length - 1][0]), H); gn.closePath(); gn.fillStyle = '#2a2d31'; gn.fill(); }
  fade(gn);
  const texNight = new THREE.CanvasTexture(cn); texNight.colorSpace = THREE.SRGBColorSpace;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  // 円柱の一部(カメラが中心)
  const P = [], U = [], n = 64, y0 = -Math.tan(0.2 * Math.PI / 180) * R, y1 = Math.tan(TOP * Math.PI / 180) * R;
  for (let k = 0; k < n; k++) {
    const a = (A0 + (A1 - A0) * k / n) * Math.PI / 180, b = (A0 + (A1 - A0) * (k + 1) / n) * Math.PI / 180;
    const ax = Math.sin(a) * R, az = -Math.cos(a) * R, bx = Math.sin(b) * R, bz = -Math.cos(b) * R, ua = k / n, ub = (k + 1) / n;
    P.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
    U.push(ua, 0, ub, 0, ub, 1, ua, 0, ub, 1, ua, 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true, fog: false, side: THREE.DoubleSide }));
  m.renderOrder = -1.9; m.frustumCulled = false; m.name = 'mountains'; m.userData.noLift = true;
  m.userData.setNight = (on) => { m.material.map = on ? texNight : tex; m.material.needsUpdate = true; };
  return m;
}

const SMALL_AREA = 150;
const WHITE_COLORS = [0xf2f1ec, 0xeeece6, 0xe9e7e0, 0xf4f3ef, 0xe3e2dd];
// 小さい建物の色: 黄土色・グレー・白っぽいグレー・赤茶
const SMALL_COLORS = [0xb59a68, 0xa8925f, 0x8f9194, 0x9a9c9e, 0xc9c9c4, 0xd6d4ce, 0x8a5a44, 0x7b4f3d];   // これより小さい建物(m²)は出入口・小屋などの構築物とみなす
// 湘南の小さな建物(一戸建て・小規模ビル): 窓・入口の模様なしで、白いグレー・白・薄い茶色のどれか一色
const SHONAN_SMALL_COLORS = [0xd3d4d0, 0xf1f0eb, 0xcdb89c];
// TOKYO の小さな建物: 白・薄いグレー・茶色
const TOKYO_SMALL_COLORS = [0xf1f0eb, 0xc9cac7, 0xa07f60];
function buildBuildings(data, g, wallMats, roofMat, opts = {}) {
  const walls = STYLES.map(() => ({ p: [], u: [], c: [], n: [], f: [], r: [] }));
  const plain = { p: [], u: [], c: [], n: [], f: [], r: [] };   // 小さい構築物: 窓なしのグレー一色
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
    let gy = TERRAIN ? TERRAIN.min(pts) : 0;
    if (opts.groundAt && gy <= 0.01) gy = Math.min(gy, ...pts.map(([x, z]) => opts.groundAt(x, z)));   // 江の島: 地面の高さ。湘南: 砂浜の上は 2m 下
    if (lk && lk.special === 'seacandle') { buildSeaCandle(g, pts, gy); return; }
    let style = h > 50 ? [0, 0, 1, 2, 4][Math.floor(R() * 5)] : [1, 1, 3, 4, 0][Math.floor(R() * 5)];
    const base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
    if (lk && lk.style != null) style = lk.style;
    const small = area < SMALL_AREA && !lk;
    let wallHex = small ? SMALL_COLORS[Math.floor(R() * SMALL_COLORS.length)] : (lk?.wall ?? base);
    if (b.white && !lk && R() < 0.65) wallHex = WHITE_COLORS[Math.floor(R() * WHITE_COLORS.length)];   // 湘南: 海沿い・幹線道路沿い・江の島は白多め
    if (b.grey) wallHex = 0xb9bcbf;   // 指定のグレーのビル
    const plainSmall = !!opts.smallColors && !lk && !b.grey && area < 400 && h <= 13;
    if (plainSmall) wallHex = opts.smallColors[Math.floor(R() * opts.smallColors.length)];
    const col = new THREE.Color(wallHex), S = STYLES[style], W = plainSmall ? plain : walls[style];
    // 高さで色を分ける帯: [下, 上, 色, 1階の出入口を描くか]
    const bands = lk
      ? [[0, lk.base ? lk.baseH : 0, new THREE.Color(lk.base ?? 0), 0], [lk.base ? lk.baseH : 0, lk.top ? h - lk.topH : h, col, 0], [lk.top ? h - lk.topH : h, h, new THREE.Color(lk.top ?? 0), 0]].filter((x) => x[1] > x[0])
      : [[0, h, col, 1]];
    const litR = 1 + Math.floor(R() * 900) + 0.1 + R() * 0.1;   // 夜の窓: 整数部は種、小数部は点いている割合(1〜2割)
    const ccw = a > 0;      // x-z 平面での向き
    const wall = (ring) => {
      let s = 0;
      for (let k = 0; k < ring.length; k++) {
        const [x0, z0] = ring[k], [x1, z1] = ring[(k + 1) % ring.length], len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.05) continue;
        let nx = (z1 - z0) / len, nz = -(x1 - x0) / len; if (ccw) { nx = -nx; nz = -nz; }
        const u0 = s / S.tileW, u1 = (s + len) / S.tileW;
        for (const [ya, yb, bc, sf] of bands) {
          const va = ya / S.tileH, vb = yb / S.tileH;
          W.p.push(x0, ya + gy, z0, x1, ya + gy, z1, x1, yb + gy, z1, x0, ya + gy, z0, x1, yb + gy, z1, x0, yb + gy, z0);
          W.u.push(u0, va, u1, va, u1, vb, u0, va, u1, vb, u0, vb);
          for (let q = 0; q < 6; q++) { W.c.push(bc.r, bc.g, bc.b); W.n.push(nx, 0, nz); W.f.push(sf); W.r.push(litR); }
        }
        s += len;
      }
    };
    wall(pts); (b.holes || []).forEach(wall);
    roofShapes.push({ o: pts, h: b.holes || [], y: h + gy, col: col.clone().multiplyScalar(0.72) });
  });
  const mk = (o, mat) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.u, 2));
    geo.setAttribute('sf', new THREE.Float32BufferAttribute(o.f, 1));
    if (o.r) geo.setAttribute('lr', new THREE.Float32BufferAttribute(o.r, 1));
    const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.userData.noLift = true; return m;
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
  const rm = new THREE.Mesh(rg, roofMat); rm.matrixAutoUpdate = false; rm.userData.noLift = true; g.add(rm);
}

// ---- 濠と川: 地面より下げて、岸に壁 ----
// 地面は1枚の板なので、水の所に「穴」をあける代わりに、
//  1) 水面と岸の壁を先に描き、2) 水の形を地面の高さに「見えない板」で描いて奥行きだけ書き込み、
//  3) そのあと地面を描く(見えない板より奥なので水の所には描かれない)。
const MOAT_DEPTH = 3, RIVER_DEPTH = 5, SEA_DEPTH = 0.8;
const SAND = 0xd8c9a3, SEA = 0x3d6b66;   // 海は川と同じ色
const STONE = 0xa39a88, RIVER_WALL = 0x6c6e70;
function buildWater(data, g, wallsOnly = false) {
  const sets = [
    { rings: data.water.filter((w) => w.moat), lines: [], d: MOAT_DEPTH, wall: STONE },
    { rings: data.water.filter((w) => !w.moat && !w.sea), lines: data.rivers || [], d: RIVER_DEPTH, wall: RIVER_WALL },
    { rings: data.water.filter((w) => w.sea), lines: [], d: SEA_DEPTH, wall: SAND, color: SEA },
  ];
  const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const inAnyWater = (x, z) => data.water.some((w) => pointIn(w.o, x, z) && !(w.h || []).some((h) => pointIn(h, x, z)));
  for (const s of sets) {
    const wall = { p: [], n: [] };
    const quad = (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.05) return;
      const nx = (bz - az) / L, nz = -(bx - ax) / L, y0 = -s.d, y1 = 0.02;
      wall.p.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
      for (let q = 0; q < 6; q++) wall.n.push(nx, 0, nz);
    };
    // 海の中・海との境目に川の岸の壁を立てない(海に浮く柵に見えるので)
    const seaR = data.water.filter((w) => w.sea);
    const inSea = (x, z) => seaR.some((w) => pointIn(w.o, x, z) && !(w.h || []).some((h) => pointIn(h, x, z)));
    const nearSea = (ax, az, bx, bz) => {
      if (s.color === SEA || !seaR.length) return false;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, L = Math.hypot(bx - ax, bz - az) || 1, nx = (bz - az) / L * 3, nz = -(bx - ax) / L * 3;
      return inSea(mx, mz) || inSea(mx + nx, mz + nz) || inSea(mx - nx, mz - nz);
    };
    // 両側が水の所(水どうしの境目)にも壁を立てない
    const onRiverLine = (x, z) => (data.rivers || []).some((rv) => {
      for (let i = 0; i + 1 < rv.pts.length; i++) {
        const [ax, az] = rv.pts[i], [bx, bz] = rv.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        if ((ax + dx * u - x) ** 2 + (az + dz * u - z) ** 2 < (rv.w / 2) ** 2) return true;
      }
      return false;
    });
    const wet = (x, z) => inAnyWater(x, z) || onRiverLine(x, z);
    const between = (ax, az, bx, bz) => {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2, L = Math.hypot(bx - ax, bz - az) || 1, nx = (bz - az) / L * 1.5, nz = -(bx - ax) / L * 1.5;
      return wet(mx + nx, mz + nz) && wet(mx - nx, mz - nz);
    };
    const ringWall = (r) => { for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; if (!nearSea(a[0], a[1], b[0], b[1]) && !between(a[0], a[1], b[0], b[1])) quad(a[0], a[1], b[0], b[1]); } };
    for (const w of s.rings) { ringWall(w.o); (w.h || []).forEach(ringWall); }
    const floor = [], mask = [];
    for (const rv of s.lines) {
      ribbon(rv.pts, rv.w, -s.d, floor); ribbon(rv.pts, rv.w, 0, mask);
      for (let i = 1; i + 1 < rv.pts.length; i++) { disc(rv.pts[i][0], rv.pts[i][1], rv.w / 2, -s.d, floor); disc(rv.pts[i][0], rv.pts[i][1], rv.w / 2, 0, mask); }
      // 岸の壁: 面で描いた川(や濠)の中に入る所は作らない
      for (const sd of [-1, 1]) {
        const e = offset(rv.pts, sd * rv.w / 2);
        for (let i = 0; i + 1 < e.length; i++) {
          const mx = (e[i][0] + e[i + 1][0]) / 2, mz = (e[i][1] + e[i + 1][1]) / 2;
          if (inAnyWater(mx, mz) || nearSea(e[i][0], e[i][1], e[i + 1][0], e[i + 1][1]) || between(e[i][0], e[i][1], e[i + 1][0], e[i + 1][1])) continue;
          quad(e[i][0], e[i][1], e[i + 1][0], e[i + 1][1]);
        }
      }
    }
    const add = (m, order) => { m.renderOrder = order; m.userData.noLift = true; g.add(m); };
    if (!wallsOnly && s.rings.length) {
      add(polyFill(s.rings, -s.d, s.color ?? WATER), -1.8);
      const mk = polyFill(s.rings, 0, WATER); mk.material = maskMat; add(mk, -1.6);
    }
    if (!wallsOnly && floor.length) {
      add(flatMesh(floor, WATER), -1.8);
      const mk = flatMesh(mask, WATER); mk.material = maskMat; add(mk, -1.6);
    }
    if (wall.p.length) add(solidMesh(wall, new THREE.MeshLambertMaterial({ color: s.wall, side: THREE.DoubleSide })), -1.8);
  }
}

// ---- 皇居の奥などの森: 木を1本ずつではなく、こんもりした大きな塊をいくつか ----
function buildForests(data, g) {
  const area = data.area;
  const inWater = (x, z) => data.water.some((w) => pointIn(w.o, x, z));
  // 走れる範囲の外にある建物(皇居の中など)のまわりには森を置かない
  const bg = new Map();
  for (const b of data.buildings) {
    const [x, z] = b.p[0]; if (area && pointIn(area, x, z)) continue;
    for (const [px, pz] of b.p) { const k = Math.floor(px / 20) + ',' + Math.floor(pz / 20); if (!bg.has(k)) bg.set(k, []); bg.get(k).push([px, pz]); }
  }
  const nearBld = (x, z, r) => {
    for (let gx = Math.floor((x - r) / 20); gx <= Math.floor((x + r) / 20); gx++) for (let gz = Math.floor((z - r) / 20); gz <= Math.floor((z + r) / 20); gz++)
      for (const [px, pz] of bg.get(gx + ',' + gz) || []) if ((px - x) ** 2 + (pz - z) ** 2 < r * r) return true;
    return false;
  };
  const geo0 = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const P0 = geo0.getAttribute('position').array;
  let n = 0;
  const regions = data.parks.slice();
  if (data.palace && data.palace.length > 3) regions.push({ o: data.palace, h: [] });   // 皇居の中も森に
  for (const pk of regions) {
    const o = pk.o;
    let a = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < o.length; k++) {
      const [ax, az] = o[k], [bx, bz] = o[(k + 1) % o.length]; a += ax * bz - bx * az;
      x0 = Math.min(x0, ax); z0 = Math.min(z0, az); x1 = Math.max(x1, ax); z1 = Math.max(z1, az);
    }
    if (Math.abs(a) / 2 < 15000) continue;                    // 大きな緑地だけ
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (area && pointIn(area, cx, cz)) continue;              // 走れる範囲の公園(日比谷公園など)は芝生のまま
    const R = seeded(Math.round(cx * 7 + cz * 13)), pos = [], col = [];
    const c = new THREE.Color();
    for (let x = x0 + 12; x < x1; x += 26) for (let z = z0 + 12; z < z1; z += 26) {
      const px = x + (R() - 0.5) * 14, pz = z + (R() - 0.5) * 14;
      if (!pointIn(o, px, pz) || inWater(px, pz) || (area && pointIn(area, px, pz))) continue;
      const r = 15 + R() * 9, h = 9 + R() * 7;
      if (nearBld(px, pz, r + 3)) continue;
      c.setHSL(0.27 + R() * 0.05, 0.42, 0.22 + R() * 0.08);
      for (let k = 0; k < P0.length; k += 3) {
        pos.push(px + P0[k] * r, Math.max(0, h * 0.55 + P0[k + 1] * h * 0.75), pz + P0[k + 2] * r);
        col.push(c.r, c.g, c.b);
      }
    }
    if (!pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    m.matrixAutoUpdate = false; m.name = 'forest'; g.add(m); n++;
  }
  document.body.dataset.osmForests = String(n);
}

// ---- 敷地(ビルのまわりの空き地): いくつかの色の舗装を混ぜる ----
const LOT_COLORS = [0x6e7073, 0x7c7e80, 0x8f8a80, 0xa59a86, 0x9c8a74, 0x8a6e5c, 0xb3aea4, 0x797670, 0x9fa3a6];
function buildLots(data, g) {
  const groups = LOT_COLORS.map(() => []);
  (data.lots || []).forEach((L) => {
    let cx = 0, cz = 0; for (const [x, z] of L.o) { cx += x; cz += z; }
    const R = seeded(Math.round(cx / L.o.length * 7 + cz / L.o.length * 3));
    groups[Math.floor(R() * LOT_COLORS.length)].push(L);
  });
  groups.forEach((list, i) => { if (list.length) g.add(polyFill(list, 0.008, LOT_COLORS[i])); });
}

// ---- 工事中の敷地: 白い仮囲い、建設中のビル(柱と床の骨組み)、タワークレーン ----
function buildSites(data, g) {
  const wall = { p: [], n: [] }, steel = { p: [], n: [] }, slab = { p: [], n: [] }, crane = { p: [], n: [] }, ground = [];
  for (const s of data.sites || []) {
    const o = s.o;
    let A = 0, cx = 0, cz = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < o.length; k++) {
      const [ax, az] = o[k], [bx, bz] = o[(k + 1) % o.length], c = ax * bz - bx * az;
      A += c; cx += (ax + bx) * c; cz += (az + bz) * c;
      x0 = Math.min(x0, ax); z0 = Math.min(z0, az); x1 = Math.max(x1, ax); z1 = Math.max(z1, az);
      // 仮囲い(白い壁 3m)
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.1) continue;
      boxInto(wall, (ax + bx) / 2, 1.5, (az + bz) / 2, 0.15, 3, L + 0.15, Math.atan2(bx - ax, bz - az));
    }
    const area = Math.abs(A) / 2; if (area < 1) continue;
    cx /= 3 * A; cz /= 3 * A;
    ground.push({ o, h: [] });
    if (area < 1500) continue;            // 小さい工事は囲いだけ
    const R = seeded(Math.round(cx * 13 + cz * 7));
    // 建設中のビル: 敷地の中に入る格子状の柱、3.8m ごとの床。上の方ほど柱だけ
    const side = Math.min(Math.sqrt(area) * 0.55, 60), floors = 4 + Math.floor(R() * Math.min(20, area / 600)), done = Math.floor(floors * (0.5 + R() * 0.3));
    const step = 7.2, n = Math.max(2, Math.round(side / step));
    const bx0 = cx - (n * step) / 2, bz0 = cz - (n * step) / 2;
    const inside = (x, z) => pointIn(o, x, z);
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = bx0 + i * step, z = bz0 + j * step; if (!inside(x, z)) continue;
      boxInto(steel, x, floors * 3.8 / 2, z, 0.6, floors * 3.8, 0.6);
    }
    for (let f = 1; f <= floors; f++) {
      const y = f * 3.8;
      for (let i = 0; i <= n; i++) for (let j = 0; j < n; j++) {
        const x = bx0 + i * step, za = bz0 + j * step;
        if (inside(x, za) && inside(x, za + step)) boxInto(steel, x, y, za + step / 2, 0.4, 0.5, step, 0);
        const zb = bz0 + i * step, xa = bx0 + j * step;
        if (inside(xa, zb) && inside(xa + step, zb)) boxInto(steel, xa + step / 2, y, zb, step, 0.5, 0.4, 0);
      }
      if (f <= done) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = bx0 + (i + 0.5) * step, z = bz0 + (j + 0.5) * step;
        if (inside(x, z)) boxInto(slab, x, y, z, step, 0.3, step);
      }
    }
    // タワークレーン: マスト、運転室、長いジブとカウンタージブ
    const top = floors * 3.8 + 22, mx = bx0 + n * step * (0.3 + R() * 0.4), mz = bz0 + n * step * (0.3 + R() * 0.4), ang = R() * Math.PI * 2;
    const ux = Math.sin(ang), uz = Math.cos(ang), jl = Math.min(55, side + 15);
    boxInto(crane, mx, top / 2, mz, 2, top, 2);
    boxInto(crane, mx, top + 1.5, mz, 3, 3, 3);
    boxInto(crane, mx + ux * jl / 2, top + 3.5, mz + uz * jl / 2, 1.4, 1.4, jl, ang);
    boxInto(crane, mx - ux * 8, top + 3.5, mz - uz * 8, 1.4, 1.4, 16, ang);
    boxInto(crane, mx - ux * 13, top + 2, mz - uz * 13, 3, 3, 4, ang);   // おもり
    boxInto(crane, mx, top + 8, mz, 0.8, 9, 0.8);                         // 頭の塔
    boxInto(crane, mx + ux * jl * 0.7, top - 6, mz + uz * jl * 0.7, 0.15, 18, 0.15);   // 吊りワイヤー
  }
  if (ground.length) g.add(polyFill(ground, 0.009, 0x8c8172));                 // 土
  g.add(solidMesh(wall, new THREE.MeshLambertMaterial({ color: 0xf0f0ec })));
  g.add(solidMesh(steel, new THREE.MeshLambertMaterial({ color: 0x8a7f74 })));
  g.add(solidMesh(slab, new THREE.MeshLambertMaterial({ color: 0xb9b7b1 })));
  g.add(solidMesh(crane, new THREE.MeshLambertMaterial({ color: 0xe0b52c })));
  document.body.dataset.osmSites = String((data.sites || []).length);
}

// ---- 歩道の柵: 片側2車線以上の道路の、車道と歩道の間 ----
// 車道の上か(道路の中心線からの距離で判定。歩道は含まない)。湘南の地表は歩道も「道路」なので、柵の判定に使う
function makeCarriageTest(data) {
  const C = 25, grid = new Map();
  for (const r of data.roads) {
    const half = roadWidth(r) / 2, p = r.pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1], seg = [ax, az, bx, bz, half];
      for (let gx = Math.floor((Math.min(ax, bx) - half) / C); gx <= Math.floor((Math.max(ax, bx) + half) / C); gx++)
        for (let gz = Math.floor((Math.min(az, bz) - half) / C); gz <= Math.floor((Math.max(az, bz) + half) / C); gz++) {
          const k = gx + ',' + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg);
        }
    }
  }
  return (x, z) => {
    for (const [ax, az, bx, bz, half] of grid.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || []) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if ((ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < half * half) return true;
    }
    return false;
  };
}
// ---- 湘南: 歩道と海の岸壁の境目の柵(護岸の上が歩道の所だけ)。形は歩道の柵と同じ ----
function buildSeaFences(walls, g, native, carriage) {
  if (!walls) return;
  const post = { p: [], n: [] }, bar = { p: [], n: [] }, w = walls.w, S = walls.stride ?? 8;
  for (let k = 0; k < w.length; k += S) {
    const ax = w[k], az = w[k + 1], ay = w[k + 2], bx = w[k + 3], bz = w[k + 4], by = w[k + 5], nx = w[k + 6], nz = w[k + 7];
    const len = Math.hypot(bx - ax, bz - az); if (len < 0.1) continue;
    const mx = (ax + bx) / 2 - nx * 0.35, mz = (az + bz) / 2 - nz * 0.35;   // 護岸の縁から 0.35m 陸側
    const hx = mx - nx * 0.6, hz = mz - nz * 0.6, hit = native.at(hx, hz);
    if (!hit || hit.kind !== 1 || carriage(hx, hz)) continue;               // 上が歩道の所だけ
    const y = (ay + by) / 2, ang = Math.atan2(bx - ax, bz - az);
    boxInto(bar, mx, y + 0.71, mz, 0.06, 0.08, len + 0.02, ang);   // 高さは歩道の柵と同じ 3/4
    boxInto(bar, mx, y + 0.34, mz, 0.04, 0.05, len + 0.02, ang);
    boxInto(post, ax - nx * 0.35, y + 0.375, az - nz * 0.35, 0.07, 0.75, 0.07, ang);
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xd9dcdd });
  if (post.p.length) g.add(solidMesh(post, mat), solidMesh(bar, mat));
}
function buildFences(data, g, onRoad, yo = 0, k = 1) {   // yo: 柵の足元の高さ(湘南は歩道が 20cm 高い)、k: 高さの倍率
  const post = { p: [], n: [] }, bar = { p: [], n: [] };
  const J = new Map();
  for (const r of data.roads) for (const i of r.junctions) {
    const k = r.pts[i].join(','); J.set(k, Math.max(J.get(k) || 0, roadWidth(r) / 2));
  }
  for (const r of data.roads) {
    if (r.bridge || !(r.oneway ? r.lanes >= 2 : r.lanes >= 4)) continue;
    const half = roadWidth(r) / 2, p = r.pts, s = cumLen(p), L = s.at(-1), holes = [];
    for (const i of r.junctions) { const R = (J.get(p[i].join(',')) || half) + 6; holes.push([s[i] - R, s[i] + R]); }   // 交差点と横断歩道の所はあける
    holes.sort((a, b) => a[0] - b[0]);
    const spans = []; let x = 0;
    for (const [a, b] of holes) { if (a > x) spans.push([x, a]); x = Math.max(x, b); }
    if (L > x) spans.push([x, L]);
    for (const [a, b] of spans) {
      if (b - a < 6) continue;
      const body = cut(p, s, a, b); if (body.length < 2) continue;
      for (const sd of [-1, 1]) {
        const e = offset(body, sd * (half + 0.45));
        let acc = 0;
        for (let i = 0; i + 1 < e.length; i++) {
          const [x0, z0] = e[i], [x1, z1] = e[i + 1], len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.1) continue;
          const tx = (x1 - x0) / len, tz = (z1 - z0) / len, nx = tz * sd, nz = -tx * sd, ang = Math.atan2(tx, tz);   // 外向き(offset と同じ向き)
          // 外側が別の車道(中央分離帯)なら柵は作らない
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if ([1.6, 3, 5, 8, 11, 14].some((d) => onRoad(mx + nx * d, mz + nz * d))) { acc += len; continue; }   // 中央分離帯(向こうも車道)には柵なし
          boxInto(bar, mx, yo + 0.95 * k, mz, 0.06, 0.08, len, ang);
          boxInto(bar, mx, yo + 0.45 * k, mz, 0.04, 0.05, len, ang);
          for (let d = (3 - acc % 3) % 3; d < len; d += 3) boxInto(post, x0 + tx * d, yo + 0.5 * k, z0 + tz * d, 0.07, 1.0 * k, 0.07, ang);
          acc += len;
        }
      }
    }
  }
  const mat = new THREE.MeshLambertMaterial({ color: 0xd9dcdd });
  g.add(solidMesh(post, mat), solidMesh(bar, mat));
}

// ---- 林(防砂林・松林など): 芝の地面に、こんもりした木の塊を並べる。道路・建物の上には置かない ----
// 森の壁の絵(横長): 木の絵をたくさん重ねて、すき間のない木立にする。下は暗く、上は明るい
function makeForestStrip(seed) {
  const W = 1024, H = 256, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), R = seeded(seed);
  // 奥の暗い茂み
  for (let q = 0; q < 1800; q++) {
    const x = R() * W, top = H * (0.18 + 0.25 * Math.abs(Math.sin(x * 0.011 + seed)) + R() * 0.1), y = top + R() * (H * 0.92 - top);
    const d = (y - top) / (H - top), r = 6 + R() * 10;
    g.fillStyle = `hsl(${82 + R() * 22},${34 + R() * 14}%,${Math.round(31 - d * 7 + R() * 5)}%)`;   // 奥: 街路樹の色を中心に少し暗く
    g.beginPath(); g.ellipse(x, y, r * 1.4, r, R() * 3, 0, Math.PI * 2); g.fill();
  }
  // 手前の幹(ところどころ見える)
  g.strokeStyle = 'rgba(60,45,35,0.9)';
  for (let q = 0; q < 26; q++) { const x = R() * W; g.lineWidth = 3 + R() * 4; g.beginPath(); g.moveTo(x, H); g.lineTo(x + (R() - 0.5) * 10, H * 0.62); g.stroke(); }
  // 手前の明るい葉の塊(上の方)
  for (let q = 0; q < 900; q++) {
    const x = R() * W, top = H * (0.16 + 0.25 * Math.abs(Math.sin(x * 0.011 + seed))), y = top + R() * H * 0.45;
    const r = 4 + R() * 8;
    g.fillStyle = `hsl(${80 + R() * 24},${36 + R() * 16}%,${Math.round(35 + R() * 10 - (y - top) / H * 10)}%)`;   // 手前: 淡めの緑
    g.beginPath(); g.ellipse(x, y, r * 1.4, r, R() * 3, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.anisotropy = 4;
  return tex;
}
function buildWoods(data, g, onRoad, blocked) {
  // 林: 芝の地面と、縁に沿って立てた「森の壁の絵」を何枚か重ねる(車から見た背景が木立に見えるように)
  const W = data.woods || []; if (!W.length) return;
  g.add(polyFill(W, 0.03, 0x5f7f45));
  const P = [], U = [], N = [];
  let panels = 0;
  for (const w of W) {
    const o = w.o; let A = 0;
    for (let k = 0; k < o.length; k++) { const [ax, az] = o[k], [bx, bz] = o[(k + 1) % o.length]; A += ax * bz - bx * az; }
    const inward = A > 0 ? 1 : -1;   // 内側の向き
    const R = seeded(Math.round(o[0][0] * 3 + o[0][1] * 7));
    for (const depth of [2.5, 9, 17]) {
      for (let k = 0; k < o.length; k++) {
        const [ax, az] = o[k], [bx, bz] = o[(k + 1) % o.length], L = Math.hypot(bx - ax, bz - az); if (L < 4) continue;
        const tx = (bx - ax) / L, tz = (bz - az) / L, nx = -tz * inward, nz = tx * inward;
        for (let s0 = 0; s0 < L; s0 += 22) {
          const s1 = Math.min(L, s0 + 24), h = 11 + R() * 5;
          const x0 = ax + tx * s0 + nx * depth, z0 = az + tz * s0 + nz * depth, x1 = ax + tx * s1 + nx * depth, z1 = az + tz * s1 + nz * depth;
          const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
          if (!pointIn(o, mx, mz) || onRoad(mx, mz) || onRoad(x0, z0) || onRoad(x1, z1)) continue;
          if (blocked.hitsBuilding && blocked.hitsBuilding(mx, mz, 1)) continue;
          const u0 = R() * 4, u1 = u0 + (s1 - s0) / 24;
          P.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, 0, z0, x1, h, z1, x0, h, z0);
          U.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
          for (let q = 0; q < 6; q++) N.push(0, 1, 0);
          panels++;
        }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: makeForestStrip(7), alphaTest: 0.5, side: THREE.DoubleSide }));
  m.matrixAutoUpdate = false; m.name = 'woods'; g.add(m);
  // 中にも街路樹と同じ木の絵を並べる(上から見ても林に見えるように)
  const pts = [];
  for (const w of W) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of w.o) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const R = seeded(Math.round(x0 * 5 + z0 * 3));
    for (let x = x0 + 6; x < x1; x += 11) for (let z = z0 + 6; z < z1; z += 11) {
      const px = x + (R() - 0.5) * 7, pz = z + (R() - 0.5) * 7;
      if (!pointIn(w.o, px, pz)) continue;
      if ([[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]].some(([a, b]) => onRoad(px + a, pz + b))) continue;
      if (blocked.hitsBuilding && blocked.hitsBuilding(px, pz, 3)) continue;
      pts.push([px, pz]);
    }
  }
  buildTrees({ trees: pts }, g, 1.3);
  document.body.dataset.osmWoods = String(panels + pts.length);
}

// ---- 街路樹(位置は osm_to_city.py が決める) ----
// 木の絵(2次元)。何種類かを1枚に並べる。
// 幹から枝を伸ばし、枝先ごとに葉の塊(小さな葉をたくさん、下は暗く上は明るく)を描く。塊のすき間から枝が見える。
const TREE_KINDS = [
  { w: 0.92, top: 0.06, bot: 0.55, clumps: 16, hue: 0.27 },   // 横に広い(ケヤキ風)
  { w: 0.80, top: 0.03, bot: 0.62, clumps: 14, hue: 0.25 },   // 写真のような高木
  { w: 0.55, top: 0.03, bot: 0.70, clumps: 12, hue: 0.22 },   // 縦長(イチョウ風・黄緑)
  { w: 0.95, top: 0.14, bot: 0.55, clumps: 18, hue: 0.29 },   // 低く横に張る
  { w: 0.70, top: 0.05, bot: 0.66, clumps: 13, hue: 0.30 },   // 濃い緑
  { w: 0.85, top: 0.08, bot: 0.58, clumps: 15, hue: 0.24 },   // 明るい緑
];
function makeTreeAtlas() {
  const S = 384, c = document.createElement('canvas'); c.width = S * TREE_KINDS.length; c.height = S;
  const g = c.getContext('2d');
  TREE_KINDS.forEach((k, i) => {
    const R = seeded(900 + i * 37), ox = i * S, bx = ox + S / 2;
    // 隣の木の枠へはみ出さない(はみ出すと隣の木の横に葉が浮いて見える)
    g.save(); g.beginPath(); g.rect(ox + 3, 0, S - 6, S); g.clip();
    const cy = S * (k.top + k.bot) / 2, ry = S * (k.bot - k.top) / 2, rx = S * k.w / 2;
    // 葉の塊の位置(樹冠の楕円の中、外側寄り)
    const cl = [];
    for (let q = 0; q < k.clumps; q++) {
      const a = (q / k.clumps) * Math.PI * 2 + R() * 0.5, r = 0.45 + R() * 0.5;
      cl.push([bx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r * 0.9 - ry * 0.05, S * (0.07 + R() * 0.05)]);
    }
    cl.push([bx, cy - ry * 0.55, S * 0.09]);
    // 幹
    const forkY = cy + ry * 0.35;
    g.strokeStyle = '#4a3b2e'; g.lineCap = 'round';
    g.lineWidth = S * 0.032; g.beginPath(); g.moveTo(bx, S); g.lineTo(bx + (R() - 0.5) * S * 0.02, forkY); g.stroke();
    // 枝: 幹の上から各塊へ(根元は太く)
    for (const [x, y] of cl) {
      g.lineWidth = S * (0.008 + R() * 0.01);
      g.beginPath(); g.moveTo(bx, forkY + R() * ry * 0.3);
      g.quadraticCurveTo((bx + x) / 2 + (R() - 0.5) * 20, (forkY + y) / 2, x, y); g.stroke();
    }
    // 葉の塊: 下から上へ描く(上の塊が手前)
    cl.sort((a, b) => b[1] - a[1]);
    for (const [x, y, r] of cl) {
      for (let q = 0; q < 140; q++) {
        const a = R() * Math.PI * 2, d = Math.sqrt(R()) * r;
        const px = x + Math.cos(a) * d * 1.25, py = y + Math.sin(a) * d * 0.8;
        const up = (y - py) / r;                                   // -1(下)〜1(上)
        const light = 0.20 + 0.16 * (up + 1) / 2 + (R() - 0.5) * 0.08 + (px < x ? 0.03 : 0);
        g.fillStyle = `hsl(${Math.round((k.hue + (R() - 0.5) * 0.04) * 360)},${Math.round(48 + R() * 20)}%,${Math.round(light * 100)}%)`;
        const lr = S * (0.008 + R() * 0.008);
        g.beginPath(); g.ellipse(px, py, lr * 1.6, lr, R() * Math.PI, 0, Math.PI * 2); g.fill();
      }
    }
    g.restore();
  });
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
// 木の絵を貼る1枚の板。いつもカメラの方を向く(縦は立てたまま)。
function treeGeometry(kind) {
  const u0 = kind / TREE_KINDS.length + 0.004, u1 = (kind + 1) / TREE_KINDS.length - 0.004, P = [], U = [], N = [];
  const q = [[-0.5, 0, u0, 0], [0.5, 0, u1, 0], [0.5, 1, u1, 1], [-0.5, 0, u0, 0], [0.5, 1, u1, 1], [-0.5, 1, u0, 1]];
  for (const [x, y, u, v] of q) { P.push(x, y, 0); U.push(u, v); N.push(0, 1, 0); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return geo;
}
function billboard(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
      vec4 bbC = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
      float bbW = length(instanceMatrix[0].xyz), bbH = length(instanceMatrix[1].xyz);
      vec3 bbR = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * vec3(1.0, 0.0, 1.0) + vec3(1e-5, 0.0, 0.0));
      vec4 mvPosition = viewMatrix * vec4(bbC.xyz + bbR * position.x * bbW + vec3(0.0, position.y * bbH, 0.0), 1.0);
      gl_Position = projectionMatrix * mvPosition;`);
  };
  return mat;
}
// ---- 中央分離帯の低い植え込み(湘南): 緑地の上に高さ 0.75m の箱。端は交差点に出ないよう 0.5m ずつ縮める ----
// 色は濃い緑が基本。約 2.5m ごとに区切り、濃い緑の数種類から選んで並べる。
const HEDGE_GREENS = [0x2c5426, 0x35612d, 0x274a22, 0x3d6b34, 0x2f5a30].map((h) => new THREE.Color(h));
function buildHedges(data, g, native) {
  const o = { p: [], n: [], c: [] }, H = 0.75;   // 膝丈の1.5倍
  let seed = 0;
  for (const [x, z, ang, len, wid] of data.medians || []) {
    const L = len - 1.0, W = Math.min(1.2, Math.max(0.5, wid - 0.6)); if (L < 1) continue;   // 幅は一定(1.2m)で緑地帯の真ん中。狭い所だけ細く
    const y0 = native?.at(x, z)?.y ?? 0, y1 = y0 + H;
    const tx = Math.sin(ang), tz = Math.cos(ang), n = Math.max(1, Math.round(L / 2.5)), seg = L / n;
    const R = seeded(Math.round(x * 13 + z * 7) + seed++);
    for (let k = 0; k < n; k++) {
      const off = -L / 2 + seg * (k + 0.5), cx = x + tx * off, cz = z + tz * off;
      const col = HEDGE_GREENS[Math.floor(R() * HEDGE_GREENS.length)];
      const hx = tx * seg / 2, hz = tz * seg / 2, nx = tz * W / 2, nz = -tx * W / 2;
      const c = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => [cx + hx * a + nx * b, cz + hz * a + nz * b]);
      const top = []; rect(cx, cz, ang, seg, W, y1, top); upward(top);
      for (let q = 0; q < top.length; q += 3) { o.p.push(top[q], top[q + 1], top[q + 2]); o.n.push(0, 1, 0); o.c.push(col.r, col.g, col.b); }
      for (let i = 0; i < 4; i++) {
        const [ax, az] = c[i], [bx, bz] = c[(i + 1) % 4], l = Math.hypot(bx - ax, bz - az);
        let ex = (bz - az) / l, ez = -(bx - ax) / l;
        if (ex * (ax - cx) + ez * (az - cz) < 0) { ex = -ex; ez = -ez; }   // 外向き
        o.p.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y0, az, bx, y1, bz, ax, y1, az);
        for (let q = 0; q < 6; q++) { o.n.push(ex, 0, ez); o.c.push(col.r * 0.85, col.g * 0.85, col.b * 0.85); }   // 横は少し暗く
      }
    }
  }
  if (!o.p.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.matrixAutoUpdate = false; m.name = 'median-hedges'; m.userData.noLift = true; g.add(m);
}
function buildTrees(data, g, big = 1, nativeSurfaces = false) {
  const T = data.trees || []; if (!T.length) return;
  const mat = billboard(new THREE.MeshLambertMaterial({ map: makeTreeAtlas(), alphaTest: 0.5, side: THREE.DoubleSide }));
  const groups = TREE_KINDS.map(() => []);
  T.forEach(([x, z]) => { const R = seeded(Math.round(x * 31 + z * 17)); R(); groups[Math.floor(R() * TREE_KINDS.length)].push([x, z, R]); });
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), P = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
  groups.forEach((list, kind) => {
    if (!list.length) return;
    const m = new THREE.InstancedMesh(treeGeometry(kind), mat, list.length);
    list.forEach(([x, z, R], i) => {
      const s = 0.8 + R() * 0.45;
      M.compose(P.set(x, TERRAIN ? TERRAIN.at(x, z) : 0, z), Q.setFromAxisAngle(Y, R() * Math.PI), S.set(10 * s * big, 10 * s * big * (big === 1 ? 0.8 : 1), 10 * s * big)); m.setMatrixAt(i, M);   // 街路樹は高さ 0.8 倍
      C.setHSL(0, 0, 0.88 + R() * 0.2); m.setColorAt(i, C);   // 木ごとに少し明るさを変える
    });
    m.frustumCulled = false; m.name = 'street-trees'; g.add(m);
  });
  // 木の並ぶ帯(植え込み)は芝生の色
  const gs = [];
  for (const [x, z, ang, len, wid] of data.strips || []) rect(x, z, ang, len, wid, 0.03, gs);
  if (!nativeSurfaces && gs.length) g.add(flatMesh(gs, GRASS));
  // 車道に挟まれた緑地帯(木なし・黄緑)
  const md = [];
  for (const [x, z, ang, len, wid] of data.medians || []) rect(x, z, ang, len, wid, 0.035, md);
  if (!nativeSurfaces && md.length) g.add(flatMesh(md, 0x6f8f3a));
  if (big === 1) document.body.dataset.osmTrees = String(T.length);
}

// ---- 1階は窓ではなく出入口(ガラス戸と看板の帯) ----
// 壁の絵の上から、高さ 4.2m より下だけ描き替える。横方向の位置は uv.x × 絵の幅(m)。
function addStorefront(mat, tileW, bays = 4, floors = 4) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTileW = { value: tileW };
    sh.uniforms.uGrid = { value: new THREE.Vector2(bays, floors) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWY; varying float vWX; varying float vSF; varying float vLR; varying vec2 vTUV;\nuniform float uTileW;\nattribute float sf; attribute float lr;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y; vWX = uv.x * uTileW; vSF = sf; vLR = lr; vTUV = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWY; varying float vWX; varying float vSF; varying float vLR; varying vec2 vTUV;\nuniform vec2 uGrid;\nfloat sfGlass = 0.0;\nfloat litHash(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }')
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
        // 夜の窓: 全部ではなくまばらに。建物ごとの割合(2〜5割)で、窓1枚ずつ点ける・消すを決める
        float litSeed = floor(vLR), litRatio = vLR > 0.5 ? fract(vLR) : 0.35;
        if (vWY < 4.2 && vSF > 0.5) totalEmissiveRadiance = emissive * vec3(1.0, 0.86, 0.62) * sfGlass * step(litHash(vec2(floor(vWX / 2.4), litSeed + 7.0)), litRatio);   // 店の明かり
        else totalEmissiveRadiance *= step(litHash(floor(vTUV * uGrid) + vec2(litSeed * 0.731, litSeed * 1.37)), litRatio);`);
  };
}

// ---- 正面玄関(東京証券取引所): 白い枠に囲まれた黒い大きな開口、入口の上に旗のような看板 ----
function makeJpxSign() {
  // 白地に、上に赤い縦線4本、下に赤い半円(文字は入れない)
  const W = 256, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#d7262e';
  for (let i = 0; i < 4; i++) {   // 少し傾いた平行四辺形の縦線
    const x = 62 + i * 36;
    g.beginPath(); g.moveTo(x, 70); g.lineTo(x + 22, 62); g.lineTo(x + 22, 170); g.lineTo(x, 178); g.closePath(); g.fill();
  }
  g.beginPath(); g.arc(W / 2, H - 40, 96, Math.PI, 0); g.closePath(); g.fill();   // 赤い半円(日の出)
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function buildFront(f, g) {
  const tx = -f.nz, tz = f.nx;   // 壁に沿った横向き
  const quad = (w, y0, y1, out, mat) => {
    const cx = f.x + f.nx * out, cz = f.z + f.nz * out, hx = tx * w / 2, hz = tz * w / 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      cx - hx, y0, cz - hz, cx + hx, y0, cz + hz, cx + hx, y1, cz + hz,
      cx - hx, y0, cz - hz, cx + hx, y1, cz + hz, cx - hx, y1, cz - hz], 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([f.nx, 0, f.nz, f.nx, 0, f.nz, f.nx, 0, f.nz, f.nx, 0, f.nz, f.nx, 0, f.nz, f.nx, 0, f.nz], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1], 2));
    const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; g.add(m);
  };
  const W = Math.min(f.w * 0.62, 14);
  // 白い枠の両側の袖壁(建物から 2.6m 張り出す)
  for (const sd of [-1, 1]) {
    const px = f.x + tx * sd * (W + 5) / 2 + f.nx * 1.3, pz = f.z + tz * sd * (W + 5) / 2 + f.nz * 1.3;
    const bx = { p: [], n: [] }; boxInto(bx, px, 13.5, pz, 0.4, 27, 2.6, Math.atan2(f.nx, f.nz));
    g.add(solidMesh(bx, new THREE.MeshLambertMaterial({ color: 0xf2f1ee })));
  }
  const top = { p: [], n: [] }; boxInto(top, f.x + f.nx * 1.3, 27.2, f.z + f.nz * 1.3, W + 5.4, 0.6, 2.6, Math.atan2(f.nx, f.nz));
  g.add(solidMesh(top, new THREE.MeshLambertMaterial({ color: 0xf2f1ee })));
  quad(W + 5, 0, 27, 2.6, new THREE.MeshLambertMaterial({ color: 0xf2f1ee, side: THREE.DoubleSide }));   // 白い枠
  quad(W, 0, 24, 2.7, new THREE.MeshLambertMaterial({ color: 0x15171a, side: THREE.DoubleSide }));       // 黒い開口
  quad(W * 0.78, 6.5, 6.5 + W * 0.78 * 1.45, 2.8, new THREE.MeshLambertMaterial({ map: makeJpxSign(), side: THREE.DoubleSide }));   // 看板(入口の上)
  quad(W * 0.5, 0, 4.5, 2.8, new THREE.MeshLambertMaterial({ color: 0x3a4148, side: THREE.DoubleSide }));   // 入口のガラス戸
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
      if (L.front) {   // 正面玄関の前に張り出した部分は消す(玄関の枠と看板を見せる)
        const f = L.front, mx = (A.x + B.x + C.x) / 3, mz = (A.z + B.z + C.z) / 3;
        const d = (mx - f.x) * f.nx + (mz - f.z) * f.nz, s = (mx - f.x) * -f.nz + (mz - f.z) * f.nx;
        if (d > -1.5 && d < 8 && Math.abs(s) < f.w / 2 + 1 && (A.y + B.y + C.y) / 3 < 30) continue;
      }
      if (Math.abs(N.y) > 0.5) {   // 傾いた面・水平な面は窓を貼らず屋根の色で
        for (const P of [A, B, C]) { RP.push(P.x, P.y, P.z); RC.push(rcol.r, rcol.g, rcol.b); }
        continue;
      }
      // 指定した辺に面した壁だけ別の色(例: コレド日本橋の永代通り側を水色)
      let fcol = col, WW = W, SS = S;
      if (L.faceColor) {
        const [[sx0, sz0], [sx1, sz1]] = L.faceColor.seg, sl = Math.hypot(sx1 - sx0, sz1 - sz0) || 1;
        const ux = (sx1 - sx0) / sl, uz = (sz1 - sz0) / sl, mx = (A.x + B.x + C.x) / 3 - sx0, mz = (A.z + B.z + C.z) / 3 - sz0;
        const along = mx * ux + mz * uz, side = mx * -uz + mz * ux;   // side: 辺から外向き(+)の距離
        if (along > -2 && along < sl + 2 && side > -15 && side < 30 && Math.abs(N.x * -uz + N.z * ux) > 0.7) { fcol = L._fc || (L._fc = new THREE.Color(L.faceColor.color)); WW = walls[L.faceColor.style ?? 0]; SS = STYLES[L.faceColor.style ?? 0]; }
      }
      // 横方向(面に沿った水平の向き)
      let hx = -N.z, hz = N.x; const hl = Math.hypot(hx, hz); if (hl < 1e-3) { hx = 1; hz = 0; } else { hx /= hl; hz /= hl; }
      for (const P of [A, B, C]) {
        WW.p.push(P.x, P.y, P.z); WW.n.push(N.x, N.y, N.z); WW.c.push(fcol.r, fcol.g, fcol.b);
        WW.u.push((P.x * hx + P.z * hz) / SS.tileW, P.y / SS.tileH); WW.f.push(L.awning ? 2 : 1);
      }
    }
    for (let k = 0; k < L.roofs.length; k += 3) { RP.push(L.roofs[k], L.roofs[k + 1], L.roofs[k + 2]); RC.push(rcol.r, rcol.g, rcol.b); }
  });
  for (const L of lm.landmarks) if (L.front) buildFront(L.front, g);
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
function makeBlocker(data, native = null) {
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
  if (!native) data.water.forEach((w) => add(w.o, w.h, 'w'));
  // 線で描かれた川: 線分ごとに幅つきで登録
  for (const rv of native ? [] : data.rivers || []) for (let i = 0; i + 1 < rv.pts.length; i++) {
    const [ax, az] = rv.pts[i], [bx, bz] = rv.pts[i + 1], h = rv.w / 2;
    add([[Math.min(ax, bx) - h, Math.min(az, bz) - h], [Math.max(ax, bx) + h, Math.max(az, bz) + h]], [ax, az, bx, bz, h], 'r');
  }
  // 線路の高架・ホーム: 道路の上(高架下をくぐる所)以外は通れない
  for (const v of data.viaducts || []) if (!v.concrete && !v.ceil) add(v.rings[0].map(([x, z]) => [x, z]), v.rings.slice(1).map((r) => r.map(([x, z]) => [x, z])), 'w');   // 高架: 道路の所だけ通れる
  (data.platforms || []).forEach((pf) => { if (pf.y > 0) add(pf.o, pf.h, 'w'); });
  for (const s of data.sites || []) add(s.o, [], 'b');   // 工事中の敷地には入れない(街路樹・林は当たり判定なし)
  const area = data.area;
  // 道路(橋の上を走れるように): 1m 角の升目に印
  const RW = Math.ceil(X1 - X0), RH = Math.ceil(Z1 - Z0), road = native ? null : new Uint8Array(RW * RH);
  for (const r of native ? [] : data.roads) {
    // 上下線が並んだ橋は、あいだのすき間(中央分離帯)まで床なので道路として印を付ける
    const half = r.bridge && r.pair ? r.pair.gap / 2 + roadWidth(r) / 2 + 0.5 : roadWidth(r) / 2 + 0.5;
    const p = r.bridge && r.pair ? offset(r.pts, r.pair.side * r.pair.gap / 2) : r.pts;
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
  // 交差点の角も道路にする(角を曲がる時に引っ掛からないように)
  const JR = new Map();
  for (const r of native ? [] : data.roads) for (const i of r.junctions) { const k = r.pts[i].join(','); JR.set(k, Math.max(JR.get(k) || 0, roadWidth(r) / 2 + 2.5)); }
  for (const [k, R] of JR) {
    const [jx, jz] = k.split(',').map(Number);
    for (let dz = -R; dz <= R; dz += 0.7) for (let dx = -R; dx <= R; dx += 0.7) {
      if (dx * dx + dz * dz > R * R) continue;
      const ix = Math.floor(jx + dx - X0), iz = Math.floor(jz + dz - Z0);
      if (ix >= 0 && iz >= 0 && ix < RW && iz < RH) road[iz * RW + ix] = 1;
    }
  }
  const onRoad = native ? (x, z) => native.at(x, z)?.kind === 1 : (x, z) => { const ix = Math.floor(x - X0), iz = Math.floor(z - Z0); return ix >= 0 && iz >= 0 && ix < RW && iz < RH && road[iz * RW + ix] === 1; };
  const fn = (x, z, r = 0.3) => {
    if (x < X0 + r || x > X1 - r || z < Z0 + r || z > Z1 - r) return true;
    if (area && !pointIn(area, x, z)) return true;   // 走れる範囲(川や幹線道路で区切った多角形)の外
    if (native) { const hit = native.at(x, z); if (!hit || hit.kind === 3) return true; if (fn.refY != null && Math.abs(hit.y - fn.refY) > 1.2) return true; }   // 護岸(2m の段差)は越えられない
    if (TERRAIN && TERRAIN.inBox(x, z) && TERRAIN.slope(x, z) > 0.18) return true;   // 江の島: 急な坂には入れない(道路の上も)
    if (onRoad(x, z)) return false;                  // 車道の上は何があっても通れる(引っ掛かり防止)
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
  // 砂浜・砂地(砂煙を出す)
  const sg = new Map();
  for (const b of data.beaches || []) {
    let a = Infinity, bb = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, z] of b.o) { a = Math.min(a, x); bb = Math.min(bb, z); c = Math.max(c, x); d = Math.max(d, z); }
    for (let gx = Math.floor(a / C); gx <= Math.floor(c / C); gx++) for (let gz = Math.floor(bb / C); gz <= Math.floor(d / C); gz++) {
      const k = gx + ',' + gz; if (!sg.has(k)) sg.set(k, []); sg.get(k).push(b);
    }
  }
  if (native) fn.setFrom = (x, z) => { const h = native.at(x, z); fn.refY = h ? h.y : null; };
  fn.isSand = native ? (x, z) => native.at(x, z)?.kind === 2 : (x, z) => !onRoad(x, z) && (sg.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || []).some((b) => inPoly(b.o, b.h, x, z));
  fn.hitsBuilding = (x, z, r) => {
    const list = grid.get(Math.floor(x / C) + ',' + Math.floor(z / C)) || [];
    return list.some((it) => it.kind === 'b' && x > it.box[0] - r && x < it.box[2] + r && z > it.box[1] - r && z < it.box[3] + r
      && [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]].some(([a, b]) => inPoly(it.o, it.h, x + a, z + b)));
  };
  return fn;
}

// 現在の表示形状だけを地表メッシュへ変換するためのスナップショット。
// 元の GLB や OSM ファイルは使わない。道路の幅・白線も表示と同じ関数から取り出す。
export function snapshotCitySurfaceLayers(data) {
  const layers = [];
  const rings = (name, list, color, kind = 'land', y = 0) => {
    if (list.length) layers.push({ name, rings: list, color, kind, y });
  };
  const triangles = (name, positions, color, kind = 'land', y = 0) => {
    if (positions.length) layers.push({ name, positions, color, kind, y });
  };
  const [x0, z0, x1, z1] = data.bounds;
  rings('ground', [{ o: [[x0 - 300, z0 - 300], [x1, z0 - 300], [x1, z1 + 300], [x0 - 300, z1 + 300]], h: [] }], WALK);
  for (const [name, ws, depth] of [
    ['sea', data.water.filter((w) => w.sea), SEA_DEPTH],
    ['river', data.water.filter((w) => !w.sea && !w.moat), SEA_DEPTH],   // 水面はすべて同じ高さ(段差の帯を作らない)
    ['moat', data.water.filter((w) => w.moat), SEA_DEPTH],
  ]) rings(name, ws, WATER, 'water', -0.03);   // 水面は陸とほぼ同じ高さ(岸に段差・すき間を作らない)
  const river = [];
  for (const rv of data.rivers || []) {
    ribbon(rv.pts, rv.w, 0, river);
    for (let i = 1; i + 1 < rv.pts.length; i++) disc(rv.pts[i][0], rv.pts[i][1], rv.w / 2, 0, river);
  }
  triangles('river-lines', river, WATER, 'water', -0.03);
  // terrain は生成側でこの位置に挿入(既存の島の形を地表として使う)。
  layers.push({ name: 'terrain', color: GRASS, kind: 'land' });
  const lots = LOT_COLORS.map(() => []);
  for (const L of data.lots || []) {
    const cx = L.o.reduce((a, p) => a + p[0], 0) / L.o.length;
    const cz = L.o.reduce((a, p) => a + p[1], 0) / L.o.length;
    lots[Math.floor(seeded(Math.round(cx * 7 + cz * 3))() * lots.length)].push(L);
  }
  lots.forEach((ls, i) => rings('lot-' + i, ls, LOT_COLORS[i]));
  rings('parks', data.parks || [], GRASS);
  rings('beaches', data.beaches || [], SAND, 'sand');
  rings('rocks', data.rocks || [], 0x9a9b98);
  rings('piers', data.piers || [], 0x9a9b98);
  rings('parking', data.parking || [], ASPHALT, 'road');
  const gs = [], md = [];
  for (const [x, z, ang, len, wid] of data.strips || []) rect(x, z, ang, len, wid, 0, gs);
  for (const [x, z, ang, len, wid] of data.medians || []) rect(x, z, ang, len, wid, 0, md);
  const roadLayers = new Map();
  const scratch = new THREE.Group();
  buildRoads(data, scratch, (p, color, name) => roadLayers.set(name, { p, color }));
  scratch.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  // 元の高さの順を明示。水面以外の色は同じ地表を分けて割り当てる。
  for (const name of ['sidewalk', 'deck']) { const q = roadLayers.get(name); triangles(name, q.p, q.color, 'road'); }
  triangles('strips', gs, SIDEWALK_COLOR, 'road'); triangles('medians', md, 0x6f8f3a);   // 歩道の緑地帯はなくして、ただの歩道
  for (const name of ['curb', 'road', 'white', 'yellow']) {
    const q = roadLayers.get(name); triangles(name, q.p, q.color, 'road');
  }
  return layers;
}

export function decorateOsmCity(root, url, landmarkUrl, bridgeUrl, terrainUrl, surfaceUrl = null) {
  let panorama = null;
  let terrainMesh = null, onTerrain = null;
  root.traverse((o) => { if (o.isMesh) o.visible = false; });
  const styleTex = STYLES.map((s, i) => makeStyleTextures(s, i));
  const glow = [];
  const wallMats = STYLES.map((s, i) => { const m = new THREE.MeshLambertMaterial({ map: styleTex[i].map, vertexColors: true, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: styleTex[i].emissiveMap, emissiveIntensity: 0 }); addStorefront(m, s.tileW, s.bays, s.floors); glow.push(m); return m; });
  const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const city = new THREE.Group(); city.name = 'osm-city';
  (surfaceUrl ? root : root.parent || root).add(city);
  let blocked = () => false, night = false, cityBounds = null, lampCtl = null, foamMesh = null;
  const lmFetch = landmarkUrl ? fetch(landmarkUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  const brFetch = bridgeUrl ? fetch(bridgeUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  const trFetch = terrainUrl ? fetch(terrainUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  // 読み込み中の表示
  const loading = document.createElement('div');
  loading.id = 'osm-loading';
  loading.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(12,16,20,0.78);color:#fff;font:600 28px system-ui,sans-serif;letter-spacing:0.2em;pointer-events:none;';
  loading.innerHTML = '<div style="text-align:center">読み込み中<div id="osm-loading-step" style="margin-top:12px;font:400 14px system-ui,sans-serif;letter-spacing:0.05em;opacity:0.75">地図データを取得中…</div></div>';
  document.body.appendChild(loading);
  const step = (s) => { const el = document.getElementById('osm-loading-step'); if (el) el.textContent = s; };
  const t0 = performance.now(), times = {};
  const T = (name, fn) => { const a = performance.now(); fn(); times[name] = Math.round(performance.now() - a); };
  const ready = Promise.all([fetch(url).then((r) => r.json()), lmFetch, brFetch, trFetch]).then(async ([data, lm, br, tr]) => {
    TERRAIN = tr ? makeTerrain(tr) : null;
    times.fetch = Math.round(performance.now() - t0);
    step('街を組み立て中…');
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));   // 文字を先に描かせる
    const [X0, Z0, X1, Z1] = data.bounds;
    const native = surfaceUrl ? await loadNativeSurfaces(surfaceUrl, city) : null;
    if (surfaceUrl) foamMesh = await loadFoam(surfaceUrl.replace('shonan-surfaces.json', 'shonan-foam.json'), city).catch(() => null);
    foamMesh?.userData.setNight(night);
    const wallData = surfaceUrl ? await loadWalls(surfaceUrl.replace('shonan-surfaces.json', 'shonan-walls.json'), city).catch(() => null) : null;
    if (surfaceUrl) lampCtl = await loadLamps(surfaceUrl.replace('shonan-surfaces.json', 'shonan-lamps.json'), city, native).catch((e) => { console.warn('街灯', e); return null; });
    lampCtl?.setNight(night);   // 読み込む前に夜になっていた時
    if (!native) {
      // 地面: 東の端に海がある湘南は、東側を範囲の端で切る(その先は何も描かない)
      const gEast = data.water.some((w) => w.sea) ? X1 : X1 + 300;
      const ground = []; ribbon([[X0 - 300, (Z0 + Z1) / 2], [gEast, (Z0 + Z1) / 2]], Z1 - Z0 + 600, -0.3, ground);
      const gm = flatMesh(ground, WALK);   // 地面は他の面より奥に描く(遠くで水面や公園が地面に負けないように)
      gm.material.polygonOffsetFactor = 4; gm.material.polygonOffsetUnits = 4; gm.userData.noLift = true;
      city.add(gm);
      city.add(polyFill(data.parks, 0.02, GRASS));
      gm.renderOrder = -1.4;   // 空(-2)のあと、水の穴(-1.8 / -1.6)のあと
      T('buildLots', () => buildLots(data, city));
      T('buildWater', () => buildWater(data, city));
      if (data.beaches && data.beaches.length) city.add(polyFill(data.beaches, 0.026, SAND));   // 砂浜
      if (data.rocks && data.rocks.length) city.add(polyFill(data.rocks, 0.027, 0x9a9b98));   // 岩場(黒っぽいグレー)
      if (data.piers && data.piers.length) city.add(polyFill(data.piers, 0.028, data.woods && data.woods.length ? 0x9a9b98 : WALK));   // TOKYO は地面と同じグレー   // 堤防・突堤(グレー)
      if (data.parking && data.parking.length) city.add(polyFill(data.parking, 0.03, ASPHALT));   // 駐車場(アスファルトの面)
    } else {
      terrainMesh = native.support;
      // 水辺の壁(立体の岸)は作らない: 地表は1枚の平らな面だけ
      document.body.dataset.shonanSurfaceMode = 'native-partition';
      document.body.dataset.shonanSurfaceStats = JSON.stringify(native.stats);
    }
    if (!(data.woods && data.woods.length)) T('buildForests', () => buildForests(data, city));   // 湘南は林を木の絵で
    // 湘南: 街路樹はなし。中央分離帯の緑地は低い植え込み
    if (native) T('buildHedges', () => buildHedges(data, city, native));
    else T('buildTrees', () => buildTrees(data, city, 1, false));
    T('buildRoads', () => buildRoads(data, city, native ? () => {} : null));
    T('buildElevated', () => buildElevated(data, city));
    if (br) T('buildBridges', () => buildBridges(br, city, data.area));
    T('buildArches', () => buildArches(data, city));
    T('buildBuildings', () => buildBuildings(data, city, wallMats, roofMat, { smallColors: surfaceUrl ? SHONAN_SMALL_COLORS : TOKYO_SMALL_COLORS, groundAt: native ? (x, z) => Math.min(0, native.at(x, z)?.y ?? 0) : null }));
    if (lm) {
      T('buildLandmarks', () => buildLandmarks(lm, city, wallMats, roofMat));
      // 当たり判定は足元の形で
      for (const L of lm.landmarks) for (const r of L.fp) data.buildings.push({ p: r, holes: [] });
      document.body.dataset.osmLandmarks = String(lm.landmarks.length);
    }
    T('makeBlocker', () => { blocked = makeBlocker(data, native); });
    T('buildRailways', () => buildRailways(data, city, blocked.onRoad));
    T('buildWoods', () => buildWoods(data, city, blocked.onRoad, blocked));
    if (native) {   // 湘南: 車道かどうかは中心線から(歩道を車道と見なさない)
      const carriage = makeCarriageTest(data);
      T('buildFences', () => buildFences(data, city, carriage, 0.2, 0.75));   // 湘南: 柵の高さは 3/4
      T('buildSeaFences', () => buildSeaFences(wallData, city, native, carriage));
    } else T('buildFences', () => buildFences(data, city, blocked.onRoad));
    T('buildSites', () => buildSites(data, city));
    document.body.dataset.osmBuildings = String(data.buildings.length);
    document.body.dataset.osmRoads = String(data.roads.length);
    // 地図に使う範囲: 走れる範囲(area)の外枠 + 少し
    if (data.area) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const [x, z] of data.area) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
      cityBounds = [a - 80, b - 80, c + 80, d + 80];
    } else cityBounds = data.bounds;
    if (TERRAIN) {
      T('terrain', () => { liftToTerrain(city); if (!native) terrainMesh = buildTerrainMesh(city); });
    }
    if (terrainMesh && onTerrain) onTerrain(terrainMesh);
    if (data.water.some((w) => w.sea)) { panorama = makeMountainPanorama(); city.add(panorama); panorama.userData.setNight(night); }   // 湘南: 遠くの山並み
    times.total = Math.round(performance.now() - t0);
    document.body.dataset.osmLoadMs = JSON.stringify(times);
    console.info('[osm-city] load ms', times);
    loading.remove();
  }).catch((e) => { console.warn('[osm-city]', e); step('読み込みに失敗しました'); if (surfaceUrl) throw e; });
  return {
    ready,
    isBlocked: (x, z, R) => blocked(x, z, R),
    // 湘南: 段差の判定の基準にする高さ(ぶつかる前に居た所の地面)
    setBlockFrom: (x, z) => blocked.setFrom?.(x, z),
    surfaceKind: (x, z) => (blocked.onRoad && blocked.onRoad(x, z) ? 1 : blocked.isSand && blocked.isSand(x, z) ? 2 : 0),
    isSand: (x, z) => !!(blocked.isSand && blocked.isSand(x, z)),
    bounds: () => cityBounds,      // 地図(Q)用。読み込み前は null
    onTerrain(fn) { onTerrain = fn; if (terrainMesh) fn(terrainMesh); },   // 江の島の地形(走る面)ができたら呼ぶ
    update(dt, camera) { updateWaterTime(performance.now() / 1000); if (panorama && camera) { panorama.visible = camera.position.y < 120;   // 高い所から見下ろす時(地図・遠くへ引いた時)は山並みを出さない
      panorama.position.set(camera.position.x, 0, camera.position.z); panorama.updateMatrixWorld(); } },
    setNight(on) { if (on === night) return; night = on; glow.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); lampCtl?.setNight(on); panorama?.userData.setNight(on); foamMesh?.userData.setNight(on); setSeaNight(on); },   // 湘南: 街灯も夜だけ点ける
  };
}
