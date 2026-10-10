import { livekitIdentityFor } from '@/lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { requireSession } from '@/lib/auth-guard';
import { isRoomName, livekitRoomFor } from '@/lib/space';
import { isInviteRevoked } from '@/lib/invite-revocation';

interface TokenBody {
  roomName?: string;
}

/**
 * LiveKit のアクセストークンを発行する。
 *
 * 認証は session Cookie ベース（Discord OAuth または招待リンクで発行済み）。
 * クライアントは論理名の roomName のみ送る。名前・ロール・identity・回は Cookie から確定し、
 * LiveKit 上の部屋名は回ごとに分ける (lib/space.ts)。
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const body: TokenBody = await request.json().catch(() => ({}));
  const roomName = body?.roomName;
  if (!isRoomName(roomName)) {
    return NextResponse.json({ error: 'roomName が不正です' }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { session } = auth;
  const space = session.space ?? '';

  // 失効したリンクのゲストには、Cookie が残っていてもトークンを出さない
  if (session.kind === 'guest' && session.inviteJti) {
    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    if (await isInviteRevoked(roomService, space, session.inviteJti)) {
      return NextResponse.json(
        { error: 'このリンクは講師によって無効にされました。' },
        { status: 410 }
      );
    }
  }

  const identity = livekitIdentityFor(session);
  const displayName = session.displayName.substring(0, 32);

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: displayName,
    metadata: JSON.stringify({
      role: session.role,
      // metadata の currentRoom は論理名 (クライアント・rooms-status はこれで判定する)
      currentRoom: roomName,
      raisedHand: false,
      raisedAt: null,
      discordId: session.discordId,
      kind: session.kind ?? 'discord',
    }),
  });

  at.addGrant({
    roomJoin: true,
    room: livekitRoomFor(space, roomName),
    canPublish: true,
    canSubscribe: true,
    // 受講生も挙手で自分の metadata を更新するため必須
    canUpdateOwnMetadata: true,
    ...(session.role === 'instructor' && { roomAdmin: true }),
  });

  const token = await at.toJwt();

  return NextResponse.json({
    token,
    livekitUrl,
    participantName: displayName,
    role: session.role,
    kind: session.kind ?? 'discord',
    avatarUrl: session.avatarUrl,
    initialRec: session.initialRec ?? 'off',
    space,
  });
}
