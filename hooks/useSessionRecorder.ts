'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
  RemoteTrack,
  Track,
  RoomEvent,
  type LocalTrackPublication,
  type RemoteTrackPublication,
} from 'livekit-client';
import { SessionAudioRecorder } from '@/lib/audio-recorder';
import type { RoomName } from '@/lib/types';

export interface RoomRecording {
  room: RoomName;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  startedAt: number;
}

interface UseSessionRecorderOptions {
  /** 録音を有効にするか（講師のみ true 想定） */
  enabled: boolean;
  /** 現在いるルーム（変わったら新しいファイルとして録音し直す） */
  currentRoom: RoomName;
}

/**
 * 自習室の音声を **ルームごとに別ファイル** として録音する hook。
 *
 * 動作:
 *   - enabled === true で AudioContext + MediaRecorder を起動
 *   - currentRoom が変わるとそのタイミングで現在の録音を確定保存し、
 *     新しいルーム用の録音を開始する
 *   - finalizeAll() で「現在進行中の録音」もクローズし、配列を返す
 *
 * 結果として、メインルームとブレイクアウトの会話が独立した録音ファイルになり、
 * EchoNote 側で別セッションとして要約される。
 */
export function useSessionRecorder({ enabled, currentRoom }: UseSessionRecorderOptions) {
  const room = useRoomContext();
  const recorderRef = useRef<SessionAudioRecorder | null>(null);
  const recorderRoomRef = useRef<RoomName | null>(null);
  const recorderStartedAtRef = useRef<number | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [currentRoomLabel, setCurrentRoomLabel] = useState<RoomName | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [completedRecordings, setCompletedRecordings] = useState<RoomRecording[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !room) return;

    let cancelled = false;
    const audioRecorder = new SessionAudioRecorder();
    const startedAt = Date.now();
    const thisRoom = currentRoom;

    const subscribeToExisting = () => {
      const localPublication = room.localParticipant.getTrackPublication(
        Track.Source.Microphone
      ) as LocalTrackPublication | undefined;
      if (localPublication?.track?.mediaStreamTrack) {
        audioRecorder.addTrack(
          `local-${localPublication.trackSid}`,
          localPublication.track.mediaStreamTrack
        );
      }
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          if (pub.track?.mediaStreamTrack) {
            audioRecorder.addTrack(`remote-${pub.trackSid}`, pub.track.mediaStreamTrack);
          }
        });
      });
    };

    const handleTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication
    ) => {
      if (track.kind === Track.Kind.Audio && track.mediaStreamTrack) {
        audioRecorder.addTrack(`remote-${publication.trackSid}`, track.mediaStreamTrack);
      }
    };

    const handleTrackUnsubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication
    ) => {
      audioRecorder.removeTrack(`remote-${publication.trackSid}`);
    };

    const handleLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (
        publication.track?.kind === Track.Kind.Audio &&
        publication.track.mediaStreamTrack
      ) {
        audioRecorder.addTrack(
          `local-${publication.trackSid}`,
          publication.track.mediaStreamTrack
        );
      }
    };

    recorderRef.current = audioRecorder;
    recorderRoomRef.current = thisRoom;
    recorderStartedAtRef.current = startedAt;

    (async () => {
      try {
        await audioRecorder.start();
        if (cancelled) {
          audioRecorder.abort();
          return;
        }
        subscribeToExisting();
        room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
        room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
        room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
        setIsRecording(true);
        setCurrentRoomLabel(thisRoom);
        setStartedAt(startedAt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[recorder] start failed:', err);
        setError(`録音を開始できませんでした: ${msg}`);
      }
    })();

    return () => {
      cancelled = true;
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);

      // 現在の録音を確定して配列に追加（fire-and-forget）。
      // 1秒未満は誤検知（ルーム切替の瞬間など）として捨てる。
      if (audioRecorder.isRecording) {
        audioRecorder
          .stopAndFinalize()
          .then((result) => {
            if (result.durationMs >= 1000) {
              setCompletedRecordings((prev) => [
                ...prev,
                {
                  room: thisRoom,
                  blob: result.blob,
                  mimeType: result.mimeType,
                  durationMs: result.durationMs,
                  startedAt,
                },
              ]);
            }
          })
          .catch((err) => console.error('[recorder] finalize on transition failed:', err));
      } else {
        audioRecorder.abort();
      }

      if (recorderRef.current === audioRecorder) {
        recorderRef.current = null;
        recorderRoomRef.current = null;
        recorderStartedAtRef.current = null;
      }
      setIsRecording(false);
      setCurrentRoomLabel(null);
      setStartedAt(null);
    };
  }, [enabled, currentRoom, room]);

  // タブを閉じる前の警告
  useEffect(() => {
    if (!isRecording && completedRecordings.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '録音中または未送信の録音があります。タブを閉じると失われます。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording, completedRecordings.length]);

  /**
   * 進行中の録音をクローズし、これまでに蓄積された全録音の配列を返す。
   */
  const finalizeAll = useCallback(async (): Promise<RoomRecording[]> => {
    const recorder = recorderRef.current;
    const recorderRoom = recorderRoomRef.current;
    const startedAt = recorderStartedAtRef.current;
    const accumulated = [...completedRecordings];

    if (recorder && recorder.isRecording && recorderRoom && startedAt) {
      try {
        const result = await recorder.stopAndFinalize();
        if (result.durationMs >= 1000) {
          accumulated.push({
            room: recorderRoom,
            blob: result.blob,
            mimeType: result.mimeType,
            durationMs: result.durationMs,
            startedAt,
          });
        }
      } catch (err) {
        console.error('[recorder] finalizeAll failed:', err);
      } finally {
        recorderRef.current = null;
        recorderRoomRef.current = null;
        recorderStartedAtRef.current = null;
        setIsRecording(false);
        setCurrentRoomLabel(null);
        setStartedAt(null);
      }
    }
    setCompletedRecordings([]);
    return accumulated;
  }, [completedRecordings]);

  return {
    isRecording,
    currentRoomLabel,
    startedAt,
    completedRecordings,
    error,
    finalizeAll,
  };
}
