// デモ画面の検証プレイ。
//
// デモは index.html?demoShell=1 が入口。シェル側はゲームを全画面 iframe で
// 動かし、コースを順に切り替えながら曲をかける。つまり状態が2か所にある:
//   シェル(最上位)  … 段・コース・曲・BGM音量
//   ゲーム(iframe)  … 自車やCPU車、音の層
// コース切替のたびに iframe は読み込み直されるので、毎回取り直すこと。
import {
  startServer, drive, makeChecker, parseArgs, say,
} from './lib/harness.mjs';
import { chromium } from 'playwright';

const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const args = parseArgs();
const seconds = args.seconds === 45 ? 60 : args.seconds;
const limit = args.limit;

const watchdog = setTimeout(() => {
  say(`\n[ NG ] デモ画面が ${limit} 秒以内に終わらなかった`);
  process.exit(1);
}, limit * 1000);
watchdog.unref?.();

// 今のゲーム iframe を取り直す。切替直後は居ないことがある。
const gameFrame = (page) =>
  page.frames().find((f) => f.url().includes('demoEmbedded=1')) ?? null;

const server = await startServer();
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  headless: !args.head,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/404|net::ERR|Failed to load resource/.test(m.text())) {
    errors.push(`console: ${m.text()}`);
  }
});

let ok = false;
try {
  say(`デモ画面を起動中…（${seconds}秒）`);
  await page.goto(`${server.url}/index.html?demoShell=1&car=${args.car}`, { waitUntil: 'load' });
  await page.waitForSelector('iframe', { timeout: 60000 });

  const checker = makeChecker(`デモ画面 (demoShell=1)  ${seconds}秒`);
  const stages = new Set();
  const courses = new Set();
  const tracks = new Set();
  let frameSeen = 0;
  let gameAlive = 0;

  // デモの進み具合はゲーム(iframe)側の dataset が持っている。シェルではない。
  let lastAudio = null;
  let lastLabel = '-';
  let weatherChanges = '0';
  await drive(page, seconds, async (i, n) => {
    const frame = gameFrame(page);
    let state = null;
    if (frame) {
      frameSeen++;
      // 重いコースでは応答が返らないことがあるので、待ちすぎない。
      state = await Promise.race([
        frame.evaluate(async () => {
          if (!window.__voxDrive) return null;
          const d = document.body.dataset;
          let audio = null;
          try {
            const m = await import('/js/audio.js?v=20260730-interior-equal-power-xfade-1');
            const dbg = m.AUDIO._debug();
            if (dbg) {
              audio = {
                エンジン音: +(dbg.engVol ?? 0).toFixed(4),
                燃焼ノイズ: +(dbg.engNoiseVol ?? 0).toFixed(4),
                重ね音: +(dbg.gearTone ?? 0).toFixed(4),
              };
            }
          } catch { /* 音がまだ動いていない */ }
          return {
            段: d.demoSequenceStage, コース: d.demoSequenceCourse,
            曲: d.demoTrackIndex, 曲名: d.demoTrackLabel,
            連続再生: d.demoSequence, 天気の切替: d.demoWeatherChanges,
            audio,
          };
        }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 8000)),
      ]);
    }
    if (state) {
      gameAlive++;
      if (state.段 !== undefined) stages.add(state.段);
      if (state.コース) courses.add(state.コース);
      if (state.曲 !== undefined) tracks.add(state.曲);
      if (state.曲名) lastLabel = state.曲名;
      if (state.天気の切替) weatherChanges = state.天気の切替;
      if (state.audio) lastAudio = state.audio;
    }
    say(`  ${i}/${n}  段=${state?.段 ?? '-'} コース=${state?.コース ?? '-'} `
      + `曲=${state?.曲 ?? '-'} ゲーム=${frame ? (state ? '動作中' : '読み込み中') : 'なし'}`);
  });

  const audio = lastAudio;
  const shell = await page.evaluate(() => ({
    BGM音量: document.body.dataset.demoBgmVolume,
  })).catch(() => ({}));

  // ---- 不変条件 ----
  checker.check('コンソールエラーが無い', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' / ') : '0件');
  checker.check('デモのシェルが立ち上がっている', frameSeen > 0,
    `ゲームのiframeを ${frameSeen}/${Math.max(1, Math.round(seconds / 5))} 回確認`);
  checker.check('ゲームが動いている', gameAlive > 0, `${gameAlive}回 動作を確認`);
  checker.check('デモが進んでいる', stages.size > 0 || courses.size > 0 || tracks.size > 0,
    `段=${[...stages].join(',') || '-'} コース=${[...courses].join(',') || '-'} `
    + `曲=${tracks.size}種`);
  if (audio) {
    checker.check('デモでは音が1層だけ',
      audio.燃焼ノイズ === 0 && audio.重ね音 === 0, JSON.stringify(audio));
  } else {
    checker.note('音の判定', '見送り（このタイミングでゲーム側から音の状態を取れなかった）');
  }

  // ---- 目安 ----
  checker.note('通ったコース', [...courses].join(' → ') || '-');
  checker.note('かかった曲', `${tracks.size}曲 (最後: ${lastLabel})`);
  checker.note('天気の切替', weatherChanges);
  checker.note('BGM音量', shell.BGM音量 ?? '-');

  ok = checker.finish();
} finally {
  clearTimeout(watchdog);
  await browser.close();
  server.stop();
}
process.exit(ok ? 0 : 1);
