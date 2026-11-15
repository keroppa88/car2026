// タイトル → 車 → コース(赤城山・湘南) → スタート地点の画面を写す。node test/start_select_shot.mjs 出力の頭
import { chromium } from 'playwright';
import { startServer } from './lib/harness.mjs';
const s = await startServer();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux/chrome' }).catch(() => chromium.launch());
const out = process.argv[2] || '/tmp/start';
for (const label of ['赤城山', '湘南']) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  await p.goto(s.url); await p.waitForTimeout(2500);
  await p.getByText('Toyota 86').click(); await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
  await p.locator('#course-grid').getByText(label, { exact: true }).click(); await p.waitForTimeout(300);
  await p.keyboard.press('Enter'); await p.waitForTimeout(800);
  await p.screenshot({ path: `${out}_${label}.png` });
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(200); await p.screenshot({ path: `${out}_${label}_2.png` });
  await p.close();
}
await b.close(); s.stop(); process.exit(0);
