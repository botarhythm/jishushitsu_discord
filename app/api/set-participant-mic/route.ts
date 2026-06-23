import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';

interface SetParticipantMicRequest {
  participantIdentity: string;
  /** 対象参加者が所属するルーム（= 講師の現在ルーム） */
  roomName: string;
  /** true: マイクON指示 / false: マイクOFF指示 */
  enabled: boolean;
}

/**
 * 講師が対象参加者のマイクをON/OFFする。
 *
 * クライアント側 `localParticipant.publishData` は講師ブラウザの publisher
 * データチャネル経由で届かないことがあるため、移動機能と同じく
 * サーバー側 `roomService.sendData` で `set-mic` を配信する（実績のある経路）。
 * 受信側はソフトミュート（setMicrophoneEnabled）なので、ON指示で本人が再開できる。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body: SetParticipantMicRequest = await request.json();
    const { participantIdentity, roomName, enabled } = body;

    if (!participantIdentity || !roomName) {
      return NextResponse.json(
        { error: 'participantIdentity と roomName が必要です' },
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

    const message = JSON.stringify({
      type: 'set-mic',
      payload: { enabled: !!enabled },
    });

    const encoder = new TextEncoder();
    const data = encoder.encode(message);

    await roomService.sendData(roomName, data, DataPacket_Kind.RELIABLE, {
      destinationIdentities: [participantIdentity],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Set participant mic error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
