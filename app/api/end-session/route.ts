import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 講師がセッションを終了するときに、対象ルーム内の全参加者に
 * 「end-session」シグナルをブロードキャストする。
 *
 * Body: { roomName }
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const roomName = typeof body?.roomName === 'string' ? body.roomName : '';
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
