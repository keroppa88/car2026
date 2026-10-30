// 指定したカメラで湘南を描いて保存する。ピクセルの一覧を渡すと、その点の3D座標(地面などとの交点)も返す。
// node tools/shonan/paint/render.mjs job.json  (job: {W,H,cams:[{pos,target,out,pick?,pickOut?}]})
// 3D座標: 高さ 150m より上の当たり(空・遠景の山の板)は飛ばす
import fs from 'node:fs';
import { startServer, openCourse } from '../../../test/lib/harness.mjs';
const job = JSON.parse(fs.readFileSync(process.argv[2]));
const s = await startServer();
const { browser, page } = await openCourse(s, { course: process.env.COURSE || 'shonan' });
await page.setViewportSize({ width: job.W, height: job.H });
await page.waitForTimeout(4000);
await page.evaluate(() => { for (const el of document.body.children) if (el.tagName !== 'CANVAS' && !el.querySelector?.('canvas')) el.style.display = 'none'; document.querySelectorAll('body *').forEach((e) => { if (e.tagName !== 'CANVAS' && !e.querySelector('canvas') && getComputedStyle(e).position === 'fixed') e.style.display = 'none'; }); });
if (job.night) { await page.keyboard.press('n'); await page.waitForTimeout(1500); }   // job.night: 夜にして描く
for (const c of job.cams) {
  await page.evaluate(({ pos, target, fov, up }) => { const d = window.__mapDebug; d.freeze(); d.camera.fov = fov || 60; d.camera.aspect = innerWidth / innerHeight; d.camera.position.set(...pos); d.camera.up.set(...(up || [0, 1, 0])); d.camera.lookAt(...target); d.camera.far = 12000; d.camera.updateProjectionMatrix(); d.camera.updateMatrixWorld(); }, c);
  await page.waitForTimeout(1500);
  if (c.out) await page.screenshot({ path: c.out });
  if (c.pick) {
    const px = JSON.parse(fs.readFileSync(c.pick));
    const res = await page.evaluate((px) => { const d = window.__mapDebug, T = d.THREE, rc = new T.Raycaster(), W = innerWidth, H = innerHeight;
      const objs = []; d.scene.traverse((o) => { if (o.isMesh && o.visible && !o.isInstancedMesh) objs.push(o); });
      return px.map(([x, y]) => { rc.setFromCamera(new T.Vector2(x / W * 2 - 1, -(y / H * 2 - 1)), d.camera); const h = rc.intersectObjects(objs, false).find((q) => q.point.y < 150); return h ? [...h.point.toArray(), h.object.name, h.object.material?.color?.getHexString?.()] : null; }); }, px);
    fs.writeFileSync(c.pickOut, JSON.stringify(res));
  }
}
await browser.close(); process.exit(0);
