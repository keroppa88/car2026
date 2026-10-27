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
function check(x,z,kind,color) {
  const hit = native.at(x,z);
  assert.ok(hit,`地表なし: ${x},${z}`);
  if(kind!==undefined) assert.equal(hit.kind,kind,`路面種別: ${x},${z}`);
  caster.set(new THREE.Vector3(x,120,z),new THREE.Vector3(0,-1,0));
  const intersections = caster.intersectObjects(native.meshes,false);
  assert.ok(intersections.length,`表示の面なし: ${x},${z}`);
  assert.ok(Math.abs(hit.y-intersections[0].point.y)<1e-4,'判定と実際の三角形の高さが不一致');
  if(color!==undefined) {
    const first=intersections[0], colors=first.object.geometry.getAttribute('color');
    const expected=new THREE.Color(color).toArray().map(v=>Math.round(v*255));
    assert.deepEqual([colors.getX(first.face.a),colors.getY(first.face.a),colors.getZ(first.face.a)].map(v=>Math.round(v*255)),expected,`地表色: ${x},${z}`);
  }
}
const city = JSON.parse(await fs.readFile(new URL('map/shonan-city.json',root)));
for(const p of [[9860.65,822.78],[-3713.13,-1067.66],[-9019.21,-75.47]]) check(...p,1);
// 復旧した稲村ヶ崎の東端。端点そのものを避け、道路の内側を検査。
check(9900,825,1);
// 稲村ヶ崎の画像指示: 赤は海、黄緑は緑地、オレンジはグレーの護岸。
check(9300,820,3);
check(9507,706,0,0x6f9a4f);
check(9955,900,0,0x6f9a4f);
// 稲村ヶ崎(2回目): 道路の海側は砂浜、東端と岬の林のあいだは緑地。
check(9250,785,2);
check(9490,795,2);
check(9720,805,0,0x6f9a4f);
check(8850,710,2);   // 指示範囲より西の砂浜はそのまま。

// 江の島の画像指示: 黄色=砂、赤=海、橙=コンクリート、桃=接続道路。
check(5790,350,3);
check(6800,600,3);
check(6860,385,3);   // コンクリートの内側を埋めない。
check(6200,400,2);
check(6010,580,2);
check(5809.06,435.75,0,0x9a9b98);
check(6942.75,426.1,0,0x9a9b98);
check(6219.74,261.405,1);
check(7106,450,0);   // 岬の本体を保持。

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
