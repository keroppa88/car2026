import * as THREE from '../lib/three.module.js';

// メトロポリス: マス目の地図(METRO_GRID)から街を組み立てる。1マス = 10m。北は -z。
//   # 道路  ~ 川  B 橋  . 日本の中小ビル街  R 丸の内風のビル街  O チャイナタウン・香港風
//   P ニューヨーク風(ブロードウェイ・タイムズスクエア)  G 公園
//   (. はコンビニ・ガソリンスタンド・ファミレス・マンション・一戸建て・中小ビルの混ざった街)
// 地図はエクセル(tools/metropolis-map.xlsx)で塗り、tools/metropolis_from_xlsx.py で取り込む。
//  - 道路は1マス幅(片側1車線)か2マス幅(片側2車線)。車道の外は歩道。
//  - 交差点の中は線を引かない。横断歩道は2マス幅の道どうしの交差点だけ。
//  - 建物はまだ置かない(区画は地区の色の敷地として見せ、入れない)。
//  - 地図の端は反対側の端とつながっている(main.js が車を移し、見た目は周りに8枚写しを置く)。
// 地図のマス目は map/metropolis-grid.txt と同じ。
export const METRO_GRID = [
  '...##...##~~~#..##..#..#..#..#.OO##OO#O#O#O#.',
  '...##...##~~~#..##..#..#..#..#.OO##OO#O#O#O#.',
  '##########~~~################################',
  '...##...##~~~#..##..#..#..#..#OOO##OO#O#O#O#.',
  '...##...##~~~#..##..#..#..#..#OOO##OO#O#O#O#.',
  '#############################################',
  '#############################################',
  '...##.#.##~~~...##..#..#..#..#OOO##OO#O#O#O#.',
  '...##.#.##~~~...##..#..#..#..#OOO##OO#O#O#O#.',
  '##########~~~################################',
  '...##.#.##~~~...##..#..#..#..#...##OO#O#O#O#.',
  '...#######~~~...##..#..#..#..#...##OO#O#O#O#.',
  '...##.#.##~~~###############################.',
  '##########~~~PPP##..#..#..#..#...##OO#O#O#O##',
  '...##.#.##~~~PPP##..#..#..#..#...##OO#O#O#O#.',
  '...#######~~~PPP############################.',
  '...##.#.##~~~PPP##PP#PP#PP#PP#PPP##OO#O#O#O#.',
  '...##.#.##~~~PPP##PP#PP#PP#PP#PPP##OO#O#O#O#.',
  '##########BBB################################',
  '##########BBB################################',
  '...##...##~~~#PP##PP#PP#PP#PP#PPP##OO#O#O#O#.',
  '...##...##~~~#PP##PP#PP#PP#PP#PPP##OO#O#O#O#.',
  '...##...##~~~#PP##PP#PP#PP#PP#PPP##OO#O#O#O#.',
  '##########BBB################################',
  '##########BBB################################',
  '...##...##~~~RRR##GGGGGGGGGGGGGGG##RR#RR#RR#.',
  '...##...##~~~RRR##GGGGGGGGGGGGGGG##RR#RR#RR#.',
  '##########~~~RRR##GGGGGGGGGGGGGGG##RR#RR#RR##',
  '...##...##~~~RRR##GGGGGGGGGGGGGGG###########.',
  '...##...##~~~RRR###################RR#RR#RR#.',
  '##########~~~RRR##RRRR#RR#RRR#RRR##RR#RR#RR##',
  '...##...##~~~RRR#######RR#RRR#RRR###########.',
  '...##...##~~~RRR##RRRR#RR#RRR#RRR##RR#RR#RR#.',
  '##########~~~RRR##RRRR#RR#RRR#RRR##RR#RR#RR#.',
  '...##...##BBB###############################.',
  '...##...##~~~...##..#..#..#..#...##..#..#..#.',
  '...##...##~~~...##..#..#..#..#...##..#..#..#.',
]
export const CELL = 10;
const ROWS = METRO_GRID.length, COLS = METRO_GRID[0].length;
export const METRO_W = COLS * CELL, METRO_H = ROWS * CELL;
const OX = -METRO_W / 2, OZ = -METRO_H / 2;            // 地図の左上(北西)の角
const LANE = 3.25;
const ASPHALT = 0x3d3f42, WALK = 0xa7a8a4, CURB = 0xbdbbb5;
const ZONE_COLORS = { '.': 0xc9c6bd, R: 0x9c5a4e, O: 0xd09a3a, P: 0x9a6aa3, G: 0x6f9a4f };

