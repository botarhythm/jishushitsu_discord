import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';
import { isRoomName, livekitRoomFor } from '@/lib/space';
import { revokeInvite } from '@/lib/invite-revocation';

interface RemoveParticipantRequest {
  roomName: string;
  participantIdentity: string;
  /** true なら招待リンクのゲストのリンクも失効させる (同じリンクで入り直せなくする) */
  revokeInvite?: boolean;
}

const GUEST_IDENTITY_PREFIX = 'guest:';

export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body: RemoveParticipantRequest = await request.json();
    const { roomName, participantIdentity } = body;

    if (!isRoomName(roomName) || !participantIdentity) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    const revoke = body.revokeInvite === true;
    if (revoke && !participantIdentity.startsWith(GUEST_IDENTITY_PREFIX)) {
      return NextResponse.json(
        { error: '招待リンクで参加した人だけ、リンクを無効にできます' },
        { status: 400 }
      );
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    const space = auth.session.space ?? '';
    // 失効を先に記録する (退出させた直後の自動再接続でトークンを取り直させない)
    if (revoke) {
      await revokeInvite(roomService, space, participantIdentity.slice(GUEST_IDENTITY_PREFIX.length));
    }
    try {
      await roomService.removeParticipant(livekitRoomFor(space, roomName), participantIdentity);
    } catch (err) {
      // 失効だけが目的なら、すでに退出済み (部屋にいない) でも成功として扱う
      if (!revoke) throw err;
      return NextResponse.json({ success: true, revoked: true, removed: false });
    }

    return NextResponse.json({ success: true, revoked: revoke, removed: true });
  } catch (error) {
    console.error('Remove participant error:', error);
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
