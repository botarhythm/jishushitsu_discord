'use client';

import { useCallback, useRef, useState } from 'react';

interface UseLocalRecordingOptions {
  /** ファイル名のprefix (デフォルト '自習室') */
  filePrefix?: string;
  /** マイクをmixするか (デフォルト true) */
  includeMicrophone?: boolean;
}

interface RecordingResources {
  recorder: MediaRecorder;
  chunks: Blob[];
  displayStream: MediaStream;
  micStream: MediaStream | null;
  audioContext: AudioContext | null;
}

/**
 * ローカル録画フック。
 * `getDisplayMedia` でタブ/画面を取得し、必要に応じてマイクをmixしてWebMで保存する。
 *
 * - start(): 画面選択ダイアログを表示。ユーザーが選んだ後 MediaRecorder で録画開始
 * - stop(): 録画を停止し、Blob を自動ダウンロードする。Blob を返す
 * - 画面共有を OS の「共有を停止」で止めた場合も自動で stop が走る
 */
export function useLocalRecording({
  filePrefix = '自習室',
  includeMicrophone = true,
}: UseLocalRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resourcesRef = useRef<RecordingResources | null>(null);
  // stop を ref 経由で参照できるようにし、track の 'ended' イベントから呼び出す
  const stopRef = useRef<() => Promise<Blob | null>>(() => Promise.resolve(null));

  const cleanup = useCallback(() => {
    const r = resourcesRef.current;
    if (!r) return;
    r.displayStream.getTracks().forEach((t) => t.stop());
    r.micStream?.getTracks().forEach((t) => t.stop());
    r.audioContext?.close().catch(() => {
      // ignore — context may already be closed
    });
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
      // Blob URL は60秒後に解放（DLが走り終えている十分な時間）
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

  // stopRef は最新の stop を常に参照する
  stopRef.current = stop;

  const start = useCallback(async () => {
    setError(null);
    if (resourcesRef.current) return; // 既に録画中

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        // タブ音声も拾いたいので true。ユーザーが「タブ音声を共有」をチェックすれば含まれる
        audio: true,
      });
    } catch (err) {
      // ユーザーが画面選択ダイアログをキャンセルした場合などはエラーとして表示しない
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
    let finalStream = displayStream;

    if (includeMicrophone) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();
        const dest = audioContext.createMediaStreamDestination();

        const tabAudioTracks = displayStream.getAudioTracks();
        if (tabAudioTracks.length > 0) {
          const tabSrc = audioContext.createMediaStreamSource(
            new MediaStream(tabAudioTracks)
          );
          tabSrc.connect(dest);
        }
        const micSrc = audioContext.createMediaStreamSource(micStream);
        micSrc.connect(dest);

        finalStream = new MediaStream([
          ...displayStream.getVideoTracks(),
          ...dest.stream.getAudioTracks(),
        ]);
      } catch (micErr) {
        console.warn('[useLocalRecording] マイク取得失敗、タブ音声のみ録画:', micErr);
        // 失敗してもタブ音声のみで続行
      }
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
    };

    // 画面共有を OS の停止ボタンで止めた場合は自動で stop
    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopRef.current();
    });

    recorder.start(1000);
    setStartedAt(Date.now());
    setIsRecording(true);
  }, [includeMicrophone]);

  return { isRecording, startedAt, error, start, stop };
}
