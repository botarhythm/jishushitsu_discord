import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';
import { isRoomName, livekitRoomFor } from '@/lib/space';

interface MoveParticipantRequest {
  participantIdentity: string;
  targetRoomName: string;
  currentRoomName: string;
}

export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body: MoveParticipantRequest = await request.json();
    const { participantIdentity, targetRoomName, currentRoomName } = body;
    if (!participantIdentity || !isRoomName(targetRoomName) || !isRoomName(currentRoomName)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

    const message = JSON.stringify({
      type: 'move-to-room',
      payload: {
        targetRoom: targetRoomName,
        instructedBy: 'instructor',
      },
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    // targetRoom は論理名のまま送る (受け取った側が /api/token で自分の回の部屋へ入り直す)
    await roomService.sendData(livekitRoomFor(auth.session.space, currentRoomName), data, DataPacket_Kind.RELIABLE, {
      destinationIdentities: [participantIdentity],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Move participant error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
