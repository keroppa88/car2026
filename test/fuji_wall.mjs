import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer();
const { browser, page } = await openCourse(s, { course: 'fuji' });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.waitForTimeout(6000);
const r = await page.evaluate(async () => {
  const p = window.__mapDebug.player, h = p.heading, lx = Math.cos(h), lz = -Math.sin(h);
  p.pos.x += lx * 10; p.pos.z += lz * 10; p.heading = h - Math.PI / 2;
  const x0 = p.pos.x, z0 = p.pos.z, out = [];
  for (let k = 0; k < 12; k++) { p.vel.set(lx * 15, 0, lz * 15); await new Promise((r) => setTimeout(r, 200)); out.push(+(((p.pos.x - x0) * lx + (p.pos.z - z0) * lz)).toFixed(1)); }
  return out;
});
console.log('左へ進んだ距離', JSON.stringify(r), 'wallhits', await page.evaluate(() => document.body.dataset.mapWallCollisionCount), errs.slice(0, 3));
await browser.close(); process.exit(0);
