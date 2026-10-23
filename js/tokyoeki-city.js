import * as THREE from '../lib/three.module.js';

// メトロポリス: マス目の地図(METRO_GRID)から街を組み立てる。
//   # 道路  ~ 水  S 砂地(地面)  G 木と芝生  O 公園の中の建物  . 建物
//  - 道路は1マス = 2車線(片側1車線)。2マスなら片側2車線、3マスなら片側3車線。1マス = 6.5m(車線2本分)。
//  - 建物の区画(つながった白のマス)ごとに、歩道2.5mを取って建物を建てる。広い区画は敷地に分ける。
//  - 交差点の中は線を引かない。横断歩道と停止線は、片側2車線以上の道どうしの交差点だけ。
// 地図はエクセル(tools/metropolis-map.xlsx)で塗り、tools/metropolis_from_xlsx.py で取り込む。
export const METRO_GRID = [
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS~~~~~~~~~',
  '~~~~SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS~~~~~~',
  '~~~~SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS~~~~~',
  '~~~SSSSSSSSSSSSSSSSSSSSSSSSSSS########################################SSSSSSSSSSSSSSSSSS~~~~~',
  '~~~SSSSSSSSSSSSSSSSS###########################################################SSSSSSSSS~~~~~',
  '~~~SSSSSSSSSS######################################################################SSSSS~~~~~',
  '~~~SSSSSSS####################......###.............###....#...#....#.#################S~~~~~',
  '~~~SSSS#############................###.............###....#...#....#...#....#.########S~~~~~',
  '~~~S#########.......................###.............###....#...#....#...#....#...#.####SS~~~~',
  '~~~S######..........................###.............##########.#....#...#....#...#...###S~~~~',
  '~~~S###.............................###.............###....#..###...#...##########...###S~~~~',
  '~~~S###.............................###.............###....#...#.##.#...#....#...#...###S~~~~',
  '~~~S###.............................###.............###....#...#...###..#....#...#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#.####...#...#######S~~~~',
  '~~~S###.............................###.............###....#...#....#...#.#..#...#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#..#.#...#...###S~~~~',
  '~~~S###.............................###.............#####################...####.#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#....#..###..###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#....#...#.#####S~~~~',
  '~~~S###.............................###.............##########################...#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#....#...#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#....#...#...###S~~~~',
  '~~~S###.............................###.............###....#...#....#...#....#...#...###S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#GGGG#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#GGGG#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGOOOOOGGGG###....#...#....#...#GGGG#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGOOOOOGGGG###....#...#....#...#GGGG#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGOOOOOGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGOOOGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGOOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGOOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGOOOGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGOOOOOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGOOOOOOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGOOOOOOOGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGOOOOGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###################################GGGGGGGGGGGGG####################################S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S###....#....#...#....#...#G#....###GGGGGGGGGGGGG###....#...#....#...#....#...#...###S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~S####################################################################################S~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
  '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
];
export const CELL = 6.5;
const ROWS = METRO_GRID.length, COLS = METRO_GRID[0].length;
export const METRO_W = COLS * CELL, METRO_H = ROWS * CELL;
const OX = -METRO_W / 2, OZ = -METRO_H / 2;            // 地図の左上(北西)の角
const LANE = CELL / 2, WALKW = 2.5;
const ASPHALT = 0x3d3f42, WALK = 0xa7a8a4, CURB = 0xbdbbb5, SAND = 0xd8c48e, GRASS = 0x6f9a4f, WATER = 0x3d6b66;

const at = (r, c) => (r < 0 || c < 0 || r >= ROWS || c >= COLS ? '~' : METRO_GRID[r][c]);
const isRoad = (r, c) => at(r, c) === '#';
const cellX = (c) => OX + c * CELL, cellZ = (r) => OZ + r * CELL;

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


function quad(out, x0, z0, x1, z1, y) { out.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1); }   // 上向きの面

