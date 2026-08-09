// 海岸線の検証プレイ。
// この地図は複数のセグメントを縦につないだもの（loopMode: sequence）。
// 見るのは「継ぎ目で自車が止まらないか」「対向車と同方向車が両方いるか」。
// 海岸線は交通量を優先して当たり判定を切ってあるので、衝突は数えない。
import { runCourse, drive, readProbe, readAudio, readDataset, say} from './lib/harness.mjs';

const ok = await runCourse('sea', async ({ page, errors, checker, args }) => {
  const before = await readDataset(page, [
    'seaCpuOncoming', 'seaCpuSameDirection', 'seaCpuRouteMaxGap',
    'mapSegmentCount', 'mapSequenceSeamZs', 'playerCpuCollisionMode',
  ]);

  await drive(page, args.seconds, async (i, n) => {
    const s = await readProbe(page);
    const d = await readDataset(page, ['mapBlockedSurfaceStops', 'mapUnsupportedSeamPasses']);
    say(`  ${i}/${n}  走行=${s.travelMeters.toFixed(0)}m `
      + `止まりかけ=${s.stuckFrames}f 路面ロスト復帰=${d.mapBlockedSurfaceStops ?? 0} `
      + `継ぎ目通過=${d.mapUnsupportedSeamPasses ?? 0}`);
  });

  const p = await readProbe(page);
  const audio = await readAudio(page);
  const after = await readDataset(page, [
    'mapBlockedSurfaceStops', 'mapSeaForwardBridgeUses', 'mapUnsupportedSeamPasses',
    'seaCpuOncoming', 'seaCpuSameDirection',
  ]);

  // ---- 不変条件 ----
  checker.check('コンソールエラーが無い', errors.length === 0,
    errors.length ? errors.slice(0, 3).join(' / ') : '0件');
  checker.check('自車が路外へ落ちない', p.fellOutsideRoad === 0, `${p.fellOutsideRoad}フレーム`);
  checker.check('自車が走り続けている', p.travelMeters > 100,
    `${p.travelMeters.toFixed(0)}m`);
  checker.check('止まりっぱなしにならない', p.stuckFrames < p.frames * 0.5,
    `ほぼ停止 ${p.stuckFrames}/${p.frames}フレーム`);
  checker.check('自車が地面を突き抜けない',
    Number.isFinite(p.playerMinY) && p.playerMinY > -50 && p.playerMaxY < 200,
    `高さ ${p.playerMinY.toFixed(1)}〜${p.playerMaxY.toFixed(1)}m`);
  checker.check('対向車と同方向車が両方いる',
    Number(before.seaCpuOncoming) > 0 && Number(before.seaCpuSameDirection) > 0,
    `対向${before.seaCpuOncoming}台 / 同方向${before.seaCpuSameDirection}台`);
  checker.check('CPU車をすり抜ける設定のまま', before.playerCpuCollisionMode === 'pass',
    `${before.playerCpuCollisionMode}（海岸線は交通量優先ですり抜ける）`);
  checker.check('自動運転では音が1層だけ',
    audio && audio.エンジン音 > 0.001 && audio.燃焼ノイズ === 0 && audio.重ね音 === 0,
    JSON.stringify(audio));

  // ---- 目安 ----
  checker.note('セグメント数', before.mapSegmentCount);
  checker.note('走行ラインの最大すき間', `${before.seaCpuRouteMaxGap}m`);
  checker.note('路面を見失って戻した回数', after.mapBlockedSurfaceStops ?? '0');
  checker.note('無面の継ぎ目を通した回数', after.mapUnsupportedSeamPasses ?? '0');
  checker.note('前方の橋渡しで拾った回数', after.mapSeaForwardBridgeUses ?? '0');
  checker.note('CPU車を見た延べ回数', String(p.cpuSamples));
  checker.note('自車の最高速', `${p.maxKmh.toFixed(0)}km/h`);

  return checker.finish();
});

process.exit(ok ? 0 : 1);
