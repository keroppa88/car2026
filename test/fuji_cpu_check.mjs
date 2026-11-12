import { startServer, openCourse } from './lib/harness.mjs';
const s = await startServer();
const { browser, page } = await openCourse(s, { course: 'fuji' });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.waitForTimeout(8000);
const r = await page.evaluate(() => ({ same: document.body.dataset.gunmaCpuSameDirection, top: document.body.dataset.playerTopSpeedKmh, keys: Object.keys(document.body.dataset).filter((k) => /cpu|Cpu/.test(k)).map((k) => k + '=' + document.body.dataset[k]) }));
console.log(JSON.stringify(r), errs);
await browser.close(); process.exit(0);
