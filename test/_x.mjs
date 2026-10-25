import { startServer, openCourse } from './lib/harness.mjs';
const server = await startServer();
const { browser, page, errors } = await openCourse(server, { course: 'nihonbashi' });
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForFunction(() => document.body.dataset.osmLandmarks, null, { timeout: 300000 });
await page.evaluate(() => { for (const s of ['#help','.panel','#speed','#hud']) document.querySelectorAll(s).forEach(e=>e.style.display='none'); });
const shot = async (name, cam, look) => {
  await page.evaluate(([c, l]) => { const d = window.__mapDebug; d.freeze(); d.camera.position.set(...c); d.camera.lookAt(...l); d.camera.updateMatrixWorld(); }, [cam, look]);
  await page.waitForTimeout(2500); await page.screenshot({ path: '/tmp/claude-0/-home-claude/0561a10a-9173-57c4-885b-5a9b3770069e/scratchpad/' + name + '.png' });
};
await shot('n-nomura', [395, 5, -770], [461, 14, -856]);
await shot('n-taka', [300, 6, -530], [350, 18, -600]);
console.log('errors', errors);
await browser.close(); process.exit(0);
