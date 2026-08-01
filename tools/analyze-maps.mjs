import fs from 'node:fs';

const files = ['map_tokyo.gltf', 'warehouse/map.gltf', 'map_gunma.gltf', 'map_monaco.gltf', 'map_indy.gltf'];
const scales = {
  'map_tokyo.gltf': 0.000075,
  'warehouse/map.gltf': 0.000075,
  'map_gunma.gltf': 0.15,
  'map_monaco.gltf': 0.01,
  'map_indy.gltf': 0.15,
};
const roadNamesByFile = {
  'map_tokyo.gltf': new Set(['M08', 'FF565656']),
  'warehouse/map.gltf': new Set(['M08', 'FF565656']),
  'map_gunma.gltf': new Set(['M08', 'FF1E1E1E']),
  'map_monaco.gltf': new Set(['M08', 'FF3A3A3A']),
  'map_indy.gltf': new Set(['M08', 'FF565656', 'FFACACAC', 'FF727272', 'FF1E1E1E', 'CCCCCCCC', 'FFE2E2E2', 'FFCCCC00']),
};
const treeNamesByFile = {
  'map_tokyo.gltf': new Set(['F08', 'FF4863A5']),
  'warehouse/map.gltf': new Set(['F08', 'FF4863A5']),
  'map_gunma.gltf': new Set(['F08', 'FF006633', 'FF437A5A']),
  'map_monaco.gltf': new Set(['F08', 'FF4863A5', 'FF437A5A', 'FF00994C']),
  'map_indy.gltf': new Set(['F08', 'FF4863A5']),
};

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  }
  return out;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  return [
    (1 - (y * y2 + z * z2)) * sx, (x * y2 + w * z2) * sx, (x * z2 - w * y2) * sx, 0,
    (x * y2 - w * z2) * sy, (1 - (x * x2 + z * z2)) * sy, (y * z2 + w * x2) * sy, 0,
    (x * z2 + w * y2) * sz, (y * z2 - w * x2) * sz, (1 - (x * x2 + y * y2)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function transform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
function closestOnSegment(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, (-(a[0] - px) * dx - (a[2] - pz) * dz) / (dx * dx + dz * dz || 1)));
  return [a[0] + dx * t, a[1] + (b[1] - a[1]) * t, a[2] + dz * t];
}
function closestTriangleToOrigin(a, b, c) {
  const v0x = b[0] - a[0], v0z = b[2] - a[2];
  const v1x = c[0] - a[0], v1z = c[2] - a[2];
  const v2x = -a[0], v2z = -a[2];
  const d00 = v0x * v0x + v0z * v0z;
  const d01 = v0x * v1x + v0z * v1z;
  const d11 = v1x * v1x + v1z * v1z;
  const d20 = v2x * v0x + v2z * v0z;
  const d21 = v2x * v1x + v2z * v1z;
  const denominator = d00 * d11 - d01 * d01;
  if (Math.abs(denominator) > 1e-12) {
    const v = (d11 * d20 - d01 * d21) / denominator;
    const w = (d00 * d21 - d01 * d20) / denominator;
    const u = 1 - v - w;
    if (u >= 0 && v >= 0 && w >= 0) return [0, a[1] * u + b[1] * v + c[1] * w, 0];
  }
  return [
    closestOnSegment(0, 0, a, b),
    closestOnSegment(0, 0, b, c),
    closestOnSegment(0, 0, c, a),
  ].sort((p, q) => p[0] ** 2 + p[2] ** 2 - q[0] ** 2 - q[2] ** 2)[0];
}

