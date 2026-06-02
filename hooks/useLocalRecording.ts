'use client';

import { useCallback, useRef, useState } from 'react';
import type { Room, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';

/**
 * MediaRecorder の WebM 出力に SeekHead / Cues / Duration を注入して
 * 編集ソフトで開ける「シーク可能な WebM」に変換する。
 * ts-ebml は動的 import (録画停止時のみロード)。
 */
async function injectWebmSeekMetadata(blob: Blob): Promise<Blob> {
  // ts-ebml は Node の Buffer グローバルに依存しているため、ブラウザでは事前に polyfill する。
  if (typeof window !== 'undefined' && typeof (window as unknown as { Buffer?: unknown }).Buffer === 'undefined') {
    const { Buffer } = await import('buffer');
    (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
  }
  const { Decoder, tools, Reader } = await import('ts-ebml');
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;
  const buf = await blob.arrayBuffer();
  const elms = decoder.decode(buf);
  elms.forEach((elm) => reader.read(elm));
  reader.stop();
  const refinedMetadataBuf = tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues
  );
  const bodyBuf = buf.slice(reader.metadataSize);
  return new Blob([refinedMetadataBuf, bodyBuf], { type: blob.type });
}

export type RecordingQuality = 'streaming' | 'standard' | 'high';

interface QualityPreset {
  width: number;
  height: number;
  frameRate: number;
  videoBitsPerSecond: number;
}

const QUALITY_PRESETS: Record<RecordingQuality, QualityPreset | null> = {
  // ストリーミング配信に最適 (720p / 24fps / ~1.5 Mbps)
  streaming: { width: 1280, height: 720, frameRate: 24, videoBitsPerSecond: 1_500_000 },
  // 標準 (1080p / 30fps / ~2.5 Mbps)
  standard: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 2_500_000 },
  // ネイティブ解像度・高ビットレート (ファイルサイズ大)
  high: null,
};

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
      r.recorder.onstop = async () => {
        const rawBlob = new Blob(r.chunks, { type: r.recorder.mimeType });
        // MediaRecorder の WebM は SeekHead / Cues / Duration が欠落しており
        // 編集ソフトでタイムラインを構築できない (シーク不能)。
        // ts-ebml でメタデータを注入し、シーク可能な WebM に変換してから保存。
        const seekable = rawBlob.type.includes('webm')
          ? await injectWebmSeekMetadata(rawBlob).catch((e) => {
              console.warn('[useLocalRecording] シーク索引の付与に失敗。生のBlobを保存します。', e);
              return rawBlob;
            })
          : rawBlob;
        downloadBlob(seekable);
        cleanup();
        setIsRecording(false);
        setStartedAt(null);
        resolve(seekable);
      };
      r.recorder.stop();
    });
  }, [cleanup, downloadBlob]);

  stopRef.current = stop;

  const start = useCallback(async (quality: RecordingQuality = 'streaming') => {
    setError(null);
    if (resourcesRef.current) return;

    const preset = QUALITY_PRESETS[quality];

    // 録画対象は「セッション中の自習室タブそのもの」。
    // getDisplayMedia を呼んだ自タブは既定でピッカーから除外される (selfBrowserSurface=exclude)
    // ため、ピッカーで選ばせる方式だと自習室タブを選べない。
    // preferCurrentTab: true で自タブを直接キャプチャする (下の getDisplayMedia 参照)。
    // displaySurface: 'browser' はタブ面であることの明示。
    const videoConstraints: MediaTrackConstraints = preset
      ? {
          displaySurface: 'browser',
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        }
      : { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 } };

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
        // 非標準だが Chromium 系で有効。型定義に無いので as 経由で付与。
        // preferCurrentTab: true → Chrome は「このタブを共有しますか?」確認のみを表示し、
        // 自習室タブの描画内容だけ (ツールバー・タブ帯・メニュー・他タブを除く) を直接録る。
        // 自タブを録るのが目的なので、selfBrowserSurface / surfaceSwitching /
        // monitorTypeSurfaces は併記しない (preferCurrentTab と競合し無効化されるため)。
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions);
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
      const recorderOptions: MediaRecorderOptions = { mimeType };
      if (preset) recorderOptions.videoBitsPerSecond = preset.videoBitsPerSecond;
      recorder = new MediaRecorder(finalStream, recorderOptions);
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
