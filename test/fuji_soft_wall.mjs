import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer();
const { browser, page } = await openCourse(s, { course: 'fuji' });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.waitForTimeout(6000);
// 1) 草地: スタートの左 14m に置いて、コースと平行に 50m/s
const r1 = await page.evaluate(async () => {
  const p = window.__mapDebug.player, h = p.heading, lx = Math.cos(h), lz = -Math.sin(h);
  p.pos.x += lx * 14; p.pos.z += lz * 14; p.vel.set(Math.sin(h) * 40, 0, Math.cos(h) * 40);
  const out = [];
  for (let k = 0; k < 8; k++) { await new Promise((r) => setTimeout(r, 250)); out.push([Math.round(p.vel.length() * 3.6), document.body.dataset.playerSurface]); }
  return out;
});
console.log('草地', JSON.stringify(r1));
await page.screenshot({ path: process.argv[2] });
console.log('wall', await page.evaluate(() => document.body.dataset.mapWallCollisionCount), errs.slice(0, 3));
await browser.close(); process.exit(0);
