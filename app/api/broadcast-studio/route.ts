import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
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
  /** 設定したホストの identity。受信側で自分の設定を無視する（ホストは studioMode で制御）のに使う */
  senderIdentity?: string;
}

/**
 * 講師（ホスト）の収録/講演コンポジションをルーム内の全参加者へ強制配信する。
 *
 * 状態は LiveKit の **room metadata** に保存する。
 * データチャネル（sendData/publishData）の一発プッシュは、送信時に受信パスが未確立の
 * 後から入室した参加者を取りこぼし、再送もされない（次の設定変更まで届かない）。
 * room metadata なら参加者は接続時に現在値を必ず取得でき、変更は RoomMetadataChanged で
 * 全員へ再配布されるため、後入室・再接続でも確実に同期する。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const body: BroadcastStudioRequest = await request.json();
    const { roomName, active, layout, slots, showNameplates, showAudience, senderIdentity } = body;

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

    // studio 状態を room metadata に保存。collision 回避のため `studio` キーでラップする。
    // 非アクティブ（解除）時は studio:null を書き、受信側でロックを解除させる。
    const metadata = JSON.stringify({
      studio: active
        ? {
            active: true,
            layout,
            slots,
            showNameplates: !!showNameplates,
            showAudience: !!showAudience,
            host: senderIdentity ?? null,
          }
        : null,
    });

    await roomService.updateRoomMetadata(roomName, metadata);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Broadcast studio error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
