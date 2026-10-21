import * as THREE from '../lib/three.module.js';

// 東京駅〜日本橋(八重洲・日本橋・京橋)をモデルにした、碁盤の目のオフィス街を three.js でゼロから組み立てる。
//  - 道はすべて東西(x)・南北(z)のまっすぐな線。交差点はすべて直角の十字路か丁字路で、行き止まりは無い。
//  - 大通り(片側2〜3車線)は約165mおき。その間に55mおきの細い道(1車線)。
//  - 地区は3つ: 西は東京のオフィス街、真ん中はニューヨーク風、東は香港風。
//  - 北の端は日本橋川。首都高が東西の大通りの真上を通り、その下をくぐれる。
//  - 横断歩道と信号は大通りどうしの交差点だけ。大通りの歩道には柵。
//  - 走行面は地図(map_tokyoeki.glb)を使わず、main.js が敷く平らな面。建物・街の外へは isBlocked で出られない。
// 北は -z。1単位 = 1m。

const LANE = 3.25;
const ASPHALT = 0x3d3f42, CURB = 0xbdbbb5, WALK = 0xa7a8a4, CONCRETE = 0x8c8f92;

// ---- 街の設計 ----
// 南北の道(位置は x)と東西の道(位置は z)。lanes: 両方向の車線の合計(1 は細い道)。
export const EKI_NS = [
  { x: -235, lanes: 4 },   // 外堀通り(西の端。向こうは東京駅)
  { x: -180, lanes: 1 }, { x: -125, lanes: 1 },
  { x: -70, lanes: 6 },    // 中央通り
  { x: -15, lanes: 1 }, { x: 40, lanes: 1 },
  { x: 95, lanes: 4 },
  { x: 150, lanes: 1 }, { x: 205, lanes: 1 },
  { x: 260, lanes: 6 },    // 昭和通り
  { x: 330, lanes: 4 },    // 東の端
];
export const EKI_EW = [
  { z: -230, lanes: 4 },   // 北の端(日本橋川沿い)
  { z: -175, lanes: 1 }, { z: -120, lanes: 1 },
  { z: -65, lanes: 6 },    // 永代通り
  { z: -10, lanes: 1 }, { z: 45, lanes: 1 },
  { z: 100, lanes: 4 },    // 八重洲通り
  { z: 155, lanes: 1 }, { z: 210, lanes: 1 },
  { z: 265, lanes: 4 },    // 南の端(鍛冶橋通り)
];
const WALK_MAJOR = 4.0, WALK_NARROW = 1.2;
const halfCw = (r) => (r.lanes === 1 ? 4.5 : r.lanes * LANE) / 2;          // 車道の半幅
const halfCorr = (r) => halfCw(r) + (r.lanes === 1 ? WALK_NARROW : WALK_MAJOR);   // 車道+歩道の半幅
const X0 = EKI_NS[0].x, X1 = EKI_NS[EKI_NS.length - 1].x, Z0 = EKI_EW[0].z, Z1 = EKI_EW[EKI_EW.length - 1].z;
const OUT = 45;                                     // 外周の道の外に並べる建物の帯の奥行き

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

// 道に沿った帯の四角(車道・歩道)を足す
function quad(out, x0, z0, x1, z1, y) { out.push(x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1); }   // 上向きの面

