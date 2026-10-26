import * as THREE from '../lib/three.module.js';

// 地表を区分して作った実メッシュ。色を付けるための重ね面・深度マスクは使わない。
// 表示、支持面、路面種別の判定がすべて同じ三角形を参照する。
export async function loadNativeSurfaces(url, group) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`地表データ: ${response.status}`);
  const data = await response.json();
  if (data.version !== 1) throw new Error('地表データの形式が異なります');
  const binaryResponse = await fetch(new URL(data.binary, response.url || new URL(url, location.href)));
  if (!binaryResponse.ok) throw new Error(`地表メッシュ: ${binaryResponse.status}`);
  const encoded = await binaryResponse.arrayBuffer();
  const buffer = data.compression === 'gzip'
    ? await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : encoded;
  if (buffer.byteLength !== data.byteLength) throw new Error('地表メッシュのサイズが一致しません');
  const material = new THREE.MeshLambertMaterial({ name: 'shonan-native-surface', vertexColors: true, side: THREE.DoubleSide });
  const meshes = [], support = [], grid = new Map(), cell = 25;
  for (const chunk of data.chunks) {
    const positions = new Float32Array(buffer, chunk.positions, chunk.count * 3);
    const colors = new Uint8Array(buffer, chunk.colors, chunk.count * 3);
    const kinds = new Uint8Array(buffer, chunk.kinds, chunk.count / 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(chunk.x, 0, chunk.z); mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
    mesh.name = chunk.water ? 'shonan-water' : 'shonan-surface';
    mesh.userData.noLift = true; mesh.userData.nativeSurface = true;
    group.add(mesh); meshes.push(mesh); if (!chunk.water) support.push(mesh);
    // 陸の近くの水だけを判定に登録。遠い沖合には走れる範囲がない。
    for (let t = 0; t < kinds.length; t++) {
      const k = t * 9;
      const ax = positions[k] + chunk.x, az = positions[k + 2] + chunk.z;
      const bx = positions[k + 3] + chunk.x, bz = positions[k + 5] + chunk.z;
      const cx = positions[k + 6] + chunk.x, cz = positions[k + 8] + chunk.z;
      const [x0, z0, x1, z1] = data.bounds;
      if (Math.max(ax, bx, cx) < x0 || Math.min(ax, bx, cx) > x1 || Math.max(az, bz, cz) < z0 || Math.min(az, bz, cz) > z1) continue;
      const triangle = { positions, k, x: chunk.x, z: chunk.z, kind: kinds[t] };
      for (let i = Math.floor(Math.min(ax, bx, cx) / cell); i <= Math.floor(Math.max(ax, bx, cx) / cell); i++)
        for (let j = Math.floor(Math.min(az, bz, cz) / cell); j <= Math.floor(Math.max(az, bz, cz) / cell); j++) {
          const key = `${i},${j}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(triangle);
        }
    }
  }
  let lastX, lastZ, last;
  const at = (x, z) => {
    if (x === lastX && z === lastZ) return last;
    lastX = x; lastZ = z; last = null;
    for (const t of grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) || []) {
      const p = t.positions, k = t.k, px = x - t.x, pz = z - t.z;
      const ax = p[k], az = p[k + 2], bx = p[k + 3], bz = p[k + 5], cx = p[k + 6], cz = p[k + 8];
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) < 1e-12) continue;
      const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den;
      const v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * p[k + 1] + v * p[k + 4] + w * p[k + 7];
      if (!last || y > last.y) last = { y, kind: t.kind };
    }
    return last;
  };
  return { meshes, support, at, bounds: data.bounds, stats: data.stats };
}
