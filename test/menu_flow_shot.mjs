// タイトル → 車 → 分野(Cruising / Driving / Others) → コース を写す。マウスを重ねたときの紹介文も。node test/menu_flow_shot.mjs 出力の頭
import { chromium } from 'playwright';
import { startServer } from './lib/harness.mjs';
const s = await startServer();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux/chrome' }).catch(() => chromium.launch());
const out = process.argv[2] || '/tmp/menu';
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(s.url); await p.waitForTimeout(2500);
await p.getByText('Toyota 86').click(); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
await p.screenshot({ path: `${out}_group.png` });
for (const [i, g] of ['cruising', 'driving', 'others'].entries()) {
  await p.locator(`#group-grid [data-key="${g}"]`).click(); await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  await p.locator('#course-grid .select-card').nth(1).hover(); await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}_${g}.png` });
  console.log(g, await p.evaluate(() => [...document.querySelectorAll('#course-grid .select-card')].map((c) => c.querySelector('strong').textContent + '(' + (c.querySelector('.select-desc')?.textContent || '') + ')').join(' / ')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
}
// Driving → 赤城山 → 開始位置 → 始める
await p.locator('#group-grid [data-key="driving"]').click(); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
await p.locator('#course-grid [data-key="akagi"]').click(); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
await p.keyboard.press('Enter'); await p.waitForTimeout(1500); console.log('開いたURL', p.url(), errs);
await b.close(); s.stop(); process.exit(0);