function buildStreets(group) {
  const asphalt = [], walk = [], white = [], yellow = [], curb = [];
  const fence = { p: [], n: [] };
  const sig = { pole: { p: [], n: [] }, head: { p: [], n: [] }, lamps: [0, 1].map(() => [0, 1, 2].map(() => ({ p: [], n: [] }))) };
  // 歩道(街の外周まで一面)
  quad(walk, X0 - halfCorr(EKI_NS[0]), Z0 - halfCorr(EKI_EW[0]), X1 + halfCorr(EKI_NS.at(-1)), Z1 + halfCorr(EKI_EW.at(-1)), 0.0);
  // 車道
  for (const r of EKI_NS) quad(asphalt, r.x - halfCw(r), Z0 - halfCw(EKI_EW[0]), r.x + halfCw(r), Z1 + halfCw(EKI_EW.at(-1)), 0.04);
  for (const r of EKI_EW) quad(asphalt, X0 - halfCw(EKI_NS[0]), r.z - halfCw(r), X1 + halfCw(EKI_NS.at(-1)), r.z + halfCw(r), 0.04);
  // 道ごとに、交差点と交差点の間に線・縁石・柵を引く。
  //  along: その道の向きの座標(南北の道なら z)。cross: 交わる道の並び。
  const roadLines = (r, ns) => {
    const at = r.x ?? r.z, cross = ns ? EKI_EW : EKI_NS, hw = halfCw(r);
    const P = (a, o) => (ns ? [at + o, a] : [a, at + o]);       // 道の向きの座標 a、道の中心から横へ o
    for (let i = 0; i + 1 < cross.length; i++) {
      const A = cross[i], B = cross[i + 1];
      const ca = (A.x ?? A.z), cb = (B.x ?? B.z);
      const majA = A.lanes > 1 && r.lanes > 1, majB = B.lanes > 1 && r.lanes > 1;
      // 線は交差点(と横断歩道)の手前で止める
      const s0 = ca + halfCorr(A) + (majA ? 5 : 0.5), s1 = cb - halfCorr(B) - (majB ? 5 : 0.5);
      if (s1 - s0 < 2) continue;
      const seg = (o) => [P(s0, o), P(s1, o)];
      if (r.lanes > 1) {
        ribbon(seg(0), 0.15, 0.07, yellow);                                  // 中央線(黄)
        for (let k = 1; k < r.lanes / 2; k++) for (const sd of [-1, 1]) ribbon(seg(sd * k * LANE), 0.12, 0.07, white, [5, 5]);
        for (const sd of [-1, 1]) ribbon(seg(sd * (hw - 0.25)), 0.15, 0.07, white);   // 外側線
      } else {
        for (const sd of [-1, 1]) ribbon(seg(sd * (hw - 0.3)), 0.12, 0.07, white);    // 路側帯の線
      }
      // 縁石と柵(歩道の縁)。縁石は交差点の角まで、柵は大通りだけで交差点の手前まで。
      const e0 = ca + halfCw(A), e1 = cb - halfCw(B);
      for (const sd of [-1, 1]) {
        ribbon([P(e0, sd * (hw + 0.15)), P(e1, sd * (hw + 0.15))], 0.3, 0.07, curb);
        if (r.lanes > 1) {
          const f0 = ca + halfCorr(A) + 2.5, f1 = cb - halfCorr(B) - 2.5;
          if (f1 - f0 < 4) continue;
          const n = Math.max(1, Math.round((f1 - f0) / 2));
          for (let k = 0; k <= n; k++) { const [x, z] = P(f0 + (f1 - f0) * k / n, sd * (hw + 0.6)); boxInto(fence, x, 0.45, z, 0.07, 0.9, 0.07); }
          const [mx, mz] = P((f0 + f1) / 2, sd * (hw + 0.6)), len = f1 - f0, ang = ns ? 0 : Math.PI / 2;
          boxInto(fence, mx, 0.85, mz, 0.06, 0.06, len, ang); boxInto(fence, mx, 0.4, mz, 0.04, 0.04, len, ang);
        }
      }
    }
  };
  EKI_NS.forEach((r) => roadLines(r, true));
  EKI_EW.forEach((r) => roadLines(r, false));
  // 大通りどうしの交差点: 4方向に横断歩道・停止線・信号
  let signals = 0;
  for (const a of EKI_NS) for (const b of EKI_EW) {
    if (a.lanes < 4 || b.lanes < 4) continue;
    const cx = a.x, cz = b.z;
    // 来る向き(dx,dz)ごと。来る道の半幅 hwIn、交わる道の半幅(+歩道) hwX。
    for (const [dx, dz, inR, xR] of [[0, 1, a, b], [0, -1, a, b], [1, 0, b, a], [-1, 0, b, a]]) {
      const hwIn = halfCw(inR), corrX = halfCorr(xR), hwX = halfCw(xR);
      const lx = dz, lz = -dx;                                     // 来る車の左
      // 横断歩道(交差点の手前、交わる道の歩道の延長線上)
      const cwc = hwX + 2.5;                                       // 交差点の中心からの距離
      const qx = cx - dx * cwc, qz = cz - dz * cwc, ang = Math.atan2(dx, dz);
      for (let k = -hwIn + 0.7; k < hwIn - 0.5; k += 0.9) rect(qx + lx * k, qz + lz * k, ang, 4, 0.45, 0.075, white);
      // 停止線(来る車線の側だけ)
      const sl = cwc + 3.2;
      rect(cx - dx * sl + lx * hwIn / 2, cz - dz * sl + lz * hwIn / 2, ang + Math.PI / 2, hwIn - 0.3, 0.45, 0.075, white);
      // 信号: 交差点の向こう側の左の角。腕を来る車線の上へ。灯は来る車へ向け、左から青・黄・赤。
      const px = cx + dx * (hwX + 2.5) + lx * (hwIn + 1.2), pz = cz + dz * (hwX + 2.5) + lz * (hwIn + 1.2);
      const reach = Math.min(hwIn / 2 + 1.2, 7.5), arm = Math.atan2(lx, lz);
      boxInto(sig.pole, px, 2.8, pz, 0.22, 5.6, 0.22);
      boxInto(sig.pole, px - lx * reach / 2, 5.45, pz - lz * reach / 2, 0.12, 0.12, reach, arm);
      const hx = px - lx * reach, hz = pz - lz * reach;
      boxInto(sig.head, hx, 5.15, hz, 0.32, 0.45, 1.35, arm);
      const grp = dx === 0 ? 0 : 1, face = Math.atan2(-dx, -dz);
      for (let k = 0; k < 3; k++) {
        const off = 0.42 * (1 - k);
        boxInto(sig.lamps[grp][k], hx + lx * off - dx * 0.18, 5.15, hz + lz * off - dz * 0.18, 0.3, 0.3, 0.05, face);
      }
      signals++;
    }
  }
  const g = new THREE.Group(); g.name = 'tokyoeki-streets';
  const road = flatMesh(asphalt, ASPHALT), side = flatMesh(walk, WALK);
  road.material.polygonOffsetFactor = -1; road.material.polygonOffsetUnits = -1;
  side.material.polygonOffsetFactor = 0; side.material.polygonOffsetUnits = 0;
  g.add(side, road, flatMesh(curb, CURB), flatMesh(white, 0xe9e9e6), flatMesh(yellow, 0xd9b23a));
  g.add(solidMesh(fence, new THREE.MeshLambertMaterial({ color: 0xe8ebee })));
  const lampMats = [0, 1].map(() => [0x2fd28a, 0xffc23a, 0xff3a2a].map((c) => new THREE.MeshLambertMaterial({ color: 0x2b2f35, emissive: c, emissiveIntensity: 0 })));
  g.add(solidMesh(sig.pole, new THREE.MeshLambertMaterial({ color: 0x8a8f96 })), solidMesh(sig.head, new THREE.MeshLambertMaterial({ color: 0x4f555c })));
  sig.lamps.forEach((grp, i) => grp.forEach((o, k) => g.add(solidMesh(o, lampMats[i][k]))));
  group.add(g);
  document.body.dataset.tokyoEkiSignals = String(signals);
  // 信号の切り替え: 組0(南北の道) 青0-14 黄14-17 赤17-32 / 組1(東西の道) 赤0-17 青17-29 黄29-32
  let phase = '';
  return (t) => {
    const c = t % 32, st = [c < 14 ? 0 : c < 17 ? 1 : 2, c >= 17 && c < 29 ? 0 : c >= 29 ? 1 : 2], key = st.join();
    if (key === phase) return; phase = key;
    lampMats.forEach((mats, i) => mats.forEach((m, k) => { m.emissiveIntensity = k === st[i] ? 1.6 : 0; m.color.setHex(k === st[i] ? 0xffffff : 0x2b2f35); }));
  };
}

