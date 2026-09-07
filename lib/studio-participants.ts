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
  /**
   * RMS 音量 0..1（speaking アニメーション用）を読み出す。
   *
   * 値そのものではなく getter で渡す。RMS は 100ms 間隔で更新されるため、
   * state として持つと AI が居るだけで画面全体が毎秒10回再レンダリングされ、
   * 収録中のメインスレッドを圧迫して音声の取りこぼしを招く。
   * 描画ループ（AiEnergyOrb）から直接引く。
   */
  getLevel: () => number;
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
   * あなたの声をアプリから ChatGPT へ送るか。
   *
   * false にすると、アプリはリモート参加者の声だけを送る。物理マイクを
   * VoiceMeeter 側で常時 B1 に流している構成では false にする
   * （両方送ると ChatGPT にあなたの声が二重に届く）。
   * false 側の利点は、アプリを起動していなくても他の通話アプリが
   * 普通にマイクを使えること。
   */
  sendLocalMic?: boolean;
  /**
   * AI の声をアプリがヘッドホンへ再生するか。
   *
   * false にすると再生しない。Windows の「このデバイスを聴く」で常時モニタして
   * いる構成では false にする（両方鳴らすと二重に聞こえる）。
   * false 側の利点は、アプリを起動していなくても ChatGPT の声が聞こえること
   * ＝ ChatGPT を普段どおり単体で使える。代償はモニタ音の遅延。
   */
  monitorAiLocally?: boolean;
  /**
   * 自己ループ検査に通った（または手動確認した）ときの配線の指紋。
   * 現在の配線とこれが一致する間は、セットアップを再度通さずワンクリックで起動してよい。
   *
   * 自己ループの危険は「どのデバイスをどう繋いだか」に紐づくので、配線が変わらない限り
   * 再検査は不要。デバイスを変更すると指紋が外れ、再びセットアップ必須に戻る。
   */
  validatedFingerprint?: string | null;
  /** 全参加者向けv4検証。確認段階を分離し、旧記録ではワンクリック開始を許可しない。 */
  validation?: {
    schemaVersion: 4;
    fingerprint: string;
    callMicDeviceId: string | null;
    browserWiringConfirmedAt: string;
    selfLoopConfirmedAt: string;
    remoteRoundtripAt: string;
  } | null;
}

export const DEFAULT_AI_CONFIG: AiParticipantConfig = {
  displayName: 'ChatGPT',
  avatar: '🤖',
  sourceDeviceId: null,
  sinkDeviceId: null,
  sendLocalMic: true,
  monitorAiLocally: true,
  validatedFingerprint: null,
  validation: null,
};

/** 配線（音声ソース + 送出先）の指紋 */
export function aiWiringFingerprint(config: AiParticipantConfig): string {
  return `${config.sourceDeviceId ?? ''}|${config.sinkDeviceId ?? ''}|${config.sendLocalMic !== false ? 'app-mic' : 'direct-mic'}`;
}

/** 保存済みの検証結果が現在の配線に対して有効か */
export function isAiWiringValidated(
  config: AiParticipantConfig,
  currentCallMicDeviceId?: string | null
): boolean {
  return (
    !!config.sourceDeviceId &&
    !!config.sinkDeviceId &&
    !!config.validation &&
    config.validation.schemaVersion === 4 &&
    !!config.validation.browserWiringConfirmedAt &&
    !!config.validation.selfLoopConfirmedAt &&
    !!config.validation.remoteRoundtripAt &&
    config.validation.fingerprint === aiWiringFingerprint(config) &&
    (currentCallMicDeviceId === undefined ||
      config.validation.callMicDeviceId === currentCallMicDeviceId)
  );
}

export const AI_AVATAR_PRESETS = ['🤖', '🧠', '✨', '🎙️', '🦉', '🐬'] as const;

/* ── 永続化 (v2) ──────────────────────────────────────────
 *
 * v1 (キー jishushitsu.aiParticipant) は config を素の JSON で保存しており、
 * ①スキーマ版数が無く、後から追加した真偽値フィールドが「無い＝既定値 true」に
 * 化ける ②UI が古いスナップショット全体を保存すると他フィールドが巻き戻る、
 * という2つの欠陥で設定消失を起こした (2026-08-20 実機で再現、Codex レビュー #3)。
 *
 * v2 は {schemaVersion, updatedAt, config} の封筒に入れ、キー自体を変える。
 * 旧ビルドのタブは v2 キーを知らないため、並走しても v2 を上書きできない。
 * 書き込みは patchAiConfig() の「最新値を読み直してから patch だけ重ねる」
 * 経路に一本化し、スナップショット全体保存を廃止する。
 */

const STORAGE_KEY_V2 = 'jishushitsu.aiParticipant.v2';

interface AiConfigEnvelopeV2 {
  schemaVersion: 2;
  updatedAt: number;
  config: AiParticipantConfig;
}