const at = (r, c) => METRO_GRID[((r % ROWS) + ROWS) % ROWS][((c % COLS) + COLS) % COLS];
const isRoad = (r, c) => { const k = at(r, c); return k === '#' || k === 'B'; };
const cellX = (c) => OX + c * CELL, cellZ = (r) => OZ + r * CELL;

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

// 道路のマスの向きと幅を調べる。横に3マス以上続けば東西の道、縦に3マス以上続けば南北の道、両方なら交差点。
// 幅(thick)は直角の向きに続く道のマス数(1か2)。端は反対側とつながっているとして数える。
function runLen(r, c, dr, dc) { let n = 1; for (let k = 1; k < 8 && isRoad(r + dr * k, c + dc * k); k++) n++; for (let k = 1; k < 8 && isRoad(r - dr * k, c - dc * k); k++) n++; return n; }
function classify() {
  const info = [];
  for (let r = 0; r < ROWS; r++) {
    info.push([]);
    for (let c = 0; c < COLS; c++) {
      if (!isRoad(r, c)) { info[r].push(null); continue; }
      const h = runLen(r, c, 0, 1), v = runLen(r, c, 1, 0);
      const kind = h >= 3 && v >= 3 ? 'X' : h >= 3 ? 'H' : v >= 3 ? 'V' : 'X';
      // 帯の中での位置: 東西の道なら、帯の北の端の行と幅
      let r0 = r; while (r0 > r - 2 && isRoad(r0 - 1, c) && kind === 'H') r0--;
      let c0 = c; while (c0 > c - 2 && isRoad(r, c0 - 1) && kind === 'V') c0--;
      info[r].push({ kind, h, v, r0, c0, thick: kind === 'H' ? v : kind === 'V' ? h : 0 });
    }
  }
  return info;
}

