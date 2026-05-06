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
  instructorKey?: string;
}

export default function RoomPage() {
  const router = useRouter();
  const [session, setSession] = useState<RoomSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem('lk_token');
    const livekitUrl = sessionStorage.getItem('lk_url');
    const participantName = sessionStorage.getItem('lk_name');
    const role = sessionStorage.getItem('lk_role') as UserRole | null;
    const currentRoom = (sessionStorage.getItem('lk_room') as RoomName) || 'main';
    const instructorKey = sessionStorage.getItem('lk_instructor_key') || undefined;

    if (!token || !livekitUrl || !participantName || !role) {
      router.replace('/');
      return;
    }

    setSession({ token, livekitUrl, participantName, role, currentRoom, instructorKey });
    setLoading(false);
  }, [router]);

  const handleRoomChange = async (targetRoom: RoomName) => {
    if (!session) return;

    try {
      const res = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: targetRoom,
          participantName: session.participantName,
          role: session.role,
          ...(session.instructorKey && { instructorKey: session.instructorKey }),
        }),
      });

      if (!res.ok) throw new Error('Failed to get token');

      const data = await res.json();

      sessionStorage.setItem('lk_token', data.token);
      sessionStorage.setItem('lk_url', data.livekitUrl);
      sessionStorage.setItem('lk_room', targetRoom);

      setSession((prev) =>
        prev
          ? { ...prev, token: data.token, livekitUrl: data.livekitUrl, currentRoom: targetRoom }
          : null
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

  if (!session) return null;

  return (
    <RoomView
      token={session.token}
      livekitUrl={session.livekitUrl}
      participantName={session.participantName}
      role={session.role}
      currentRoom={session.currentRoom}
      instructorKey={session.instructorKey}
      onRoomChange={handleRoomChange}
    />
  );
}