// ---- 建物 ----
// 街区(道と道の間)を、道に面した敷地に分けてビルを建てる。街区が深ければ背中合わせの2列。
// 高さは東京駅に近いほど・大通りに面するほど高い。広い街区の一部は低層部+塔の高層ビル。
function planBuildings() {
  const R = seeded(20261022), blds = [];
  let dist = 'tokyo';                                  // いま建てている地区
  const add = (x0, z0, x1, z1, h, style) => blds.push({ x0, z0, x1, z1, h, style, dist });
  const FLOOR = 3.8;
  const rows = (lo, hi, a, b, horiz, height) => {
    // a..b を道に面した間口 12〜28m の敷地に分け、奥行き lo..hi に建てる
    let s = a;
    while (s < b - 6) {
      const wmin = dist === 'hk' ? 8 : 12, wvar = dist === 'hk' ? 8 : 16;
      let w = wmin + R() * wvar; if (b - (s + w) < wmin * 0.8) w = b - s;
      const h = height(), g = dist === 'hk' ? 0.15 : 0.4;
      if (horiz) add(s + g, lo, s + w - g, hi, h); else add(lo, s + g, hi, s + w - g, h);
      // ニューヨーク: 高いビルは上の方を内側へ下げる(セットバック)
      if (dist === 'ny' && h > 70) {
        const top = blds.at(-1), ins = 2.5, h2 = h + Math.round((15 + R() * 40) / FLOOR) * FLOOR;
        top.h = Math.round(h * 0.75 / FLOOR) * FLOOR;
        add(top.x0 + ins, top.z0 + ins, top.x1 - ins, top.z1 - ins, h2);
      }
      s += w;
    }
  };
  for (let i = 0; i + 1 < EKI_NS.length; i++) for (let j = 0; j + 1 < EKI_EW.length; j++) {
    const W = EKI_NS[i], E = EKI_NS[i + 1], N = EKI_EW[j], S = EKI_EW[j + 1];
    const x0 = W.x + halfCorr(W) + 0.5, x1 = E.x - halfCorr(E) - 0.5, z0 = N.z + halfCorr(N) + 0.5, z1 = S.z - halfCorr(S) - 0.5;
    // 地区: 西は東京のオフィス街、真ん中はニューヨーク(れんがと石の高層・セットバック)、東は香港(細く高い塔が密集)
    const cxm = (x0 + x1) / 2;
    dist = cxm < -70 ? 'tokyo' : cxm < 95 ? 'ny' : 'hk';
    const near = dist === 'tokyo' ? Math.max(0, 1 - (x0 - X0) / 250) : 0.5;
    const base = (major) => () => {
      let tall;
      if (dist === 'ny') tall = major ? 70 + R() * 60 : 35 + R() * 40;
      else if (dist === 'hk') tall = major ? 90 + R() * 70 : 60 + R() * 60;
      else tall = (major ? 30 + near * 50 : 18 + near * 20) * (0.6 + R() * 0.8);
      return Math.max(3, Math.round(tall / FLOOR)) * FLOOR;
    };
    const major = (r) => r.lanes > 1;
    // 大通りに面した広い街区は、ときどき1棟の高層ビル(低層部+塔)
    if (dist !== 'hk' && (major(W) || major(E) || major(N) || major(S)) && R() < (dist === 'ny' ? 0.18 : 0.1 + near * 0.2)) {
      const pod = (4 + Math.round(R() * 3)) * FLOOR;
      add(x0, z0, x1, z1, pod, 'pod');
      const ins = 5 + R() * 4, th = Math.round((90 + near * 90 + R() * 40) / FLOOR) * FLOOR;
      add(x0 + ins, z0 + ins, x1 - ins, z1 - ins, th, 'tower');
      continue;
    }
    // 南北に長い街区は、東西の道に面した端の列と、南北の道に面した2列
    const depth = (z1 - z0) / 2;
    rows(z0, z0 + Math.min(depth, 22), x0, x1, true, base(major(N)));          // 北の道に面する
    rows(z1 - Math.min(depth, 22), z1, x0, x1, true, base(major(S)));          // 南の道に面する
    if (z1 - z0 > 46) {                                                        // 間が空くなら東西の道に面した列で埋める
      const m0 = z0 + 22.4, m1 = z1 - 22.4, half = (x1 - x0) / 2;
      rows(x0, x0 + half - 0.2, m0, m1, false, base(major(W)));
      rows(x0 + half + 0.2, x1, m0, m1, false, base(major(E)));
    }
  }
  // 外周の道の外側(東・南・北の対岸)に並ぶ建物の帯(入れない)
  const ring = (x0, z0, x1, z1, horiz) => rows(horiz ? z0 : x0, horiz ? z1 : x1, horiz ? x0 : z0, horiz ? x1 : z1, horiz, () => Math.round((20 + R() * 45) / FLOOR) * FLOOR);
  dist = 'ring';
  const e = EKI_NS.at(-1), s = EKI_EW.at(-1), n = EKI_EW[0], wr = EKI_NS[0];
  ring(wr.x - halfCorr(wr) - OUT, Z0 - 60, wr.x - halfCorr(wr) - 0.5, Z1 + 60, false);
  ring(e.x + halfCorr(e) + 0.5, Z0 - 60, e.x + halfCorr(e) + OUT, Z1 + 60, false);
  ring(X0 - 10, s.z + halfCorr(s) + 0.5, X1 + 60, s.z + halfCorr(s) + OUT, true);
  ring(X0 - 10, n.z - halfCorr(n) - 75 - OUT, X1 + 60, n.z - halfCorr(n) - 75, true);   // 川の向こう岸
  return blds;
}
function buildBuildings(blds, group, wallMats, roofMat) {
  const walls = STYLES.map(() => ({ p: [], u: [], c: [], n: [] }));
  const roofs = { p: [], c: [], n: [] };
  blds.forEach((b, i) => {
    const R = seeded(i * 131 + 17);
    let style = b.style === 'tower' ? (R() < 0.8 ? 2 : 0) : b.h > 50 ? [0, 0, 1, 2, 4][Math.floor(R() * 5)] : [1, 1, 3, 4, 0][Math.floor(R() * 5)];
    let base = style === 2 ? GLASS_COLORS[Math.floor(R() * GLASS_COLORS.length)] : WALL_COLORS[Math.floor(R() * WALL_COLORS.length)];
    if (b.dist === 'ny' && b.style !== 'tower') { style = R() < 0.6 ? 1 : 4; base = NY_COLORS[Math.floor(R() * NY_COLORS.length)]; }
    if (b.dist === 'hk') { style = 3; base = HK_COLORS[Math.floor(R() * HK_COLORS.length)]; }
    const col = new THREE.Color(base), roof = new THREE.Color(base).multiplyScalar(0.72);
    const S = STYLES[style], W = walls[style], h = b.h;
    const pts = [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]];
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const [x0, z0] = pts[k], [x1, z1] = pts[(k + 1) % 4], len = Math.hypot(x1 - x0, z1 - z0);
      const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;          // 外向き
      const u0 = s / S.tileW, u1 = (s + len) / S.tileW, v1 = h / S.tileH;
      W.p.push(x0, 0, z0, x1, h, z1, x1, 0, z1, x0, 0, z0, x0, h, z0, x1, h, z1);
      W.u.push(u0, 0, u1, v1, u1, 0, u0, 0, u0, v1, u1, v1);
      for (let q = 0; q < 6; q++) { W.c.push(col.r, col.g, col.b); W.n.push(nx, 0, nz); }
      s += len;
    }
    roofs.p.push(b.x0, h, b.z0, b.x1, h, b.z1, b.x1, h, b.z0, b.x0, h, b.z0, b.x0, h, b.z1, b.x1, h, b.z1);
    for (let q = 0; q < 6; q++) { roofs.c.push(roof.r, roof.g, roof.b); roofs.n.push(0, 1, 0); }
  });
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
}

