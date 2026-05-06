'use client';

import { useCallback, useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useParticipants,
  useLocalParticipant,
  useDataChannel,
  VideoTrack,
  useTracks,
  isTrackReference,
} from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { Track, Participant } from 'livekit-client';
import { RoomName, UserRole, ParticipantMetadata, ROOM_LABELS, BREAKOUT_ROOMS } from '@/lib/types';
import InstructorDashboard from './InstructorDashboard';

interface RoomViewProps {
  token: string;
  livekitUrl: string;
  participantName: string;
  role: UserRole;
  currentRoom: RoomName;
  instructorKey?: string;
  onRoomChange: (room: RoomName) => void;
}

export default function RoomView(props: RoomViewProps) {
  return (
    <LiveKitRoom
      token={props.token}
      serverUrl={props.livekitUrl}
      connect={true}
      audio={true}
      video={false}
      className="h-screen flex flex-col bg-stone-900"
      options={{ adaptiveStream: true, dynacast: true }}
    >
      <RoomAudioRenderer />
      <RoomInner {...props} />
    </LiveKitRoom>
  );
}

function RoomInner({
  participantName,
  role,
  currentRoom,
  instructorKey,
  onRoomChange,
}: RoomViewProps) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [raisedHand, setRaisedHand] = useState(false);
  const [focusedParticipant, setFocusedParticipant] = useState<string | null>(null);
  const isInstructor = role === 'instructor';
  const isBreakout = currentRoom !== 'main';

  // Handle incoming data channel messages (room move commands)
  useDataChannel((msg) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === 'move-to-room') {
        onRoomChange(data.payload.targetRoom as RoomName);
      }
    } catch {
      // ignore malformed messages
    }
  });

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!isMicOn);
    setIsMicOn(!isMicOn);
  }, [localParticipant, isMicOn]);

  const toggleCamera = useCallback(async () => {
    await localParticipant.setCameraEnabled(!isCameraOn);
    setIsCameraOn(!isCameraOn);
  }, [localParticipant, isCameraOn]);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (isScreenSharing) {
        await localParticipant.setScreenShareEnabled(false);
      } else {
        await localParticipant.setScreenShareEnabled(true);
      }
      setIsScreenSharing(!isScreenSharing);
    } catch {
      setIsScreenSharing(false);
    }
  }, [localParticipant, isScreenSharing]);

  const toggleRaiseHand = useCallback(async () => {
    const newState = !raisedHand;
    const metadata: ParticipantMetadata = {
      raisedHand: newState,
      raisedAt: newState ? new Date().toISOString() : null,
    };
    await localParticipant.setMetadata(JSON.stringify(metadata));
    setRaisedHand(newState);
  }, [localParticipant, raisedHand]);

  const returnToMain = useCallback(() => {
    onRoomChange('main');
  }, [onRoomChange]);

  const handleEndBreakout = useCallback(async () => {
    // Notify all participants in this BO to return to main
    const encoder = new TextEncoder();
    const message = JSON.stringify({ type: 'move-to-room', payload: { targetRoom: 'main' } });
    await room.localParticipant.publishData(encoder.encode(message), {
      reliable: true,
    });
    onRoomChange('main');
  }, [room, onRoomChange]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-stone-800 border-b border-stone-700">
          <div className="flex items-center gap-3">
            <span className="text-stone-300 text-sm font-medium">{ROOM_LABELS[currentRoom]}</span>
            {isBreakout && (
              <span className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded-full">
                ブレイクアウト中
              </span>
            )}
          </div>
          <span className="text-stone-400 text-sm">{participantName}</span>
        </div>

        {/* Participant grid */}
        <div className="flex-1 overflow-auto p-3">
          <ParticipantGrid
            participants={participants}
            focused={focusedParticipant}
            onFocus={setFocusedParticipant}
          />
        </div>

        {/* Breakout list (main room only) */}
        {!isBreakout && (
          <BreakoutList currentRoom={currentRoom} role={role} onJoin={onRoomChange} />
        )}

        {/* Control bar */}
        <ControlBar
          isMicOn={isMicOn}
          isCameraOn={isCameraOn}
          isScreenSharing={isScreenSharing}
          raisedHand={raisedHand}
          isInstructor={isInstructor}
          isBreakout={isBreakout}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleRaiseHand={toggleRaiseHand}
          onReturnToMain={returnToMain}
          onEndBreakout={handleEndBreakout}
        />
      </div>

      {/* Instructor dashboard (instructor only) */}
      {isInstructor && instructorKey && (
        <InstructorDashboard
          participants={participants}
          currentRoom={currentRoom}
          instructorKey={instructorKey}
          instructorName={participantName}
          onMoveParticipant={onRoomChange}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────
// ParticipantGrid
// ────────────────────────────────────────────
function ParticipantGrid({
  participants,
  focused,
  onFocus,
}: {
  participants: Participant[];
  focused: string | null;
  onFocus: (id: string | null) => void;
}) {
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
        <div className="flex-1 rounded-lg overflow-hidden bg-stone-800 relative">
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
          className="rounded-lg overflow-hidden bg-stone-800 relative cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all"
          onClick={() => onFocus(trackRef.participant.identity)}
        >
          <VideoTrack trackRef={trackRef} className="w-full h-full object-contain" />
          <ParticipantLabel participant={trackRef.participant} />
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

// ────────────────────────────────────────────
// BreakoutList
// ────────────────────────────────────────────
function BreakoutList({
  currentRoom,
  role,
  onJoin,
}: {
  currentRoom: RoomName;
  role: UserRole;
  onJoin: (room: RoomName) => void;
}) {
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

// ────────────────────────────────────────────
// ControlBar
// ────────────────────────────────────────────
function ControlBar({
  isMicOn,
  isCameraOn,
  isScreenSharing,
  raisedHand,
  isInstructor,
  isBreakout,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRaiseHand,
  onReturnToMain,
  onEndBreakout,
}: {
  isMicOn: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  raisedHand: boolean;
  isInstructor: boolean;
  isBreakout: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleRaiseHand: () => void;
  onReturnToMain: () => void;
  onEndBreakout: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3 px-4 py-3 bg-stone-800 border-t border-stone-700">
      <ControlButton
        label={isMicOn ? 'マイクOFF' : 'マイクON'}
        active={isMicOn}
        icon={isMicOn ? '🎤' : '🔇'}
        onClick={onToggleMic}
      />
      <ControlButton
        label={isCameraOn ? 'カメラOFF' : 'カメラON'}
        active={isCameraOn}
        icon={isCameraOn ? '📷' : '📵'}
        onClick={onToggleCamera}
      />
      <ControlButton
        label={isScreenSharing ? '共有停止' : '画面共有'}
        active={isScreenSharing}
        icon="🖥️"
        onClick={onToggleScreenShare}
      />

      {!isInstructor && !isBreakout && (
        <button
          onClick={onToggleRaiseHand}
          className={`flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
            raisedHand
              ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/30'
              : 'bg-stone-700 text-stone-300 hover:bg-stone-600'
          }`}
          aria-label={raisedHand ? '挙手を取り消す' : '挙手する'}
          aria-pressed={raisedHand}
        >
          <span className="text-lg">✋</span>
          <span>{raisedHand ? '挙手中' : '挙手'}</span>
        </button>
      )}

      {isBreakout && (
        <button
          onClick={onReturnToMain}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-stone-700 text-stone-300 hover:bg-stone-600 transition-colors"
        >
          <span className="text-lg">🚪</span>
          <span>メインに戻る</span>
        </button>
      )}

      {isInstructor && isBreakout && (
        <button
          onClick={onEndBreakout}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
        >
          <span className="text-lg">⏹️</span>
          <span>終了してメインへ</span>
        </button>
      )}
    </div>
  );
}

function ControlButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
        active
          ? 'bg-stone-600 text-white'
          : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
      }`}
    >
      <span className="text-lg">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