for (const file of files) {
  const roadNames = roadNamesByFile[file];
  const treeNames = treeNamesByFile[file];
  const gltf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64');
  const worlds = new Array(gltf.nodes.length);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const visit = (index, parent) => {
    worlds[index] = multiply(parent, nodeMatrix(gltf.nodes[index]));
    for (const child of gltf.nodes[index].children || []) visit(child, worlds[index]);
  };
  for (const root of gltf.scenes[gltf.scene || 0].nodes) visit(root, identity);
  const accessor = (index) => {
    const acc = gltf.accessors[index], view = gltf.bufferViews[acc.bufferView];
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const bytes = acc.componentType === 5126 ? 4 : acc.componentType === 5125 ? 4 : 2;
    const stride = view.byteStride || components * bytes;
    const offset = (view.byteOffset || 0) + (acc.byteOffset || 0);
    const get = acc.componentType === 5126 ? 'readFloatLE' : acc.componentType === 5125 ? 'readUInt32LE' : 'readUInt16LE';
    return Array.from({ length: acc.count }, (_, i) =>
      Array.from({ length: components }, (__, c) => raw[get](offset + i * stride + c * bytes)));
  };
  let nearest = null;
  let roadTriangles = 0, treeTriangles = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const roadShortEdges = [];
  const materialStats = new Map();
  const roadMaterials = new Set(), treeMaterials = new Set();
  for (let nodeIndex = 0; nodeIndex < gltf.nodes.length; nodeIndex++) {
    const node = gltf.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      const material = (gltf.materials[primitive.material]?.name || '').trim().toUpperCase();
      if (!roadNames.has(material) && !treeNames.has(material)) continue;
      const positions = accessor(primitive.attributes.POSITION).map((point) => transform(worlds[nodeIndex], point));
      for (const point of positions) for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
      }
      const indices = primitive.indices === undefined ? positions.map((_, i) => i) : accessor(primitive.indices).flat();
      if (!materialStats.has(material)) materialStats.set(material, { triangles: 0, edges: [], nearest: Infinity });
      const stat = materialStats.get(material);
      stat.triangles += indices.length / 3;
      for (let i = 0; i < indices.length; i += 3) {
        const trianglePoints = [positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]];
        const edges = [[0, 1], [1, 2], [2, 0]].map(([from, to]) =>
          Math.hypot(
            trianglePoints[to][0] - trianglePoints[from][0],
            trianglePoints[to][2] - trianglePoints[from][2]
          )).filter((length) => length > 1e-6).sort((x, y) => x - y);
        if (edges.length) stat.edges.push(edges[0]);
        const point = closestTriangleToOrigin(...trianglePoints);
        stat.nearest = Math.min(stat.nearest, Math.hypot(point[0], point[2]));
      }
      if (roadNames.has(material)) {
        roadMaterials.add(material);
        roadTriangles += indices.length / 3;
        for (let i = 0; i < indices.length; i += 3) {
          const point = closestTriangleToOrigin(positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]);
          const trianglePoints = [positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]]];
          const edges2d = [[0, 1], [1, 2], [2, 0]].map(([from, to]) =>
            Math.hypot(
              trianglePoints[to][0] - trianglePoints[from][0],
              trianglePoints[to][2] - trianglePoints[from][2]
            )).filter((length) => length > 1e-6).sort((x, y) => x - y);
          if (edges2d.length) roadShortEdges.push(edges2d[0]);
          const distance = Math.hypot(point[0], point[2]);
          if (!nearest || distance < nearest.distance) {
            const a = positions[indices[i]], b = positions[indices[i + 1]], c = positions[indices[i + 2]];
            const edges = [[a, b], [b, c], [c, a]].sort((e1, e2) =>
              Math.hypot(e2[1][0] - e2[0][0], e2[1][2] - e2[0][2])
              - Math.hypot(e1[1][0] - e1[0][0], e1[1][2] - e1[0][2]));
            nearest = {
              point,
              distance,
              heading: Math.atan2(edges[0][1][0] - edges[0][0][0], edges[0][1][2] - edges[0][0][2]),
            };
          }
        }
      } else {
        treeMaterials.add(material);
        treeTriangles += indices.length / 3;
      }
    }
  }
  const scale = scales[file];
  roadShortEdges.sort((a, b) => a - b);
  const materialSummary = {};
  for (const [name, stat] of materialStats) {
    stat.edges.sort((a, b) => a - b);
    materialSummary[name] = {
      triangles: stat.triangles,
      shortestEdgeP50Game: stat.edges.length ? stat.edges[Math.floor(stat.edges.length / 2)] * scale : null,
      nearestGame: stat.nearest * scale,
    };
  }
  const quantile = (q) => roadShortEdges[Math.min(roadShortEdges.length - 1, Math.floor(roadShortEdges.length * q))] * scale;
  console.log(JSON.stringify({
    file,
    scale,
    roadMaterials: [...roadMaterials],
    treeMaterials: [...treeMaterials],
    roadTriangles,
    treeTriangles,
    gameBoundingBox: {
      min: bounds.min.map((value) => value * scale),
      max: bounds.max.map((value) => value * scale),
      size: bounds.max.map((value, axis) => (value - bounds.min[axis]) * scale),
    },
    roadShortestEdgeGameQuantiles: roadShortEdges.length ? {
      p25: quantile(0.25), p50: quantile(0.5), p75: quantile(0.75), p90: quantile(0.9),
    } : null,
    materialSummary,
    nearestRoadRaw: nearest,
    nearestRoadGame: nearest ? {
      point: nearest.point.map((value) => value * scale),
      distance: nearest.distance * scale,
      heading: nearest.heading,
    } : null,
  }));
}