// ---- 東京駅・日本橋川・首都高 ----
export const EKI_ELEVATED_Z = -65;                     // 首都高はこの東西の大通りの真上を通る(下をくぐれる)
const PIERS = [];                                      // 首都高の橋脚(中央線の上。当たり判定あり)
function buildLandmarks(group) {
  const solid = { p: [], n: [] }, deck = { p: [], n: [] }, water = [];
  // 日本橋川(北の道の向こう)
  const n = EKI_EW[0], wz1 = n.z - halfCorr(n) - 2, wz0 = wz1 - 70;
  quad(water, X0 - 200, wz0, X1 + 200, wz1, -0.6);
  boxInto(solid, (X0 + X1) / 2, -0.3, wz1 + 1, X1 - X0 + 400, 0.8, 2);        // 護岸
  // 首都高: 大通りの真上、高さ9mに桁。橋脚は中央線の上に、交差点を避けて40mおき。
  const r = EKI_EW.find((q) => q.z === EKI_ELEVATED_Z), w = halfCw(r) * 2 + 2;
  boxInto(deck, (X0 + X1) / 2, 10, r.z, X1 - X0 + 300, 1.8, w);
  for (const sd of [-1, 1]) boxInto(deck, (X0 + X1) / 2, 11.6, r.z + sd * (w / 2 - 0.2), X1 - X0 + 300, 1.2, 0.4);   // 壁高欄
  for (let x = X0 - 140; x < X1 + 150; x += 40) {
    if (EKI_NS.some((q) => Math.abs(q.x - x) < halfCorr(q) + 4)) continue;
    boxInto(deck, x, 4.6, r.z, 1.4, 9.2, 1.4);
    PIERS.push({ x0: x - 0.7, z0: r.z - 0.7, x1: x + 0.7, z1: r.z + 0.7 });
  }
  const g = new THREE.Group(); g.name = 'tokyoeki-landmarks';
  g.add(solidMesh(solid, new THREE.MeshLambertMaterial({ color: CONCRETE })), solidMesh(deck, new THREE.MeshLambertMaterial({ color: 0x8e9196 })),
    flatMesh(water, 0x3d6b66));
  group.add(g);
}

