'use client';

import { useMemo, useState } from 'react';
import {
  VideoTrack,
  useTracks,
  useParticipants,
  isTrackReference,
} from '@livekit/components-react';
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

interface TileItem {
  participant: Participant;
  trackRef: TrackReference | null;
  /** screen-share タイルかどうか。1人が camera と screen 両方持ってると2タイル出す */
  source: 'camera' | 'screen' | 'none';
}

export function ParticipantGrid({ focused, onFocus, instructorContext }: ParticipantGridProps) {
  const tracks = useTracks(
    [Track.Source.ScreenShare, Track.Source.Camera],
    { onlySubscribed: false }
  );
  const participants = useParticipants();

  const tiles = useMemo<TileItem[]>(() => {
    const list: TileItem[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      if (!isTrackReference(t)) continue;
      const src = t.source === Track.Source.ScreenShare ? 'screen' : 'camera';
      list.push({ participant: t.participant, trackRef: t, source: src });
      seen.add(`${t.participant.identity}:${src}`);
    }
    for (const p of participants) {
      const hasCam = seen.has(`${p.identity}:camera`);
      const hasScreen = seen.has(`${p.identity}:screen`);
      if (!hasCam && !hasScreen) {
        list.push({ participant: p, trackRef: null, source: 'none' });
      }
    }
    return list;
  }, [tracks, participants]);

  if (tiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-stone-500 text-sm">
        参加者がいません
      </div>
    );
  }

  const focusedTile = focused ? tiles.find((t) => t.participant.identity === focused) : null;

  if (focusedTile) {
    return (
      <div className="h-full flex flex-col gap-2">
        <Tile
          item={focusedTile}
          large
          onClick={() => onFocus(null)}
          instructorContext={instructorContext}
          extraTopRight={
            <button
              onClick={() => onFocus(null)}
              className="bg-black/50 text-white text-xs px-2 py-1 rounded hover:bg-black/70"
            >
              グリッドに戻る
            </button>
          }
        />
        <ThumbnailRow tiles={tiles} onFocus={onFocus} />
      </div>
    );
  }

  const cols = tiles.length === 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4;

  return (
    <div
      className="grid gap-2 h-full"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {tiles.map((item) => (
        <Tile
          key={`${item.participant.identity}-${item.source}`}
          item={item}
          onClick={() => onFocus(item.participant.identity)}
          instructorContext={instructorContext}
        />
      ))}
    </div>
  );
}

function Tile({
  item,
  large = false,
  onClick,
  instructorContext,
  extraTopRight,
}: {
  item: TileItem;
  large?: boolean;
  onClick: () => void;
  instructorContext?: InstructorActionContext;
  extraTopRight?: React.ReactNode;
}) {
  const { participant, trackRef, source } = item;
  const name = participant.name?.trim() || participant.identity;

  let meta: ParticipantMetadata | null = null;
  try {
    if (participant.metadata) meta = JSON.parse(participant.metadata);
  } catch {}

  return (
    <div
      className={`group rounded-lg overflow-hidden bg-stone-800 relative ${large ? 'flex-1' : 'cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all'}`}
      onClick={large ? undefined : onClick}
    >
      <div className="aspect-video w-full bg-stone-900 flex items-center justify-center">
        {trackRef ? (
          <VideoTrack trackRef={trackRef} className="w-full h-full object-contain" />
        ) : (
          <AvatarPlaceholder name={name} />
        )}
      </div>

      <div className="flex items-center justify-center gap-1.5 bg-stone-900/90 px-2 py-1 border-t border-stone-700">
        {meta?.raisedHand && <span className="text-sm leading-none">✋</span>}
        <span className="text-xs font-medium text-stone-100 truncate" title={name}>
          {name}
        </span>
        {source === 'screen' && (
          <span className="text-[10px] uppercase tracking-wide text-amber-400">screen</span>
        )}
        <MicIndicator participant={participant} />
      </div>

      {extraTopRight && <div className="absolute top-2 right-2">{extraTopRight}</div>}

      {instructorContext &&
        participant.identity !== instructorContext.selfIdentity && (
          <KickButton participant={participant} instructorContext={instructorContext} />
        )}
    </div>
  );
}

function AvatarPlaceholder({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center text-stone-400">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-stone-700 text-2xl font-semibold text-stone-200">
        {initial}
      </div>
    </div>
  );
}

function MicIndicator({ participant }: { participant: Participant }) {
  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;
  return (
    <span
      className={`text-xs leading-none ${muted ? 'text-stone-500' : 'text-emerald-400'}`}
      aria-label={muted ? 'マイクオフ' : 'マイクオン'}
      title={muted ? 'マイクオフ' : 'マイクオン'}
    >
      {muted ? '🔇' : '🎤'}
    </span>
  );
}

function ThumbnailRow({
  tiles,
  onFocus,
}: {
  tiles: TileItem[];
  onFocus: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto h-24 flex-shrink-0">
      {tiles.map((item) => {
        const name = item.participant.name?.trim() || item.participant.identity;
        return (
          <div
            key={`thumb-${item.participant.identity}-${item.source}`}
            className="h-full aspect-video rounded overflow-hidden bg-stone-700 relative cursor-pointer flex-shrink-0"
            onClick={() => onFocus(item.participant.identity)}
            title={name}
          >
            {item.trackRef ? (
              <VideoTrack trackRef={item.trackRef} className="w-full h-full object-contain" />
            ) : (
              <AvatarPlaceholder name={name} />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate text-center">
              {name}
            </div>
          </div>
        );
      })}
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
