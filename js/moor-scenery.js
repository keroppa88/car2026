import * as THREE from '../lib/three.module.js';

// Lone trees and scattered gritstone rocks on the open moor. Two instanced
// meshes each for trees and rocks: a handful of draw calls in total.
// Positions are chosen along one period of the ring, then repeated one seam
// before and after, so the copies past each end of the road match.
export function createMoorScenery(scene, course, seed) {
  let state = (seed ^ 0x6d2b79f5) >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const { route, groundHeightAt, seam } = course;
  const offset = seam.offset;
  const group = new THREE.Group();
  group.name = 'moor-scenery';
  const nearestRoad = (x, z) => {
    let best = Infinity;
    for (let i = 0; i < route.length; i += 4) {
      best = Math.min(best, Math.hypot(x - route[i].x, z - route[i].z));
    }
    // Also the neighbouring copies across the seam.
    for (const k of [-1, 1]) {
      for (let i = 0; i < route.length; i += 4) {
        best = Math.min(best, Math.hypot(x - route[i].x - offset.x * k, z - route[i].z - offset.z * k));
      }
    }
    return best;
  };
  // Pick a spot beside the road at a chosen distance band.
  const place = (minDistance, maxDistance) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = route[Math.floor(random() * route.length)];
      const angle = random() * Math.PI * 2;
      const r = minDistance + random() * (maxDistance - minDistance);
      const x = p.x + Math.cos(angle) * r, z = p.z + Math.sin(angle) * r;
      if (x < seam.startX || x >= seam.endX) continue;
      if (nearestRoad(x, z) < minDistance) continue;
      return { x, z };
    }
    return null;
  };
  const copies = (spot, fn) => {
    for (const k of [-1, 0, 1]) {
      const x = spot.x + offset.x * k, z = spot.z + offset.z * k;
      // Only the nearby copies are ever seen; skip the rest.
      if (k !== 0 && Math.min(Math.abs(x - seam.startX), Math.abs(x - seam.endX)) > 600) continue;
      fn(x, z);
    }
  };
  const matrix = new THREE.Matrix4(), quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(), position = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  // Lone trees: a short dark trunk under a wind-bent round crown.
  const treeSpots = [];
  for (let i = 0; i < 70; i++) {
    const spot = place(14, 260);
    if (spot) treeSpots.push({ ...spot, size: 0.8 + random() * 0.7, lean: (random() - 0.5) * 0.5, turn: random() * Math.PI * 2 });
  }
  const treeMatrices = [];
  for (const tree of treeSpots) copies(tree, (x, z) => treeMatrices.push({ x, z, tree }));
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 6).translate(0, 1.6, 0),
    new THREE.MeshLambertMaterial({ color: 0x3b3129 }), treeMatrices.length);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.6, 1).scale(1.25, 0.85, 1.1).translate(0, 4.4, 0),
    new THREE.MeshLambertMaterial({ color: 0x3e5230, flatShading: true }), treeMatrices.length);
  treeMatrices.forEach(({ x, z, tree }, i) => {
    position.set(x, groundHeightAt(x, z) - 0.2, z);
    quaternion.setFromAxisAngle(up, tree.turn)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tree.lean));
    scale.setScalar(tree.size);
    matrix.compose(position, quaternion, scale);
    trunks.setMatrixAt(i, matrix);
    crowns.setMatrixAt(i, matrix);
  });
  trunks.name = crowns.name = 'MoorTree';
  group.add(trunks, crowns);

  // Rocks: flat-shaded, squashed boulders, some in small clusters.
  const rockSpots = [];
  for (let i = 0; i < 220; i++) {
    const spot = place(10, 320);
    if (!spot) continue;
    const cluster = random() < 0.3 ? 2 + Math.floor(random() * 4) : 1;
    for (let c = 0; c < cluster; c++) {
      rockSpots.push({
        x: spot.x + (random() - 0.5) * 4 * c, z: spot.z + (random() - 0.5) * 4 * c,
        size: 0.35 + random() * (c === 0 ? 1.4 : 0.7), turn: random() * Math.PI * 2,
        squash: 0.45 + random() * 0.35,
      });
    }
  }
  const rockMatrices = [];
  for (const rock of rockSpots) copies(rock, (x, z) => rockMatrices.push({ x, z, rock }));
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ color: 0x77736a, flatShading: true }), rockMatrices.length);
  rockMatrices.forEach(({ x, z, rock }, i) => {
    position.set(x, groundHeightAt(x, z) + rock.size * rock.squash * 0.35, z);
    quaternion.setFromAxisAngle(up, rock.turn);
    scale.set(rock.size * 1.3, rock.size * rock.squash, rock.size);
    matrix.compose(position, quaternion, scale);
    rocks.setMatrixAt(i, matrix);
  });
  rocks.name = 'MoorRock';
  group.add(rocks);
  scene.add(group);
  return group;
}
