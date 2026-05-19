import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { RoomName, UserRole } from '@/lib/types';

/**
 * 講師 (または EchoNote 経由のサーバー間呼び出し) が発行する「招待リンク」用 JWT。
 *
 * - Discord 認証をスキップして名前入力のみで自習室に入れる
 * - 有効期限は短め (デフォルト 2 時間)
 * - 1 回 consume されたら再使用不可 (module-level Set で best-effort)
 * - role と initialRec をトークンに埋め込み、入室時の振る舞いを決める
 *
 * 注意: consume 状態はプロセスメモリにしか持たないため、Vercel のような
 * 複数インスタンス環境では別インスタンスで再使用される余地がある。
 * 厳密な one-shot 保証が必要になったら KV/Redis に移すこと。
 */

const INVITE_TTL_SEC = 2 * 60 * 60;

/** 入室直後に自動 ON にしたい録音/録画。`audio` は LiveKit 音声 mix → EchoNote 送信、`screen` はタブ録画。 */
export type InitialRecMode = 'off' | 'audio' | 'screen' | 'both';

export interface InviteTokenPayload {
  jti: string;
  roomName: RoomName;
  role: UserRole;
  initialRec: InitialRecMode;
}

export interface IssueInviteOptions {
  roomName: RoomName;
  role: UserRole;
  initialRec?: InitialRecMode;
}

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(secret);
}

export async function issueInviteToken(opts: IssueInviteOptions): Promise<{
  token: string;
  jti: string;
  expiresAt: number;
}> {
  const jti = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + INVITE_TTL_SEC;
  const initialRec: InitialRecMode = opts.initialRec ?? 'off';
  const token = await new SignJWT({
    roomName: opts.roomName,
    role: opts.role,
    initialRec,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getSecret());
  return { token, jti, expiresAt };
}

function isValidRoomName(v: unknown): v is RoomName {
  return v === 'main' || v === 'bo-1' || v === 'bo-2' || v === 'bo-3';
}

function isValidRole(v: unknown): v is UserRole {
  return v === 'instructor' || v === 'student';
}

function isValidInitialRec(v: unknown): v is InitialRecMode {
  return v === 'off' || v === 'audio' || v === 'screen' || v === 'both';
}

export async function verifyInviteToken(
  token: string
): Promise<InviteTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'],
    });
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    if (!jti) return null;
    if (!isValidRoomName(payload.roomName)) return null;
    // 後方互換: 古いトークン (role 未設定) は student として扱う
    const role: UserRole = isValidRole(payload.role) ? payload.role : 'student';
    const initialRec: InitialRecMode = isValidInitialRec(payload.initialRec)
      ? payload.initialRec
      : 'off';
    return { jti, roomName: payload.roomName, role, initialRec };
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
