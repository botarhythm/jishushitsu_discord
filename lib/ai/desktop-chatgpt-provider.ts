import type { AiParticipantInfo } from '@/lib/studio-participants';
import { BaseAiProvider } from '@/lib/ai/provider';
import { RmsSpeakingDetector } from '@/lib/ai/speaking-detector';

/**
 * ChatGPT デスクトップ版音声モードを「外部音声参加者」として取り込む Provider。
 *
 * やること（要件§15）:
 *   - 仮想オーディオデバイス（VB-CABLE 等）を getUserMedia で開き、音声ストリームを公開する
 *   - トラック単位 RMS の発話状態を公開する
 * やらないこと:
 *   - ChatGPT の制御 / OpenAI API 呼び出し / 認証情報へのアクセス
 *
 * デバイス消失（track ended）で status: error に遷移する。connect() の再呼び出しで
 * 同一 info.id のまま新トラックを取得する（再接続。要件§26）。
 */
export class DesktopChatGPTProvider extends BaseAiProvider {
  private track: MediaStreamTrack | null = null;
  private detector: RmsSpeakingDetector | null = null;
  private onEnded = () => {
    this.teardownTrack();
    this.setStatus('error');
  };

  constructor(
    readonly info: AiParticipantInfo,
    private readonly getDeviceId: () => string | null
  ) {
    super();
  }

  async connect(): Promise<void> {
    const deviceId = this.getDeviceId();
    if (!deviceId) {
      this.setStatus('error');
      throw new Error('AI音声ソースのデバイスが選択されていません');
    }
    this.setStatus('connecting');
    // 前のトラックが残っていれば破棄（Provider がトラックの唯一のオーナー）
    this.teardownTrack();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          // 仮想ケーブル経由のライン音声なので、ブラウザの音声加工は全て無効化する。
          // 特に AEC はブラウザ再生音（=リモート配信中の AI 音声自身）と相関する信号を
          // 打ち消してしまう恐れがある。
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
    } catch (e) {
      this.setStatus('error');
      throw e;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      this.setStatus('error');
      throw new Error('選択したデバイスから音声トラックを取得できませんでした');
    }
    this.track = track;
    track.addEventListener('ended', this.onEnded);
    this.detector = new RmsSpeakingDetector(track);
    this.detector.start((s) => this.emitSpeaking(s));
    this.setStatus('connected');
  }

  async disconnect(): Promise<void> {
    this.teardownTrack();
    this.setStatus('disconnected');
  }

  getAudioTrack(): MediaStreamTrack | null {
    return this.track;
  }

  private teardownTrack(): void {
    this.detector?.stop();
    this.detector = null;
    if (this.track) {
      this.track.removeEventListener('ended', this.onEnded);
      try {
        this.track.stop();
      } catch {
        // ignore
      }
      this.track = null;
    }
  }
}
