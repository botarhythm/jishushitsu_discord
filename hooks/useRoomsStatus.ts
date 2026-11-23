import { useEffect, useState, useCallback, useRef } from 'react';
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

export interface UseRoomsStatusOptions {
  /** 部屋ごとの在室一覧を表示している間だけ true にする。false の間は一切取りに行かない */
  enabled: boolean;
  /** 定期取得の間隔（ms）。入退室はイベントで即時に取り直すので、これは取りこぼしの保険 */
  intervalMs: number;
}

/**
 * 部屋ごとの在室一覧を /api/rooms-status から取る。
 *
 * 2026-11-23、参加者 5〜6 人・4 時間の回で 1 日 1.9 万回（1 回ごとに LiveKit の
 * listParticipants を 6 部屋分）まで膨らんだ。原因は「全員のタブが 3 秒ごと・
 * 裏のタブでも・一覧を出していない画面でも」取りに行っていたこと。
 * そのため、表示中かつタブが表にある間だけ、間隔を空けて取る。
 */
export function useRoomsStatus({ enabled, intervalMs }: UseRoomsStatusOptions) {
  const [roomsStatus, setRoomsStatus] = useState<RoomsStatusMap>(createInitialStatus());
  const [loading, setLoading] = useState(true);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const inFlightRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!enabledRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // 前の取得が返ってくる前に重ねて投げない（イベントの連発・タイマーの重なり対策）
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch('/api/rooms-status', { cache: 'no-store' });
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
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void fetchStatus();
      timer = setInterval(() => {
        void fetchStatus();
      }, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    // タブが裏に回ったら止め、表に戻ったら即座に取り直して再開する
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enabled, intervalMs, fetchStatus]);

  return { roomsStatus, loading, refetch: fetchStatus };
}
