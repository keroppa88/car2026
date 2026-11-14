// メニュー画面(車を選んだあとのコース選択)を写す。node test/menu_shot.mjs 出力.png
import { chromium } from 'playwright';
import { startServer } from './lib/harness.mjs';
const s = await startServer();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux/chrome' }).catch(() => chromium.launch());
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto(s.url); await p.waitForTimeout(2500);
await p.getByText('Toyota 86').click(); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
const sel = await p.evaluate(() => { const im = [...document.querySelectorAll('img')].find((i) => i.src.includes('fuji')); if (!im) return null; im.scrollIntoView({ block: 'center' }); return im.closest('button, div')?.textContent?.trim(); }); console.log(sel);
const f = p.locator('img[src*="fuji"]');

await p.waitForTimeout(800);
await p.screenshot({ path: process.argv[2] }); await b.close(); s.stop(); process.exit(0);