// ---- 道路 ----
// 横に3マス以上続けば東西の道(H)、縦に3マス以上続けば南北の道(V)、両方なら交差点(X)。
// 幅(thick)は直角の向きに続く道のマス数 = 片側の車線数。
function runLen(r, c, dr, dc) { let n = 1; for (let k = 1; k < 10 && isRoad(r + dr * k, c + dc * k); k++) n++; for (let k = 1; k < 10 && isRoad(r - dr * k, c - dc * k); k++) n++; return n; }
function classify() {
  const info = [];
  for (let r = 0; r < ROWS; r++) {
    info.push([]);
    for (let c = 0; c < COLS; c++) {
      if (!isRoad(r, c)) { info[r].push(null); continue; }
      const h = runLen(r, c, 0, 1), v = runLen(r, c, 1, 0);
      const kind = h > 4 && v > 4 ? 'X' : h >= 3 && h > v ? 'H' : v >= 3 && v > h ? 'V' : 'X';
      let r0 = r; if (kind === 'H') while (isRoad(r0 - 1, c)) r0--;
      let c0 = c; if (kind === 'V') while (isRoad(r, c0 - 1)) c0--;
      info[r].push({ kind, r0, c0, thick: kind === 'H' ? v : kind === 'V' ? h : 0 });
    }
  }
  // 太い道どうしが交わる所は、上の判定で H/V になることがあるので、両方向に太い道が通るマスは交差点にする
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const I = info[r][c]; if (!I || I.kind === 'X') continue;
    if (I.thick > 3) I.kind = 'X';
  }
  return info;
}
function buildRoads(g) {
  const info = classify();
  const asphalt = [], white = [], yellow = [], curb = [];
  const cellAt = (r, c) => (r < 0 || c < 0 || r >= ROWS || c >= COLS ? null : info[r][c]);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!isRoad(r, c)) continue;
    const x0 = cellX(c), z0 = cellZ(r), x1 = x0 + CELL, z1 = z0 + CELL;
    quad(asphalt, x0, z0, x1, z1, 0.04);
    // 縁石: 道路でないマスとの境
    if (!isRoad(r - 1, c)) ribbon([[x0, z0 + 0.15], [x1, z0 + 0.15]], 0.3, 0.08, curb);
    if (!isRoad(r + 1, c)) ribbon([[x0, z1 - 0.15], [x1, z1 - 0.15]], 0.3, 0.08, curb);
    if (!isRoad(r, c - 1)) ribbon([[x0 + 0.15, z0], [x0 + 0.15, z1]], 0.3, 0.08, curb);
    if (!isRoad(r, c + 1)) ribbon([[x1 - 0.15, z0], [x1 - 0.15, z1]], 0.3, 0.08, curb);
    const I = info[r][c];
    if (I.kind !== 'H' && I.kind !== 'V') continue;
    const H = I.kind === 'H', thick = I.thick, half = thick * CELL / 2;
    const mid = H ? cellZ(I.r0) + half : cellX(I.c0) + half;
    const a0 = H ? x0 : z0, a1 = H ? x1 : z1, cl = H ? [z0, z1] : [x0, x1];
    const seg = (o) => (H ? [[a0, mid + o], [a1, mid + o]] : [[mid + o, a0], [mid + o, a1]]);
    // 線は帯の中心を含むマスでまとめて引く(幅が偶数なら境の下・右のマス)
    if (!(mid >= cl[0] && mid < cl[1]) && !(thick % 2 === 1 && mid > cl[0] && mid < cl[1])) continue;
    if (thick >= 2) {
      ribbon(seg(0), 0.15, 0.08, yellow);                                           // 中央線(黄)
      for (let k = 1; k < thick; k++) for (const sd of [-1, 1]) ribbon(seg(sd * k * LANE), 0.12, 0.08, white, [5, 5]);
    } else ribbon(seg(0), 0.12, 0.08, white, [5, 5]);                               // 片側1車線: 白の破線
    for (const sd of [-1, 1]) ribbon(seg(sd * (half - 0.25)), 0.15, 0.08, white);  // 外側線
    // 交差点の手前: 横断歩道と停止線(片側2車線以上どうし)
    if (thick < 2) continue;
    for (const dir of [-1, 1]) {
      const N = cellAt(H ? r : r + dir, H ? c + dir : c);
      if (!N || N.kind !== 'X') continue;
      let crossW = 0;
      for (let k = 1; k <= 8; k++) { const q = cellAt(H ? r : r + dir * k, H ? c + dir * k : c); if (q && q.kind === 'X') crossW++; else break; }
      if (crossW < 2) continue;
      const edge = dir > 0 ? a1 : a0, ang = H ? Math.PI / 2 : 0, cpos = edge - dir * 2.5;
      for (let o = -half + 0.7; o < half - 0.5; o += 0.9) {
        if (H) rect(cpos, mid + o, ang, 4, 0.45, 0.085, white); else rect(mid + o, cpos, ang, 4, 0.45, 0.085, white);
      }
      // 停止線: 交差点へ向かう車線の側だけ(左側通行。東へ向かう車線は北側 = -z、南へ向かう車線は東側 = +x)
      const sl = edge - dir * 5.5, side = H ? -dir : dir;
      if (H) rect(sl, mid + side * half / 2, ang + Math.PI / 2, half - 0.3, 0.45, 0.085, white);
      else rect(mid + side * half / 2, sl, ang + Math.PI / 2, half - 0.3, 0.45, 0.085, white);
    }
  }
  const road = flatMesh(asphalt, ASPHALT);
  g.add(road, flatMesh(curb, CURB), flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a));
}

