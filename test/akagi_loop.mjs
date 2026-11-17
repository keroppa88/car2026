// 赤城山: くだりで駐車場を過ぎると暗転して上へ、のぼりで草原を抜ける手前で暗転して駐車場前へ戻るか
import fs from 'fs';
import { startServer, openCourse } from './lib/harness.mjs';
const D = JSON.parse(fs.readFileSync(new URL('../map/akagi-course.json', import.meta.url)));
const s = await startServer(); const { browser, page } = await openCourse(s, { course: 'akagi' }); await page.waitForTimeout(5000);
for (const [i, dir, label] of [[1999, 1, 'くだり'], [84, -1, 'のぼり'], [1986, -1, 'のぼり(駐車場前から。何も起きないはず)']]) {
  const A = D.route[i - 1], B = D.route[i + 1], P = D.route[i], l = Math.hypot(B[0] - A[0], B[2] - A[2]), fx = (B[0] - A[0]) / l * dir, fz = (B[2] - A[2]) / l * dir;
  const r = await page.evaluate(async ([P, fx, fz, route]) => {
    const p = window.__mapDebug.player, near = () => { let b = 1e18, k = 0; route.forEach((q, j) => { const d = (q[0] - p.pos.x) ** 2 + (q[2] - p.pos.z) ** 2; if (d < b) { b = d; k = j; } }); return k; };
    p.pos.set(P[0], P[1] + 0.3, P[2]); p.heading = Math.atan2(fx, fz); const out = [];
    for (let k = 0; k < 26; k++) { const h = p.heading; p.vel.set(Math.sin(h) * 12, 0, Math.cos(h) * 12); await new Promise((r) => setTimeout(r, 200)); let dk = null; window.__mapDebug.camera.traverse((o) => { if (o.renderOrder === 9999) dk = o.material.opacity; }); out.push([near(), dk].map((v) => (typeof v === 'number' ? +v.toFixed(2) : v))); }
    return [out, document.body.dataset.akagiLoopCount, +p.pos.y.toFixed(2), +p.heading.toFixed(2)];
  }, [P, fx, fz, D.route]);
  console.log(label, '[近い点, 暗さ]', JSON.stringify(r[0]), ' 回数', r[1], ' 高さ', r[2], '向き', r[3]);
}
await browser.close(); s.stop(); process.exit(0);
