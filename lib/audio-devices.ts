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

/**
 * 指定の再生デバイスへテストトーンを一定時間流す。
 *
 * プリフライトの自動化に使う: 仮想ケーブルの再生側 (CABLE Input 等) に
 * 鳴らせば、ChatGPT に喋らせなくても「ケーブルの疎通」と「AI 音声経路の
 * 自己ループ」を機械で判定できる (Codex レビュー #9)。
 * 880Hz は FakeProvider と同じ・人の声と混同しない帯域。
 */
export async function playToneProbe(
  sinkDeviceId: string,
  durationMs: number,
  frequency = 880
): Promise<{ ok: boolean; error?: string }> {
  let el: HTMLAudioElement | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
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
    await new Promise((r) => setTimeout(r, durationMs));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
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
    }
  }
}
