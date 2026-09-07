import { NextRequest, NextResponse } from 'next/server';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';
import { livekitIdentityFor } from '@/lib/session';
import { AI_LIVEKIT_IDENTITY, AI_PARTICIPANT_METADATA } from '@/lib/ai/livekit-participant';
import { ROOM_LABELS, type RoomName } from '@/lib/types';

interface TokenBody {
  roomName?: string;
  displayName?: string;
  avatar?: string;
}

function isRoomName(value: string): value is RoomName {
  return Object.prototype.hasOwnProperty.call(ROOM_LABELS, value);
}

export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  const parsedBody: unknown = await request.json().catch(() => ({}));
  const body: TokenBody = parsedBody && typeof parsedBody === 'object' ? parsedBody : {};
  const roomName = typeof body.roomName === 'string' ? body.roomName : '';
  if (!isRoomName(roomName)) {
    return NextResponse.json({ error: 'roomName が不正です' }, { status: 400 });
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
  const participants = await roomService.listParticipants(roomName).catch(() => null);
  if (!participants) {
    return NextResponse.json({ error: 'ルーム状態を確認できません' }, { status: 503 });
  }

  const instructorIdentity = livekitIdentityFor(auth.session);
  if (!participants.some((participant) => participant.identity === instructorIdentity)) {
    return NextResponse.json({ error: '対象ルームに講師として接続していません' }, { status: 403 });
  }
  if (participants.some((participant) => participant.identity === AI_LIVEKIT_IDENTITY)) {
    return NextResponse.json(
      { error: 'ChatGPTはすでにこのルームへ参加しています', code: 'AI_ALREADY_CONNECTED' },
      { status: 409 }
    );
  }

  const displayName =
    typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim().slice(0, 32)
      : 'ChatGPT';
  const avatar = typeof body.avatar === 'string' ? body.avatar.slice(0, 16) : '🤖';
  const token = new AccessToken(apiKey, apiSecret, {
    identity: AI_LIVEKIT_IDENTITY,
    name: displayName,
    metadata: JSON.stringify({ ...AI_PARTICIPANT_METADATA, avatar, ownerIdentity: instructorIdentity }),
  });
  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });

  return NextResponse.json({
    token: await token.toJwt(),
    livekitUrl,
    identity: AI_LIVEKIT_IDENTITY,
  });
}