function buildCity(group) {
  const info = classify();
  const asphalt = [], walk = [], white = [], yellow = [], curb = [], water = [];
  const zones = {}; for (const k in ZONE_COLORS) zones[k] = [];
  const rail = { p: [], n: [] };
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const k = at(r, c), x0 = cellX(c), z0 = cellZ(r), x1 = x0 + CELL, z1 = z0 + CELL;
    if (k === '~') { quad(water, x0, z0, x1, z1, -0.8); continue; }
    if (!isRoad(r, c)) { quad(zones[k] ?? zones['.'], x0, z0, x1, z1, 0.15); continue; }
    const I = info[r][c];
    // 路面と、区画に接する辺の歩道
    quad(asphalt, x0, z0, x1, z1, 0.04);
    if (I.kind === 'H' || I.kind === 'V') {
      const H = I.kind === 'H', thick = I.thick, cw = (thick >= 2 ? 4 : 2) * LANE;
      const sw = (thick * CELL - cw) / 2;                         // 歩道の幅
      // 帯の中心線(H: z、V: x)
      const mid = H ? cellZ(I.r0) + thick * CELL / 2 : cellX(I.c0) + thick * CELL / 2;
      const a0 = H ? x0 : z0, a1 = H ? x1 : z1;
      const seg = (o) => (H ? [[a0, mid + o], [a1, mid + o]] : [[mid + o, a0], [mid + o, a1]]);
      // 歩道は道の両側(川・橋の上は欄干)
      for (const sd of [-1, 1]) {
        const e = mid + sd * (thick * CELL / 2), inner = mid + sd * cw / 2;
        const lo = Math.min(e, inner), hi = Math.max(e, inner);
        // この行(列)が帯の該当する側を含む時だけ描く
        const cl = H ? [z0, z1] : [x0, x1];
        const p0 = Math.max(lo, cl[0]), p1 = Math.min(hi, cl[1]);
        if (p1 > p0) {
          if (H) quad(walk, a0, p0, a1, p1, 0.06); else quad(walk, p0, a0, p1, a1, 0.06);
        }
        if (inner > cl[0] - 0.01 && inner < cl[1] + 0.01) ribbon(seg(sd * (cw / 2 + 0.15)), 0.3, 0.08, curb);
        if (k === 'B' && e > cl[0] - 0.01 && e < cl[1] + 0.01) {           // 橋の欄干
          const [[ax, az], [bx, bz]] = seg(sd * (thick * CELL / 2 - 0.3));
          boxInto(rail, (ax + bx) / 2, 0.6, (az + bz) / 2, H ? CELL : 0.3, 1.1, H ? 0.3 : CELL);
        }
      }
      // 白線(帯の中心を通る行・列だけで描く)
      const cl = H ? [z0, z1] : [x0, x1];
      if (mid >= cl[0] && mid <= cl[1] && (mid < cl[1] || thick === 1)) {
        if (thick >= 2) {
          ribbon(seg(0), 0.15, 0.08, yellow);                                    // 中央線(黄)
          for (const sd of [-1, 1]) ribbon(seg(sd * LANE), 0.12, 0.08, white, [5, 5]);   // 車線境界
        } else {
          ribbon(seg(0), 0.12, 0.08, white, [5, 5]);                            // 細い道の中央線(白の破線)
        }
        for (const sd of [-1, 1]) ribbon(seg(sd * (cw / 2 - 0.25)), 0.15, 0.08, white);   // 外側線
        // 交差点の手前: 横断歩道と停止線(2マス幅の道どうしの交差点だけ)
        for (const dir of [-1, 1]) {
          const nr = H ? r : r + dir, nc = H ? c + dir : c;
          const N = info[((nr % ROWS) + ROWS) % ROWS][((nc % COLS) + COLS) % COLS];
          if (!N || N.kind !== 'X' || thick < 2) continue;
          let crossW = 0;                                                       // 交わる道の幅(交差点のマス数)
          for (let k = 1; k <= 4; k++) { const q = info[((H ? r : r + dir * k) % ROWS + ROWS) % ROWS][((H ? c + dir * k : c) % COLS + COLS) % COLS]; if (q && q.kind === 'X') crossW++; else break; }
          if (crossW < 2) continue;
          const edge = dir > 0 ? a1 : a0, ang = H ? Math.PI / 2 : 0;
          const cpos = edge - dir * 2.5;
          for (let o = -cw / 2 + 0.7; o < cw / 2 - 0.5; o += 0.9) {
            if (H) rect(cpos, mid + o, ang, 4, 0.45, 0.085, white); else rect(mid + o, cpos, ang, 4, 0.45, 0.085, white);
          }
          // 停止線: 交差点へ向かう車線の側(左側通行。東へ向かう車線は北側 = -z)
          const sl = edge - dir * 5.5, side = H ? -dir : dir;
          if (H) rect(sl, mid + side * cw / 4, ang + Math.PI / 2, cw / 2 - 0.3, 0.45, 0.085, white);
          else rect(mid + side * cw / 4, sl, ang + Math.PI / 2, cw / 2 - 0.3, 0.45, 0.085, white);
        }
      }
    }
  }
  const g = new THREE.Group(); g.name = 'metropolis';
  const road = flatMesh(asphalt, ASPHALT);
  g.add(road, flatMesh(walk, WALK), flatMesh(curb, CURB), flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a), flatMesh(water, 0x3d6b66));
  for (const k in zones) if (zones[k].length) g.add(flatMesh(zones[k], ZONE_COLORS[k]));
  if (rail.p.length) g.add(solidMesh(rail, new THREE.MeshLambertMaterial({ color: 0x8e9196 })));
  group.add(g);
  return g;
}

export function decorateTokyoEki(root) {
  root.traverse((o) => { if (o.isMesh) o.visible = false; });
  const city = new THREE.Group(); city.name = 'metropolis-city';
  (root.parent || root).add(city);
  const tile = buildCity(city);
  // 端でつながって見えるよう、周りに8枚の写し(形は使い回し)
  for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
    if (!dx && !dz) continue;
    const t = tile.clone(); t.position.set(dx * METRO_W, 0, dz * METRO_H); city.add(t);
  }
  // 遠くの地面
  const ground = []; quad(ground, -3 * METRO_W, -3 * METRO_H, 3 * METRO_W, 3 * METRO_H, -1.0);
  city.add(flatMesh(ground, 0x8f918c));
  return {
    // 道路と橋だけ走れる(区画・川には入れない)
    isBlocked: (x, z, R = 0.3) => {
      for (const [ox, oz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) {
        const c = Math.floor((x + ox - OX) / CELL), r = Math.floor((z + oz - OZ) / CELL);
        if (!isRoad(r, c)) return true;
      }
      return false;
    },
    update() {},
    setNight() {},
  };
}
