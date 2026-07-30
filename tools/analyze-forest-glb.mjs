import fs from 'node:fs';

const files = ['map/forest01.glb', 'map/forest02.glb', 'map/forest03.glb', 'map/forest04.glb'];
const scale = 0.00008503937064;
const roadMaterials = new Set(['WOOD_CHIPS_01_1K', 'WOOD_CHIPS_01_IK']);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function readGlb(file) {
  const glb = fs.readFileSync(file);
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: invalid GLB`);
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) {
      json = JSON.parse(chunk.toString('utf8').replace(/\0+$/u, '').trimEnd());
    } else if (type === 0x004e4942) {
      binary = chunk;
    }
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error(`${file}: JSON/BIN chunk missing`);
  return { json, binary };
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
      }
    }
  }
  return out;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  return [
    (1 - (y * y2 + z * z2)) * sx, (x * y2 + w * z2) * sx, (x * z2 - w * y2) * sx, 0,
    (x * y2 - w * z2) * sy, (1 - (x * x2 + z * z2)) * sy, (y * z2 + w * x2) * sy, 0,
    (x * z2 + w * y2) * sz, (y * z2 - w * x2) * sz, (1 - (x * x2 + y * y2)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transform(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function emptyBounds() {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function expand(bounds, point) {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function roundGame(value) {
  return Number((value * scale).toFixed(4));
}

for (const file of files) {
  const { json, binary } = readGlb(file);
  const worlds = new Array(json.nodes.length);
  const visit = (index, parent) => {
    worlds[index] = multiply(parent, nodeMatrix(json.nodes[index]));
    for (const child of json.nodes[index].children ?? []) {
      visit(child, worlds[index]);
    }
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, identity);

  const positionsFor = (accessorIndex) => {
    const accessor = json.accessors[accessorIndex];
    const view = json.bufferViews[accessor.bufferView];
    if (accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
      throw new Error(`${file}: unsupported POSITION accessor`);
    }
    const stride = view.byteStride ?? 12;
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return Array.from({ length: accessor.count }, (_, index) => [
      binary.readFloatLE(offset + index * stride),
      binary.readFloatLE(offset + index * stride + 4),
      binary.readFloatLE(offset + index * stride + 8),
    ]);
  };

  const allBounds = emptyBounds();
  const roadBounds = emptyBounds();
  const roadPoints = [];
  for (let nodeIndex = 0; nodeIndex < json.nodes.length; nodeIndex++) {
    const node = json.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    for (const primitive of json.meshes[node.mesh].primitives) {
      const materialName =
        (json.materials[primitive.material]?.name ?? '').trim().toUpperCase();
      const road = roadMaterials.has(materialName);
      for (const local of positionsFor(primitive.attributes.POSITION)) {
        const world = transform(worlds[nodeIndex], local);
        expand(allBounds, world);
        if (road) {
          expand(roadBounds, world);
          roadPoints.push(world);
        }
      }
    }
  }

  const roadSpanZ = roadBounds.max[2] - roadBounds.min[2];
  const endpointBand = roadSpanZ * 0.008;
  const endpoint = (maximum) => {
    const edgeZ = maximum ? roadBounds.max[2] : roadBounds.min[2];
    const points = roadPoints.filter((point) =>
      Math.abs(point[2] - edgeZ) <= endpointBand
    );
    const minX = Math.min(...points.map((point) => point[0]));
    const maxX = Math.max(...points.map((point) => point[0]));
    const surfaceYs = points.map((point) => point[1]).sort((a, b) => a - b);
    const medianY = surfaceYs[Math.floor(surfaceYs.length * 0.5)];
    return {
      centerX: roundGame((minX + maxX) * 0.5),
      minX: roundGame(minX),
      maxX: roundGame(maxX),
      width: roundGame(maxX - minX),
      medianY: roundGame(medianY),
      minY: roundGame(surfaceYs[0]),
      maxY: roundGame(surfaceYs.at(-1)),
    };
  };

  console.log(JSON.stringify({
    file,
    mapX: {
      min: roundGame(allBounds.min[0]),
      max: roundGame(allBounds.max[0]),
      width: roundGame(allBounds.max[0] - allBounds.min[0]),
    },
    mapZ: {
      min: roundGame(allBounds.min[2]),
      max: roundGame(allBounds.max[2]),
      length: roundGame(allBounds.max[2] - allBounds.min[2]),
    },
    roadZ: {
      min: roundGame(roadBounds.min[2]),
      max: roundGame(roadBounds.max[2]),
      length: roundGame(roadBounds.max[2] - roadBounds.min[2]),
      insetAtMin: roundGame(roadBounds.min[2] - allBounds.min[2]),
      insetAtMax: roundGame(allBounds.max[2] - roadBounds.max[2]),
    },
    roadAtMaxZ: endpoint(true),
    roadAtMinZ: endpoint(false),
  }));
}
