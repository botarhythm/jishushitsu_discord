'use client';

import { useCallback, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import type { RoomName } from '@/lib/types';
import type { RoomRecording } from '@/hooks/useSessionRecorder';
import type { EndSessionChoice } from '@/components/EndSessionModal';

const ROOM_FILENAME_LABELS: Record<RoomName, string> = {
  main: 'メイン',
  'bo-1': 'BO1',
  'bo-2': 'BO2',
  'bo-3': 'BO3',
};

async function uploadRecordingToEchoNote(
  recording: RoomRecording,
  instructorKey: string,
  yyyymmdd: string
): Promise<{ viewUrl?: string }> {
  const ext = recording.mimeType.includes('webm')
    ? 'webm'
    : recording.mimeType.includes('ogg')
      ? 'ogg'
      : 'mp4';
  const roomLabel = ROOM_FILENAME_LABELS[recording.room] || recording.room;
  const fname = `${yyyymmdd}_自習室_${roomLabel}.${ext}`;

  const form = new FormData();
  form.append('file', new File([recording.blob], fname, { type: recording.mimeType }));
  form.append('instructorKey', instructorKey);
  form.append('clientName', '自習室');
  form.append('memo', roomLabel);
  form.append('sessionDate', yyyymmdd);

  const res = await fetch('/api/echonote/upload', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { viewUrl: data.viewUrl };
}

export type UploadResult =
  | { success: true; viewUrl?: string; discarded?: boolean }
  | { success: false; error: string };

interface UseEndSessionOptions {
  instructorKey?: string;
  currentRoom: RoomName;
  echoNoteConfigured: boolean;
  finalizeAll: () => Promise<RoomRecording[]>;
  /** 録音開始時刻(epoch ms)。モーダルを開いた瞬間の経過秒スナップショットに使う。 */
  recordingStartedAt: number | null;
}

export function useEndSession({
  instructorKey,
  currentRoom,
  echoNoteConfigured,
  finalizeAll,
  recordingStartedAt,
}: UseEndSessionOptions) {
  const room = useRoomContext();
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [endModalDurationSec, setEndModalDurationSec] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  const openEndModal = useCallback(() => {
    setEndModalDurationSec(
      recordingStartedAt ? Math.floor((Date.now() - recordingStartedAt) / 1000) : 0
    );
    setEndModalOpen(true);
  }, [recordingStartedAt]);

  const handleEndChoice = useCallback(
    async (choice: EndSessionChoice) => {
      if (choice === 'leave-self') {
        await room.disconnect();
        try {
          sessionStorage.clear();
        } catch {
          // ignore
        }
        window.location.href = '/';
        return;
      }

      // end-all-discard: 全員退出 + 録音破棄
      if (choice === 'end-all-discard') {
        setUploading(true);
        setUploadProgress('セッションを終了しています…');
        try {
          await finalizeAll();
          if (instructorKey) {
            fetch('/api/end-session', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instructorKey, roomName: currentRoom }),
            }).catch((err) => console.error('[end-session] error:', err));
          }
          setUploadResult({ success: true, discarded: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setUploadResult({ success: false, error: msg });
        } finally {
          setUploading(false);
        }
        return;
      }

      // end-all-with-summary
      setUploading(true);
      setUploadProgress('録音を停止しています…');
      try {
        const recordings = await finalizeAll();

        if (instructorKey) {
          fetch('/api/end-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructorKey, roomName: currentRoom }),
          }).catch((err) => console.error('[end-session] error:', err));
        }

        if (recordings.length === 0) {
          setUploadResult({ success: true });
          return;
        }
        if (!echoNoteConfigured || !instructorKey) {
          setUploadResult({
            success: false,
            error: 'EchoNoteが未設定のため録音は送信されませんでした。退出は完了しています。',
          });
          return;
        }

        const today = new Date();
        const yyyymmdd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

        const totalMB = recordings.reduce((sum, r) => sum + r.blob.size / 1024 / 1024, 0);
        setUploadProgress(
          `${recordings.length}件の録音をEchoNoteへ送信中... (合計 ${totalMB.toFixed(1)}MB)`
        );

        const results = await Promise.allSettled(
          recordings.map((r) => uploadRecordingToEchoNote(r, instructorKey, yyyymmdd))
        );

        const successes = results.filter((r) => r.status === 'fulfilled');
        const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

        if (successes.length === 0) {
          throw new Error(
            failures[0]?.reason instanceof Error
              ? failures[0].reason.message
              : String(failures[0]?.reason || '送信失敗')
          );
        }

        const lastSuccess = successes[successes.length - 1] as PromiseFulfilledResult<{
          viewUrl?: string;
        }>;
        setUploadResult({
          success: true,
          viewUrl: lastSuccess.value.viewUrl,
        });
        if (failures.length > 0) {
          console.warn(`[end-session] ${failures.length}件のアップロードが失敗しました`, failures);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[end-session] failed:', err);
        setUploadResult({ success: false, error: msg });
      } finally {
        setUploading(false);
      }
    },
    [room, finalizeAll, instructorKey, currentRoom, echoNoteConfigured]
  );

  const handleCloseEndModal = useCallback(() => {
    setEndModalOpen(false);
    setUploadResult(null);
    setUploadProgress('');
    if (uploadResult?.success) {
      room.disconnect().finally(() => {
        try {
          sessionStorage.clear();
        } catch {
          // ignore
        }
        window.location.href = '/';
      });
    }
  }, [uploadResult, room]);

  return {
    endModalOpen,
    openEndModal,
    endModalDurationSec,
    uploading,
    uploadProgress,
    uploadResult,
    handleEndChoice,
    handleCloseEndModal,
  };
}
