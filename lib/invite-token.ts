import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { RoomName } from '@/lib/types';

/**
 * 講師が発行する「招待リンク」用 JWT。
 *
 * - Discord 認証をスキップして名前入力のみで自習室に入れる
 * - 有効期限は短め (デフォルト 2 時間)
 * - 1 回 consume されたら再使用不可 (module-level Set で best-effort)
 *
 * 注意: consume 状態はプロセスメモリにしか持たないため、Vercel のような
 * 複数インスタンス環境では別インスタンスで再使用される余地がある。
 * 厳密な one-shot 保証が必要になったら KV/Redis に移すこと。
 */

const INVITE_TTL_SEC = 2 * 60 * 60;

export interface InviteTokenPayload {
  jti: string;
  roomName: RoomName;
}

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(secret);
}

export async function issueInviteToken(roomName: RoomName): Promise<{
  token: string;
  jti: string;
  expiresAt: number;
}> {
  const jti = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + INVITE_TTL_SEC;
  const token = await new SignJWT({ roomName })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getSecret());
  return { token, jti, expiresAt };
}

export async function verifyInviteToken(
  token: string
): Promise<InviteTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const roomName = payload.roomName;
    if (!jti) return null;
    if (
      roomName !== 'main' &&
      roomName !== 'bo-1' &&
      roomName !== 'bo-2' &&
      roomName !== 'bo-3'
    ) {
      return null;
    }
    return { jti, roomName };
  } catch {
    return null;
  }
}

// ── consume 管理 (best-effort, in-memory) ──
// Map<jti, expiresAt(秒)> 形式で「使用済み」を持つ。
// 期限切れの jti は次回アクセス時に剥がす。
const consumed = new Map<string, number>();

function gc(now: number): void {
  for (const [jti, exp] of consumed) {
    if (exp < now) consumed.delete(jti);
  }
}

export function isInviteConsumed(jti: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  gc(now);
  return consumed.has(jti);
}

export function markInviteConsumed(jti: string): void {
  const now = Math.floor(Date.now() / 1000);
  consumed.set(jti, now + INVITE_TTL_SEC);
}
