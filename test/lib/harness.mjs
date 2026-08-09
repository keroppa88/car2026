// 検証プレイの共通部分。
// ローカルサーバを立て、ブラウザでコースを開き、自動運転で走らせながら
// 毎フレーム状態を記録する。コース別のスクリプトはここを使って
// 「何を合格とするか」だけを書く。
//
// 使い方:
//   node test/tokyo.mjs            首都高速だけ
//   node test/run.mjs              全コース
//   node test/tokyo.mjs --seconds 120 --head   長めに / 画面を出して
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

export const COURSES = {
  tokyo: '首都高速',
  sea: '海岸線',
  forest: '森林地帯',
  indy: 'インディアナポリス',
};

// ---------------------------------------------------------------- 引数 ---
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { seconds: 45, head: false, car: 'toyota86', limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
    else if (argv[i] === '--head') args.head = true;
    else if (argv[i] === '--car') args.car = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);   // 全体の制限時間(秒)
  }
  // 地図の読み込みに時間がかかるコースがあるので、走行時間の倍＋余裕を既定にする。
  if (!args.limit) args.limit = args.seconds * 2 + 240;
  return args;
}

// 途中経過をその場で出す。パイプへ流すと溜め込まれて、進んでいるのか
// 止まっているのか分からなくなるため。
export function say(line) {
  try { fs.writeSync(1, `${line}\n`); } catch { console.log(line); }
}

