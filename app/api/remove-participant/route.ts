import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';

function validateInstructorKey(key: string): boolean {
  const validKeys = [
    process.env.INSTRUCTOR_KEY_MOTOZAWA,
    process.env.INSTRUCTOR_KEY_TSUKAKOSHI,
  ].filter(Boolean);
  return validKeys.includes(key);
}

interface RemoveParticipantRequest {
  instructorKey: string;
  roomName: string;
  participantIdentity: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: RemoveParticipantRequest = await request.json();
    const { instructorKey, roomName, participantIdentity } = body;

    if (!validateInstructorKey(instructorKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!roomName || !participantIdentity) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    await roomService.removeParticipant(roomName, participantIdentity);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Remove participant error:', error);
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
