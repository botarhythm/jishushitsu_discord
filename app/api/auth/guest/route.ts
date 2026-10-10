import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { verifyInviteToken } from '@/lib/invite-token';
import { isInviteRevoked } from '@/lib/invite-revocation';
import { setSessionCookie, signSession } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GuestAuthBody {
  token?: string;
  displayName?: string;
}

/**
 * 招待トークンを使って guest セッション Cookie を発行する。
 *
 * 1 人 1 リンク。同じリンクでの再入室は許す (参加者 ID は jti 固定なので同一人物として扱われる)。
 * セッションの期限はリンクの期限にそろえる。講師が失効させたリンクは 410。
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

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }
  const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  if (await isInviteRevoked(roomService, payload.space, payload.jti)) {
    return NextResponse.json(
      { error: 'このリンクは講師によって無効にされました。講師に新しいリンクを依頼してください。' },
      { status: 410 }
    );
  }

  const jwt = await signSession(
    {
      discordId: `guest:${payload.jti}`,
      displayName,
      role: payload.role,
      kind: 'guest',
      inviteJti: payload.jti,
      initialRec: payload.initialRec,
      space: payload.space,
    },
    { expiresAt: payload.expiresAt }
  );
  await setSessionCookie(jwt);

  return NextResponse.json({ ok: true, role: payload.role, initialRec: payload.initialRec });
}
