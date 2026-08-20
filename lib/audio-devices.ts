import { getSharedAudioContext } from '@/lib/audio-runtime';
import { isLoopbackCaptureLabel } from '@/lib/studio-participants';
/**
 * 音声デバイスの列挙と判定のユーティリティ。
 *
 * セットアップUIと収録前チェックの両方から使うため、コンポーネントから切り出す。
 */

export interface DeviceOption {
  deviceId: string;
  groupId: string;
  label: string;
  /** 仮想ケーブル系（AI音声の経路に使う候補）か */
  recommended: boolean;
}

export function isVirtualCableLabel(label: string): boolean {
  return /cable|vb-audio|virtual|voicemeeter|blackhole|loopback/i.test(label);
}

export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function toDeviceOption(d: MediaDeviceInfo): DeviceOption {
  return {
    deviceId: d.deviceId,
    groupId: d.groupId,
    label: d.label || `デバイス (${d.deviceId.slice(0, 8)}…)`,
    recommended: isVirtualCableLabel(d.label),
  };
}

/**
 * 仮想ケーブルの「送出先 (playback)」に対応する「監視入力 (capture)」を特定する。
 *
 * - VoiceMeeter: 送出先(Voicemeeter Input)と録音側の名前が対応しない。
 *   本ガイドの配線は Virtual Input → B1 なので、B1 の録音側を監視する。
 * - 一般の仮想ケーブル: "X Input" ⇔ "X Output" のラベル対応。
 * - 最後の手段として groupId 一致。
 */
export function findCableMonitorInput(
  sink: DeviceOption,
  inputs: DeviceOption[]
): DeviceOption | null {
  if (/voicemeeter/i.test(sink.label)) {
    const b1 = inputs.find((d) => normalizeLabel(d.label).includes('voicemeeter out b1'));
    if (b1) return b1;
  }
  const expected = normalizeLabel(sink.label.replace(/\bInput\b/i, 'Output'));
  if (expected !== normalizeLabel(sink.label)) {
    const byLabel = inputs.find((d) => normalizeLabel(d.label) === expected);
    if (byLabel) return byLabel;
  }
  const byGroup = inputs.find((d) => d.groupId && d.groupId === sink.groupId);
  return byGroup ?? null;
}

/**
 * 指定デバイスを一定時間監視し、有意な音声が観測されたかを返す。
 * 収録前チェックの「声が届いているか」判定に使う。
 */
/**
 * 録音側デバイス（例: CABLE Output）に対応する「再生側」デバイスを特定する。
 *
 * ChatGPT の出力先として何を選ばせるべきかを UI に具体名で提示するために使う。
 * 「確認してください」ではなくデバイス名を名指しできるようにするのが目的。
 */
export function findCablePlaybackForCapture(
  capture: DeviceOption,
  outputs: DeviceOption[]
): DeviceOption | null {
  if (capture.label.includes("Output")) {
    const expected = normalizeLabel(capture.label.replace("Output", "Input"));
    const byLabel = outputs.find((d) => normalizeLabel(d.label) === expected);
    if (byLabel) return byLabel;
  }
  const byGroup = outputs.find((d) => d.groupId && d.groupId === capture.groupId);
  return byGroup ?? null;
}

