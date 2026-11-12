import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer();
const { browser, page } = await openCourse(s, { course: 'fuji' });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.waitForTimeout(25000);
const r = await page.evaluate(() => {
  const d = window.__mapDebug; const out = [];
  d.scene.traverse((o) => { if (o.userData && o.userData.__dummy) out.push(1); });
  return { ds: document.body.dataset.gunmaCpuSpeedsKmh, drift: document.body.dataset.fujiCpuDriftSeen };
});
await page.screenshot({ path: process.argv[2] });
console.log(JSON.stringify(r), errs.slice(0, 3));
await browser.close(); process.exit(0);
