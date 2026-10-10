import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'crypto';
import { UserRole } from '@/lib/types';
import { DEFAULT_SPACE, isValidSpace } from '@/lib/space';

/**
 * 講師が発行する「招待リンク」用 JWT。
 *
 * - Discord 認証をスキップして名前入力のみで自習室に入れる
 * - 有効期限は発行時に選ぶ (既定 24 時間・上限 72 時間)。前日の告知にも使える
 * - **1 人 1 リンク**。同じリンクでの再入室を許す (通信切れ・別端末からの入り直し)。
 *   LiveKit の参加者 ID はリンクの jti から作るので、同じリンクで入り直すと同じ参加者として扱われる
 * - リンクは発行した講師の「回」(space) に固定される。別の回の部屋には入れない
 * - 失効は lib/invite-revocation.ts (回の部屋が開いている間に効く)
 */

export const INVITE_TTL_CHOICES_HOURS = [2, 6, 24, 72] as const;
export type InviteTtlHours = (typeof INVITE_TTL_CHOICES_HOURS)[number];
export const DEFAULT_INVITE_TTL_HOURS: InviteTtlHours = 24;

export function isInviteTtlHours(v: unknown): v is InviteTtlHours {
  return INVITE_TTL_CHOICES_HOURS.includes(v as InviteTtlHours);
}

/** 入室直後に自動 ON にしたい録画。`screen` はタブ録画 (ローカル保存)。 */
export type InitialRecMode = 'off' | 'audio' | 'screen' | 'both';

export interface InviteTokenPayload {
  jti: string;
  role: UserRole;
  initialRec: InitialRecMode;
  space: string;
  /** 失効時刻 (epoch 秒) */
  expiresAt: number;
}

export interface IssueInviteOptions {
  role: UserRole;
  space: string;
  ttlHours?: InviteTtlHours;
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
  const ttlHours = opts.ttlHours ?? DEFAULT_INVITE_TTL_HOURS;
  const expiresAt = Math.floor(Date.now() / 1000) + ttlHours * 60 * 60;
  const initialRec: InitialRecMode = opts.initialRec ?? 'off';
  const token = await new SignJWT({
    // 旧トークンとの互換のため roomName は残す (入室先は常にメイン)
    roomName: 'main',
    role: opts.role,
    initialRec,
    space: opts.space || undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getSecret());
  return { token, jti, expiresAt };
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
    if (!jti || typeof payload.exp !== 'number') return null;
    const space = payload.space === undefined ? DEFAULT_SPACE : payload.space;
    if (!isValidSpace(space)) return null;
    // 後方互換: 古いトークン (role 未設定) は student として扱う
    const role: UserRole = isValidRole(payload.role) ? payload.role : 'student';
    const initialRec: InitialRecMode = isValidInitialRec(payload.initialRec)
      ? payload.initialRec
      : 'off';
    return { jti, role, initialRec, space, expiresAt: payload.exp };
  } catch {
    return null;
  }
}
