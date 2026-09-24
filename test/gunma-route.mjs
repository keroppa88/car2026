import assert from 'node:assert/strict';
import { buildGunmaMap } from '../js/gunma-map.js';
import { buildGunmaTrafficPaths, sampleGunmaTrafficPath } from '../js/gunma-traffic.js';

for (const seed of [1, 20260923, 4294967295]) {
  const { route, tangents } = buildGunmaMap(seed);
  const { same, oncoming } = buildGunmaTrafficPaths(route, tangents);
  assert.equal(same.points.length, route.length);
  assert.equal(oncoming.points.length, route.length);
  for (let i = 0; i < route.length; i += 37) {
    const center = route[i], normal = tangents[i];
    const left = same.points[i], right = oncoming.points[route.length - 1 - i];
    assert.ok(Math.abs((left.x - center.x) * normal.x
      + (left.z - center.z) * normal.z + 2.05) < 1e-5);
    assert.ok(Math.abs((right.x - center.x) * normal.x
      + (right.z - center.z) * normal.z - 2.05) < 1e-5);
    assert.equal(left.y, center.y);
    assert.equal(right.y, center.y);
    const nextLeft = same.points[(i + 1) % route.length];
    const reverseIndex = route.length - 1 - i;
    const nextRight = oncoming.points[(reverseIndex + 1) % route.length];
    const leftDx = nextLeft.x - left.x, leftDz = nextLeft.z - left.z;
    const rightDx = nextRight.x - right.x, rightDz = nextRight.z - right.z;
    assert.ok(leftDx * rightDx + leftDz * rightDz < 0);
  }
  for (const path of [same, oncoming]) {
    assert.ok(path.length > 3000);
    for (const distance of [0, 2, 95, path.length - 0.1]) {
      const a = sampleGunmaTrafficPath(path, distance);
      const b = sampleGunmaTrafficPath(path, distance + path.length);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6);
    }
    const before = sampleGunmaTrafficPath(path, -0.05);
    const after = sampleGunmaTrafficPath(path, 0.05);
    assert.ok(Math.hypot(before.x - after.x, before.z - after.z) < 0.2);
  }
}
console.log('Gunma CPU lanes and loop interpolation: OK');
