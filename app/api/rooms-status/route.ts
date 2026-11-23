import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { requireSession } from '@/lib/auth-guard';
import { RoomName, BREAKOUT_ROOMS } from '@/lib/types';
import { livekitRoomFor } from '@/lib/space';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RoomsStatusPayload = {
  rooms: { roomName: RoomName; participants: { identity: string; name: string; role: string }[] }[];
};

// 同じスペースへの問い合わせを短い間まとめる。参加者が何人いても、1 つの関数インスタンスから
// LiveKit へ listParticipants を投げるのは 2 秒に 1 回（6 部屋分）までにする。
// 応答はスペースごとに同じ内容（閲覧者によらない）なので、まとめても漏れは無い。
const CACHE_TTL_MS = 2_000;
const cache = new Map<string, { at: number; promise: Promise<RoomsStatusPayload> }>();

export async function GET(_request: NextRequest) {
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

    const space = auth.session.space;
    const cacheKey = String(space ?? '');
    const now = Date.now();
    const hit = cache.get(cacheKey);
    let promise: Promise<RoomsStatusPayload>;
    if (hit && now - hit.at < CACHE_TTL_MS) {
      promise = hit.promise;
    } else {
      promise = loadRoomsStatus(livekitUrl, apiKey, apiSecret, space);
      cache.set(cacheKey, { at: now, promise });
      // 失敗した結果は使い回さない
      promise.catch(() => {
        if (cache.get(cacheKey)?.promise === promise) cache.delete(cacheKey);
      });
    }
    const payload = await promise;

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('Fetch room status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function loadRoomsStatus(
  livekitUrl: string,
  apiKey: string,
  apiSecret: string,
  space: Parameters<typeof livekitRoomFor>[0]
): Promise<RoomsStatusPayload> {
    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    const rooms: RoomName[] = ['main', ...BREAKOUT_ROOMS];

    const roomStatuses = await Promise.all(
      rooms.map(async (roomName) => {
        try {
          const participants = await roomService.listParticipants(
            livekitRoomFor(space, roomName)
          );
          
          const users = participants.flatMap((p) => {
            let role = 'student';
            let metadataRoom: unknown;
            try {
              if (p.metadata) {
                const meta = JSON.parse(p.metadata);
                metadataRoom = meta.currentRoom;
                if (meta.role === 'instructor') {
                  role = 'instructor';
                }
              }
            } catch {
              // メタデータがパースできない場合はデフォルト値
            }

            if (typeof metadataRoom === 'string' && metadataRoom !== roomName) {
              return [];
            }

            return [{
              identity: p.identity,
              name: p.name || p.identity,
              role,
            }];
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

    return { rooms: roomStatuses };
}
