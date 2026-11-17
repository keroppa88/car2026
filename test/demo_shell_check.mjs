// デモの外枠: マップを選び、そのマップの空・昼夜で走り、決めた時間で次のマップへ移るか。直近のマップを続けて選ばないか
import { chromium } from 'playwright';
import { startServer } from './lib/harness.mjs';
const s = await startServer();
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux/chrome' }).catch(() => chromium.launch());
const p = await b.newPage({ viewport: { width: 640, height: 400 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(`${s.url}/index.html?demoShell=1&demoMapMs=${process.argv[2] || 40000}`);
const seen = [];
for (let k = 0; k < Number(process.argv[3] || 4); k++) {
  const f = await (async () => { for (let t = 0; t < 120; t++) { const fr = p.frames().find((x) => x !== p.mainFrame()); if (fr) { try { if (await fr.evaluate(() => document.body.dataset.demoSequence === 'true')) return fr; } catch {} } await p.waitForTimeout(1000); } return null; })();
  if (!f) { console.log('デモが始まらない'); break; }
  const info = await f.evaluate(() => ({ course: document.body.dataset.course || new URLSearchParams(location.search).get('course'), look: document.body.dataset.demoMapLook, night: document.body.dataset.weatherStarsVisible, cloud: document.body.dataset.weatherCloudMode, rain: document.body.dataset.weatherRain, sky: document.body.dataset.weatherColorCode }));
  seen.push(info.course); console.log(k, info.course, '夜(星)', info.night, '雲', info.cloud, '雨', info.rain, info.look);
  const cur = p.frames().find((x) => x !== p.mainFrame()).url();
  for (let t = 0; t < 200; t++) { await p.waitForTimeout(1000); const u = p.frames().find((x) => x !== p.mainFrame())?.url(); if (u && u !== cur) break; }
}
console.log('出た順', seen.join(' → '), ' 続けて同じ', seen.some((c, i) => i && seen.slice(Math.max(0, i - 5), i).includes(c)), errs.slice(0, 3));
await b.close(); s.stop(); process.exit(0);
