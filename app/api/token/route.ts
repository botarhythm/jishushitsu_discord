import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { requireSession } from '@/lib/auth-guard';

interface TokenBody {
  roomName?: string;
}

/**
 * LiveKit のアクセストークンを発行する。
 *
 * 認証は session Cookie ベース（Discord OAuth で発行済み）。
 * クライアントは roomName のみ送る。名前・ロール・identity は Cookie から確定。
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const body: TokenBody = await request.json().catch(() => ({}));
  const roomName = typeof body?.roomName === 'string' ? body.roomName : '';
  if (!roomName) {
    return NextResponse.json({ error: 'roomName が必要です' }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { session } = auth;

  // identity は kind に応じて prefix。guest の discordId は既に `guest:<jti>` 形式。
  const identity =
    session.kind === 'guest' ? session.discordId : `discord:${session.discordId}`;
  const displayName = session.displayName.substring(0, 32);

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: displayName,
    metadata: JSON.stringify({
      role: session.role,
      discordId: session.discordId,
      kind: session.kind ?? 'discord',
    }),
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    ...(session.role === 'instructor' && { roomAdmin: true }),
  });

  const token = await at.toJwt();

  return NextResponse.json({
    token,
    livekitUrl,
    participantName: displayName,
    role: session.role,
    avatarUrl: session.avatarUrl,
  });
}