// ---- 建物 ----
// 白のマスのつながり(区画)ごとに、外接する長方形から道路側に歩道を取り、敷地に分けて建てる。
// 長方形でない区画は、行ごとの横の並びで長方形に分けてから建てる。
function planBuildings() {
  const R = seeded(20261023), seen = new Set(), lots = [];
  const FLOOR = 3.6;
  const blocks = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (at(r, c) !== '.' || seen.has(r * COLS + c)) continue;
    // 長方形に広げる: 右へ、そのあと下へ(同じ幅で全部白なら)
    let c1 = c; while (at(r, c1 + 1) === '.' && !seen.has(r * COLS + c1 + 1)) c1++;
    let r1 = r;
    while (true) { let ok = true; for (let k = c; k <= c1; k++) if (at(r1 + 1, k) !== '.' || seen.has((r1 + 1) * COLS + k)) { ok = false; break; } if (!ok) break; r1++; }
    for (let rr = r; rr <= r1; rr++) for (let k = c; k <= c1; k++) seen.add(rr * COLS + k);
    blocks.push({ r0: r, c0: c, r1, c1 });
  }
  for (const b of blocks) {
    // 道路に接する辺だけ歩道を取る(隣が建物の区画なら境界ぎりぎり)
    const roadN = [...Array(b.c1 - b.c0 + 1)].some((_, k) => at(b.r0 - 1, b.c0 + k) !== '.');
    const roadS = [...Array(b.c1 - b.c0 + 1)].some((_, k) => at(b.r1 + 1, b.c0 + k) !== '.');
    const roadW = [...Array(b.r1 - b.r0 + 1)].some((_, k) => at(b.r0 + k, b.c0 - 1) !== '.');
    const roadE = [...Array(b.r1 - b.r0 + 1)].some((_, k) => at(b.r0 + k, b.c1 + 1) !== '.');
    const x0 = cellX(b.c0) + (roadW ? WALKW : 0.3), x1 = cellX(b.c1 + 1) - (roadE ? WALKW : 0.3);
    const z0 = cellZ(b.r0) + (roadN ? WALKW : 0.3), z1 = cellZ(b.r1 + 1) - (roadS ? WALKW : 0.3);
    if (x1 - x0 < 4 || z1 - z0 < 4) continue;
    const area = (x1 - x0) * (z1 - z0);
    // 大きい区画はオフィス街(高め)、小さい区画は中小ビル・マンション
    const big = area > 3000;
    const split = (lx0, lz0, lx1, lz1, depth) => {
      const w = lx1 - lx0, d = lz1 - lz0, target = big ? 900 + R() * 1500 : 250 + R() * 450;
      if (w * d < target || depth > 7 || Math.max(w, d) < 14) {
        const g = 0.5;
        let h = big ? (20 + R() * 100) : (8 + R() * 28);
        if (big && R() < 0.15) h += 60 + R() * 60;
        h = Math.max(2, Math.round(h / FLOOR)) * FLOOR;
        lots.push({ x0: lx0 + g, z0: lz0 + g, x1: lx1 - g, z1: lz1 - g, h, big });
        return;
      }
      const t = 0.35 + R() * 0.3;
      if (w >= d) { const m = lx0 + w * t; split(lx0, lz0, m, lz1, depth + 1); split(m, lz0, lx1, lz1, depth + 1); }
      else { const m = lz0 + d * t; split(lx0, lz0, lx1, m, depth + 1); split(lx0, m, lx1, lz1, depth + 1); }
    };
    split(x0, z0, x1, z1, 0);
  }
  // 公園の中の建物(O): マスごとに低い建物
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (at(r, c) === 'O') {
    lots.push({ x0: cellX(c), z0: cellZ(r), x1: cellX(c + 1), z1: cellZ(r + 1), h: 6, park: true });
  }
  return lots;
}
function buildBuildings(lots, g, wallMats, roofMat) {
  const walls = STYLES.map(() => ({ p: [], u: [], c: [], n: [] }));
  const roofs = { p: [], c: [], n: [] };
  lots.forEach((b, i) => {
    const R = seeded(i * 131 + 17);
    let style = b.h > 50 ? [0, 0, 1, 2, 4][Math.floor(R() * 5)] : [1, 1, 3, 4, 0][Math.floor(R() * 5)];
    let base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
    if (b.park) { style = 1; base = 0xd7b98e; }
    const col = new THREE.Color(base), roof = new THREE.Color(base).multiplyScalar(0.72);
    const S = STYLES[style], W = walls[style], h = b.h;
    const pts = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = pts[k], [x1, z1] = pts[(k + 1) % 4], len = Math.hypot(x1 - x0, z1 - z0);
      const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
      const u0 = s / S.tileW, u1 = (s + len) / S.tileW, v1 = h / S.tileH;
      W.p.push(x0, 0, z0, x1, 0, z1, x1, h, z1, x0, 0, z0, x1, h, z1, x0, h, z0);
      W.u.push(u0, 0, u1, 0, u1, v1, u0, 0, u1, v1, u0, v1);
      for (let q = 0; q < 6; q++) { W.c.push(col.r, col.g, col.b); W.n.push(nx, 0, nz); }
      s += len;
    }
    roofs.p.push(b.x0, h, b.z0, b.x0, h, b.z1, b.x1, h, b.z0, b.x1, h, b.z0, b.x0, h, b.z1, b.x1, h, b.z1);
    for (let q = 0; q < 6; q++) { roofs.c.push(roof.r, roof.g, roof.b); roofs.n.push(0, 1, 0); }
  });
  const mk = (o, mat, uv) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(o.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(o.n, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(o.c, 3));
    if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(o.u, 2));
    const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; return m;
  };
  walls.forEach((w, i) => { if (w.p.length) g.add(mk(w, wallMats[i], true)); });
  g.add(mk(roofs, roofMat, false));
}

