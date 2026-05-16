'use client';

import { RoomName, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';

interface BreakoutListProps {
  onJoin: (room: RoomName) => void;
}

export function BreakoutList({ onJoin }: BreakoutListProps) {
  return (
    <div className="px-4 py-2 bg-stone-800 border-t border-stone-700">
      <p className="text-xs text-stone-400 mb-1">ブレイクアウトルーム</p>
      <div className="flex gap-2">
        {BREAKOUT_ROOMS.map((room) => (
          <button
            key={room}
            onClick={() => onJoin(room)}
            className="text-xs px-3 py-1.5 rounded-full bg-stone-700 text-stone-300 hover:bg-amber-600 hover:text-white transition-colors"
          >
            {ROOM_LABELS[room]}に聴講参加
          </button>
        ))}
      </div>
    </div>
  );
}
