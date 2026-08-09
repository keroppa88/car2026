// インディアナポリスの検証プレイ。
// ここだけ周回コース（走行ラインが輪）。CPU車はバンク（傾いた路面）に
// 車体を貼り付けて走るので、そこを見失うと空中に浮いたり落ちたりする。
// 周回なので端の巻き戻しは無く、代わりに「ラップが進むか」を見る。
import { runCourse, drive, readProbe, readAudio, readDataset, say} from './lib/harness.mjs';

const ok = await runCourse('indy', async ({ page, errors, checker, args }) => {
  const before = await readDataset(page, [
    'indyCpuCount', 'indyCpuRanks', 'indyCpuRoutePoints', 'indyCpuLane',
    'streetLightCount', 'indyStreetLightInsideRoadCount',
  ]);

  await drive(page, args.seconds, async (i, n) => {
    const s = await readProbe(page);
    const d = await readDataset(page, [
      'indyCpuLapDistanceMeters', 'indyCpuBankSurfaceMissesNow',
      'indyCpuMaxBankTiltDeg', 'indyBankSeamPasses',
    ]);
    say(`  ${i}/${n}  走行=${s.travelMeters.toFixed(0)}m `
      + `CPU周回距離=${d.indyCpuLapDistanceMeters ?? '-'} `
      + `バンク見失い=${d.indyCpuBankSurfaceMissesNow ?? 0} `
      + `最大バンク傾き=${d.indyCpuMaxBankTiltDeg ?? '-'}度`);
  });

  const p = await readProbe(page);
  const audio = await readAudio(page);
  const after = await readDataset(page, [
    'indyCpuBankSurfaceMissesNow', 'indyCpuBankFallbackFrames', 'indyCpuRecoveries',
    'indyCpuMinActualSpeedKmh', 'indyCpuMaxBankTiltDeg', 'indyBankSeamPasses',
  ]);

  // ---- 不変条件 ----
  checker.check('コンソールエラーが無い', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' / ') : '0件');
  checker.check('自車が路外へ落ちない', p.fellOutsideRoad === 0, `${p.fellOutsideRoad}フレーム`);
  checker.check('自車が走り続けている', p.travelMeters > 100, `${p.travelMeters.toFixed(0)}m`);
  checker.check('止まりっぱなしにならない', p.stuckFrames < p.frames * 0.5,
    `ほぼ停止 ${p.stuckFrames}/${p.frames}フレーム`);
  checker.check('自車が地面を突き抜けない',
    Number.isFinite(p.playerMinY) && p.playerMinY > -50 && p.playerMaxY < 200,
    `高さ ${p.playerMinY.toFixed(1)}〜${p.playerMaxY.toFixed(1)}m`);
  checker.check('CPU車が出ている', Number(before.indyCpuCount) > 0, `${before.indyCpuCount}台`);
  checker.check('CPU車が止まっていない', Number(after.indyCpuMinActualSpeedKmh) > 5,
    `いちばん遅い車 ${after.indyCpuMinActualSpeedKmh}km/h`);
  checker.check('CPU車がバンクを見失っていない',
    Number(after.indyCpuBankSurfaceMissesNow || 0) === 0,
    `見失い ${after.indyCpuBankSurfaceMissesNow ?? 0}台`);
  // 周回コースなので走行ラインは輪。端で座標を書き換える処理が無いことを、
  // ずらして描いた回数が0であることで確かめる（縦ループの地図ではない）。
  checker.check('縦ループのずらしが入っていない', p.cpuShifted === 0,
    `${p.cpuShifted}回`);
  checker.check('自動運転では音が1層だけ',
    audio && audio.エンジン音 > 0.001 && audio.燃焼ノイズ === 0 && audio.重ね音 === 0,
    JSON.stringify(audio));

  // ---- 目安 ----
  checker.note('CPUのランク構成', before.indyCpuRanks ?? '-');
  checker.note('走行ラインの点数', before.indyCpuRoutePoints ?? '-');
  checker.note('バンクの最大傾き', `${after.indyCpuMaxBankTiltDeg ?? '-'}度`);
  checker.note('バンク継ぎ目の通過', after.indyBankSeamPasses ?? '0');
  checker.note('CPUの復帰処理', after.indyCpuRecoveries ?? '0');
  checker.note('街灯', `${before.streetLightCount ?? '-'}基`
    + `（うち路面内 ${before.indyStreetLightInsideRoadCount ?? '-'}）`);
  checker.note('自車の最高速', `${p.maxKmh.toFixed(0)}km/h`);

  return checker.finish();
});

process.exit(ok ? 0 : 1);