// 当たり判定: 建物(軸にそろった四角)と、街の外(外周の道の外)。
function makeBlocker(blds) {
  const CELL = 20, grid = new Map();
  blds.forEach((b, i) => {
    for (let gx = Math.floor(b.x0 / CELL); gx <= Math.floor(b.x1 / CELL); gx++)
      for (let gz = Math.floor(b.z0 / CELL); gz <= Math.floor(b.z1 / CELL); gz++) {
        const k = gx + ',' + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const ex0 = X0 - halfCorr(EKI_NS[0]), ex1 = X1 + halfCorr(EKI_NS.at(-1)), ez0 = Z0 - halfCorr(EKI_EW[0]), ez1 = Z1 + halfCorr(EKI_EW.at(-1));
  return (x, z, r = 0.3) => {
    if (x < ex0 + r || x > ex1 - r || z < ez0 + r || z > ez1 - r) return true;
    const list = grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!list) return false;
    for (const i of list) { const b = blds[i]; if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true; }
    return false;
  };
}

// root: 地図(走行面だけに使う)。見た目はすべて隠し、街を組み立てて同じ親に置く。
export function decorateTokyoEki(root) {
  root.traverse((o) => { if (o.isMesh) o.visible = false; });
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
  const city = new THREE.Group(); city.name = 'tokyoeki-city';
  (root.parent || root).add(city);
  // 地面(街の外まで)
  const ground = [];
  quad(ground, X0 - 400, Z0 - 400, X1 + 400, Z1 + 400, -0.08);
  city.add(flatMesh(ground, 0x8f918c));
  const updateSignals = buildStreets(city);
  const blds = planBuildings();
  buildBuildings(blds, city, wallMats, roofMat);
  buildLandmarks(city);
  const blocked = makeBlocker([...blds, ...PIERS]);
  document.body.dataset.tokyoEkiBuildings = String(blds.length);
  let clock = 0;
  return {
    isBlocked: (x, z, R) => blocked(x, z, R),
    update(dt) { clock += dt; updateSignals(clock); },
    setNight(on) { glowMaterials.forEach((m) => { m.emissiveIntensity = on ? 0.85 : 0; }); },
  };
}
