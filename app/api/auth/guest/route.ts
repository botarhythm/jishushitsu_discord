import { NextRequest, NextResponse } from 'next/server';
import {
  isInviteConsumed,
  markInviteConsumed,
  verifyInviteToken,
} from '@/lib/invite-token';
import { setSessionCookie, signSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GuestAuthBody {
  token?: string;
  displayName?: string;
}

/**
 * 招待トークンを使って guest セッション Cookie を発行する。
 * 1 トークン 1 回限り (consume 後は 410 Gone)。
 */
export async function POST(request: NextRequest) {
  const body: GuestAuthBody = await request.json().catch(() => ({}));
  const token = (body.token || '').trim();
  const displayName = (body.displayName || '').trim().slice(0, 32);

  if (!token) {
    return NextResponse.json({ error: 'token が必要です' }, { status: 400 });
  }
  if (!displayName) {
    return NextResponse.json({ error: '表示名を入力してください' }, { status: 400 });
  }

  const payload = await verifyInviteToken(token);
  if (!payload) {
    return NextResponse.json(
      { error: 'リンクが無効または期限切れです' },
      { status: 401 }
    );
  }
  if (isInviteConsumed(payload.jti)) {
    return NextResponse.json(
      { error: 'このリンクは既に使用済みです。講師に新しいリンクを依頼してください。' },
      { status: 410 }
    );
  }

  markInviteConsumed(payload.jti);

  const jwt = await signSession({
    discordId: `guest:${payload.jti}`,
    displayName,
    role: 'student',
    kind: 'guest',
    inviteJti: payload.jti,
  });
  await setSessionCookie(jwt);

  return NextResponse.json({ ok: true });
}
