// 赤城山: 読み込み、スタート位置、スクリーンショット、ガードレールに当たるか
import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer();
const { browser, page } = await openCourse(s, { course: 'akagi' });
const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.waitForTimeout(7000);
await page.screenshot({ path: process.argv[2] || '/tmp/akagi.png' });
const pos = await page.evaluate(() => { const p = window.__mapDebug?.player; return p ? [p.pos.x, p.pos.y, p.pos.z, p.heading].map((v) => +v.toFixed(2)) : null; });
import fs from 'fs';
const D = JSON.parse(fs.readFileSync(new URL('../map/akagi-course.json', import.meta.url)));
const i = D.start + 60, A = D.route[i - 1], B = D.route[i + 1], P = D.route[i];   // スタートから 180m 先(ガードレールのある所)
const r = await page.evaluate(async ([P, h]) => {
  const p = window.__mapDebug.player; p.pos.set(P[0], P[1] + 0.3, P[2]); p.heading = h; p.vel.set(0, 0, 0);
  await new Promise((r) => setTimeout(r, 500));
  const lx = Math.cos(h), lz = -Math.sin(h);
  const x0 = p.pos.x, z0 = p.pos.z, out = [];
  for (let k = 0; k < 12; k++) { p.vel.set(lx * 12, 0, lz * 12); await new Promise((r) => setTimeout(r, 200)); out.push(+(((p.pos.x - x0) * lx + (p.pos.z - z0) * lz)).toFixed(1)); }
  return out;
}, [P, Math.atan2(B[0] - A[0], B[2] - A[2])]);
console.log('位置', JSON.stringify(pos), '横へ進んだ距離', JSON.stringify(r), 'wallhits', await page.evaluate(() => document.body.dataset.mapWallCollisionCount), errs.slice(0, 5));
await browser.close(); s.stop(); process.exit(0);
