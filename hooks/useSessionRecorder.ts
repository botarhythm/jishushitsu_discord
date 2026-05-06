'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
  RemoteTrack,
  Track,
  RoomEvent,
  type LocalTrackPublication,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';
import { SessionAudioRecorder } from '@/lib/audio-recorder';

export interface SessionRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

interface UseSessionRecorderOptions {
  /** 録音を有効にするか（講師のみ true 想定） */
  enabled: boolean;
}

/**
 * 自習室の全員の音声をブラウザで録音する hook。
 *
 * 動作:
 *   1. enabled === true で AudioContext + MediaRecorder を起動
 *   2. ローカルマイクと、購読済み/今後購読する全リモート音声トラックをミックス対象に追加
 *   3. 参加者離脱時はソース切断
 *   4. stop() で Blob を返す
 *
 * 注意:
 *   - 講師ブラウザのタブを閉じると録音が失われる（beforeunload で警告する設計）
 *   - 録音時間は AudioContext のセッション内で連続。長時間（3h+）はブラウザによっては不安定
 */
export function useSessionRecorder({ enabled }: UseSessionRecorderOptions) {
  const room = useRoomContext();
  const recorderRef = useRef<SessionAudioRecorder | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !room) return;

    let cancelled = false;
    const recorder = new SessionAudioRecorder();
    recorderRef.current = recorder;

    const subscribeToExisting = () => {
      // ローカルマイクトラック
      const localPublication = room.localParticipant.getTrackPublication(
        Track.Source.Microphone
      ) as LocalTrackPublication | undefined;
      if (localPublication?.track?.mediaStreamTrack) {
        recorder.addTrack(
          `local-${localPublication.trackSid}`,
          localPublication.track.mediaStreamTrack
        );
      }
      // 既に購読済みのリモート音声トラック
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          if (pub.track?.mediaStreamTrack) {
            recorder.addTrack(`remote-${pub.trackSid}`, pub.track.mediaStreamTrack);
          }
        });
      });
    };

    const handleTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication,
      _participant: RemoteParticipant
    ) => {
      if (track.kind === Track.Kind.Audio && track.mediaStreamTrack) {
        recorder.addTrack(`remote-${publication.trackSid}`, track.mediaStreamTrack);
      }
    };

    const handleTrackUnsubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication
    ) => {
      recorder.removeTrack(`remote-${publication.trackSid}`);
    };

    const handleLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (
        publication.track?.kind === Track.Kind.Audio &&
        publication.track.mediaStreamTrack
      ) {
        recorder.addTrack(
          `local-${publication.trackSid}`,
          publication.track.mediaStreamTrack
        );
      }
    };

    (async () => {
      try {
        await recorder.start();
        if (cancelled) {
          recorder.abort();
          return;
        }
        subscribeToExisting();
        room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
        room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
        room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
        setIsRecording(true);
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
      recorderRef.current?.abort();
      recorderRef.current = null;
      setIsRecording(false);
    };
  }, [enabled, room]);

  // タブ閉じる前の警告
  useEffect(() => {
    if (!isRecording) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '録音中です。タブを閉じると録音が失われます。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording]);

  const stopRecording = useCallback(async (): Promise<SessionRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    try {
      const result = await recorder.stopAndFinalize();
      setIsRecording(false);
      return result;
    } catch (err) {
      console.error('[recorder] stop failed:', err);
      return null;
    } finally {
      recorderRef.current = null;
    }
  }, []);

  return { isRecording, error, stopRecording };
}
