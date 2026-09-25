// With +Y up, (dz, -dx) points to the driver's left along the route.
// Reverse the offset for oncoming traffic, whose driving direction is reversed.
// The route is a ring whose last point continues to route[0] + seam: one lap
// along a path ends one seam further on, so positions stay continuous.
export function buildGunmaTrafficPaths(route, tangents, laneOffset = 2.05, seam = { x: 0, z: 0 }) {
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
    const shift = oncoming ? { x: -seam.x, z: -seam.z } : { x: seam.x, z: seam.z };
    const distances = new Float64Array(points.length + 1);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = nextPoint(points, i, shift);
      distances[i + 1] = distances[i] + Math.hypot(b.x - a.x, b.z - a.z);
    }
    return { points, distances, length: distances[points.length], seam: shift };
  };
  return { same: makePath(false), oncoming: makePath(true) };
}

function nextPoint(points, i, shift) {
  if (i + 1 < points.length) return points[i + 1];
  const first = points[0];
  return { x: first.x + shift.x, y: first.y, z: first.z + shift.z };
}

export function sampleGunmaTrafficPath(path, meters) {
  const length = path.length;
  const laps = Math.floor(meters / length);
  const distance = meters - laps * length;
  let lo = 0, hi = path.points.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (path.distances[mid] <= distance) lo = mid;
    else hi = mid;
  }
  const shift = path.seam ?? { x: 0, z: 0 };
  const a = path.points[lo], b = nextPoint(path.points, lo, shift);
  const segment = path.distances[lo + 1] - path.distances[lo];
  const t = segment > 0 ? (distance - path.distances[lo]) / segment : 0;
  return {
    x: a.x + (b.x - a.x) * t + shift.x * laps,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t + shift.z * laps,
  };
}
