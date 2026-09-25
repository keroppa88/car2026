import assert from 'node:assert/strict';
import { buildGunmaMap } from '../js/gunma-map.js';
import { buildGunmaTrafficPaths, sampleGunmaTrafficPath } from '../js/gunma-traffic.js';
import { MAP_CONFIGS } from '../js/game-config.js';

assert.equal(MAP_CONFIGS.gunma.spawnOffsetRight, 1.68);
// The spawn heading points east: screen-left / driver's left is negative Z.
const spawnHeading = MAP_CONFIGS.gunma.spawnHeading;
const spawnLeftZ = -Math.sin(spawnHeading) * MAP_CONFIGS.gunma.spawnOffsetRight;
assert.ok(spawnLeftZ < 0);

for (const seed of [1, 20260923, 4294967295]) {
  const { route, tangents, seam } = buildGunmaMap(seed);
  const { same, oncoming } = buildGunmaTrafficPaths(route, tangents, 2.05, seam.offset);
  const auto = buildGunmaTrafficPaths(route, tangents, MAP_CONFIGS.gunma.spawnOffsetRight, seam.offset).same;
  // Both ends are straights on the valley floor, so the seam warp keeps height and heading.
  assert.ok(Math.abs(route[0].y - route[route.length - 1].y) < 1e-6);
  assert.equal(same.points.length, route.length);
  assert.equal(oncoming.points.length, route.length);
  for (let i = 0; i < route.length; i += 37) {
    const center = route[i], normal = tangents[i];
    const left = same.points[i], right = oncoming.points[route.length - 1 - i];
    // Neighbours across the seam sit one seam offset away.
    const beforeRaw = route[(i - 1 + route.length) % route.length];
    const before = i === 0
      ? { x: beforeRaw.x - seam.offset.x, z: beforeRaw.z - seam.offset.z } : beforeRaw;
    const after = route[(i + 1) % route.length];
    const forwardX = after.x - before.x, forwardZ = after.z - before.z;
    // World-space forward cross up points right, so the left lane has
    // a positive up cross forward component in X/Z coordinates.
    const laneSide = forwardZ * (left.x - center.x)
      - forwardX * (left.z - center.z);
    assert.ok(laneSide > 0);
    assert.ok(Math.abs((left.x - center.x) * normal.x
      + (left.z - center.z) * normal.z - 2.05) < 1e-5);
    assert.ok(Math.abs((right.x - center.x) * normal.x
      + (right.z - center.z) * normal.z + 2.05) < 1e-5);
    assert.equal(left.y, center.y);
    assert.equal(right.y, center.y);
    const autoCar = auto.points[i];
    const autoOffset = (autoCar.x - center.x) * normal.x
      + (autoCar.z - center.z) * normal.z;
    assert.ok(Math.abs(autoOffset - 1.68) < 1e-5);
    // Right wheel follows the previous car center, 0.9 m left of centerline.
    assert.ok(Math.abs(autoOffset - 0.78 - 0.9) < 1e-5);
    const nextLeft = same.points[(i + 1) % route.length];
    const reverseIndex = route.length - 1 - i;
    const nextRightRaw = oncoming.points[(reverseIndex + 1) % route.length];
    const nextRight = reverseIndex + 1 === route.length
      ? { x: nextRightRaw.x + oncoming.seam.x, z: nextRightRaw.z + oncoming.seam.z } : nextRightRaw;
    const leftDx = nextLeft.x - left.x, leftDz = nextLeft.z - left.z;
    const rightDx = nextRight.x - right.x, rightDz = nextRight.z - right.z;
    assert.ok(leftDx * rightDx + leftDz * rightDz < 0);
  }
  for (const path of [same, oncoming]) {
    assert.ok(path.length > 3000);
    for (const distance of [0, 2, 95, path.length - 0.1]) {
      const a = sampleGunmaTrafficPath(path, distance);
      // One lap further is the same place one seam further along the endless road.
      const b = sampleGunmaTrafficPath(path, distance + path.length);
      assert.ok(Math.hypot(a.x + path.seam.x - b.x, a.y - b.y, a.z + path.seam.z - b.z) < 1e-6);
    }
    const before = sampleGunmaTrafficPath(path, -0.05);
    const after = sampleGunmaTrafficPath(path, 0.05);
    assert.ok(Math.hypot(before.x - after.x, before.z - after.z) < 0.2);
  }
}
console.log('Gunma CPU lanes and endless seam interpolation: OK');
