'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import RoomView from '@/components/RoomView';
import { RoomName, UserRole } from '@/lib/types';

interface RoomSession {
  token: string;
  livekitUrl: string;
  participantName: string;
  role: UserRole;
  currentRoom: RoomName;
}

async function fetchLiveKitToken(roomName: RoomName): Promise<RoomSession | 'unauthorized'> {
  const res = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomName }),
  });
  if (res.status === 401) return 'unauthorized';
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `トークン取得失敗 (${res.status})`);
  }
  const data = await res.json();
  return {
    token: data.token,
    livekitUrl: data.livekitUrl,
    participantName: data.participantName,
    role: data.role,
    currentRoom: roomName,
  };
}

export default function RoomPage() {
  const router = useRouter();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchLiveKitToken('main');
        if (cancelled) return;
        if (result === 'unauthorized') {
          router.replace('/');
          return;
        }
        setSession(result);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '予期しないエラー');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleRoomChange = async (targetRoom: RoomName) => {
    try {
      const result = await fetchLiveKitToken(targetRoom);
      if (result === 'unauthorized') {
        router.replace('/');
        return;
      }
      setSession((prev) =>
        prev
          ? {
              ...prev,
              token: result.token,
              livekitUrl: result.livekitUrl,
              currentRoom: targetRoom,
            }
          : result
      );
    } catch (err) {
      console.error('Room change failed:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-50">
        <p className="text-stone-500">接続中...</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-50 px-4">
        <p className="text-red-600 text-sm text-center">{error}</p>
      </div>
    );
  }
  if (!session) return null;

  return (
    <RoomView
      token={session.token}
      livekitUrl={session.livekitUrl}
      participantName={session.participantName}
      role={session.role}
      currentRoom={session.currentRoom}
      onRoomChange={handleRoomChange}
    />
  );
}
