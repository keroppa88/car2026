// 赤城山: 駐車場の出入口(スロープ)から入れるか、スロープ以外(段差)では止まるか
import fs from 'fs';
import { startServer, openCourse } from './lib/harness.mjs';
const D = JSON.parse(fs.readFileSync(new URL('../map/akagi-course.json', import.meta.url)));
const s = await startServer(); const { browser, page } = await openCourse(s, { course: 'akagi' }); await page.waitForTimeout(5000);
for (const i of process.argv.slice(2).map(Number)) {
  const A = D.route[i - 1], B = D.route[i + 1], P = D.route[i], l = Math.hypot(B[0] - A[0], B[2] - A[2]), nx = (B[2] - A[2]) / l, nz = -(B[0] - A[0]) / l;   // 左(駐車場の側)
  const r = await page.evaluate(async ([P, nx, nz]) => {
    const p = window.__mapDebug.player; p.pos.set(P[0], P[1] + 0.3, P[2]); p.heading = Math.atan2(nx, nz); p.vel.set(0, 0, 0);
    await new Promise((r) => setTimeout(r, 500)); const out = [];
    for (let k = 0; k < 14; k++) { p.vel.set(nx * 8, 0, nz * 8); await new Promise((r) => setTimeout(r, 200)); out.push([+((p.pos.x - P[0]) * nx + (p.pos.z - P[2]) * nz).toFixed(1), +p.pos.y.toFixed(2)]); }
    return out;
  }, [P, nx, nz]);
  console.log(i, '道の高さ', P[1], '左へ進んだ距離・高さ', JSON.stringify(r));
}
await browser.close(); s.stop(); process.exit(0);
