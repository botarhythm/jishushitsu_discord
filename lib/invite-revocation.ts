import { RoomServiceClient } from 'livekit-server-sdk';
import { livekitRoomFor, livekitRoomsForSpace } from '@/lib/space';

/**
 * 招待リンクの失効 (外部ストレージを持たない best-effort 実装)。
 *
 * 失効したリンクの jti を、その回の部屋の LiveKit room metadata (`revokedInvites`) に持つ。
 * 部屋が開いている間 (= 回の最中) はどのインスタンスからでも同じ値が読めるので、
 * 失効したリンクでの入室・再入室・トークン再発行を拒否できる。
 *
 * 限界: 回の部屋がすべて閉じる (全員退出して LiveKit が部屋を消す) と記録も消える。
 * 回ID を回ごとに分け、リンクの期限を短めに選ぶことで、閉じた後の再利用の影響を
 * その回の空き部屋だけに閉じ込める。確実な失効が必要になったら KV などへ移すこと。
 */

const MAX_REVOKED = 200;

function revokedFromMetadata(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { revokedInvites?: unknown };
    return Array.isArray(parsed.revokedInvites)
      ? parsed.revokedInvites.filter((v): v is string => typeof v === 'string')
      : [];
  } catch {
    return [];
  }
}

/** その回で失効済みの jti。部屋の状態を読めないときは null (呼び出し側で扱いを決める) */
export async function listRevokedInvites(
  roomService: RoomServiceClient,
  space: string
): Promise<Set<string> | null> {
  try {
    const rooms = await roomService.listRooms(livekitRoomsForSpace(space));
    return new Set(rooms.flatMap((r) => revokedFromMetadata(r.metadata)));
  } catch {
    return null;
  }
}

export async function isInviteRevoked(
  roomService: RoomServiceClient,
  space: string,
  jti: string
): Promise<boolean> {
  const revoked = await listRevokedInvites(roomService, space);
  // 読めないときは入室を止めない (LiveKit 側の一時的な障害で授業・収録を止めない)
  return revoked?.has(jti) ?? false;
}

/**
 * jti を失効させる。回のメイン部屋を必ず用意したうえで、開いているすべての部屋の
 * metadata に記録する (誰もいない部屋が先に閉じても、ほかの部屋に残るようにする)。
 * 既存の metadata (収録モードの `studio` など) は保持して merge する。
 */
export async function revokeInvite(
  roomService: RoomServiceClient,
  space: string,
  jti: string
): Promise<void> {
  await roomService.createRoom({ name: livekitRoomFor(space, 'main') });
  const rooms = await roomService.listRooms(livekitRoomsForSpace(space));
  await Promise.all(
    rooms.map(async (room) => {
      let existing: Record<string, unknown> = {};
      try {
        existing = room.metadata ? (JSON.parse(room.metadata) as Record<string, unknown>) : {};
      } catch {
        existing = {};
      }
      const current = revokedFromMetadata(room.metadata);
      if (current.includes(jti)) return;
      const revokedInvites = [...current, jti].slice(-MAX_REVOKED);
      await roomService.updateRoomMetadata(
        room.name,
        JSON.stringify({ ...existing, revokedInvites })
      );
    })
  );
}
