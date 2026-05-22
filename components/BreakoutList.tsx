'use client';

import { RoomName, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';
import { RoomsStatusMap } from '@/hooks/useRoomsStatus';

interface BreakoutListProps {
  onJoin: (room: RoomName) => void;
  roomsStatus?: RoomsStatusMap;
}

export function BreakoutList({ onJoin, roomsStatus }: BreakoutListProps) {
  return (
    <div className="px-4 py-3 bg-stone-850 border-t border-stone-700">
      <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wider">ブレイクアウトルーム状況</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {BREAKOUT_ROOMS.map((room) => {
          const roomParticipants = roomsStatus?.[room] || [];
          return (
            <div
              key={room}
              className="flex flex-col bg-stone-900/50 rounded-lg p-2.5 border border-stone-700/60 justify-between gap-2.5 transition-all duration-200 hover:border-stone-600"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-stone-200">{ROOM_LABELS[room]}</span>
                  {roomParticipants.length > 0 ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 border border-amber-600/30">
                      {roomParticipants.length}名
                    </span>
                  ) : (
                    <span className="text-[10px] text-stone-500">空室</span>
                  )}
                </div>
                
                <button
                  onClick={() => onJoin(room)}
                  className="text-[10px] px-2.5 py-1 rounded bg-stone-700 text-stone-300 hover:bg-amber-600 hover:text-white transition-colors cursor-pointer active:scale-95 font-medium"
                >
                  入室する
                </button>
              </div>
              
              {/* 参加者リスト */}
              <div className="flex flex-wrap gap-1.5 min-h-[22px] content-start">
                {roomParticipants.length > 0 ? (
                  roomParticipants.map((p) => (
                    <span
                      key={p.identity}
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                        p.role === 'instructor'
                          ? 'bg-amber-900/30 text-amber-300 border-amber-700/40 font-medium'
                          : 'bg-stone-800 text-stone-300 border-stone-700/50'
                      }`}
                      title={p.role === 'instructor' ? '講師' : '受講生'}
                    >
                      {p.name}
                    </span>
                  ))
                ) : (
                  <span className="text-[10px] text-stone-600 italic">入室中のユーザーはいません</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
