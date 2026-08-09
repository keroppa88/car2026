// 首都高速の検証プレイ。
// この地図は縦ループ。同じ地図を前後に1周ぶんコピーして継ぎ目をつないでいる。
// ここで見るのは「ループがらみで壊れていないか」。
import {
  runCourse, drive, readProbe, readAudio, readDataset, moveToSeam, say
} from './lib/harness.mjs';

const ok = await runCourse('tokyo', async ({ page, errors, checker, args }) => {
  const info = await readDataset(page, [
    'mapVisualLoopSpanZ', 'mapVisualLoopCopies', 'mapLoopMinZ', 'mapLoopEntryMinZ',
    'tokyoCpuPoolSize',
  ]);
  const spanZ = Number(info.mapVisualLoopSpanZ);
  const 自車ループ周期 = Number(info.mapLoopMinZ) * -1 + Number(info.mapLoopEntryMinZ) * -1;

  // 継ぎ目を何度も通らせる。自動運転のままで一周するには何分もかかるので、
  // 端の手前へ運んでから自然に通過させる。運んだ分は計測から外れる。
  // 端に寄せすぎると走行ラインの外に着地して動けなくなるので 1560m に置く。
  const BLOCK_SECONDS = 15;
  const blocks = Math.max(1, Math.round(args.seconds / BLOCK_SECONDS));
  for (let i = 1; i <= blocks; i++) {
    await moveToSeam(page, 1560);
    await drive(page, BLOCK_SECONDS);
    const s = await readProbe(page);
    say(`  ${i}/${blocks}  ループ通過=${s.loopCount}回 `
      + `CPU延べ=${s.cpuSamples} ずらし有=${s.cpuShifted} 道路から外れ=${s.cpuOffRoadDraw}`);
  }

  const p = await readProbe(page);
  const audio = await readAudio(page);
  const accel = await readDataset(page, [
    'tokyoCpuMaxAccel', 'playerMaxAccelLimit', 'tokyoCpuActiveRanks',
    'tokyoCpuCurrentSpeedsKmh',
  ]);

  // ---- 不変条件（破れたら不合格） ----
  checker.check('コンソールエラーが無い', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' / ') : '0件');
  checker.check('地図コピーが前後に置かれている', Number(info.mapVisualLoopCopies) === 2,
    `${info.mapVisualLoopCopies}枚`);
  checker.check('1周ぶんの距離が揃っている', Math.abs(spanZ - 自車ループ周期) < 0.01,
    `コピー間隔=${spanZ} / 自車のループ周期=${自車ループ周期}`);
  // 「何も起きずに合格」を防ぐ。ループをまたいだ描画が出ていなければ、
  // 下の2つは検査したことにならない。
  checker.check('ループをまたいだ描画を実際に検査した', p.cpuShifted >= 20,
    `${p.cpuShifted}回`);
  checker.check('CPU車が必ず道路の上に描かれる', p.cpuOffRoadDraw === 0,
    p.cpuOffRoadDraw === 0
      ? `ずらして描いた ${p.cpuShifted} 回すべてコピー間隔の整数倍`
      : `${p.cpuOffRoadDraw}件 例: ${JSON.stringify(p.cpuOffRoadExamples)}`);
  checker.check('継ぎ目でCPU車が跳ねない', p.cpuMaxDrawPop <= 5,
    `1フレームの最大移動 ${p.cpuMaxDrawPop.toFixed(2)}m`
    + (p.cpuDrawPops.length ? ` 例: ${JSON.stringify(p.cpuDrawPops.slice(0, 3))}` : ''));
  checker.check('自車が路外へ落ちない', p.fellOutsideRoad === 0, `${p.fellOutsideRoad}フレーム`);
  // CPU車の加速はユーザー車の加速カーブが上限。とくにSは最高速162km/hと
  // コーナー上限(100〜150km/h)の差が大きいので、立ち上がりでここを超えやすい。
  checker.check('CPU車の加速がユーザー車を超えない',
    Number(accel.tokyoCpuMaxAccel) <= Number(accel.playerMaxAccelLimit) + 0.1,
    `CPUの最大 ${accel.tokyoCpuMaxAccel} / ユーザー車の上限 ${accel.playerMaxAccelLimit} m/s2`);
  checker.check('自動運転では音が1層だけ',
    audio && audio.エンジン音 > 0.001 && audio.燃焼ノイズ === 0 && audio.重ね音 === 0,
    JSON.stringify(audio));

  // ---- 目安（参考表示のみ。ここでは合否を出さない） ----
  checker.note('走った距離', `${p.travelMeters.toFixed(0)}m`);
  checker.note('自車のループ通過', `${p.loopCount}回`
    + '（自動運転は遅いので0でも構わない。検査の本命はCPU車の巻き戻し）');
  checker.note('CPU車を見た延べ回数', `${p.cpuSamples} (プール ${info.tokyoCpuPoolSize}台)`);
  checker.note('自車の最高速', `${p.maxKmh.toFixed(0)}km/h`);
  checker.note('最後に見たCPU車', `ランク=${accel.tokyoCpuActiveRanks || '-'} `
    + `速度=${accel.tokyoCpuCurrentSpeedsKmh || '-'}km/h`);
  checker.note('自車の高さ', `${p.playerMinY.toFixed(1)}〜${p.playerMaxY.toFixed(1)}m`);

  return checker.finish();
});

process.exit(ok ? 0 : 1);
