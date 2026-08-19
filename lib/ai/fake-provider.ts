import type { AiParticipantInfo } from '@/lib/studio-participants';
import { BaseAiProvider } from '@/lib/ai/provider';
import { RmsSpeakingDetector } from '@/lib/ai/speaking-detector';
import { registerAudioContext } from '@/lib/audio-runtime';

/**
 * テスト用の AI Provider（AC-006 の契約テスト手段）。
 *
 * OscillatorNode で 880Hz のトーンを周期的に鳴らす音声トラックを生成する。
 * ChatGPT / 仮想オーディオデバイスなしで、UI・registry・録画・publish の
 * 結合検証（speaking 遷移、再接続、AC-001 の周波数分離テスト）ができる。
 */
export class FakeAiProvider extends BaseAiProvider {
  private ctx: AudioContext | null = null;
  private unregister: (() => void) | null = null;
  private track: MediaStreamTrack | null = null;
  private detector: RmsSpeakingDetector | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly info: AiParticipantInfo,
    /** トーン周波数 (Hz)。AC-001 の周波数分離テストで参加者ごとに変える */
    private readonly frequency = 880,
    /** 発話パルス: onMs 鳴って offMs 黙る */
    private readonly onMs = 2000,
    private readonly offMs = 2000
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    await this.disconnectInternals();
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.unregister = registerAudioContext(ctx);
      const osc = ctx.createOscillator();
      osc.frequency.value = this.frequency;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain);
      gain.connect(dest);
      osc.start();

      // onMs 鳴って offMs 黙るパルスを自己再スケジュールで刻む
      let on = false;
      const pulse = () => {
        on = !on;
        gain.gain.setTargetAtTime(on ? 0.25 : 0, ctx.currentTime, 0.05);
        this.pulseTimer = setTimeout(pulse, on ? this.onMs : this.offMs);
      };
      pulse();

      const track = dest.stream.getAudioTracks()[0];
      if (!track) throw new Error('FakeAiProvider: トラック生成に失敗');
      this.track = track;
      this.detector = new RmsSpeakingDetector(track);
      this.detector.start((s) => this.emitSpeaking(s));
      this.setStatus('connected');
    } catch (e) {
      this.setStatus('error');
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    await this.disconnectInternals();
    this.setStatus('disconnected');
  }

  getAudioTrack(): MediaStreamTrack | null {
    return this.track;
  }

  private async disconnectInternals(): Promise<void> {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.detector?.stop();
    this.detector = null;
    if (this.track) {
      try {
        this.track.stop();
      } catch {
        // ignore
      }
      this.track = null;
    }
    this.unregister?.();
    this.unregister = null;
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
