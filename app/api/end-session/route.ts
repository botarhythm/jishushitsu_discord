import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function validateInstructorKey(key: string): boolean {
  const validKeys = [
    process.env.INSTRUCTOR_KEY_MOTOZAWA,
    process.env.INSTRUCTOR_KEY_TSUKAKOSHI,
  ].filter(Boolean);
  return validKeys.includes(key);
}

/**
 * 講師がセッションを終了するときに、対象ルーム内の全参加者に
 * 「end-session」シグナルをブロードキャストする。
 *
 * クライアント側の useDataChannel ハンドラがこれを受けて自分から退出する。
 *
 * Body: { instructorKey, roomName }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const instructorKey = typeof body?.instructorKey === 'string' ? body.instructorKey : '';
    const roomName = typeof body?.roomName === 'string' ? body.roomName : '';

    if (!validateInstructorKey(instructorKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!roomName) {
      return NextResponse.json({ error: 'roomName が必要です' }, { status: 400 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;
    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    const message = JSON.stringify({
      type: 'end-session',
      payload: { reason: 'instructor-ended' },
    });

    await roomService.sendData(
      roomName,
      new TextEncoder().encode(message),
      DataPacket_Kind.RELIABLE,
      {}
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[end-session] error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
