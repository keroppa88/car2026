import * as THREE from '../lib/three.module.js';
import { NIHON_INTRO_START, NIHON_LAP_LENGTH } from './nihon-town.js';

// 街並み(旧NeoTokyo): 日本の街を貫く一直線の二車線道路。
// 道は z = 0 を中心に +x へ延び、1周(NIHON_LAP_LENGTH)ごとに同じ街並みが繰り返す。
// ぐんまー・嵐が丘と同じ無限の輪: 最後の点は route[0] + seam.offset へ続く。
// ここで作るのは走行判定用の面だけ(見えない)。見た目は nihon-town.js が描く。

const HALF = 6.0;          // 車道の半幅(縁石まで)。中央線 z=0、外側線 |z|=5.6
const SHOULDER = 3.2;      // 判定面を縁石の外(歩道)まで少し広げておく
const SPACING = 3;         // 点の間隔(m)の目安

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

  // 走行面: 車道と、その外の路肩(歩道の上)。どちらも見えない板。
  const group = new THREE.Group();
  group.name = 'nihon_procedural';
  const first = ext[0].x, last = ext[ext.length - 1].x;
  const bands = [
    { name: 'GunmaRoad', z0: -HALF, z1: HALF },
    { name: 'GunmaShoulder', z0: -HALF - SHOULDER, z1: -HALF },
    { name: 'GunmaShoulder', z0: HALF, z1: HALF + SHOULDER },
  ];
  for (const band of bands) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      first, 0, band.z0, last, 0, band.z0, first, 0, band.z1, last, 0, band.z1,
    ], 3));
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      name: band.name, color: 0x000000, side: THREE.DoubleSide, visible: false,
    }));
    mesh.name = band.name;
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
