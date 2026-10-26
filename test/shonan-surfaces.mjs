// node test/shonan-surfaces.mjs
// 表示用と支持面用の実三角形、および道路・砂浜の判定が一致することを確認する。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import * as THREE from '../lib/three.module.js';
import { loadNativeSurfaces } from '../js/native-surfaces.js';
const root = new URL('../', import.meta.url);
const info = JSON.parse(await fs.readFile(new URL('map/shonan-surfaces.json', root)));
for (const [path, expected] of [['map/shonan-city.json',info.citySha256],['map/shonan-terrain.json',info.terrainSha256],['map/shonan-surfaces.bin.gz',info.binarySha256]]) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(new URL(path,root))).digest('hex');
  assert.equal(hash,expected,`${path}: 地表を再生成してください`);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = new URL(url, root); target.search = '';
  const body = await fs.readFile(target);
  return {ok:true,url:target.href,json:async()=>JSON.parse(body),arrayBuffer:async()=>body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)};
};
const group = new THREE.Group();
const native = await loadNativeSurfaces(new URL('map/shonan-surfaces.json',root),group);
globalThis.fetch = originalFetch;
group.updateMatrixWorld(true);
assert.ok(native.support.length>0);
for (const m of native.meshes) {
  assert.equal(m.material.polygonOffset,false);
  assert.equal(m.material.colorWrite,true);
  assert.ok(m.visible);
}
const caster = new THREE.Raycaster();
function check(x,z,kind) {
  const hit = native.at(x,z);
  assert.ok(hit,`地表なし: ${x},${z}`);
  if(kind!==undefined) assert.equal(hit.kind,kind,`路面種別: ${x},${z}`);
  caster.set(new THREE.Vector3(x,120,z),new THREE.Vector3(0,-1,0));
  const intersections = caster.intersectObjects(native.meshes,false);
  assert.ok(intersections.length,`表示の面なし: ${x},${z}`);
  assert.ok(Math.abs(hit.y-intersections[0].point.y)<1e-4,'判定と実際の三角形の高さが不一致');
}
const city = JSON.parse(await fs.readFile(new URL('map/shonan-city.json',root)));
for(const p of [[9860.65,822.78],[-3713.13,-1067.66],[-9019.21,-75.47]]) check(...p,1);
// 復旧した稲村ヶ崎の東端。端点そのものを避け、道路の内側を検査。
check(9900,825,1);
let raised=0,sand=0,water=0;
for(const chunk of info.chunks) {
 const m=native.meshes[info.chunks.indexOf(chunk)],p=m.geometry.attributes.position;
 // すべてのタイルから、境界でない三角形の重心をサンプル。
 for(let i=0;i+2<p.count;i+=Math.max(3,Math.floor(p.count/12/3)*3)) {
   const x=(p.getX(i)+p.getX(i+1)+p.getX(i+2))/3+chunk.x;
   const z=(p.getZ(i)+p.getZ(i+1)+p.getZ(i+2))/3+chunk.z;
   if(x<info.bounds[0]||x>info.bounds[2]||z<info.bounds[1]||z>info.bounds[3])continue;
   const hit=native.at(x,z);if(!hit)continue;
   if(hit.y>3&&raised<12){check(x,z);raised++;}
   if(hit.kind===2&&sand<12){check(x,z,2);sand++;}
   if(hit.kind===3&&water<12){check(x,z,3);water++;}
 }
}
assert.ok(raised>=12&&sand>=12&&water>=12,'島・砂浜・水面の検証点不足');
assert.ok(info.stats.overlapArea<1&&info.stats.missingArea<1);
console.log('PASS: 元データとの整合性、3開始地点、稲村ヶ崎東端、島・砂浜・水面の表示と判定の一致');
console.log(info.stats);
