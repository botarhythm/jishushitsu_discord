'use client';

import { useState, useCallback } from 'react';
import { Participant, Track } from 'livekit-client';
import { RoomName, ParticipantMetadata, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';

interface InstructorDashboardProps {
  participants: Participant[];
  currentRoom: RoomName;
  instructorKey: string;
  instructorName: string;
  onMoveParticipant: (room: RoomName) => void;
  /** モバイル時のドロワー開閉状態（PCでは無視） */
  drawerOpen?: boolean;
  /** モバイル時の閉じる動作 */
  onCloseDrawer?: () => void;
}

interface RaisedHandEntry {
  identity: string;
  name: string;
  raisedAt: string;
}

export default function InstructorDashboard({
  participants,
  currentRoom,
  instructorKey,
  instructorName,
  onMoveParticipant,
  drawerOpen = false,
  onCloseDrawer,
}: InstructorDashboardProps) {
  const [isMoving, setIsMoving] = useState<string | null>(null);
  const [isMuting, setIsMuting] = useState<string | null>(null);

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

  const toggleMute = useCallback(
    async (participant: Participant) => {
      if (isMuting) return;
      const audioPub = participant.getTrackPublication(Track.Source.Microphone);
      const trackSid = audioPub?.trackSid;
      if (!trackSid) {
        alert('この参加者はマイクを公開していません');
        return;
      }
      const shouldMute = !audioPub.isMuted;
      setIsMuting(participant.identity);
      try {
        const res = await fetch('/api/mute-participant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instructorKey,
            roomName: currentRoom,
            participantIdentity: participant.identity,
            trackSid,
            muted: shouldMute,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`操作に失敗しました: ${err.error ?? res.status}`);
        }
      } catch (err) {
        console.error('Mute failed:', err);
        alert('操作に失敗しました。もう一度お試しください。');
      } finally {
        setIsMuting(null);
      }
    },
    [currentRoom, instructorKey, isMuting]
  );

  const moveParticipantToRoom = useCallback(
    async (participantIdentity: string, participantName: string, targetRoom: RoomName) => {
      if (isMoving) return;

      setIsMoving(participantIdentity);

      try {
        // Send move command to target participant via server
        const res = await fetch('/api/move-participant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instructorKey,
            participantIdentity,
            targetRoomName: targetRoom,
            currentRoomName: currentRoom,
            participantName,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          alert(`移動に失敗しました: ${err.error}`);
          return;
        }

        // Move instructor to the same BO
        onMoveParticipant(targetRoom);
      } catch (err) {
        console.error('Move failed:', err);
        alert('移動に失敗しました。もう一度お試しください。');
      } finally {
        setIsMoving(null);
      }
    },
    [currentRoom, instructorKey, isMoving, onMoveParticipant]
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

              const audioPub = participant.getTrackPublication(Track.Source.Microphone);
              const hasMicTrack = !!audioPub?.trackSid;
              const isMicMuted = !audioPub || audioPub.isMuted;

              return (
                <li key={participant.identity} className="rounded-lg bg-stone-700/50 p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-stone-200 font-medium">
                      {participant.name ?? participant.identity}
                      {meta?.raisedHand && ' ✋'}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => toggleMute(participant)}
                        disabled={!hasMicTrack || isMuting === participant.identity}
                        className={`text-xs px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          isMicMuted
                            ? 'bg-stone-600 text-stone-300 hover:bg-stone-500'
                            : 'bg-green-700/50 text-green-200 hover:bg-green-700/70'
                        }`}
                        title={
                          !hasMicTrack
                            ? 'マイク未公開'
                            : isMicMuted
                              ? 'マイクを解除'
                              : 'マイクをミュート'
                        }
                        aria-label={isMicMuted ? 'マイクを解除' : 'マイクをミュート'}
                      >
                        {isMicMuted ? '🔇' : '🎤'}
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
                  {currentRoom === 'main' && (
                    <div className="flex gap-1 flex-wrap">
                      {BREAKOUT_ROOMS.map((room) => (
                        <button
                          key={room}
                          onClick={() =>
                            moveParticipantToRoom(
                              participant.identity,
                              participant.name ?? participant.identity,
                              room
                            )
                          }
                          disabled={!!isMoving}
                          className="text-xs px-2 py-1 rounded bg-stone-600 text-stone-200 hover:bg-stone-500 disabled:opacity-50 transition-colors"
                        >
                          {room.toUpperCase()}へ
                        </button>
                      ))}
                    </div>
                  )}
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
          <ul className="space-y-1.5">
            {BREAKOUT_ROOMS.map((room) => (
              <li
                key={room}
                className={`rounded-lg px-3 py-2 text-xs ${
                  currentRoom === room
                    ? 'bg-green-800/40 text-green-300'
                    : 'bg-stone-700/30 text-stone-400'
                }`}
              >
                <span className="font-medium">{ROOM_LABELS[room]}</span>
                {currentRoom === room && (
                  <span className="ml-2 text-green-400">● 使用中</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      </aside>
    </>
  );
}