// ---- 地面・水・木 ----
function buildGround(g, trees) {
  const walk = [], sand = [], grass = [], water = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const k = at(r, c), x0 = cellX(c), z0 = cellZ(r), x1 = x0 + CELL, z1 = z0 + CELL;
    if (k === '~') quad(water, x0, z0, x1, z1, -0.8);
    else if (k === 'S') quad(sand, x0, z0, x1, z1, 0.02);
    else if (k === 'G' || k === 'O') quad(grass, x0, z0, x1, z1, 0.03);
    else if (k === '.') quad(walk, x0, z0, x1, z1, 0.06);              // 建物の区画(歩道と敷地)
  }
  g.add(flatMesh(walk, WALK), flatMesh(sand, SAND), flatMesh(grass, GRASS), flatMesh(water, WATER));
  // 木: 芝生のマスに、1マスおきに少しずらして植える
  const R = seeded(77);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (at(r, c) !== 'G' || (r + c) % 2) continue;
    trees.push([cellX(c) + CELL * (0.3 + R() * 0.4), cellZ(r) + CELL * (0.3 + R() * 0.4), 0.8 + R() * 0.5]);
  }
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 2.4, 6), leaf = new THREE.IcosahedronGeometry(1.8, 0);
  const tm = new THREE.InstancedMesh(trunk, new THREE.MeshLambertMaterial({ color: 0x6b4f36 }), trees.length);
  const lm = new THREE.InstancedMesh(leaf, new THREE.MeshLambertMaterial({ color: 0x4f7a3e, flatShading: true }), trees.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3();
  trees.forEach(([x, z, s], i) => {
    M.compose(new THREE.Vector3(x, 1.2 * s, z), Q, V.set(s, s, s)); tm.setMatrixAt(i, M);
    M.compose(new THREE.Vector3(x, 3.4 * s, z), Q, V.set(s, s * 1.1, s)); lm.setMatrixAt(i, M);
  });
  g.add(tm, lm);
}

