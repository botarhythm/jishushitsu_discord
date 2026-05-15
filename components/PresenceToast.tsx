'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, RemoteParticipant } from 'livekit-client';

interface ToastEntry {
  id: number;
  type: 'join' | 'leave';
  name: string;
}

const TOAST_DURATION_MS = 3500;

export function PresenceToast() {
  const room = useRoomContext();
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextIdRef = useRef(0);

  useEffect(() => {
    const timeoutHandles = new Set<ReturnType<typeof setTimeout>>();

    const pushToast = (type: 'join' | 'leave', name: string) => {
      const id = nextIdRef.current++;
      setToasts((prev) => [...prev, { id, type, name }]);
      const handle = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        timeoutHandles.delete(handle);
      }, TOAST_DURATION_MS);
      timeoutHandles.add(handle);
    };

    const onJoin = (p: RemoteParticipant) => {
      pushToast('join', p.name ?? p.identity);
    };
    const onLeave = (p: RemoteParticipant) => {
      pushToast('leave', p.name ?? p.identity);
    };

    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);

    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
      timeoutHandles.forEach((h) => clearTimeout(h));
    };
  }, [room]);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-16 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto rounded-lg px-3 py-2 text-sm font-medium shadow-lg backdrop-blur-sm transition-opacity ${
            t.type === 'join'
              ? 'bg-green-700/90 text-green-100'
              : 'bg-stone-700/90 text-stone-200'
          }`}
          role="status"
        >
          <span className="mr-1">{t.type === 'join' ? '🟢' : '⚪'}</span>
          {t.name}さんが{t.type === 'join' ? '参加しました' : '退出しました'}
        </div>
      ))}
    </div>
  );
}
