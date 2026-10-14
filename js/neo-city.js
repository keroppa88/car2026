import * as THREE from '../lib/three.module.js';
import { createNihonTown } from './nihon-town.js';

// 街並み(旧NeoTokyo)の見た目。中身は nihon-town.js(日本の街並み)。
// 地図グループの外に置き、車のレイキャストの対象にしない。
export function createNeoCity(scene, course, startX = 0) {
  const group = new THREE.Group();
  group.name = 'nihon-town';
  scene.add(group);
  const town = createNihonTown(group, { startX });
  let elapsed = 0;
  return {
    group,
    // カメラの位置の前後だけ街を組み立てる。夜は窓・看板・街灯を光らせる。
    update(camera, hidden, nightMode = false, dt = 1 / 60) {
      elapsed += dt;
      if (town.isNight() !== nightMode) town.setNight(nightMode);
      town.update(dt, elapsed, { x: camera.position.x, z: camera.position.z });
      group.visible = !hidden;
    },
  };
}
