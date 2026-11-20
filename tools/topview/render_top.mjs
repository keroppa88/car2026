// 峠コース(赤城山と同じ作りのマップ)を真上から、ゆがみのない正射影で区切って描く。塗ってもらう下絵用。
// node tools/topview/render_top.mjs コース名 出力フォルダ [区画の一辺 m] [1区画の画素]
// 出力: tile_<列>_<行>.png と tiles.json(各区画の世界座標: x0,z0 = 左上、m_per_px)。上が北(-z)、右が東(+x)
// 全体図 overview.png も出す(区画の番号つき)
import fs from 'node:fs';
import { startServer, openCourse } from '../../test/lib/harness.mjs';
const [course, outDir, sizeArg, pxArg] = process.argv.slice(2);
const SIZE = Number(sizeArg) || 500, PX = Number(pxArg) || 1600;
fs.mkdirSync(outDir, { recursive: true });
const s = await startServer();
const { browser, page } = await openCourse(s, { course });
await page.setViewportSize({ width: PX, height: PX });
await page.waitForTimeout(3000);
await page.evaluate(() => { document.querySelectorAll('body *').forEach((e) => { if (e.tagName !== 'CANVAS' && !e.querySelector('canvas')) e.style.visibility = 'hidden'; }); });
// 道の点から、道を含む区画だけを選ぶ
const route = await page.evaluate(() => window.__mapDebug.gunmaCourse.route.map((p) => [p.x, p.z]));
const xs = route.map((p) => p[0]), zs = route.map((p) => p[1]);
const gx0 = Math.floor((Math.min(...xs) - 60) / SIZE) * SIZE, gz0 = Math.floor((Math.min(...zs) - 60) / SIZE) * SIZE;
const cols = Math.ceil((Math.max(...xs) + 60 - gx0) / SIZE), rows = Math.ceil((Math.max(...zs) + 60 - gz0) / SIZE);
const tiles = [];
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const x0 = gx0 + c * SIZE, z0 = gz0 + r * SIZE;
  if (route.some(([x, z]) => x > x0 - 40 && x < x0 + SIZE + 40 && z > z0 - 40 && z < z0 + SIZE + 40)) tiles.push({ col: c, row: r, x0, z0 });
}
await page.evaluate(() => {
  const d = window.__mapDebug; d.freeze();
  d.scene.userData.savedFog = d.scene.fog; d.scene.fog = null;          // 霧なし
  d.player.group && (d.player.group.visible = false);
  for (const a of window.__voxDrive.aiCars || []) a.group.visible = false;   // 車は消す
  d.scene.traverse((o) => { if (/mist|fog|cloud/i.test(o.name)) o.visible = false; });
});
let n = 0;
for (const t of tiles) {
  t.name = `tile_${String(++n).padStart(2, '0')}`;
  await page.evaluate(({ x0, z0, size }) => {
    const d = window.__mapDebug, cam = d.camera, cx = x0 + size / 2, cz = z0 + size / 2;
    cam.position.set(cx, 4000, cz); cam.up.set(0, 0, -1); cam.lookAt(cx, 0, cz);
    cam.projectionMatrix.makeOrthographic(-size / 2, size / 2, size / 2, -size / 2, 10, 8000);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert(); cam.updateMatrixWorld();
  }, { x0: t.x0, z0: t.z0, size: SIZE });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${t.name}.png` });
}
fs.writeFileSync(`${outDir}/tiles.json`, JSON.stringify({ course, size: SIZE, px: PX, m_per_px: SIZE / PX, tiles }, null, 1));
console.log(course, '区画', tiles.length, '一辺', SIZE, 'm', (SIZE / PX).toFixed(3), 'm/px');
await browser.close(); s.stop?.(); process.exit(0);
