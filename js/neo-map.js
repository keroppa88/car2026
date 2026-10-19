import * as THREE from '../lib/three.module.js';
import { NIHON_INTRO_START, NIHON_LAP_LENGTH, NIHON_CROSSINGS } from './nihon-town.js?v=20261018-town-70';
export { NIHON_CROSSINGS };   // 交差点の x 範囲(main.js で交わる道から幹線へつなぐのに使う)

// 街並み(旧NeoTokyo): 日本の街を貫く一直線の二車線道路。
// 道は z = 0 を中心に +x へ延び、1周(NIHON_LAP_LENGTH)ごとに同じ街並みが繰り返す。
// ぐんまー・嵐が丘と同じ無限の輪: 最後の点は route[0] + seam.offset へ続く。
// ここで作るのは走行判定用の面だけ(見えない)。見た目は nihon-town.js が描く。

const HALF = 6.0;          // 車道の半幅(縁石まで)。中央線 z=0、外側線 |z|=5.6
const WALK = 9.2;          // 歩道の外側の端(道路中心から)
export const NEO_DRIVABLE_HALF = 60;   // 走れる範囲(道路中心から)。歩道・駐車場・敷地まで
const SPACING = 3;         // 点の間隔(m)の目安
// 交差点の交わる道(NIHON_CROSSINGS、周ごとに繰り返す)は車道と同じ高さにする。
// 走行面の高さ(見た目の地図の上面に合わせる)。
const ROAD_Y = 0.02, WALK_Y = 0.15, LOT_Y = 0.13;

export function buildNeoMap() {
  const x0 = NIHON_INTRO_START;
  const period = NIHON_LAP_LENGTH;
  // 点の数は4の倍数にそろえる(ほかの生成コースと同じ)。
  const routeCount = Math.round(period / SPACING / 4) * 4;
  const step = period / routeCount;
  const route = [], zones = [];
  for (let i = 0; i < routeCount; i++) {
    route.push(new THREE.Vector3(x0 + i * step, 0, 0));
    zones.push('town');
  }
  const halfWidths = route.map(() => HALF);
  const ring = (i) => ((i % routeCount) + routeCount) % routeCount;

  const offset = new THREE.Vector3(period, 0, 0);
  const at = (i) => {
    const laps = Math.floor(i / routeCount);
    const p = route[i - laps * routeCount];
    return new THREE.Vector3(p.x + offset.x * laps, p.y, p.z + offset.z * laps);
  };
  // 進行方向の左向き(+x へ進むなら -z)。CPU車・自動運転の車線はこの向きへずらす。
  const normalAt = (i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = b.x - a.x, dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dz / length, z: -dx / length };
  };
  const tangents = route.map((_, i) => normalAt(i));
  const copy = Math.ceil(160 / step / 2) * 2;
  const extIndices = Array.from({ length: routeCount + copy * 2 }, (_, j) => j - copy);
  const ext = extIndices.map(at);
  const extTangents = extIndices.map(normalAt);
  const extZones = extIndices.map((i) => zones[ring(i)]);
  const extHalfWidths = extIndices.map((i) => halfWidths[ring(i)]);
  const seam = {
    offset: { x: offset.x, z: offset.z },
    startX: route[0].x, endX: route[0].x + offset.x,
  };
  const ringPosition = (px, pz) => (px > seam.endX ? [px - offset.x, pz - offset.z]
    : px < seam.startX ? [px + offset.x, pz + offset.z] : [px, pz]);

  // 走行面: 車道・歩道・沿道の敷地(駐車場など)。どれも見えない板で、見た目は nihon-town.js。
  // 建物・塀・電柱・駐車中の車への当たり判定は nihon-town.js の isBlocked で行う。
  const group = new THREE.Group();
  group.name = 'nihon_procedural';
  const first = ext[0].x, last = ext[ext.length - 1].x;
  const quads = { GunmaRoad: [], GunmaShoulder: [] };
  const quad = (name, x0, x1, z0, z1, y) => {
    if (x1 - x0 > 1e-6) quads[name].push([x0, x1, z0, z1, y]);
  };
  // 交わる道の x 範囲(範囲内に入る周だけ)。
  const crossings = [];
  for (let k = -2; k <= 2; k++) {
    for (const [ca, cb] of NIHON_CROSSINGS) {
      const a = ca + k * period, b = cb + k * period;
      if (b > first && a < last) crossings.push([Math.max(a, first), Math.min(b, last)]);
    }
  }
  crossings.sort((p, q) => p[0] - q[0]);
  // 車道はずっと一続き。
  quad('GunmaRoad', first, last, -HALF, HALF, ROAD_Y);
  // 車道の外は、交わる道の所を切り抜いて歩道と敷地を置く。
  let x = first;
  for (const [a, b] of [...crossings, [last, last]]) {
    for (const side of [-1, 1]) {
      const zs = (z0, z1) => (side > 0 ? [z0, z1] : [-z1, -z0]);
      quad('GunmaShoulder', x, a, ...zs(HALF, WALK), WALK_Y);
      quad('GunmaShoulder', x, a, ...zs(WALK, NEO_DRIVABLE_HALF), LOT_Y);
      quad('GunmaShoulder', a, b, ...zs(HALF, NEO_DRIVABLE_HALF), ROAD_Y);
    }
    x = b;
  }
  for (const [name, list] of Object.entries(quads)) {
    const positions = [], indices = [];
    for (const [x0q, x1q, z0, z1, y] of list) {
      const base = positions.length / 3;
      positions.push(x0q, y, z0, x1q, y, z0, x0q, y, z1, x1q, y, z1);
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      name, color: 0x000000, side: THREE.DoubleSide, visible: false,
    }));
    mesh.name = name;
    group.add(mesh);
  }

  const groundHeightAt = () => 0;
  const groundNormalAt = () => new THREE.Vector3(0, 1, 0);
  const terrainHeightAt = () => 0;
  return { group, route, tangents, ext, extTangents, extIndices, extZones, zones,
    halfWidths, extHalfWidths, seam, climb: 0,
    mistColor: new THREE.Color(0xaebdb4), mistTime: { value: 0 },
    groundHeightAt, groundNormalAt, terrainHeightAt, ringPosition };
}
