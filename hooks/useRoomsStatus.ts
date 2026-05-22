import { useEffect, useState, useCallback } from 'react';
import { RoomName, BREAKOUT_ROOMS } from '@/lib/types';

export interface RoomParticipant {
  identity: string;
  name: string;
  role: string;
}

export type RoomsStatusMap = Record<RoomName, RoomParticipant[]>;

const createInitialStatus = (): RoomsStatusMap => {
  const status = { main: [] } as unknown as RoomsStatusMap;
  BREAKOUT_ROOMS.forEach((room) => {
    status[room] = [];
  });
  return status;
};

export function useRoomsStatus() {
  const [roomsStatus, setRoomsStatus] = useState<RoomsStatusMap>(createInitialStatus());
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/rooms-status');
      if (!res.ok) throw new Error('Failed to fetch rooms status');
      const data = await res.json();
      
      const newStatus = createInitialStatus();
      if (Array.isArray(data.rooms)) {
        data.rooms.forEach((room: { roomName: RoomName; participants: RoomParticipant[] }) => {
          if (room.roomName in newStatus) {
            newStatus[room.roomName] = room.participants;
          }
        });
      }
      setRoomsStatus(newStatus);
    } catch (err) {
      console.error('[useRoomsStatus] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回取得
    fetchStatus();

    // 3秒ごとの定期ポーリング
    const timer = setInterval(() => {
      fetchStatus();
    }, 3000);

    // タブがアクティブになったときに即座にフェッチするハンドラ
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchStatus]);

  return { roomsStatus, loading, refetch: fetchStatus };
}
