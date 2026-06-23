export type RoomName = 'main' | 'bo-1' | 'bo-2' | 'bo-3' | 'bo-4' | 'bo-5' | 'bo-6';
export type UserRole = 'instructor' | 'student';

/**
 * LiveKit participant.metadata に格納する全フィールド。
 *
 * 重要: metadata は participant ごとに 1 枠の JSON 文字列を共有するため、
 * 更新時は必ず {@link mergeParticipantMetadata} で既存値とマージすること。
 * 部分的な setMetadata で全上書きすると role / currentRoom / discordId が消えて
 * 講師判定・在室判定が壊れる（過去のバグ要因）。
 */
export interface ParticipantMetadata {
  role: UserRole;
  /** その参加者が今いるルーム */
  currentRoom: RoomName;
  raisedHand: boolean;
  raisedAt: string | null;
  /** Discord User ID（token発行時に付与。認証ベースの識別用） */
  discordId?: string;
  /** 認証種別（discord / guest）。token発行時に付与 */
  kind?: string;
}

/** metadata のデフォルト値 */
export const DEFAULT_PARTICIPANT_METADATA: ParticipantMetadata = {
  role: 'student',
  currentRoom: 'main',
  raisedHand: false,
  raisedAt: null,
};

/** participant.metadata（JSON文字列）を安全にパースし、欠損はデフォルトで補う */
export function parseParticipantMetadata(raw?: string | null): ParticipantMetadata {
  if (!raw) return { ...DEFAULT_PARTICIPANT_METADATA };
  try {
    const parsed = JSON.parse(raw) as Partial<ParticipantMetadata>;
    return { ...DEFAULT_PARTICIPANT_METADATA, ...parsed };
  } catch {
    return { ...DEFAULT_PARTICIPANT_METADATA };
  }
}

/** 既存 metadata に部分更新をマージして JSON 文字列を返す（全上書き事故の防止） */
export function mergeParticipantMetadata(
  raw: string | null | undefined,
  patch: Partial<ParticipantMetadata>
): string {
  return JSON.stringify({ ...parseParticipantMetadata(raw), ...patch });
}

export interface TokenRequest {
  roomName: RoomName;
}

export interface TokenResponse {
  token: string;
  livekitUrl: string;
  participantName?: string;
  role?: UserRole;
  avatarUrl?: string;
}

export interface MoveParticipantRequest {
  participantIdentity: string;
  targetRoomName: RoomName;
  currentRoomName: RoomName;
  participantName: string;
}

export interface MoveParticipantResponse {
  success: boolean;
}

export interface RoomInfo {
  name: RoomName;
  label: string;
  participants: string[];
}

export const ROOM_LABELS: Record<RoomName, string> = {
  main: 'メインルーム',
  'bo-1': 'ブレイクアウト 1',
  'bo-2': 'ブレイクアウト 2',
  'bo-3': 'ブレイクアウト 3',
  'bo-4': 'ブレイクアウト 4',
  'bo-5': 'ブレイクアウト 5',
  'bo-6': 'ブレイクアウト 6',
};

export const BREAKOUT_ROOMS: RoomName[] = ['bo-1', 'bo-2', 'bo-3', 'bo-4', 'bo-5', 'bo-6'];

// DataChannel message types for room coordination
export interface DataMessage {
  type: 'move-to-room' | 'room-state-update';
  payload: MovToRoomPayload | RoomStatePayload;
}

export interface MovToRoomPayload {
  targetRoom: RoomName;
  instructedBy: string;
}

export interface RoomStatePayload {
  rooms: RoomInfo[];
}
