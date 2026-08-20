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
export async function detectSignal(
  deviceId: string,
  durationMs: number,
  threshold = 0.02
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
    if (!track) return { detected: false, peak: 0, error: 'トラックを取得できませんでした' };

    const ctx = new AudioContext();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let peak = 0;
    const started = performance.now();
    while (performance.now() - started < durationMs) {
      analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      peak = Math.max(peak, Math.sqrt(sum / buf.length));
      await new Promise((r) => setTimeout(r, 100));
    }
    src.disconnect();
    await ctx.close().catch(() => {});
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
