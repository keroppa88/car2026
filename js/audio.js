/*
 * Procedural car audio built on the Web Audio API — no sound files.
 *
 * Engine: two detuned oscillators using a custom combustion-pulse waveform
 * (rich harmonics) + a sub-octave square, run through a throttle/rev-driven
 * lowpass and two FIXED formant resonances that give the engine a constant
 * "voice" (they don't slide with pitch). RPM-dependent lumpiness makes idle
 * chuggy and high revs smooth, plus band-limited combustion noise. Each gear
 * has its own frequency band; the pitch climbs through the band as the revs
 * rise. The 5th gear intentionally reuses the 4th-gear band so cruising never
 * becomes excessively high-pitched.
 *
 * Tyre screech: looped white noise through two parallel bandpass filters
 * with an LFO wobble — used both for drifting and for hard braking.
 */
function audioModule() {
  // [min Hz, max Hz] per gear index: R, N, 1, 2, 3, 4, 5.
  // 回転数を上げると音階が上がり、ギアを上げると音域ごと上がる。
  // 隣接ギアは「前のギアの真ん中の回転域の音階 = 次のギアの低い回転域の音階」
  // となるよう連鎖させる (fLow[n+1] = fMid[n])。
  //   1: 40-95  (かなり低く)   mid 67.5
  //   2: 67.5-147.5            mid 107.5
  //   3: 107.5-217.5           mid 162.5
  //   4: 162.5-312.5
  //   5: 162.5-312.5 (4速と同じ音域)
  const FREQS = (() => {
    const widths = [55, 80, 110, 150];        // 1速〜4速の音域幅
    let lo = 40;
    const bands = [];
    for (const w of widths) {
      bands.push([lo, lo + w]);
      lo += w / 2;                            // 次のギアは真ん中の音から始まる
    }
    const driveBands = [...bands, [...bands[3]]]; // 5速は4速の音をそのまま使う
    return [bands[0], bands[0], ...driveBands];   // R と N は1速と同じ低い音域
  })();

  let ctx = null;
  let master, engGain, filt, osc1, osc2, oscSub;
  let engNoiseGain, engNoiseFilter, screechGain, bp1, bp2;
  let muted = false;
  let volume = 0.9;          // マスター音量(音楽モードのスライダーから調節)
  let engineMuted = false;   // エンジン系のみ消す(ドリフト音は残す)
  let rpmSmooth = 0;
  let roughPhase = 0;
  let revN = 0;              // free-rev state for neutral
  // ギアごとの重ね音(別トラック)。既存のエンジン音へ重ねて鳴らす。
  // 音量はエンジン音とは別建てで、setGearToneVolume から変えられる。
  // 変調は周波数変調。modDepth が振れ幅(Hz)、modRate が揺れる速さ(Hz)。
  // 添字は player.gear と同じ (0=R 1=N 2=1速 3=2速 4=3速 5=4速 6=5速)。
  // 1速〜5速は、1速(60Hz/±50Hz)から5速(120Hz/±80Hz)まで均等に増やす。
  const DRIVE_GEAR_TONES = (() => {
    const first = { freq: 60, modDepth: 50 };
    const fifth = { freq: 120, modDepth: 80 };
    const tones = {};
    for (let step = 0; step < 5; step++) {
      const ratio = step / 4;
      tones[2 + step] = {
        freq: first.freq + (fifth.freq - first.freq) * ratio,
        wave: 'triangle',
        lpf: 8000,
        modDepth: first.modDepth + (fifth.modDepth - first.modDepth) * ratio,
        modRate: 20,
      };
    }
    return tones;
  })();
  const GEAR_TONES = {
    // N(アイドリング): 40Hzのサイン波を±100Hz・20Hzで揺らし、6025Hzで切る
    1: { freq: 40, wave: 'sine', lpf: 6025, modDepth: 100, modRate: 20 },
    ...DRIVE_GEAR_TONES,
  };
  let toneOsc, toneModOsc, toneModGain, toneFilt, toneGain;
  let gearToneVolume = 0.25;
  let gearToneNow = null;      // 今あてているギア(切り替え時だけ設定し直す)

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    // ----- engine -----
    engGain = ctx.createGain();
    engGain.gain.value = 0;

    // 燃焼パルス列に近いリッチな倍音の波形(単純なのこぎりより自然な唸り)。
    const N = 30, wr = new Float32Array(N), wi = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      let a = 1 / n;
      if (n > 6) a *= Math.pow(0.82, n - 6);   // 高次倍音はさらに減衰
      if (n % 2 === 1) a *= 1.12;               // 奇数倍音をやや強調(荒々しさ)
      wi[n] = a;
    }
    const engWave = ctx.createPeriodicWave(wr, wi);

    filt = ctx.createBiquadFilter();            // スロットル/回転で開く明るさ制御
    filt.type = 'lowpass';
    filt.frequency.value = 500;
    filt.Q.value = 0.8;

    // 固定フォルマント(回転で動かない共鳴)= エンジン固有の「声色」。
    const formant1 = ctx.createBiquadFilter();
    formant1.type = 'peaking';
    formant1.frequency.value = 480; formant1.Q.value = 1.4; formant1.gain.value = 6;
    const formant2 = ctx.createBiquadFilter();
    formant2.type = 'peaking';
    formant2.frequency.value = 1300; formant2.Q.value = 1.1; formant2.gain.value = 4.5;

    osc1 = ctx.createOscillator();
    osc1.setPeriodicWave(engWave);
    osc2 = ctx.createOscillator();
    osc2.setPeriodicWave(engWave);
    osc2.detune.value = 11;              // slight detune = engine roughness
    oscSub = ctx.createOscillator();
    oscSub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.4;

    osc1.connect(filt);
    osc2.connect(filt);
    oscSub.connect(subGain);
    subGain.connect(filt);
    filt.connect(formant1);
    formant1.connect(formant2);
    formant2.connect(engGain);
    engGain.connect(master);
    osc1.start(); osc2.start(); oscSub.start();

    // ----- tyre screech -----
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;

    // 4速・5速では燃焼のザラつきとして、この帯域ノイズを強める。
    engNoiseFilter = ctx.createBiquadFilter();
    engNoiseFilter.type = 'bandpass';
    engNoiseFilter.frequency.value = 260;
    engNoiseFilter.Q.value = 0.7;
    engNoiseGain = ctx.createGain();
    engNoiseGain.gain.value = 0;
    noise.connect(engNoiseFilter);
    engNoiseFilter.connect(engNoiseGain);
    engNoiseGain.connect(master);

    bp1 = ctx.createBiquadFilter();
    bp1.type = 'bandpass';
    bp1.frequency.value = 800;
    bp1.Q.value = 6;
    bp2 = ctx.createBiquadFilter();
    bp2.type = 'bandpass';
    bp2.frequency.value = 1500;
    bp2.Q.value = 9;
    screechGain = ctx.createGain();
    screechGain.gain.value = 0;

    noise.connect(bp1);
    noise.connect(bp2);
    bp1.connect(screechGain);
    bp2.connect(screechGain);
    screechGain.connect(master);
    noise.start();

    // ----- ギアごとの重ね音(別トラック) -----
    toneOsc = ctx.createOscillator();
    toneOsc.type = 'sine';
    toneModOsc = ctx.createOscillator();
    toneModOsc.type = 'sine';
    toneModGain = ctx.createGain();
    toneModOsc.connect(toneModGain);
    toneModGain.connect(toneOsc.frequency);      // 周波数変調
    toneFilt = ctx.createBiquadFilter();
    toneFilt.type = 'lowpass';
    toneGain = ctx.createGain();
    toneGain.gain.value = 0;
    toneOsc.connect(toneFilt);
    toneFilt.connect(toneGain);
    toneGain.connect(master);
    toneOsc.start(); toneModOsc.start();

    // wobble so the screech "sings" instead of hissing statically
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 70;
    lfo.connect(lfoGain);
    lfoGain.connect(bp1.frequency);
    lfo.start();
  }

  // Browsers block audio until a user gesture — call this from input handlers.
  function unlock() {
    if (!ctx) {
      try { init(); } catch (e) { console.warn('WebAudio unavailable:', e); return; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    loadGearSound();
  }

  // ------------------------------------------------------ シフトチェンジ音 ----
  // sound/gear.m4a の頭1秒だけを鳴らす。エンジン音とは別系統で master へ直結する
  // ので、重なって鳴ってよい。ファイルが無い間は何も鳴らさずそのまま走る。
  const GEAR_SOUND_URL = 'sound/gear.m4a';
  const GEAR_SOUND_SECONDS = 1;
  const GEAR_SOUND_VOLUME = 0.2125;   // 0.85 の1/4
  let gearBuffer = null;
  let gearLoading = null;
  let gearLoadFailed = false;
  let gearShiftSounds = 0;

  function loadGearSound() {
    if (!ctx || gearBuffer || gearLoading || gearLoadFailed) return;
    gearLoading = fetch(GEAR_SOUND_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${GEAR_SOUND_URL}`);
        return response.arrayBuffer();
      })
      .then((raw) => ctx.decodeAudioData(raw))
      .then((buffer) => { gearBuffer = buffer; })
      .catch((error) => {
        // 音源は後から用意される。無い間は黙って鳴らさない(毎回試さない)。
        gearLoadFailed = true;
        console.info(`${GEAR_SOUND_URL} が読めないのでシフト音は鳴らしません:`, error.message);
      })
      .finally(() => { gearLoading = null; });
  }

  // シフトアップ/ダウンのたびに呼ぶ。鳴らせた時だけ true。
  function playGearShift() {
    if (!ctx || ctx.state !== 'running' || muted) return false;
    if (!gearBuffer) { loadGearSound(); return false; }
    const t = ctx.currentTime;
    const length = Math.min(GEAR_SOUND_SECONDS, gearBuffer.duration);
    const src = ctx.createBufferSource();
    src.buffer = gearBuffer;
    const gain = ctx.createGain();
    // 1秒で切るので、終わり際だけ短く落としてプツッという切れ目を防ぐ。
    gain.gain.setValueAtTime(GEAR_SOUND_VOLUME, t);
    gain.gain.setValueAtTime(GEAR_SOUND_VOLUME, t + Math.max(0, length - 0.03));
    gain.gain.linearRampToValueAtTime(0, t + length);
    src.connect(gain);
    gain.connect(master);
    src.start(t, 0, length);
    src.onended = () => {
      try { src.disconnect(); gain.disconnect(); } catch (_) { /* 済 */ }
    };
    gearShiftSounds++;
    return true;
  }

  // ---------------------------------------------------- 車内音(mp3ループ) ----
  // HTMLAudioElement の loop=true は MP3 先頭のエンコーダ遅延(この素材は約23ms)を
  // 毎周そのまま鳴らすため、継ぎ目でぶつっと途切れる。ここでは自前でデコードし、
  // 末尾を先頭へ等パワークロスフェードで畳み込んだ「継ぎ目のないバッファ」を作って
  // AudioBufferSourceNode.loop で回す。ループ位置はサンプル単位で連続する。
  // クロスフェード長。0.25秒でも段差は消えるが、0.5秒だと継ぎ目前後の音量差も
  // ほぼ0dBに収まった(freeway1: +3.13dB → -0.09dB)。長すぎると同じ音の重なりが増える。
  const INTERIOR_XFADE_S = 0.5;       // ループ継ぎ目のクロスフェード長
  // 低速/高速を乗り換える時間。この間は2つの音が重なって鳴る。
  const INTERIOR_SWITCH_S = 0.6;
  const interiorBuffers = new Map();  // url -> 加工済み AudioBuffer
  const interiorLoading = new Map();  // url -> Promise (二重ロード防止)
  let interiorVolume = 0.85;
  let interiorNode = null;            // 再生中の { src, gain, url }

  // 末尾 x サンプルを先頭へ重ねて、末尾→先頭が波形として連続するバッファを作る。
  // 出力末尾は src[outLen-1]、出力先頭は src[outLen] になるので元の並びが途切れない。
  function makeSeamlessLoop(buf) {
    const sr = buf.sampleRate;
    const x = Math.min(Math.round(INTERIOR_XFADE_S * sr), Math.floor(buf.length / 4));
    const outLen = buf.length - x;
    if (outLen <= 0) return buf;
    const out = ctx.createBuffer(buf.numberOfChannels, outLen, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      dst.set(src.subarray(0, outLen));
      for (let i = 0; i < x; i++) {
        const t = (i + 0.5) / x;
        dst[i] = src[i] * Math.sin(t * Math.PI / 2)
               + src[outLen + i] * Math.cos(t * Math.PI / 2);
      }
    }
    return out;
  }

  function loadInterior(url) {
    const done = interiorBuffers.get(url);
    if (done) return Promise.resolve(done);
    let p = interiorLoading.get(url);
    if (p) return p;
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.arrayBuffer();
      })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => {
        const looped = makeSeamlessLoop(buf);
        interiorBuffers.set(url, looped);
        interiorLoading.delete(url);
        return looped;
      })
      .catch((e) => { interiorLoading.delete(url); throw e; });
    interiorLoading.set(url, p);
    return p;
  }

  // 初回の切替で待たされないよう、あらかじめデコードしておく。
  function preloadInterior(urls) {
    unlock();
    if (!ctx) return;
    for (const url of urls) loadInterior(url).catch(() => {});
  }

  // 低速↔高速の乗り換えは「等パワークロスフェード」で重ねる。
  // 指数カーブ(0.0001↔音量)で交差させると、中間で両方が -33dB まで落ちて
  // 0.2秒ほど無音の穴があく。sin/cos なら二乗和が常に1で、road noise のような
  // 無相関の2音を重ねても音量が凹まない。
  const XFADE_POINTS = 64;
  function equalPowerCurve(peak, rising) {
    const curve = new Float32Array(XFADE_POINTS);
    for (let i = 0; i < XFADE_POINTS; i++) {
      const phase = (i / (XFADE_POINTS - 1)) * Math.PI / 2;
      curve[i] = peak * (rising ? Math.sin(phase) : Math.cos(phase));
    }
    return curve;
  }

  // 走行中のカーブ予約を安全に打ち切る(音量スライダー等が重なった時用)。
  function cancelGain(param, t) {
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(t);
  }

  function fadeOutInterior(sec, at) {
    const node = interiorNode;
    interiorNode = null;
    if (!node) return;
    const t = at ?? ctx.currentTime;
    const g = node.gain.gain;
    const from = g.value;
    cancelGain(g, t);
    g.setValueCurveAtTime(equalPowerCurve(from, false), t, sec);
    node.src.stop(t + sec + 0.02);
  }

  // 車内音を url のループへ切り替える。既に別の音が鳴っていればクロスフェードする。
  function playInterior(url) {
    unlock();
    if (!ctx) return;
    if (interiorNode && interiorNode.url === url) return;
    loadInterior(url).then((buf) => {
      // 読み込み中に別の音へ切り替わった/停止した場合は捨てる。
      if (!ctx || (interiorNode && interiorNode.url === url)) return;
      // 新旧を同じ時刻から重ねる。片方だけ先に始まると合計音量が波打つ。
      const t = ctx.currentTime;
      fadeOutInterior(INTERIOR_SWITCH_S, t);
      const gain = ctx.createGain();
      gain.gain.value = 0;             // カーブ開始前に鳴らさない
      gain.gain.setValueCurveAtTime(
        equalPowerCurve(interiorVolume, true), t, INTERIOR_SWITCH_S);
      // カーブ終了後の値を固定しておく(以降の音量変更の基準になる)。
      gain.gain.setValueAtTime(interiorVolume, t + INTERIOR_SWITCH_S + 0.001);
      gain.connect(ctx.destination);   // 効果音のmasterとは独立(従来のAudio要素と同じ扱い)
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      src.start();
      interiorNode = { src, gain, url };
    }).catch((e) => console.warn('interior sound failed:', e));
  }

  function stopInterior() {
    if (ctx) fadeOutInterior(0.12);
  }

  // フェードを待たずに車内音を切る(silence() で suspend する時間軸は進まないため)。
  function stopInteriorNow() {
    const node = interiorNode;
    interiorNode = null;
    if (!node) return;
    try { node.src.stop(); } catch (e) { /* 既に停止している */ }
    node.gain.disconnect();
  }

  function setInteriorVolume(v) {
    interiorVolume = Math.max(0, Math.min(1, v));
    if (interiorNode) {
      // 乗り換えのカーブ中に呼ばれても例外にならないよう、先に予約を打ち切る。
      const t = ctx.currentTime;
      cancelGain(interiorNode.gain.gain, t);
      interiorNode.gain.gain.setTargetAtTime(interiorVolume, t, 0.05);
    }
  }

  function interiorPlaying() {
    return interiorNode ? interiorNode.url : '';
  }

  function toggle() {
    muted = !muted;
    if (ctx) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03);
    return !muted;
  }

  // ゲーム効果音(エンジン・スクリーチ等)全体の音量 0..1。
  // ギアごとの重ね音だけの音量。0で消える。
  function setGearToneVolume(v) {
    gearToneVolume = Math.max(0, Math.min(1, v));
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v)) * 0.9;
    if (ctx && !muted) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
  }

  // エンジン音・燃焼ノイズだけを消す。タイヤスクリーチ(ドリフト音)は
  // master 直結のまま残るので、車内音モード・無音モードでも鳴る。
  function setEngineMuted(v) {
    engineMuted = !!v;
  }

  // 鳴っている音を全て止め、次のユーザー操作(unlock)まで無音へ戻す。
  // ページ再読込で音が消えるのと同じ状態を、再読込せずに作る。
  // デモ画面が「ドラッグで鳴り始めたエンジン音」を消すために使う。
  function silence() {
    if (!ctx) return;
    stopInteriorNow();
    const t = ctx.currentTime;
    for (const g of [engGain, engNoiseGain, screechGain, toneGain]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0, t);
    }
    rpmSmooth = 0;
    revN = 0;
    gearToneNow = null;
    if (ctx.state === 'running') ctx.suspend();
  }

  /*
   * s: { gear, rpm (0..1 within the gear), throttle, slip (|lateral m/s|),
   *      drifting, brakeSkid, speed (|forward m/s|) }
   */
  function update(dt, s) {
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const f = FREQS[s.gear] || FREQS[2];

    let rpm;
    if (s.gear === 1) {
      // neutral: nothing drives the wheels, so rev with the pedal
      revN += ((s.throttle ? 1 : 0) - revN) * Math.min(1, dt * (s.throttle ? 1.8 : 2.6));
      rpm = revN;
    } else {
      rpm = Math.min(1, s.rpm + (s.throttle ? 0.06 : 0));
    }
    rpmSmooth += (rpm - rpmSmooth) * Math.min(1, dt * 4);

    const freq = f[0] + (f[1] - f[0]) * rpmSmooth;

    // 燃焼のムラ(ドコドコ感)は全ギア共通。アイドル(低回転)ほど脈動が強く、
    // 高回転ほど滑らかな唸りになる。エンジンらしさの肝。
    const rough = 0.3 + 0.55 * (1 - rpmSmooth);
    roughPhase += dt * (16 + rpmSmooth * 42);   // 約2.5Hz(アイドル)〜9Hz(高回転)
    const wobble = rough * (
      Math.sin(roughPhase) * 0.012 +
      Math.sin(roughPhase * 0.37 + 0.9) * 0.006
    );
    const roughFreq = freq * (1 + wobble);
    osc1.frequency.setTargetAtTime(roughFreq, t, 0.02);
    osc2.frequency.setTargetAtTime(roughFreq * (1 - wobble * 0.4), t, 0.02);
    oscSub.frequency.setTargetAtTime(roughFreq / 2, t, 0.02);

    // 明るさ(倍音)はスロットルと回転で開く: 踏むと硬く鋭く、離すと丸く。
    const bright = 320 + roughFreq * 4 + rpmSmooth * 900 + (s.throttle ? 1500 : 0);
    filt.frequency.setTargetAtTime(bright, t, 0.04);

    // 音量に脈動(ドコドコ)を乗せる。全体を0.8倍(既定がうるさいため20%減)。
    const vol = (0.05 + 0.10 * rpmSmooth + (s.throttle ? 0.05 : 0)) * 0.8;
    const pulse = 1 + rough * (Math.sin(roughPhase) * 0.13 + Math.sin(roughPhase * 0.5) * 0.06);
    engGain.gain.setTargetAtTime(engineMuted ? 0 : Math.max(0, vol * pulse), t, 0.03);

    // 燃焼ノイズ(全ギア。踏むと増え、回転で明るくなる)。エンジン音と同じく20%減。
    const engineNoise = (0.006 + rpmSmooth * 0.02 + (s.throttle ? 0.018 : 0.004)) * 0.8;
    engNoiseGain.gain.setTargetAtTime(engineMuted ? 0 : engineNoise, t, 0.035);
    engNoiseFilter.frequency.setTargetAtTime(200 + roughFreq * 2, t, 0.05);

    // ギアごとの重ね音。設定のあるギアでだけ鳴らし、音量は別建てで持つ。
    const tone = GEAR_TONES[s.gear];
    if (tone && gearToneNow !== s.gear) {
      gearToneNow = s.gear;
      toneOsc.type = tone.wave;
      toneOsc.frequency.setTargetAtTime(tone.freq, t, 0.05);
      toneModOsc.frequency.setTargetAtTime(tone.modRate, t, 0.05);
      toneModGain.gain.setTargetAtTime(tone.modDepth, t, 0.05);
      toneFilt.frequency.setTargetAtTime(tone.lpf, t, 0.05);
    }
    if (!tone) gearToneNow = null;
    toneGain.gain.setTargetAtTime(tone && !engineMuted ? gearToneVolume : 0, t, 0.08);

    // screech: whichever is stronger — drifting or locked-up braking
    const drift = s.drifting ? Math.min(1, Math.max(0, s.slip - 1.5) / 5) : 0;
    const brake = s.brakeSkid ? Math.min(1, s.speed / 22) : 0;
    screechGain.gain.setTargetAtTime(Math.max(drift, brake) * 0.6, t, 0.06);   // 従来の1.5倍
    bp1.frequency.setTargetAtTime(700 + s.slip * 25 + (brake > drift ? 150 : 0), t, 0.1);
  }

  return {
    unlock, toggle, setEngineMuted, setVolume, update, silence, playGearShift,
    setGearToneVolume,
    playInterior, stopInterior, preloadInterior, setInteriorVolume, interiorPlaying,
    bands: FREQS,
    _debug() {
      return ctx ? {
        state: ctx.state,
        freq: osc1.frequency.value,
        engVol: engGain.gain.value,
        screech: screechGain.gain.value,
        interior: interiorPlaying(),
        gearTone: toneGain ? +toneGain.gain.value.toFixed(4) : null,
        gearToneVolume,
        gearToneWave: toneOsc ? toneOsc.type : null,
        gearToneFreq: toneOsc ? +toneOsc.frequency.value.toFixed(1) : null,
        gearToneLpf: toneFilt ? +toneFilt.frequency.value.toFixed(0) : null,
        gearToneModRate: toneModOsc ? +toneModOsc.frequency.value.toFixed(1) : null,
        gearToneModDepth: toneModGain ? +toneModGain.gain.value.toFixed(0) : null,
        gearShiftSounds,
        gearSoundReady: !!gearBuffer,
      } : null;
    },
  };
}

export const AUDIO = audioModule();
