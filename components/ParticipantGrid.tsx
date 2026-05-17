'use client';

import { useState } from 'react';
import { VideoTrack, useTracks, isTrackReference } from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { Track, Participant } from 'livekit-client';
import { ParticipantMetadata, RoomName } from '@/lib/types';

export interface InstructorActionContext {
  currentRoom: RoomName;
  selfIdentity: string;
}

interface ParticipantGridProps {
  focused: string | null;
  onFocus: (id: string | null) => void;
  instructorContext?: InstructorActionContext;
}

export function ParticipantGrid({ focused, onFocus, instructorContext }: ParticipantGridProps) {
  const tracks = useTracks(
    [Track.Source.ScreenShare, Track.Source.Camera],
    { onlySubscribed: false }
  );

  if (tracks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-stone-500 text-sm">
        まだ誰も画面共有していません
      </div>
    );
  }

  const allVideoTracks = tracks.filter(isTrackReference);
  const focusedTrack = focused
    ? allVideoTracks.find((t) => t.participant.identity === focused)
    : null;

  if (focusedTrack) {
    return (
      <div className="h-full flex flex-col gap-2">
        <div className="group flex-1 rounded-lg overflow-hidden bg-stone-800 relative">
          <VideoTrack trackRef={focusedTrack} className="w-full h-full object-contain" />
          <div className="absolute bottom-2 left-2 bg-black/50 text-white text-xs px-2 py-1 rounded">
            {focusedTrack.participant.name}
          </div>
          <button
            onClick={() => onFocus(null)}
            className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2 py-1 rounded hover:bg-black/70"
          >
            グリッドに戻る
          </button>
          {instructorContext &&
            focusedTrack.participant.identity !== instructorContext.selfIdentity && (
              <KickButton
                participant={focusedTrack.participant}
                instructorContext={instructorContext}
              />
            )}
        </div>
        <ThumbnailRow tracks={allVideoTracks} onFocus={onFocus} />
      </div>
    );
  }

  const videoTracks = tracks.filter(isTrackReference);
  const cols = videoTracks.length === 1 ? 1 : videoTracks.length <= 4 ? 2 : videoTracks.length <= 9 ? 3 : 4;

  return (
    <div
      className="grid gap-2 h-full"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {videoTracks.map((trackRef) => (
        <div
          key={`${trackRef.participant.identity}-${trackRef.source}`}
          className="group rounded-lg overflow-hidden bg-stone-800 relative cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all"
          onClick={() => onFocus(trackRef.participant.identity)}
        >
          <VideoTrack trackRef={trackRef} className="w-full h-full object-contain" />
          <ParticipantLabel participant={trackRef.participant} />
          {instructorContext &&
            trackRef.participant.identity !== instructorContext.selfIdentity && (
              <KickButton
                participant={trackRef.participant}
                instructorContext={instructorContext}
              />
            )}
        </div>
      ))}
    </div>
  );
}

function ThumbnailRow({
  tracks,
  onFocus,
}: {
  tracks: TrackReference[];
  onFocus: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto h-24 flex-shrink-0">
      {tracks.map((trackRef) => (
        <div
          key={`thumb-${trackRef.participant.identity}-${trackRef.source}`}
          className="h-full aspect-video rounded overflow-hidden bg-stone-700 relative cursor-pointer flex-shrink-0"
          onClick={() => onFocus(trackRef.participant.identity)}
        >
          <VideoTrack trackRef={trackRef} className="w-full h-full object-contain" />
        </div>
      ))}
    </div>
  );
}

function ParticipantLabel({ participant }: { participant: Participant }) {
  let meta: ParticipantMetadata | null = null;
  try {
    if (participant.metadata) meta = JSON.parse(participant.metadata);
  } catch {}

  return (
    <div className="absolute bottom-1 left-1 flex items-center gap-1">
      <span className="bg-black/50 text-white text-xs px-1.5 py-0.5 rounded">
        {participant.name}
      </span>
      {meta?.raisedHand && <span className="text-base">✋</span>}
    </div>
  );
}

function KickButton({
  participant,
  instructorContext,
}: {
  participant: Participant;
  instructorContext: InstructorActionContext;
}) {
  const [pending, setPending] = useState(false);
  const name = participant.name ?? participant.identity;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    if (!confirm(`${name}さんを退出させますか？`)) return;
    setPending(true);
    try {
      const res = await fetch('/api/remove-participant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: instructorContext.currentRoom,
          participantIdentity: participant.identity,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`退出処理に失敗しました: ${err.error ?? res.status}`);
      }
    } catch (err) {
      console.error('Remove participant failed:', err);
      alert('退出処理に失敗しました。もう一度お試しください。');
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-red-600/90 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-500 disabled:opacity-40"
      aria-label={`${name}さんを退出させる`}
      title={`${name}さんを退出させる`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
      <span>退出</span>
    </button>
  );
}