export async function detectSignal(
  deviceId: string,
  durationMs: number,
  threshold = 0.015,
  onProgress?: (level: number, remainingMs: number) => void
): Promise<{ detected: boolean; peak: number; error?: string }> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) return { detected: false, peak: 0, error: "トラックを取得できませんでした" };

    const ctx = getSharedAudioContext();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let peak = 0;
    const started = performance.now();
    // 検出したら即座に打ち切る。利用者を待たせないことと、
    // 反応時間で測定窓を食い潰して誤検出になるのを防ぐため。
    while (performance.now() - started < durationMs) {
      analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      peak = Math.max(peak, rms);
      onProgress?.(rms, Math.max(0, durationMs - (performance.now() - started)));
      if (peak >= threshold) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    src.disconnect();
    analyser.disconnect();
    return { detected: peak >= threshold, peak };
  } catch (e) {
    return {
      detected: false,
      peak: 0,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/* ── 「何を選べばよいか」を名指しするための推定 ──────────────────
 * 収録前チェックが失敗したとき「選んでください」ではなく
 * 「〈このデバイス〉を選んでください」と言えるようにする。
 * 確実に当てられるとは限らないので、見つからなければ呼び出し側が
 * 従来どおりの一般的な説明にフォールバックする。
 */

/** AI 音声ソース（ChatGPT の声の入口）の推奨。定番は CABLE Output */
export function suggestAiSourceInput(inputs: DeviceOption[]): DeviceOption | null {
  const cableOutput = inputs.find((d) => normalizeLabel(d.label).startsWith('cable output'));
  if (cableOutput) return cableOutput;
  // Voicemeeter Out B1 は「こちらの声を ChatGPT へ送る」経路の監視用であり、
  // AI 音声ソースとして選ぶと自分の声を AI の声として録ってしまう。
  return (
    inputs.find(
      (d) => d.recommended && !normalizeLabel(d.label).includes('voicemeeter out b')
    ) ?? null
  );
}

/** 通話マイクの推奨。仮想デバイスでも録音ループバックでもない最初の入力 */
export function suggestPhysicalMicInput(inputs: DeviceOption[]): DeviceOption | null {
  return (
    inputs.find(
      (d) =>
        !isVirtualCableLabel(d.label) &&
        !isLoopbackCaptureLabel(d.label) &&
        !normalizeLabel(d.label).startsWith('default')
    ) ?? null
  );
}

/** ChatGPT への送出先の推奨。定番は Voicemeeter Input */
export function suggestSendSinkOutput(outputs: DeviceOption[]): DeviceOption | null {
  const vm = outputs.find((d) => normalizeLabel(d.label).startsWith('voicemeeter input'));
  if (vm) return vm;
  return outputs.find((d) => d.recommended) ?? null;
}

/* ── テストトーン ────────────────────────────────────────
 * プリフライトの自動化に使う: 仮想ケーブルの再生側 (CABLE Input 等) に鳴らせば、
 * ChatGPT に喋らせなくても「ケーブルの疎通」と「AI 音声経路の自己ループ」を
 * 機械で判定できる。880Hz は FakeProvider と同じ・人の声と混同しない帯域。
 *
 * handle 方式なのは計測との同期のため: setSinkId / play が非同期に終わってから
 * 音が出るので、「開始を await してから測り始め、測り終えてから止める」形に
 * しないと、トーンが鳴る前に計測が終わって偽陰性 (漏れているのに合格) になる
 * (Codex 第2巡 #1)。
 */

export interface ToneProbeHandle {
  /** 音が実際に出始めたか (setSinkId / play の成否)。失敗なら ok=false */
  started: Promise<{ ok: boolean; error?: string }>;
  /** 停止と後片付け。必ず呼ぶこと (finally で) */
  stop: () => void;
}

export function startToneProbe(sinkDeviceId: string, frequency = 880): ToneProbeHandle {
  let el: HTMLAudioElement | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      osc?.stop();
      osc?.disconnect();
      gain?.disconnect();
      dest?.disconnect();
    } catch {
      // ignore
    }
    if (el) {
      el.srcObject = null;
      el.remove();
      el = null;
    }
  };

  const started = (async () => {
    try {
      const ctx = getSharedAudioContext();
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      dest = ctx.createMediaStreamDestination();
      osc = ctx.createOscillator();
      osc.frequency.value = frequency;
      gain = ctx.createGain();
      gain.gain.value = 0.3;
      osc.connect(gain);
      gain.connect(dest);

      // setSinkId が先。失敗時に既定出力へトーンが漏れる要素を作らない
      el = document.createElement('audio');
      await el.setSinkId(sinkDeviceId);
      el.srcObject = dest.stream;
      document.body.appendChild(el);
      osc.start();
      await el.play();
      if (stopped) {
        // 開始前に stop された競合。後片付けだけやり直す
        stopped = false;
        stop();
        return { ok: false, error: 'stopped before start' };
      }
      return { ok: true };
    } catch (e) {
      stop();
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();

  return { started, stop };
}

/** 一定時間鳴らして止める簡易版 (試聴テスト用)。失敗は戻り値で返す */
export async function playToneProbe(
  sinkDeviceId: string,
  durationMs: number,
  frequency = 880
): Promise<{ ok: boolean; error?: string }> {
  const probe = startToneProbe(sinkDeviceId, frequency);
  try {
    const st = await probe.started;
    if (!st.ok) return st;
    await new Promise((r) => setTimeout(r, durationMs));
    return { ok: true };
  } finally {
    probe.stop();
  }
}

/**
 * 指定デバイスの RMS 包絡線 (100ms 刻み) を記録する。
 *
 * 「音が鳴った」だけでは誰の音か分からない。2つのデバイスの包絡線の相関を
 * 取れば「同じ音源か」を判定できる — 送出経路の自動判定で、監視入力に載って
 * いる音が本人のマイクの声なのか、環境音や他人の声なのかを区別するために使う
 * (Codex 第2巡 #7: RMS 閾値だけでの自動設定は誤判定する)。
 */
export async function measureEnvelope(
  deviceId: string,
  durationMs: number,
  onProgress?: (level: number, remainingMs: number) => void
): Promise<{ env: number[]; peak: number; error?: string }> {
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) return { env: [], peak: 0, error: 'トラックを取得できませんでした' };
    return await measureTrackEnvelope(track, durationMs, onProgress);
  } catch (e) {
    return { env: [], peak: 0, error: e instanceof Error ? e.message : String(e) };
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/**
 * 既存の MediaStreamTrack の包絡線を測る。
 *
 * 通話マイクは LiveKit が既に掴んでおり、同じデバイスを getUserMedia で
 * 二重に開くと環境によって NotReadableError になる。失敗経路の分岐を
 * 増やさないため、使用中のトラックはそのまま解析する (track を stop しない)。
 */
export async function measureTrackEnvelope(
  track: MediaStreamTrack,
  durationMs: number,
  onProgress?: (level: number, remainingMs: number) => void
): Promise<{ env: number[]; peak: number; error?: string }> {
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const env: number[] = [];
    let peak = 0;
    const started = performance.now();
    while (performance.now() - started < durationMs) {
      analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      env.push(rms);
      peak = Math.max(peak, rms);
      onProgress?.(rms, Math.max(0, durationMs - (performance.now() - started)));
      await new Promise((r) => setTimeout(r, 100));
    }
    src.disconnect();
    analyser.disconnect();
    return { env, peak };
  } catch (e) {
    return { env: [], peak: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 2本の包絡線のピアソン相関係数 (-1..1)。長さが違えば短い方に合わせ、
 * 監視経路の遅延を吸収するため ±5 サンプル (±500ms) のラグを試して最大を返す。
 */
export function envelopeCorrelation(a: number[], b: number[]): number {
  const corrAt = (x: number[], y: number[]): number => {
    const n = Math.min(x.length, y.length);
    if (n < 5) return 0;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    const mx = sx / n, my = sy / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const vx = x[i] - mx, vy = y[i] - my;
      num += vx * vy; dx += vx * vx; dy += vy * vy;
    }
    if (dx === 0 || dy === 0) return 0;
    return num / Math.sqrt(dx * dy);
  };
  let best = 0;
  for (let lag = -5; lag <= 5; lag++) {
    const x = lag >= 0 ? a.slice(lag) : a;
    const y = lag >= 0 ? b : b.slice(-lag);
    best = Math.max(best, corrAt(x, y));
  }
  return best;
}