// 当たり判定: 建物・木の幹・水・地図の外
function makeBlocker(lots, trees) {
  const C = 20, grid = new Map();
  const put = (i, x0, z0, x1, z1) => {
    for (let gx = Math.floor(x0 / C); gx <= Math.floor(x1 / C); gx++) for (let gz = Math.floor(z0 / C); gz <= Math.floor(z1 / C); gz++) {
      const k = gx + ',' + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  };
  const boxes = [...lots.map((b) => [b.x0, b.z0, b.x1, b.z1]), ...trees.map(([x, z]) => [x - 0.35, z - 0.35, x + 0.35, z + 0.35])];
  boxes.forEach((b, i) => put(i, ...b));
  return (x, z, r = 0.3) => {
    const c = Math.floor((x - OX) / CELL), rr = Math.floor((z - OZ) / CELL);
    if (at(rr, c) === '~') return true;
    const list = grid.get(Math.floor(x / C) + ',' + Math.floor(z / C));
    if (!list) return false;
    for (const i of list) { const b = boxes[i]; if (x > b[0] - r && x < b[2] + r && z > b[1] - r && z < b[3] + r) return true; }
    return false;
  };
}

export function decorateTokyoEki(root) {
  root.traverse((o) => { if (o.isMesh) o.visible = false; });
  const styleTex = STYLES.map((s, i) => makeStyleTextures(s, i));
  const glowMaterials = [];
  const wallMats = STYLES.map((s, i) => {
    const m = new THREE.MeshLambertMaterial({
      map: styleTex[i].map, vertexColors: true, side: THREE.DoubleSide,
      emissive: 0xffffff, emissiveMap: styleTex[i].emissiveMap, emissiveIntensity: 0,
    });
    glowMaterials.push(m); return m;
  });
  const roofMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const city = new THREE.Group(); city.name = 'metropolis';
  (root.parent || root).add(city);
  const far = []; quad(far, -3000, -3000, 3000, 3000, -1.0); city.add(flatMesh(far, WATER));   // 遠くまで水
  const trees = [];
  buildGround(city, trees);
  buildRoads(city);
  const lots = planBuildings();
  buildBuildings(lots, city, wallMats, roofMat);
  const blocked = makeBlocker(lots, trees);
  document.body.dataset.tokyoEkiBuildings = String(lots.length);
  return {
    isBlocked: (x, z, R) => blocked(x, z, R),
    update() {},
    setNight(on) { glowMaterials.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); },
  };
}
