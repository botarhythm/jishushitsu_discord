'use client';

import { useCallback, useRef, useState } from 'react';
import type { Room, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';

interface UseLocalRecordingOptions {
  filePrefix?: string;
  includeMicrophone?: boolean;
  /** LiveKit Room。渡すとリモート参加者の音声を mix する */
  room?: Room | null;
}

interface RemoteAudioNode {
  identity: string;
  trackSid: string;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
}

interface RecordingResources {
  recorder: MediaRecorder;
  chunks: Blob[];
  displayStream: MediaStream;
  micStream: MediaStream | null;
  audioContext: AudioContext | null;
  audioDestination: MediaStreamAudioDestinationNode | null;
  remoteAudioNodes: Map<string, RemoteAudioNode>;
  detachListeners: () => void;
}

/**
 * ローカル録画フック。
 *
 * - getDisplayMedia でタブ/画面を取得
 * - includeMicrophone のときローカルマイクも mix
 * - room を渡すと LiveKit のリモート参加者音声を全て mix（録画に他人の声を確実に入れる）
 */
export function useLocalRecording({
  filePrefix = '自習室',
  includeMicrophone = true,
  room = null,
}: UseLocalRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resourcesRef = useRef<RecordingResources | null>(null);
  const stopRef = useRef<() => Promise<Blob | null>>(() => Promise.resolve(null));

  const cleanup = useCallback(() => {
    const r = resourcesRef.current;
    if (!r) return;
    r.detachListeners();
    r.displayStream.getTracks().forEach((t) => t.stop());
    r.micStream?.getTracks().forEach((t) => t.stop());
    r.remoteAudioNodes.forEach((n) => {
      try {
        n.source.disconnect();
      } catch {
        // ignore
      }
    });
    r.remoteAudioNodes.clear();
    r.audioContext?.close().catch(() => {});
    resourcesRef.current = null;
  }, []);

  const downloadBlob = useCallback(
    (blob: Blob) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const ext = blob.type.includes('webm')
        ? 'webm'
        : blob.type.includes('mp4')
          ? 'mp4'
          : 'webm';
      const fname = `${filePrefix}_${ts}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [filePrefix]
  );

  const stop = useCallback(async (): Promise<Blob | null> => {
    const r = resourcesRef.current;
    if (!r || r.recorder.state === 'inactive') {
      cleanup();
      setIsRecording(false);
      setStartedAt(null);
      return null;
    }
    return new Promise<Blob | null>((resolve) => {
      r.recorder.onstop = () => {
        const blob = new Blob(r.chunks, { type: r.recorder.mimeType });
        downloadBlob(blob);
        cleanup();
        setIsRecording(false);
        setStartedAt(null);
        resolve(blob);
      };
      r.recorder.stop();
    });
  }, [cleanup, downloadBlob]);

  stopRef.current = stop;

  const start = useCallback(async () => {
    setError(null);
    if (resourcesRef.current) return;

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // silent
      } else {
        setError(msg);
      }
      return;
    }

    let micStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let audioDestination: MediaStreamAudioDestinationNode | null = null;
    const remoteAudioNodes = new Map<string, RemoteAudioNode>();
    let finalStream = displayStream;
    let detachListeners: () => void = () => {};

    const willMixAudio = includeMicrophone || !!room;
    if (willMixAudio) {
      audioContext = new AudioContext();
      audioDestination = audioContext.createMediaStreamDestination();

      // タブ音声があれば足す
      const tabAudioTracks = displayStream.getAudioTracks();
      if (tabAudioTracks.length > 0 && audioContext && audioDestination) {
        try {
          const tabSrc = audioContext.createMediaStreamSource(
            new MediaStream(tabAudioTracks)
          );
          tabSrc.connect(audioDestination);
        } catch (e) {
          console.warn('[useLocalRecording] タブ音声接続失敗', e);
        }
      }

      // ローカルマイク
      if (includeMicrophone) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const micSrc = audioContext.createMediaStreamSource(micStream);
          micSrc.connect(audioDestination);
        } catch (micErr) {
          console.warn('[useLocalRecording] マイク取得失敗:', micErr);
        }
      }

      // LiveKit リモート音声トラックを追加
      const addRemoteTrack = (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (!audioContext || !audioDestination) return;
        const ms = track.mediaStream ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : null);
        if (!ms) return;
        const key = `${participant.identity}:${track.sid ?? Math.random()}`;
        if (remoteAudioNodes.has(key)) return;
        try {
          const source = audioContext.createMediaStreamSource(ms);
          source.connect(audioDestination);
          remoteAudioNodes.set(key, { identity: participant.identity, trackSid: track.sid ?? '', source, stream: ms });
        } catch (e) {
          console.warn('[useLocalRecording] リモート音声接続失敗', e);
        }
      };

      const removeRemoteTrack = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        const sid = track.sid ?? '';
        for (const [key, node] of remoteAudioNodes) {
          if (node.identity === participant.identity && node.trackSid === sid) {
            try {
              node.source.disconnect();
            } catch {
              // ignore
            }
            remoteAudioNodes.delete(key);
          }
        }
      };

      if (room) {
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((pub) => {
            const t = pub.track;
            if (t && t.kind === Track.Kind.Audio) {
              addRemoteTrack(t as RemoteTrack, pub as RemoteTrackPublication, participant);
            }
          });
        });
        room.on(RoomEvent.TrackSubscribed, addRemoteTrack);
        room.on(RoomEvent.TrackUnsubscribed, removeRemoteTrack);
      }

      finalStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks(),
      ]);

      detachListeners = () => {
        if (room) {
          room.off(RoomEvent.TrackSubscribed, addRemoteTrack);
          room.off(RoomEvent.TrackUnsubscribed, removeRemoteTrack);
        }
      };
    }

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const mimeType =
      candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(finalStream, { mimeType });
    } catch (recErr) {
      const msg = recErr instanceof Error ? recErr.message : String(recErr);
      setError(`録画開始に失敗しました: ${msg}`);
      displayStream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      audioContext?.close().catch(() => {});
      detachListeners();
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    resourcesRef.current = {
      recorder,
      chunks,
      displayStream,
      micStream,
      audioContext,
      audioDestination,
      remoteAudioNodes,
      detachListeners,
    };

    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopRef.current();
    });

    recorder.start(1000);
    setStartedAt(Date.now());
    setIsRecording(true);
  }, [includeMicrophone, room]);

  return { isRecording, startedAt, error, start, stop };
}
