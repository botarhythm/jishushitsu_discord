import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient, DataPacket_Kind } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';

interface BroadcastStudioRequest {
  /** 配信先ルーム（= 講師の現在ルーム） */
  roomName: string;
  /** 収録/講演モードを有効化するか（false で参加者のロックを解除） */
  active: boolean;
  layout: string;
  /** スロット順に並べた出演者 identity。null は空きスロット */
  slots: (string | null)[];
  showNameplates: boolean;
  /** 下段に視聴者サムネを表示するか（録画には含めない、表示のみ） */
  showAudience: boolean;
}

/**
 * 講師（ホスト）の収録/講演コンポジションをルーム内の全参加者へ強制配信する。
 *
 * クライアント側 `localParticipant.publishData` は講師ブラウザの publisher
 * データチャネル経由で届かないことがあるため（マイク制御・移動と同様）、
 * サーバー側 `roomService.sendData` で `studio-state` を配信する（実績のある経路）。
 * destinationIdentities を省略してルーム全体へブロードキャストする。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body: BroadcastStudioRequest = await request.json();
    const { roomName, active, layout, slots, showNameplates, showAudience } = body;

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
      type: 'studio-state',
      payload: {
        active: !!active,
        layout,
        slots,
        showNameplates: !!showNameplates,
        showAudience: !!showAudience,
      },
    });

    const data = new TextEncoder().encode(message);

    // destinationIdentities 省略 = ルーム内の全参加者へブロードキャスト
    await roomService.sendData(roomName, data, DataPacket_Kind.RELIABLE);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Broadcast studio error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
