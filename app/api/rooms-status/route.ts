import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { requireSession } from '@/lib/auth-guard';
import { RoomName, BREAKOUT_ROOMS } from '@/lib/types';

export async function GET(request: NextRequest) {
  // セッションがあるユーザー（受講生・講師）のみ許可
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  try {
    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    const rooms: RoomName[] = ['main', ...BREAKOUT_ROOMS];

    const roomStatuses = await Promise.all(
      rooms.map(async (roomName) => {
        try {
          const participants = await roomService.listParticipants(roomName);
          
          const users = participants.map((p) => {
            let role = 'student';
            try {
              if (p.metadata) {
                const meta = JSON.parse(p.metadata);
                if (meta.role === 'instructor') {
                  role = 'instructor';
                }
              }
            } catch {
              // メタデータがパースできない場合はデフォルト値
            }
            return {
              identity: p.identity,
              name: p.name || p.identity,
              role,
            };
          });

          return {
            roomName,
            participants: users,
          };
        } catch (err) {
          // 部屋が作られていない、あるいは誰もいない場合はエラーになる可能性があるので空配列を返す
          return {
            roomName,
            participants: [],
          };
        }
      })
    );

    return NextResponse.json({ rooms: roomStatuses });
  } catch (error) {
    console.error('Fetch room status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
