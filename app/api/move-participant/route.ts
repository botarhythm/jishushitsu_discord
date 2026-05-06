import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, AccessToken, DataPacket_Kind } from 'livekit-server-sdk';
import { MoveParticipantRequest } from '@/lib/types';

function validateInstructorKey(key: string): boolean {
  const validKeys = [
    process.env.INSTRUCTOR_KEY_MOTOZAWA,
    process.env.INSTRUCTOR_KEY_TSUKAKOSHI,
  ].filter(Boolean);
  return validKeys.includes(key);
}

export async function POST(request: NextRequest) {
  try {
    const body: MoveParticipantRequest = await request.json();
    const { instructorKey, participantIdentity, targetRoomName, currentRoomName, participantName } = body;

    if (!validateInstructorKey(instructorKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

    // Send data message to target participant to trigger client-side reconnect
    const message = JSON.stringify({
      type: 'move-to-room',
      payload: {
        targetRoom: targetRoomName,
        instructedBy: 'instructor',
      },
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    await roomService.sendData(currentRoomName, data, DataPacket_Kind.RELIABLE, {
      destinationIdentities: [participantIdentity],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Move participant error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
