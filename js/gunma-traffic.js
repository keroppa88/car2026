// With +Y up, (dz, -dx) points to the driver's left along the route.
// Reverse the offset for oncoming traffic, whose driving direction is reversed.
export function buildGunmaTrafficPaths(route, tangents, laneOffset = 2.05) {
  const makePath = (oncoming) => {
    const points = route.map((_, i) => {
      const index = oncoming ? route.length - 1 - i : i;
      const point = route[index], normal = tangents[index];
      const side = oncoming ? -1 : 1;
      return {
        x: point.x + side * normal.x * laneOffset,
        y: point.y,
        z: point.z + side * normal.z * laneOffset,
      };
    });
    const distances = new Float64Array(points.length + 1);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      distances[i + 1] = distances[i] + Math.hypot(b.x - a.x, b.z - a.z);
    }
    return { points, distances, length: distances[points.length] };
  };
  return { same: makePath(false), oncoming: makePath(true) };
}

export function sampleGunmaTrafficPath(path, meters) {
  const length = path.length;
  const distance = ((meters % length) + length) % length;
  let lo = 0, hi = path.points.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (path.distances[mid] <= distance) lo = mid;
    else hi = mid;
  }
  const a = path.points[lo], b = path.points[(lo + 1) % path.points.length];
  const segment = path.distances[lo + 1] - path.distances[lo];
  const t = segment > 0 ? (distance - path.distances[lo]) / segment : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}
