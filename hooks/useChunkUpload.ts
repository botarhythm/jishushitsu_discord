'use client';

import { useCallback, useRef, useState } from 'react';
import type { RoomRecording } from '@/hooks/useSessionRecorder';
import type { RoomName } from '@/lib/types';

const ROOM_FILENAME_LABELS: Record<RoomName, string> = {
  main: 'メイン',
  'bo-1': 'BO1',
  'bo-2': 'BO2',
  'bo-3': 'BO3',
  'bo-4': 'BO4',
  'bo-5': 'BO5',
  'bo-6': 'BO6',
};

async function uploadRecordingToEchoNote(
  recording: RoomRecording,
  yyyymmdd: string
): Promise<{ viewUrl?: string }> {
  const ext = recording.mimeType.includes('webm')
    ? 'webm'
    : recording.mimeType.includes('ogg')
      ? 'ogg'
      : 'mp4';
  const roomLabel = ROOM_FILENAME_LABELS[recording.room] || recording.room;
  // チャンク識別子をファイル名に含める（EchoNote側で結合の手がかりに使う）
  const fname = `${yyyymmdd}_自習室_${roomLabel}_${recording.sessionGroupId.slice(0, 8)}_${String(recording.chunkIndex).padStart(3, '0')}.${ext}`;

  const form = new FormData();
  // 認証は session Cookie（instructorKey は不要）
  form.append('file', new File([recording.blob], fname, { type: recording.mimeType }));
  form.append('clientName', '自習室');
  form.append('memo', roomLabel);
  form.append('sessionDate', yyyymmdd);
  // チャンク結合用メタデータ
  form.append('sessionGroupId', recording.sessionGroupId);
  form.append('chunkIndex', String(recording.chunkIndex));
  form.append('isFinal', recording.isFinal ? 'true' : 'false');

  const res = await fetch('/api/echonote/upload', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { viewUrl: data.viewUrl };
}

/**
 * 録音チャンクを EchoNote へ逐次アップロードするオーケストレーション。
 *
 * - {@link handleChunkReady} を useSessionRecorder の onChunkReady に渡すと、
 *   30分ごと（およびルーム移動・終了時の最終チャンク）に即アップロードを開始する。
 * - 終了処理では {@link waitAndRetry} で in-flight 完了待ち＋失敗分リトライを行う。
 *
 * EchoNote 未設定なら何もアップロードしない（メモリ上に保持されるだけ）。
 */
export function useChunkUpload({
  echoNoteConfigured,
}: {
  echoNoteConfigured: boolean;
}) {
  const uploadedChunkIdsRef = useRef<Set<string>>(new Set());
  const inFlightUploadsRef = useRef<Promise<unknown>[]>([]);
  const failedChunksRef = useRef<RoomRecording[]>([]);
  const lastViewUrlRef = useRef<string | undefined>(undefined);
  const [chunksUploaded, setChunksUploaded] = useState(0);

  const uploadChunkOnce = useCallback(
    async (chunk: RoomRecording) => {
      if (!echoNoteConfigured) return; // 未設定なら何もしない
      const id = `${chunk.sessionGroupId}-${chunk.chunkIndex}`;
      if (uploadedChunkIdsRef.current.has(id)) return;
      try {
        const today = new Date(chunk.startedAt);
        const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        const result = await uploadRecordingToEchoNote(chunk, yyyymmdd);
        uploadedChunkIdsRef.current.add(id);
        setChunksUploaded((n) => n + 1);
        if (result.viewUrl) lastViewUrlRef.current = result.viewUrl;
      } catch (err) {
        console.error(`[upload] chunk ${id} failed:`, err);
        // 失敗したチャンクは終了時にリトライ対象とする
        failedChunksRef.current = [
          ...failedChunksRef.current.filter(
            (c) => `${c.sessionGroupId}-${c.chunkIndex}` !== id
          ),
          chunk,
        ];
      }
    },
    [echoNoteConfigured]
  );

  const handleChunkReady = useCallback(
    (chunk: RoomRecording) => {
      inFlightUploadsRef.current.push(uploadChunkOnce(chunk));
    },
    [uploadChunkOnce]
  );

  /** in-flight アップロードの完了待ち＋失敗分のリトライ。残失敗数と最新 viewUrl を返す。 */
  const waitAndRetry = useCallback(async (): Promise<{
    failed: number;
    viewUrl?: string;
  }> => {
    await Promise.allSettled(inFlightUploadsRef.current);
    if (failedChunksRef.current.length > 0) {
      const toRetry = [...failedChunksRef.current];
      failedChunksRef.current = [];
      await Promise.allSettled(toRetry.map((c) => uploadChunkOnce(c)));
    }
    return { failed: failedChunksRef.current.length, viewUrl: lastViewUrlRef.current };
  }, [uploadChunkOnce]);

  return { handleChunkReady, waitAndRetry, chunksUploaded };
}
