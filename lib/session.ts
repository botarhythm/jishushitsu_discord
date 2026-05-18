import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';

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
}

const SESSION_COOKIE = 'lk_session';
const SESSION_TTL_SEC = 12 * 60 * 60; // 12時間
const GUEST_SESSION_TTL_SEC = 60 * 60; // 1時間 (guest は短命)

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET is not set');
  }
  return new TextEncoder().encode(secret);
}

/** Discord/Guest 認証成功時に session JWT を発行 */
export async function signSession(payload: SessionPayload): Promise<string> {
  const ttl = payload.kind === 'guest' ? GUEST_SESSION_TTL_SEC : SESSION_TTL_SEC;
  return new SignJWT({
    discordId: payload.discordId,
    displayName: payload.displayName,
    avatarUrl: payload.avatarUrl,
    role: payload.role,
    kind: payload.kind ?? 'discord',
    inviteJti: payload.inviteJti,
    initialRec: payload.initialRec,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
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
    validInitialRec
  );
}

/** Route Handler / Server Function 内で session Cookieを書き込む */
export async function setSessionCookie(jwt: string): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  });
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
