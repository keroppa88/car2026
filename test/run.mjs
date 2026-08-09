// 検証プレイを全部まとめて走らせる。
//   node test/run.mjs                    全部
//   node test/run.mjs tokyo sea          指定したものだけ
//   node test/run.mjs --seconds 90       1本あたりの走行時間を変える
// 1本でも不合格なら終了コード1。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = [
  ['demo', 'デモ画面'],
  ['tokyo', '首都高速'],
  ['sea', '海岸線'],
  ['indy', 'インディアナポリス'],
];

const argv = process.argv.slice(2);
const names = argv.filter((a) => !a.startsWith('--') && ALL.some(([k]) => k === a));
const passThrough = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    passThrough.push(argv[i]);
    if (argv[i] !== '--head' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      passThrough.push(argv[++i]);
    }
  }
}
const targets = names.length ? ALL.filter(([k]) => names.includes(k)) : ALL;

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, file), ...passThrough], {
    stdio: 'inherit',
  });
  child.on('close', (code) => resolve(code === 0));
});

const results = [];
for (const [key, label] of targets) {
  console.log(`\n========== ${label} (${key}) ==========`);
  const ok = await run(`${key}.mjs`);
  results.push({ key, label, ok });
}

console.log('\n========== まとめ ==========');
for (const r of results) console.log(`[${r.ok ? ' OK ' : ' NG '}] ${r.label} (${r.key})`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n不合格 ${failed.length} 本` : '\nすべて合格');
process.exit(failed.length ? 1 : 0);
