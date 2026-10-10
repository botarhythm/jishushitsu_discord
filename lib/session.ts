import { cookies } from 'next/headers';
import { SignJWT, decodeJwt, jwtVerify } from 'jose';
import { DEFAULT_SPACE, isValidSpace } from '@/lib/space';

export type UserRole = 'instructor' | 'student';
export type SessionKind = 'discord' | 'guest';
export type InitialRecMode = 'off' | 'audio' | 'screen' | 'both';

export interface SessionPayload {
  /** Discord User ID (snowflake) または guest:<jti> */
  discordId: string;
  /** 表示名 (Discord global_name → username の優先順 / guest は入力名) */
  displayName: string;
  /** Discord アバターURL (任意) */
  avatarUrl?: string;
  role: UserRole;
  /** 認証種別。未指定は discord (後方互換) */
  kind?: SessionKind;
  /** guest セッション時のみ: 招待トークンの jti (退出後の再入場検知などに使用) */
  inviteJti?: string;
  /** 入室直後に自動 ON にしたい録音/録画モード (招待リンク発行時に指定) */
  initialRec?: InitialRecMode;
  /** 所属する回 (lib/space.ts)。未指定は既定の回 */
  space?: string;
}

export interface SignSessionOptions {
  /**
   * セッションの失効時刻 (epoch 秒)。guest は招待リンクの期限に合わせる。
   * 未指定なら発行から 12 時間。
   */
  expiresAt?: number;
}

const SESSION_COOKIE = 'lk_session';
const SESSION_TTL_SEC = 12 * 60 * 60; // 12時間

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  return new TextEncoder().encode(secret);
}

/** Discord/Guest 認証成功時に session JWT を発行 */
export async function signSession(
  payload: SessionPayload,
  opts: SignSessionOptions = {}
): Promise<string> {
  const expiresAt = opts.expiresAt ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  return new SignJWT({
    discordId: payload.discordId,
    displayName: payload.displayName,
    avatarUrl: payload.avatarUrl,
    role: payload.role,
    kind: payload.kind ?? 'discord',
    inviteJti: payload.inviteJti,
    initialRec: payload.initialRec,
    space: payload.space || undefined,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(getSecret());
}

/** JWTを検証してpayloadを返す。失敗時はnull */
export async function verifySession(jwt: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(jwt, getSecret(), {
      algorithms: ['HS256'],
    });
    if (!isSessionPayload(payload)) return null;
    return {
      discordId: payload.discordId,
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      role: payload.role,
      kind: payload.kind ?? 'discord',
      inviteJti: payload.inviteJti,
      initialRec: payload.initialRec,
      space: payload.space ?? DEFAULT_SPACE,
    };
  } catch {
    return null;
  }
}

function isSessionPayload(obj: unknown): obj is {
  discordId: string;
  displayName: string;
  avatarUrl?: string;
  role: UserRole;
  kind?: SessionKind;
  inviteJti?: string;
  initialRec?: InitialRecMode;
  space?: string;
} {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  const validInitialRec =
    o.initialRec === undefined ||
    o.initialRec === 'off' ||
    o.initialRec === 'audio' ||
    o.initialRec === 'screen' ||
    o.initialRec === 'both';
  return (
    typeof o.discordId === 'string' &&
    typeof o.displayName === 'string' &&
    (o.avatarUrl === undefined || typeof o.avatarUrl === 'string') &&
    (o.role === 'instructor' || o.role === 'student') &&
    (o.kind === undefined || o.kind === 'discord' || o.kind === 'guest') &&
    (o.inviteJti === undefined || typeof o.inviteJti === 'string') &&
    (o.space === undefined || isValidSpace(o.space)) &&
    validInitialRec
  );
}

/**
 * Route Handler / Server Function 内で session Cookieを書き込む。
 * Cookie の寿命は JWT の期限にそろえる (Cookie だけ残って 401 になる状態を作らない)。
 */
export async function setSessionCookie(jwt: string): Promise<void> {
  const c = await cookies();
  const exp = decodeJwt(jwt).exp;
  const now = Math.floor(Date.now() / 1000);
  const maxAge = typeof exp === 'number' ? Math.max(0, exp - now) : SESSION_TTL_SEC;
  c.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
}

/** 現在のセッション JWT の失効時刻 (epoch 秒)。未認証なら null */
export async function getSessionExpiresAt(): Promise<number | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return null;
  const exp = decodeJwt(token).exp;
  return typeof exp === 'number' ? exp : null;
}

/** ログアウト時に session Cookie を削除 */
export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
}

/** 現在のリクエストの Cookie からセッションを読み出す。未認証/期限切れ時は null */
export async function getSession(): Promise<SessionPayload | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/** state パラメータ用の Cookie 操作（CSRF対策） */
const OAUTH_STATE_COOKIE = 'oauth_state';
const OAUTH_STATE_TTL_SEC = 10 * 60;

export async function setOAuthStateCookie(state: string): Promise<void> {
  const c = await cookies();
  c.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: OAUTH_STATE_TTL_SEC,
  });
}

export async function consumeOAuthStateCookie(): Promise<string | null> {
  const c = await cookies();
  const state = c.get(OAUTH_STATE_COOKIE)?.value ?? null;
  if (state) c.delete(OAUTH_STATE_COOKIE);
  return state;
}

/**
 * セッションから LiveKit の participant identity を導出する。
 *
 * identity はクライアントから受け取らない。ここだけが正本で、トークン発行
 * (/api/token) と、identity を名乗る API (broadcast-studio) の双方が同じ
 * 規則を共有する。guest の discordId は既に `guest:<jti>` 形式。
 */
export function livekitIdentityFor(session: SessionPayload): string {
  return session.kind === 'guest' ? session.discordId : `discord:${session.discordId}`;
}
