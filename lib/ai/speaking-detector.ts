import { registerAudioContext } from '@/lib/audio-runtime';

/**
 * 音量ベース (RMS) の発話検出。
 *
 * - AnalyserNode で 100ms 間隔に RMS を計算
 * - ヒステリシス: 開始しきい値 > 終了しきい値、終了は holdMs ホールドしてチャタリング防止
 * - 必ず「トラック単位」で使うこと。participant 単位の activeSpeaker 判定は
 *   AI（ホスト名義で publish される）で混線するため使用禁止。
 * - ローカル（Provider のトラック）とリモート（購読した LiveKit トラック）で同一クラスを使う。
 */

export interface SpeakingState {
  isSpeaking: boolean;
  /** RMS 音量 0..1 */
  level: number;
  /** performance.now() 基準のタイムスタンプ */
  timestamp: number;
  /**
   * AudioContext が suspended（autoplay 制限で解析不能）のとき true。
   * 「無音」と区別して報告する — suspended 中の level=0 は発話なしを意味しない。
   */
  suspended: boolean;
}

export interface RmsSpeakingDetectorOptions {
  /** 発話開始しきい値 (RMS) */
  startThreshold?: number;
  /** 発話終了しきい値 (RMS)。startThreshold より小さくする */
  stopThreshold?: number;
  /** 終了判定のホールド時間 (ms) */
  holdMs?: number;
  /** サンプリング間隔 (ms) */
  intervalMs?: number;
}

export class RmsSpeakingDetector {
  private ctx: AudioContext | null = null;
  private unregister: (() => void) | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Float32Array | null = null;
  private isSpeaking = false;
  private belowSince: number | null = null;

  private readonly startThreshold: number;
  private readonly stopThreshold: number;
  private readonly holdMs: number;
  private readonly intervalMs: number;

  constructor(
    private readonly track: MediaStreamTrack,
    opts: RmsSpeakingDetectorOptions = {}
  ) {
    this.startThreshold = opts.startThreshold ?? 0.02;
    this.stopThreshold = opts.stopThreshold ?? 0.01;
    this.holdMs = opts.holdMs ?? 300;
    this.intervalMs = opts.intervalMs ?? 100;
  }

  start(cb: (s: SpeakingState) => void): void {
    if (this.timer) return;
    try {
      this.ctx = new AudioContext();
      this.unregister = registerAudioContext(this.ctx);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.source = this.ctx.createMediaStreamSource(new MediaStream([this.track]));
      this.source.connect(this.analyser);
      // destination には接続しない（解析専用。再生・録音経路に混ざらない）
    } catch (e) {
      console.warn('[RmsSpeakingDetector] AudioContext 初期化失敗', e);
      return;
    }

    this.timer = setInterval(() => {
      if (!this.ctx || !this.analyser || !this.buf) return;
      const now = performance.now();
      if (this.ctx.state !== 'running') {
        cb({ isSpeaking: false, level: 0, timestamp: now, suspended: true });
        return;
      }
      this.analyser.getFloatTimeDomainData(this.buf as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      const rms = Math.sqrt(sum / this.buf.length);

      if (!this.isSpeaking) {
        if (rms >= this.startThreshold) {
          this.isSpeaking = true;
          this.belowSince = null;
        }
      } else {
        if (rms < this.stopThreshold) {
          if (this.belowSince == null) this.belowSince = now;
          else if (now - this.belowSince >= this.holdMs) {
            this.isSpeaking = false;
            this.belowSince = null;
          }
        } else {
          this.belowSince = null;
        }
      }
      cb({ isSpeaking: this.isSpeaking, level: Math.min(1, rms * 4), timestamp: now, suspended: false });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.source?.disconnect();
    } catch {
      // ignore
    }
    this.source = null;
    this.analyser = null;
    this.buf = null;
    this.unregister?.();
    this.unregister = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.isSpeaking = false;
    this.belowSince = null;
  }
}
