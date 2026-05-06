export type RoomName = 'main' | 'bo-1' | 'bo-2' | 'bo-3';
export type UserRole = 'instructor' | 'student';

export interface ParticipantMetadata {
  raisedHand: boolean;
  raisedAt: string | null;
}

export interface TokenRequest {
  roomName: RoomName;
  participantName: string;
  role: UserRole;
  instructorKey?: string;
}

export interface TokenResponse {
  token: string;
  livekitUrl: string;
  participantName?: string;
  role?: UserRole;
}

export interface MoveParticipantRequest {
  instructorKey: string;
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
};

export const BREAKOUT_ROOMS: RoomName[] = ['bo-1', 'bo-2', 'bo-3'];

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