/** フィールドごとに型検証しながら既定値へマージする (as Partial を信用しない) */
function sanitizeAiConfig(raw: unknown): AiParticipantConfig {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
  return {
    displayName:
      typeof p.displayName === 'string' && p.displayName.trim()
        ? p.displayName.trim().slice(0, 32)
        : DEFAULT_AI_CONFIG.displayName,
    avatar: typeof p.avatar === 'string' && p.avatar ? p.avatar : DEFAULT_AI_CONFIG.avatar,
    sourceDeviceId: str(p.sourceDeviceId),
    sourceDeviceLabel: optStr(p.sourceDeviceLabel),
    sinkDeviceId: str(p.sinkDeviceId),
    sinkDeviceLabel: optStr(p.sinkDeviceLabel),
    sendLocalMic: bool(p.sendLocalMic, true),
    monitorAiLocally: bool(p.monitorAiLocally, true),
    validatedFingerprint: str(p.validatedFingerprint),
    validation:
      p.validation &&
      typeof p.validation === 'object' &&
      (p.validation as Record<string, unknown>).schemaVersion === 4 &&
      typeof (p.validation as Record<string, unknown>).fingerprint === 'string' &&
      typeof (p.validation as Record<string, unknown>).browserWiringConfirmedAt === 'string' &&
      typeof (p.validation as Record<string, unknown>).selfLoopConfirmedAt === 'string' &&
      typeof (p.validation as Record<string, unknown>).remoteRoundtripAt === 'string'
        ? {
            schemaVersion: 4,
            fingerprint: (p.validation as Record<string, unknown>).fingerprint as string,
            callMicDeviceId:
              typeof (p.validation as Record<string, unknown>).callMicDeviceId === 'string'
                ? ((p.validation as Record<string, unknown>).callMicDeviceId as string)
                : null,
            browserWiringConfirmedAt: (p.validation as Record<string, unknown>).browserWiringConfirmedAt as string,
            selfLoopConfirmedAt: (p.validation as Record<string, unknown>).selfLoopConfirmedAt as string,
            remoteRoundtripAt: (p.validation as Record<string, unknown>).remoteRoundtripAt as string,
          }
        : null,
  };
}

export function loadAiConfigWithStatus(): {
  config: AiParticipantConfig;
  readOk: boolean;
  updatedAt: number | null;
} {
  if (typeof window === 'undefined') {
    return { config: DEFAULT_AI_CONFIG, readOk: false, updatedAt: null };
  }
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const env = JSON.parse(rawV2) as Partial<AiConfigEnvelopeV2>;
      if (env && env.schemaVersion === 2) {
        return {
          config: sanitizeAiConfig(env.config),
          readOk: true,
          updatedAt: typeof env.updatedAt === 'number' ? env.updatedAt : null,
        };
      }
      // 版数が読めない v2 キーは壊れている。v1 フォールバックへ
    }
    // v1 からの移行 (読み取りのみ。v1 は旧ビルドのロールバック用に残す)
    const rawV1 = window.localStorage.getItem(AI_PARTICIPANT_STORAGE_KEY);
    if (rawV1) {
      return { config: sanitizeAiConfig(JSON.parse(rawV1)), readOk: true, updatedAt: null };
    }
    return { config: DEFAULT_AI_CONFIG, readOk: true, updatedAt: null };
  } catch {
    return { config: DEFAULT_AI_CONFIG, readOk: false, updatedAt: null };
  }
}

export function loadAiConfig(): AiParticipantConfig {
  return loadAiConfigWithStatus().config;
}

/** @returns 保存に成功したか。false なら設定はこのセッション限りで消える */
export function saveAiConfig(config: AiParticipantConfig, updatedAt = Date.now()): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const env: AiConfigEnvelopeV2 = { schemaVersion: 2, updatedAt, config };
    window.localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(env));
    return true;
  } catch {
    // localStorage 不可 (プライベートモード等)。呼び出し側が UI に警告を出す
    return false;
  }
}

/**
 * 保存に失敗したとき (プライベートモード等) のメモリ上の正本。
 * localStorage が使えない環境でも、同一タブ内の連続編集が
 * 「古い保存値との再マージ」で消えないようにする (Codex 第2巡 #9)。
 */
let unpersistedConfig: AiParticipantConfig | null = null;

/**
 * 設定の唯一の書き込み経路。
 *
 * 保存済みの最新値 (保存不能時はメモリ正本) へ patch だけを重ねる。呼び出し側の
 * スナップショット (React の props / 別タブの古い state) が何であっても、
 * patch に含まれないフィールドは巻き戻らない。
 *
 * load→merge→save を Web Locks で同一オリジン全タブにわたり直列化する
 * (Codex 第2巡 #3: 同期実行だけではタブ間の交錯書き込みを防げない)。
 * Web Locks 非対応環境 (このアプリは Region Capture の都合で Chromium 前提
 * なので実質無い) では直列化なしで実行する。
 *
 * @returns { config, persisted } — マージ後の全体と、localStorage へ書けたか
 */
export async function patchAiConfig(
  patch: Partial<AiParticipantConfig>,
  options?: { expectedUpdatedAt: number | null; signal?: AbortSignal }
): Promise<{ config: AiParticipantConfig; persisted: boolean; applied: boolean; updatedAt: number | null }> {
  const apply = (): { config: AiParticipantConfig; persisted: boolean; applied: boolean; updatedAt: number | null } => {
    const stored = loadAiConfigWithStatus();
    const base = unpersistedConfig ?? stored.config;
    const currentUpdatedAt = unpersistedConfig ? null : stored.updatedAt;
    if (options?.signal?.aborted) {
      return { config: base, persisted: stored.readOk, applied: false, updatedAt: currentUpdatedAt };
    }
    if (options && currentUpdatedAt !== options.expectedUpdatedAt) {
      return { config: base, persisted: stored.readOk, applied: false, updatedAt: currentUpdatedAt };
    }
    const merged = sanitizeAiConfig({ ...base, ...patch });
    const updatedAt = Math.max(Date.now(), (currentUpdatedAt ?? 0) + 1);
    const persisted = saveAiConfig(merged, updatedAt);
    unpersistedConfig = persisted ? null : merged;
    return { config: merged, persisted, applied: true, updatedAt: persisted ? updatedAt : null };
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    return locks.request('jishushitsu.aiParticipant.v2', async () => apply());
  }
  return apply();
}

/** 別タブでの保存を購読する。cb には保存後の最新 config が渡る */
export function subscribeAiConfig(cb: (config: AiParticipantConfig) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY_V2) return;
    cb(loadAiConfig());
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
