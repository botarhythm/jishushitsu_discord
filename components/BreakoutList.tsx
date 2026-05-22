'use client';

import { useState } from 'react';
import { RoomName, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';
import { RoomsStatusMap } from '@/hooks/useRoomsStatus';

// 各ブレイクアウトルーム固有の「優しいアースカラー」設定
// globals.css のアースカラー定義と完璧に一致させます
const ROOM_COLORS: Record<RoomName, { main: string; border: string; borderHover: string; bg: string; text: string }> = {
  main: {
    main: '#9a6642', // フォレストオリーブ
    border: 'rgba(154, 102, 66, 0.2)',
    borderHover: 'rgba(154, 102, 66, 0.5)',
    bg: 'rgba(154, 102, 66, 0.04)',
    text: '#d5a27f',
  },
  'bo-1': {
    main: '#b36b44', // キャメルオレンジ (Camel Orange - 温かみのある明るいアースオレンジ)
    border: 'rgba(179, 107, 68, 0.2)',
    borderHover: 'rgba(179, 107, 68, 0.5)',
    bg: 'rgba(179, 107, 68, 0.04)',
    text: '#e8a882',
  },
  'bo-2': {
    main: '#42759e', // レイクブルー (Cloudy Lake Blue)
    border: 'rgba(66, 117, 158, 0.2)',
    borderHover: 'rgba(66, 117, 158, 0.5)',
    bg: 'rgba(66, 117, 158, 0.04)',
    text: '#82b2d5',
  },
  'bo-3': {
    main: '#9a803f', // サンドオークル (Sand Ocher)
    border: 'rgba(154, 128, 63, 0.2)',
    borderHover: 'rgba(154, 128, 63, 0.5)',
    bg: 'rgba(154, 128, 63, 0.04)',
    text: '#d3be7f',
  },
  'bo-4': {
    main: '#6c757f', // ミスティチャコール (Misty Charcoal)
    border: 'rgba(108, 117, 127, 0.2)',
    borderHover: 'rgba(108, 117, 127, 0.5)',
    bg: 'rgba(108, 117, 127, 0.04)',
    text: '#a7b1bc',
  },
  'bo-5': {
    main: '#8f769a', // ミスティラベンダー (Misty Lavender - 穏やかで上品なくすんだ紫)
    border: 'rgba(143, 118, 154, 0.2)',
    borderHover: 'rgba(143, 118, 154, 0.5)',
    bg: 'rgba(143, 118, 154, 0.04)',
    text: '#cfaad4',
  },
  'bo-6': {
    main: '#3f9e62', // モスセージ (Moss Sage)
    border: 'rgba(63, 158, 98, 0.2)',
    borderHover: 'rgba(63, 158, 98, 0.5)',
    bg: 'rgba(63, 158, 98, 0.04)',
    text: '#7fd69e',
  },
};

interface BreakoutListProps {
  onJoin: (room: RoomName) => void;
  roomsStatus?: RoomsStatusMap;
}

export function BreakoutList({ onJoin, roomsStatus }: BreakoutListProps) {
  const [hoveredRoom, setHoveredRoom] = useState<RoomName | null>(null);
  const [hoveredButton, setHoveredButton] = useState<RoomName | null>(null);

  return (
    <div className="px-4 py-3 bg-stone-850 border-t border-stone-700">
      <p className="text-xs font-semibold text-stone-400 mb-2 uppercase tracking-wider">ブレイクアウトルーム状況</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {BREAKOUT_ROOMS.map((room) => {
          const roomParticipants = roomsStatus?.[room] || [];
          const isHovered = hoveredRoom === room;
          const theme = ROOM_COLORS[room];

          return (
            <div
              key={room}
              onMouseEnter={() => setHoveredRoom(room)}
              onMouseLeave={() => setHoveredRoom(null)}
              style={{
                borderColor: isHovered ? theme.borderHover : theme.border,
                backgroundColor: isHovered ? 'rgba(28, 25, 23, 0.4)' : 'rgba(28, 25, 23, 0.2)',
              }}
              className="relative flex flex-col rounded-lg pt-3.5 p-2.5 border justify-between gap-2.5 transition-all duration-200 overflow-hidden"
            >
              {/* 各部屋のアースカラーを示す上部カラーバー */}
              <div 
                className="h-1 w-full absolute top-0 left-0" 
                style={{ backgroundColor: theme.main }}
              />
              
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-stone-200">{ROOM_LABELS[room]}</span>
                  {roomParticipants.length > 0 ? (
                    <span 
                      className="text-[10px] px-1.5 py-0.5 rounded border font-medium transition-colors"
                      style={{
                        backgroundColor: `${theme.main}15`,
                        color: theme.text,
                        borderColor: `${theme.main}30`
                      }}
                    >
                      {roomParticipants.length}名
                    </span>
                  ) : (
                    <span className="text-[10px] text-stone-500">空室</span>
                  )}
                </div>
                
                <button
                  onClick={() => onJoin(room)}
                  onMouseEnter={() => setHoveredButton(room)}
                  onMouseLeave={() => setHoveredButton(null)}
                  style={{
                    backgroundColor: hoveredButton === room ? theme.main : 'rgba(60, 63, 53, 0.6)',
                    color: hoveredButton === room ? '#ffffff' : 'var(--color-stone-300)',
                  }}
                  className="text-[10px] px-2.5 py-1 rounded transition-all duration-150 cursor-pointer active:scale-95 font-medium"
                >
                  入室する
                </button>
              </div>
              
              {/* 参加者リスト */}
              <div className="flex flex-wrap gap-1.5 min-h-[22px] content-start">
                {roomParticipants.length > 0 ? (
                  roomParticipants.map((p) => {
                    const isInstructor = p.role === 'instructor';
                    return (
                      <span
                        key={p.identity}
                        style={{
                          backgroundColor: isInstructor ? `${theme.main}25` : 'rgba(41, 43, 36, 0.6)',
                          color: isInstructor ? theme.text : '#d4d6cb',
                          borderColor: isInstructor ? `${theme.main}45` : 'rgba(60, 63, 53, 0.4)',
                        }}
                        className={`text-[10px] px-2 py-0.5 rounded border transition-colors font-medium`}
                        title={isInstructor ? '講師' : '受講生'}
                      >
                        {p.name}
                      </span>
                    );
                  })
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
