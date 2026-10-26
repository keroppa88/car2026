import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './lib/harness.mjs';
const server=await startServer();let browser;
try {
  browser=await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:320,height:200}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(server.url+'/')?r.continue():r.abort());
  await page.goto(server.url+'/index.html?course=shonan&car=toyota86',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__voxDrive&&document.body.dataset.shonanSurfaceMode==='native-partition',null,{timeout:180000});
  const result=await page.evaluate(()=>({
    source:document.body.dataset.mapSource,roads:Number(document.body.dataset.osmRoads),
    buildings:Number(document.body.dataset.osmBuildings),
    starts:[[9860.65,822.78],[-3713.13,-1067.66],[-9019.21,-75.47]].map(p=>window.__osmCity.isBlocked(...p)),
    removed:window.__osmCity.isBlocked(6800,600),
    beach:window.__osmCity.isSand(6200,400),beachOpen:!window.__osmCity.isBlocked(6200,400),
    concreteSand:window.__osmCity.isSand(5809.06,435.75),
    pinkOpen:!window.__osmCity.isBlocked(6219.74,261.405)
  }));
  const city=JSON.parse(fs.readFileSync(new URL('../map/shonan-city.json',import.meta.url)));
  assert.equal(result.source,'native-surfaces');assert.equal(result.roads,city.roads.length);
  assert.equal(result.buildings,city.buildings.length);assert.ok(result.starts.every(v=>!v));
  assert.ok(result.removed&&result.beach&&result.beachOpen&&result.pinkOpen);assert.equal(result.concreteSand,false);
  await page.keyboard.press('Enter');await page.keyboard.down('s');
  await page.waitForTimeout(4000);await page.keyboard.up('s');
  const pos=await page.evaluate(()=>window.__voxDrive.player.pos.toArray());assert.ok(pos[1]>-1);
  assert.deepEqual(errors,[]);console.log('PASS 江の島ブラウザ検証',result,pos);
} finally {await browser?.close();server.stop();}