// -------------------------------------------------------------- サーバ ---
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// リポジトリ直下を配信する。cwd の持ち越しで別の場所を配信してしまう事故が
// あったので、必ず REPO_ROOT を明示して起動する。
export async function startServer() {
  const port = await freePort();
  const child = spawn('python3', ['-m', 'http.server', String(port)], {
    cwd: REPO_ROOT, stdio: 'ignore', detached: true,
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${url}/index.html`);
      if (res.ok) break;
    } catch { /* まだ起動していない */ }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`ローカルサーバが起動しない (${url})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { url, stop: () => { try { process.kill(-child.pid); } catch { child.kill(); } } };
}

// ---------------------------------------------------------- ゲーム起動 ---
// 木や建物が多いコースはヘッドレスの描画がとても重い。画面を小さくすると
// 描く画素が減って進むようになる。判定に使うのは座標と数値なので、
// 画面の大きさは結果に影響しない。
const VIEWPORT = {
  forest: { width: 320, height: 200 },
  default: { width: 900, height: 600 },
};

export async function openCourse(server, { course, car = 'toyota86', head = false }) {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !head,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const viewport = head ? VIEWPORT.default : (VIEWPORT[course] ?? VIEWPORT.default);
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // 音源や外部配信の404はゲームの不具合ではないので数えない。
    if (m.type() === 'error' && !/404|net::ERR|Failed to load resource/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
    }
  });
  await page.goto(`${server.url}/index.html?car=${car}&course=${course}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__voxDrive, null, { timeout: 300000 });
  await page.keyboard.press('Enter');          // タイトルから走行へ
  await page.waitForTimeout(1200);
  return { browser, page, errors };
}

// 自動運転に入る。入れなければ手動で全開にして走らせる。
export async function startDriving(page) {
  await page.keyboard.press('y');
  await page.waitForTimeout(600);
  const auto = await page.evaluate(() => document.body.dataset.autoDrive === 'true');
  if (!auto) {
    await page.keyboard.down('s');
    for (let g = 0; g < 4; g++) {
      await page.waitForTimeout(1500);
      await page.keyboard.press('ArrowUp');
    }
  }
  return auto ? '自動運転' : '手動全開';
}

// ------------------------------------------------------------ 毎フレーム ---
// 走行中ずっと状態を集める。コース共通で取れるものだけをここで見る。
export async function installProbe(page) {
  await page.evaluate(() => {
    const span = Number(document.body.dataset.mapVisualLoopSpanZ || 0);
    const p = {
      frames: 0, spanZ: span,
      playerMinY: Infinity, playerMaxY: -Infinity, travelMeters: 0, maxKmh: 0,
      stuckFrames: 0,                 // ほぼ止まっているフレーム数
      loopCount: 0,
      cpuSamples: 0, cpuShifted: 0, cpuOffRoadDraw: 0, cpuOffRoadExamples: [],
      cpuMaxDrawPop: 0, cpuDrawPops: [],
      fellOutsideRoad: 0,
    };
    window.__probe = p;
    // テスト側が自車を運ぶ直前に呼ぶ。運んだ分の見かけの移動を計測から外す。
    p.skipUntilFrame = -1;
    window.__probeSkip = (n = 4) => { p.skipUntilFrame = p.frames + n; };
    const prevDraw = new Map();
    let prevPos = null;
    const tick = () => {
      const { player, aiCars } = window.__voxDrive;
      p.frames++;
      const skipping = p.frames <= p.skipUntilFrame;
      p.loopCount = Number(document.body.dataset.mapLoopCount || 0);
      if (document.body.dataset.playerFallingOutsideRoad === 'true') p.fellOutsideRoad++;

      p.playerMinY = Math.min(p.playerMinY, player.pos.y);
      p.playerMaxY = Math.max(p.playerMaxY, player.pos.y);
      const kmh = player.vel.length() * 3.6;
      p.maxKmh = Math.max(p.maxKmh, kmh);
      if (kmh < 3) p.stuckFrames++;
      if (prevPos && !skipping) {
        const step = Math.hypot(player.pos.x - prevPos.x, player.pos.z - prevPos.z);
        if (step < 200) p.travelMeters += step;      // ループの飛びは距離に数えない
      }
      prevPos = { x: player.pos.x, z: player.pos.z };

      for (const ai of aiCars) {
        if (ai.appearManaged && !ai.active) { prevDraw.delete(ai.group.uuid); continue; }
        if (!ai.group.visible) { prevDraw.delete(ai.group.uuid); continue; }
        p.cpuSamples++;
        const shift = ai.group.position.z - ai.pos.z;
        if (span > 0 && Math.abs(shift) > 0.01) {
          p.cpuShifted++;
          // ずらす量は必ず地図コピー間隔の整数倍。半端だとコピーの道路から
          // 外れた場所(壁の中や空中)に描かれる。
          const err = shift - Math.round(shift / span) * span;
          if (Math.abs(err) > 0.5) {
            p.cpuOffRoadDraw++;
            if (p.cpuOffRoadExamples.length < 5) {
              p.cpuOffRoadExamples.push({ ずらし量: +shift.toFixed(1), ずれ: +err.toFixed(1) });
            }
          }
        }
        // 見かけの前後位置が1フレームでどれだけ動くか(継ぎ目の跳ね)
        const rel = ai.group.position.z - player.pos.z;
        const before = prevDraw.get(ai.group.uuid);
        if (before !== undefined && !skipping) {
          const move = Math.abs(rel - before);
          if (move < 2000) {                    // 出現/引き上げの瞬間移動は除く
            p.cpuMaxDrawPop = Math.max(p.cpuMaxDrawPop, move);
            if (move > 5 && p.cpuDrawPops.length < 10) {
              p.cpuDrawPops.push({ 飛び: +move.toFixed(1), 前: +before.toFixed(0), 後: +rel.toFixed(0) });
            }
          }
        }
        prevDraw.set(ai.group.uuid, rel);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export const readProbe = (page) => page.evaluate(() => window.__probe);

// 画面が動いているか。重すぎるコースではページが応答を返せず、こちらからの
// 問い合わせが何分も返ってこない。走行の検査に入る前にこれで見切りをつける。
export async function isResponsive(page, ms = 12000) {
  try {
    await Promise.race([
      page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(1)))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), ms)),
    ]);
    return true;
  } catch {
    return false;
  }
}

// 走行中の音の層。自動運転では1層目だけが鳴る決まり。
export const readAudio = (page) => page.evaluate(async () => {
  const m = await import('/js/audio.js?v=20260730-interior-equal-power-xfade-1');
  const d = m.AUDIO._debug();
  return d ? {
    エンジン音: +(d.engVol ?? 0).toFixed(4),
    燃焼ノイズ: +(d.engNoiseVol ?? 0).toFixed(4),
    重ね音: +(d.gearTone ?? 0).toFixed(4),
  } : null;
});

export const readDataset = (page, keys) => page.evaluate((ks) => {
  const out = {};
  for (const k of ks) out[k] = document.body.dataset[k];
  return out;
}, keys);

// ---------------------------------------------------------------- 判定 ---
export function makeChecker(courseLabel) {
  const rows = [];
  return {
    // ok が false なら不合格。detail は数値など、判断の根拠を必ず残す。
    check(name, ok, detail) { rows.push({ name, ok: !!ok, detail }); return !!ok; },
    note(name, detail) { rows.push({ name, ok: null, detail }); },
    finish() {
      const failed = rows.filter((r) => r.ok === false);
      console.log(`\n=== ${courseLabel} ===`);
      for (const r of rows) {
        const mark = r.ok === null ? '    ' : (r.ok ? ' OK ' : ' NG ');
        console.log(`[${mark}] ${r.name.padEnd(34)} ${r.detail ?? ''}`);
      }
      console.log(failed.length ? `\n不合格 ${failed.length} 件` : '\nすべて合格');
      return failed.length === 0;
    },
  };
}

// コース別スクリプトの決まり文句をまとめたもの。
// play(ctx) の中でコース固有の操作と判定を書く。
// opts.autoStart を false にすると、走り出しと毎フレーム記録の準備を
// 呼び出し側に任せる。重いコースで「走らせるかどうか」を先に決めたいとき用。
export async function runCourse(course, play, opts = {}) {
  const args = parseArgs();
  // 制限時間を過ぎたら落とす。ぶら下がったままだと、進んでいるのか
  // 壊れているのか分からず、待つだけ時間を失う。
  const watchdog = setTimeout(() => {
    say(`\n[ NG ] ${COURSES[course]} (${course}) が ${args.limit} 秒以内に終わらなかった`);
    process.exit(1);
  }, args.limit * 1000);
  watchdog.unref?.();

  say(`${COURSES[course]} (${course}) を起動中…（地図の読み込みに時間がかかることがある）`);
  const server = await startServer();
  let ok = false;
  let session;
  try {
    const t0 = Date.now();
    session = await openCourse(server, { course, car: args.car, head: args.head });
    say(`  地図の読み込み完了 ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
    let mode = '未走行';
    if (opts.autoStart !== false) {
      mode = await startDriving(session.page);
      await installProbe(session.page);
    }
    const checker = makeChecker(`${COURSES[course]} (${course})  ${mode} ${args.seconds}秒`);
    ok = await play({ ...session, checker, args, course, server, mode });
  } finally {
    clearTimeout(watchdog);
    if (session?.browser) await session.browser.close();
    server.stop();
  }
  return ok;
}

// 自車を継ぎ目の手前へ運ぶ。運んだ分は計測から外す。
// 端から少し手前に置き、そこから自然に通過させる（瞬間移動で通過させない）。
export const moveToSeam = (page, z) => page.evaluate((edgeZ) => {
  const p = window.__voxDrive.player;
  window.__probeSkip(6);
  p.pos.z = p.vel.z < 0 ? -edgeZ : edgeZ;
}, z);

// 走らせながら経過を出す。長い待ちの間に無反応にならないように。
export async function drive(page, seconds, onTick) {
  const steps = Math.max(1, Math.round(seconds / 5));
  for (let i = 0; i < steps; i++) {
    await page.waitForTimeout(Math.min(5000, seconds * 1000 / steps));
    if (onTick) await onTick(i + 1, steps);
  }
}
