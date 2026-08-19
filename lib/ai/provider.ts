import type { AiParticipantInfo } from '@/lib/studio-participants';
import type { SpeakingState } from '@/lib/ai/speaking-detector';

/**
 * AI 参加者プロバイダの共通インターフェース（要件§14）。
 *
 * UI / Recorder はこのインターフェースだけを見る。実装（DesktopChatGPTProvider /
 * FakeProvider / 将来の OpenAIRealtimeProvider 等）を import してよいのは
 * provider factory（hooks/useAiParticipant.ts）のみ — これが AC-006
 * 「新Provider追加時に変更されるのは factory とセットアップフォームだけ」の機械的基準。
 *
 * 所有権: Provider が MediaStreamTrack の唯一のオーナー。トラックを stop できるのは
 * Provider だけで、LiveKit unpublish は stopOnUnpublish=false で行うこと。
 */

export type AiProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface AiParticipantProvider {
  /** 表示情報。id は再接続後も不変（要件§26） */
  readonly info: AiParticipantInfo;
  readonly status: AiProviderStatus;

  /** 音声ソースを取得する。再呼び出し（再接続）では同一 info.id のまま新トラックを取得する */
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** 現在の音声トラック（Recorder / LiveKit publish 用）。未接続なら null */
  getAudioTrack(): MediaStreamTrack | null;

  /** status 変化の購読。戻り値は解除関数 */
  onStatusChange(cb: (s: AiProviderStatus) => void): () => void;
  /** 発話状態（トラック単位 RMS）の購読。戻り値は解除関数 */
  onSpeaking(cb: (s: SpeakingState) => void): () => void;
}

/** Provider 実装が共有する購読管理の小さな基底 */
export abstract class BaseAiProvider implements AiParticipantProvider {
  abstract readonly info: AiParticipantInfo;
  protected _status: AiProviderStatus = 'disconnected';
  private statusListeners = new Set<(s: AiProviderStatus) => void>();
  private speakingListeners = new Set<(s: SpeakingState) => void>();

  get status(): AiProviderStatus {
    return this._status;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract getAudioTrack(): MediaStreamTrack | null;

  onStatusChange(cb: (s: AiProviderStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  onSpeaking(cb: (s: SpeakingState) => void): () => void {
    this.speakingListeners.add(cb);
    return () => {
      this.speakingListeners.delete(cb);
    };
  }

  protected setStatus(s: AiProviderStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch {
        // ignore
      }
    }
  }

  protected emitSpeaking(s: SpeakingState): void {
    for (const cb of this.speakingListeners) {
      try {
        cb(s);
      } catch {
        // ignore
      }
    }
  }
}
