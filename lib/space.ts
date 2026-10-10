import { ROOM_LABELS, type RoomName } from '@/lib/types';

/**
 * 「回」(space) — 授業の回やポッドキャスト収録ごとに LiveKit の部屋を分ける名前空間。
 *
 * クライアントは常に論理名 (`main` / `bo-1` …) だけを扱い、LiveKit 上の実際の部屋名へは
 * サーバーがセッションの space を使って変換する。space はセッション Cookie にだけ持ち、
 * リクエスト body からは受け取らない (他の回の部屋を操作させない)。
 *
 * space が空文字 = 既定の回。実際の部屋名は従来どおり `main` / `bo-1` … で、
 * 既存の Discord ログイン利用者の挙動は変わらない。
 */

export const DEFAULT_SPACE = '';

const SPACE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPACE_MAX_LENGTH = 32;

/** 回ID として受け付ける形式か (英小文字・数字・単独のハイフン、32 文字まで)。空文字は既定の回。 */
export function isValidSpace(v: unknown): v is string {
  if (v === DEFAULT_SPACE) return true;
  return typeof v === 'string' && v.length <= SPACE_MAX_LENGTH && SPACE_RE.test(v);
}

/** 入力を回ID へ正規化する (前後空白除去・小文字化)。不正なら null。 */
export function normalizeSpace(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return isValidSpace(s) ? s : null;
}

export function isRoomName(v: unknown): v is RoomName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ROOM_LABELS, v);
}

/** 論理名 → LiveKit 上の実際の部屋名 */
export function livekitRoomFor(space: string | undefined, room: RoomName): string {
  return space ? `${space}--${room}` : room;
}

/** その回のすべての部屋 (LiveKit 上の実際の名前) */
export function livekitRoomsForSpace(space: string | undefined): string[] {
  return (Object.keys(ROOM_LABELS) as RoomName[]).map((r) => livekitRoomFor(space, r));
}
