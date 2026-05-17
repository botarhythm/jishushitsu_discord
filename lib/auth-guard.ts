import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from '@/lib/session';

type GuardResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

/**
 * セッション必須（ロール問わず）。
 * 使い方: `const a = await requireSession(); if (!a.ok) return a.response;`
 */
export async function requireSession(): Promise<GuardResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

/** 講師セッション必須 */
export async function requireInstructor(): Promise<GuardResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  if (session.role !== 'instructor') {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  return { ok: true, session };
}
