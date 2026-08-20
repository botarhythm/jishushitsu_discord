import { Track } from 'livekit-client';

/**
 * スタジオ（収録）層の Participant 抽象。
 *
 * 収録ステージの出演者スロットは「スロットトークン」（文字列）で表現する:
 *   - 人間: LiveKit identity をそのまま使う（従来と同一 = ワイヤ後方互換）
 *   - AI:   `ai:<aiId>` プレフィックス付き
 *
 * room metadata で配信される slots 配列は従来どおり (string | null)[] のまま。
 * 境界（描画・割当UI）でのみ判別共用体 StudioSlotRef にパースする。
 *
 * 設計原則（要件§32/§35）: `if (participant === "host")` 型の固定分岐は禁止。
 * kind による判別共用体マッチのみ正当。
 */

export const AI_SLOT_PREFIX = 'ai:';
export const AI_AUDIO_TRACK_PREFIX = 'ai-audio:';

/** トークンの上限長。metadata 経由で受け取る値の安全弁（過大入力対策） */
export const MAX_SLOT_TOKEN_LENGTH = 256;

export type StudioSlotToken = string;

export type StudioSlotRef =
  | { kind: 'human'; identity: string }
  | { kind: 'ai'; aiId: string };

/**
 * スロットトークンをパースする。
 * 不正・過大な入力は null（=空きスロット/プレースホルダ扱い）に落とし、
 * 決してクラッシュ・空画面にしない（旧クライアント/不正metadata対策）。
 */
export function parseSlotToken(token: string | null | undefined): StudioSlotRef | null {
  if (typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > MAX_SLOT_TOKEN_LENGTH) return null;
  if (trimmed.startsWith(AI_SLOT_PREFIX)) {
    const aiId = trimmed.slice(AI_SLOT_PREFIX.length);
    if (!aiId) return null;
    return { kind: 'ai', aiId };
  }
  return { kind: 'human', identity: trimmed };
}

export function aiSlotToken(aiId: string): StudioSlotToken {
  return `${AI_SLOT_PREFIX}${aiId}`;
}

export function isAiSlotToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.startsWith(AI_SLOT_PREFIX);
}

/** AI 音声を LiveKit へ publish するときの trackName */
export function aiAudioTrackName(aiId: string): string {
  return `${AI_AUDIO_TRACK_PREFIX}${aiId}`;
}

/**
 * AI 参加者の可視状態。
 * listening は Phase 1 では扱わない（AIはホスト名義で publish されるため
 * participant 単位の activeSpeaker 判定が混線する。track 単位 RMS のみ使用）。
 */
export type AiVisualState = 'idle' | 'speaking' | 'error';

/** AI 参加者の表示情報。id は再接続後も不変（要件§26） */
export interface AiParticipantInfo {
  id: string;
  displayName: string;
  /** プリセットアバター（絵文字） */
  avatar: string;
}

/**
 * room metadata で全参加者に配信する AI 参加者記述子。
 * 受信側は「ownerIdentity が一致する participant の、trackName 完全一致トラック」
 * だけを AI 音声として採用する（track SID は再publishで変わるため使わない）。
 */
export interface StudioAiDescriptor {
  id: string;
  ownerIdentity: string;
  trackName: string;
  displayName: string;
  avatar: string;
  providerKind: 'desktop';
}

/** StudioStage が描画に使う統一ビュー。human/ai をここで正規化する */
export interface AiTileState {
  info: AiParticipantInfo;
  visualState: AiVisualState;
  /** RMS 音量 0..1（speaking アニメーション用） */
  level: number;
}

/**
 * 音声 publication の分類。全 consumer（録画ミキサー / EchoNote / モニタ /
 * ChatGPT入力ミキサー）はこの1関数で判定を共有する。
 *
 * - 'human': マイク音声（人間の声）
 * - 'ai':    AI 参加者音声（trackName プレフィックスで判定）
 * - 'screen': 画面共有音声
 * - 'unknown': 上記以外の Unknown ソース（未分類。新規 consumer は既定で除外すること）
 */
