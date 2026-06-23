'use client';

import { useState, useCallback } from 'react';
import { Participant } from 'livekit-client';
import { RoomName, ParticipantMetadata, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';
import { RoomsStatusMap } from '@/hooks/useRoomsStatus';

interface InstructorDashboardProps {
  participants: Participant[];
  currentRoom: RoomName;
  instructorName: string;
  selfIdentity: string;
  /** モバイル時のドロワー開閉状態（PCでは無視） */
  drawerOpen?: boolean;
  /** モバイル時の閉じる動作 */
  onCloseDrawer?: () => void;
  roomsStatus?: RoomsStatusMap;
  /** 収録モード（YouTube/Podcast 収録レイアウト）を開始する。メインルームのみ */
  onEnterStudio?: () => void;
  /** 講師自身が表示中のルームを切り替える */
  onMoveInstructor: (room: RoomName) => void | Promise<void>;
  /** BO在室状況を即時再取得する */
  onRoomsStatusRefresh?: () => void | Promise<void>;
  /** 対象参加者のマイクをON/OFFする（data-channelソフトミュート） */
  onSetParticipantMic: (participantIdentity: string, enabled: boolean) => void;
}

interface RaisedHandEntry {
  identity: string;
  name: string;
  raisedAt: string;
}

export default function InstructorDashboard({
  participants,
  currentRoom,
  instructorName,
  selfIdentity,
  drawerOpen = false,
  onCloseDrawer,
  roomsStatus,
  onEnterStudio,
  onMoveInstructor,
  onRoomsStatusRefresh,
  onSetParticipantMic,
}: InstructorDashboardProps) {
  const [isMoving, setIsMoving] = useState<string | null>(null);

  const raisedHandEntries: RaisedHandEntry[] = participants
    .filter((p) => {
      try {
        const meta: ParticipantMetadata = JSON.parse(p.metadata ?? '{}');
        return meta.raisedHand && p.name !== instructorName;
      } catch {
        return false;
      }
    })
    .map((p) => {
      const meta: ParticipantMetadata = JSON.parse(p.metadata ?? '{}');
      return { identity: p.identity, name: p.name ?? p.identity, raisedAt: meta.raisedAt ?? '' };
    })
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));

  const students = participants.filter((p) => {
    try {
      const meta = JSON.parse(p.metadata ?? '{}');
      return meta.role !== 'instructor';
    } catch {
      return true;
    }
  });

  const refreshRoomsStatusSoon = useCallback(() => {
    void onRoomsStatusRefresh?.();
    window.setTimeout(() => {
      void onRoomsStatusRefresh?.();
    }, 1000);
  }, [onRoomsStatusRefresh]);

  const moveInstructorToRoom = useCallback(
    (targetRoom: RoomName) => {
      if (targetRoom === currentRoom) return;
      onMoveInstructor(targetRoom);
      onCloseDrawer?.();
    },
    [currentRoom, onCloseDrawer, onMoveInstructor]
  );

  const moveParticipantToRoom = useCallback(
    async (
      participantIdentity: string,
      participantName: string,
      targetRoom: RoomName,
      sourceRoom: RoomName = currentRoom
    ) => {
      if (isMoving) return;

      setIsMoving(participantIdentity);

      try {
        // Send move command to target participant via server
        const res = await fetch('/api/move-participant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            participantIdentity,
            targetRoomName: targetRoom,
            currentRoomName: sourceRoom,
            participantName,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          alert(`移動に失敗しました: ${err.error}`);
          return;
        }

        refreshRoomsStatusSoon();
      } catch (err) {
        console.error('Move failed:', err);
        alert('移動に失敗しました。もう一度お試しください。');
      } finally {
        setIsMoving(null);
      }
    },
    [currentRoom, isMoving, refreshRoomsStatusSoon]
  );

  const removeParticipant = useCallback(
    async (participantIdentity: string, participantName: string, sourceRoom: RoomName = currentRoom) => {
      if (isMoving) return;
      if (!confirm(`${participantName}さんを退出させますか？`)) return;

      setIsMoving(participantIdentity);

      try {
        const res = await fetch('/api/remove-participant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomName: sourceRoom,
            participantIdentity,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`退出処理に失敗しました: ${err.error ?? res.status}`);
          return;
        }

        refreshRoomsStatusSoon();
      } catch (err) {
        console.error('Remove participant failed:', err);
        alert('退出処理に失敗しました。もう一度お試しください。');
      } finally {
        setIsMoving(null);
      }
    },
    [currentRoom, isMoving, refreshRoomsStatusSoon]
  );

  const summonAllToMain = useCallback(async () => {
    if (isMoving) return;

    const breakoutParticipants = BREAKOUT_ROOMS.flatMap((room) =>
      (roomsStatus?.[room] || []).map((participant) => ({ ...participant, room }))
    );

    if (breakoutParticipants.length === 0) return;
    if (!confirm(`BO内の${breakoutParticipants.length}名をメインルームへ招集しますか？`)) return;

    setIsMoving('__summon_all__');

    try {
      const results = await Promise.allSettled(
        breakoutParticipants.map((participant) => {
          if (participant.identity === selfIdentity) {
            return onMoveInstructor('main');
          }

          return fetch('/api/move-participant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              participantIdentity: participant.identity,
              targetRoomName: 'main',
              currentRoomName: participant.room,
              participantName: participant.name,
            }),
          }).then(async (res) => {
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error ?? `${res.status}`);
            }
          });
        })
      );

      const failedCount = results.filter((result) => result.status === 'rejected').length;
      if (failedCount > 0) {
        alert(`${failedCount}名の招集に失敗しました。BO状況を確認してください。`);
      }

      refreshRoomsStatusSoon();
    } catch (err) {
      console.error('Summon all failed:', err);
      alert('全員招集に失敗しました。もう一度お試しください。');
    } finally {
      setIsMoving(null);
    }
  }, [isMoving, onMoveInstructor, refreshRoomsStatusSoon, roomsStatus, selfIdentity]
  );

  const breakoutParticipantCount = BREAKOUT_ROOMS.reduce(
    (count, room) => count + (roomsStatus?.[room]?.length || 0),
    0
  );

  return (
    <>
      {/* モバイル: ドロワー開放時の暗転バックドロップ */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onCloseDrawer}
          aria-hidden
        />
      )}

      <aside
        className={`bg-stone-800 border-l border-stone-700 flex flex-col overflow-hidden
          fixed inset-y-0 right-0 z-40 w-80 max-w-[85vw] transform transition-transform
          md:relative md:transform-none md:translate-x-0 md:w-72 md:flex-shrink-0
          ${drawerOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}`}
      >
        <div className="px-4 py-3 border-b border-stone-700 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-stone-200">講師ダッシュボード</h2>
            <p className="text-xs text-stone-400">{instructorName}</p>
          </div>
          {/* モバイルのみ表示する閉じるボタン */}
          {onCloseDrawer && (
            <button
              onClick={onCloseDrawer}
              className="md:hidden p-1.5 rounded hover:bg-stone-700 text-stone-400"
              aria-label="ダッシュボードを閉じる"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

      <div className="flex-1 overflow-y-auto">
        {/* 収録モード（YouTube/Podcast 用レイアウト） */}
        {onEnterStudio && currentRoom === 'main' && (
          <section className="p-3 border-b border-stone-700">
            <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wider mb-2">
              🎬 収録モード
            </h3>
            <button
              onClick={onEnterStudio}
              className="w-full rounded-lg bg-rose-700/80 px-3 py-2 text-sm font-medium text-white hover:bg-rose-600 transition-colors"
            >
              収録レイアウトを開始
            </button>
            <p className="mt-1.5 text-[11px] leading-snug text-stone-500">
              出演者を横並び表示にし、操作UIを自動格納します。YouTube/Podcast 収録向け。
            </p>
          </section>
        )}

        {/* Instructor self movement */}
        <section className="p-3 border-b border-stone-700">
          <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wider mb-2">
            講師の移動
          </h3>
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <span className="text-stone-500">現在</span>
            <span className="min-w-0 truncate font-medium text-stone-200">
              {ROOM_LABELS[currentRoom]}
            </span>
          </div>
          {currentRoom !== 'main' && (
            <button
              onClick={() => moveInstructorToRoom('main')}
              className="mb-2 w-full rounded-lg bg-stone-100 px-3 py-2 text-sm font-medium text-stone-900 hover:bg-white transition-colors"
            >
              メインへ戻る
            </button>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            {BREAKOUT_ROOMS.map((room) => {
              const isCurrent = currentRoom === room;
              return (
                <button
                  key={room}
                  onClick={() => moveInstructorToRoom(room)}
                  disabled={isCurrent}
                  className={`rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                    isCurrent
                      ? 'bg-green-800/50 text-green-200 cursor-default'
                      : 'bg-stone-700 text-stone-200 hover:bg-stone-600'
                  }`}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  {ROOM_LABELS[room].replace('ブレイクアウト ', 'BO')}
                </button>
              );
            })}
          </div>
          <button
            onClick={summonAllToMain}
            disabled={breakoutParticipantCount === 0 || !!isMoving}
            className="mt-2 w-full rounded-lg bg-amber-700/80 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            全員をメインへ招集
            {breakoutParticipantCount > 0 && (
              <span className="ml-1 text-xs text-amber-100/80">({breakoutParticipantCount}名)</span>
            )}
          </button>
        </section>

        {/* Raised hands section */}
        {raisedHandEntries.length > 0 && (
          <section className="p-3 border-b border-stone-700">
            <h3 className="text-xs font-medium text-amber-400 uppercase tracking-wider mb-2">
              ✋ 挙手中 ({raisedHandEntries.length})
            </h3>
            <ul className="space-y-2">
              {raisedHandEntries.map((entry) => (
                <li key={entry.identity} className="bg-amber-900/30 rounded-lg p-2">
                  <p className="text-sm text-amber-200 font-medium mb-1">{entry.name}</p>
                  <div className="flex gap-1 flex-wrap">
                    {BREAKOUT_ROOMS.map((room) => (
                      <button
                        key={room}
                        onClick={() => moveParticipantToRoom(entry.identity, entry.name, room)}
                        disabled={isMoving === entry.identity}
                        className="text-xs px-2 py-1 rounded bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
                      >
                        {room.toUpperCase()}へ
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* All participants section */}
        <section className="p-3 border-b border-stone-700">
          <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wider mb-2">
            参加者 ({students.length})
          </h3>
          <ul className="space-y-2">
            {students.map((participant) => {
              let meta: ParticipantMetadata | null = null;
              try {
                if (participant.metadata) meta = JSON.parse(participant.metadata);
              } catch {}

              const isMicOn = participant.isMicrophoneEnabled;
              const participantName = participant.name ?? participant.identity;

              return (
                <li key={participant.identity} className="rounded-lg bg-stone-700/50 p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-stone-200 font-medium">
                      {participantName}
                      {meta?.raisedHand && ' ✋'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onSetParticipantMic(participant.identity, !isMicOn)}
                        className={`text-xs px-1.5 py-0.5 rounded transition-colors ${
                          isMicOn
                            ? 'bg-green-700/50 text-green-200 hover:bg-green-700/70'
                            : 'bg-stone-600 text-stone-300 hover:bg-stone-500'
                        }`}
                        title={isMicOn ? 'マイクをOFFにする' : 'マイクをONにする'}
                        aria-label={isMicOn ? 'マイクをOFFにする' : 'マイクをONにする'}
                      >
                        {isMicOn ? '🎤' : '🔇'}
                      </button>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          participant.connectionQuality === 'excellent' ||
                          participant.connectionQuality === 'good'
                            ? 'bg-green-400'
                            : 'bg-yellow-400'
                        }`}
                      />
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {currentRoom === 'main' ? (
                      BREAKOUT_ROOMS.map((room) => (
                        <button
                          key={room}
                          onClick={() =>
                            moveParticipantToRoom(
                              participant.identity,
                              participantName,
                              room
                            )
                          }
                          disabled={!!isMoving}
                          className="text-xs px-2 py-1 rounded bg-stone-600 text-stone-200 hover:bg-stone-500 disabled:opacity-50 transition-colors"
                        >
                          {room.toUpperCase()}へ
                        </button>
                      ))
                    ) : (
                      <button
                        onClick={() =>
                          moveParticipantToRoom(participant.identity, participantName, 'main')
                        }
                        disabled={!!isMoving}
                        className="text-xs px-2 py-1 rounded bg-stone-100 text-stone-900 hover:bg-white disabled:opacity-50 transition-colors"
                      >
                        メインへ
                      </button>
                    )}
                    <button
                      onClick={() => removeParticipant(participant.identity, participantName)}
                      disabled={!!isMoving}
                      className="text-xs px-2 py-1 rounded bg-red-700/80 text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                    >
                      退出
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Breakout rooms status */}
        <section className="p-3">
          <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wider mb-2">
            ブレイクアウト状況
          </h3>
          <ul className="space-y-2">
            {BREAKOUT_ROOMS.map((room) => {
              const roomParticipants = roomsStatus?.[room] || [];
              const isActive = currentRoom === room;
              return (
                <li
                  key={room}
                  className={`rounded-lg p-2 text-xs flex flex-col gap-1.5 ${
                    isActive
                      ? 'bg-green-800/30 border border-green-700/40'
                      : 'bg-stone-700/30 border border-stone-700/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`font-semibold ${isActive ? 'text-green-300' : 'text-stone-300'}`}>
                      {ROOM_LABELS[room]}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {isActive && <span className="text-[10px] text-green-400">● 入室中</span>}
                      {roomParticipants.length > 0 ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-600/20 text-amber-400 font-medium">
                          {roomParticipants.length}名
                        </span>
                      ) : (
                        <span className="text-[10px] text-stone-500">空室</span>
                      )}
                    </div>
                  </div>

                  {/* 部屋のメンバーリスト */}
                  {roomParticipants.length > 0 && (
                    <div className="flex flex-col gap-1 pl-1.5 border-l border-stone-700/60 mt-0.5">
                      {roomParticipants.map((p) => (
                        <div key={p.identity} className="flex flex-col gap-1 rounded bg-stone-800/40 p-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span
                              className={
                                p.role === 'instructor'
                                  ? 'text-amber-400 font-medium'
                                  : 'text-stone-300'
                              }
                            >
                              {p.name}
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.2 rounded scale-90 origin-right ${
                              p.role === 'instructor'
                                ? 'bg-amber-950/40 text-amber-400 border border-amber-800/30'
                                : 'bg-stone-800 text-stone-400 border border-stone-750'
                            }`}>
                              {p.role === 'instructor' ? '講師' : '受講生'}
                            </span>
                          </div>
                          {p.identity !== selfIdentity && (
                            <div className="flex justify-end gap-1">
                              <button
                                onClick={() => moveParticipantToRoom(p.identity, p.name, 'main', room)}
                                disabled={!!isMoving}
                                className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-900 hover:bg-white disabled:opacity-50 transition-colors"
                              >
                                メインへ
                              </button>
                              <button
                                onClick={() => removeParticipant(p.identity, p.name, room)}
                                disabled={!!isMoving}
                                className="rounded bg-red-700/80 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-red-600 disabled:opacity-50 transition-colors"
                              >
                                退出
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
      </aside>
    </>
  );
}
