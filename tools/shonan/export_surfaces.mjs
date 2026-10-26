// 現在の表示用 JSON から形状を取り出す。元の GLB/OSM は読み込まない。
import fs from 'node:fs';
import { snapshotCitySurfaceLayers } from '../../js/osm-city.js';
const data = JSON.parse(fs.readFileSync(new URL('../../map/shonan-city.json', import.meta.url)));
process.stdout.write(JSON.stringify(snapshotCitySurfaceLayers(data)));