/**
 * ループバック録音デバイス（再生音をそのまま録るもの）か判定する。
 *
 * これをマイクとして使うと、アプリが再生している AI の声・リモート参加者の声を
 * そのまま拾ってしまい、ChatGPT の耳へ送り返してハウリングになる。
 * また自分の声は一切入らない（再生音しか録らないため）。
 */
export function isLoopbackCaptureLabel(label: string): boolean {
  const normalized = label.toLowerCase().split(" ").join("").split("　").join("");
  return ["stereomix", "ステレオミキサー", "whatuhear", "waveout", "loopback"].some((k) =>
    normalized.includes(k)
  );
}

export function classifyAudioPublication(pub: {
  trackName?: string;
  source?: Track.Source;
}): 'human' | 'ai' | 'screen' | 'unknown' {
  if (pub.trackName?.startsWith(AI_AUDIO_TRACK_PREFIX)) return 'ai';
  if (pub.source === Track.Source.Microphone) return 'human';
  if (pub.source === Track.Source.ScreenShareAudio) return 'screen';
  return 'unknown';
}

/** AI 参加者情報の localStorage 永続化キー */
export const AI_PARTICIPANT_STORAGE_KEY = 'jishushitsu.aiParticipant';

/** セットアップUIで永続化する設定 */
export interface AiParticipantConfig {
  displayName: string;
  avatar: string;
  /** AI 音声ソース（CABLE-A Output 等）の audioinput deviceId */
  sourceDeviceId: string | null;
  /** 参考情報: 選択時のデバイスラベル（deviceId 失効検知の説明用） */
  sourceDeviceLabel?: string;
  /** ChatGPT への送出先（CABLE-B Input 等）の audiooutput deviceId。null なら入力ミキサー無効 */
  sinkDeviceId: string | null;
  sinkDeviceLabel?: string;
  /**
   * 自己ループ検査に通った（または手動確認した）ときの配線の指紋。
   * 現在の配線とこれが一致する間は、セットアップを再度通さずワンクリックで起動してよい。
   *
   * 自己ループの危険は「どのデバイスをどう繋いだか」に紐づくので、配線が変わらない限り
   * 再検査は不要。デバイスを変更すると指紋が外れ、再びセットアップ必須に戻る。
   */
  validatedFingerprint?: string | null;
}

export const DEFAULT_AI_CONFIG: AiParticipantConfig = {
  displayName: 'ChatGPT',
  avatar: '🤖',
  sourceDeviceId: null,
  sinkDeviceId: null,
  validatedFingerprint: null,
};

/** 配線（音声ソース + 送出先）の指紋 */
export function aiWiringFingerprint(config: AiParticipantConfig): string {
  return `${config.sourceDeviceId ?? ''}|${config.sinkDeviceId ?? ''}`;
}

/** 保存済みの検証結果が現在の配線に対して有効か */
export function isAiWiringValidated(config: AiParticipantConfig): boolean {
  return (
    !!config.sourceDeviceId &&
    !!config.validatedFingerprint &&
    config.validatedFingerprint === aiWiringFingerprint(config)
  );
}

export const AI_AVATAR_PRESETS = ['🤖', '🧠', '✨', '🎙️', '🦉', '🐬'] as const;

export function loadAiConfig(): AiParticipantConfig {
  if (typeof window === 'undefined') return DEFAULT_AI_CONFIG;
  try {
    const raw = window.localStorage.getItem(AI_PARTICIPANT_STORAGE_KEY);
    if (!raw) return DEFAULT_AI_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AiParticipantConfig>;
    return {
      ...DEFAULT_AI_CONFIG,
      ...parsed,
      displayName:
        typeof parsed.displayName === 'string' && parsed.displayName.trim()
          ? parsed.displayName.trim().slice(0, 32)
          : DEFAULT_AI_CONFIG.displayName,
    };
  } catch {
    return DEFAULT_AI_CONFIG;
  }
}

export function saveAiConfig(config: AiParticipantConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AI_PARTICIPANT_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // localStorage 不可 (プライベートモード等) は永続化を諦めるだけでよい
  }
}
