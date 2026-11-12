import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer(); const { browser, page } = await openCourse(s, { course: 'fuji' });
await page.waitForTimeout(6000);
console.log(await page.evaluate(() => { let n = 0, seats = 0; window.__mapDebug.scene.traverse((o) => { if (o.name === 'fuji-spectators' && o.isInstancedMesh) n += o.count; }); return n / 2; }));
await browser.close(); process.exit(0);
