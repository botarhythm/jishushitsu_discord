'use client';

import { useCallback, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import type { RoomName } from '@/lib/types';
import type { RoomRecording } from '@/hooks/useSessionRecorder';
import type { EndSessionChoice } from '@/components/EndSessionModal';

export type UploadResult =
  | { success: true; viewUrl?: string; discarded?: boolean }
  | { success: false; error: string };

interface ChunkUploadApi {
  waitAndRetry: () => Promise<{ failed: number; viewUrl?: string }>;
}

interface UseEndSessionOptions {
  currentRoom: RoomName;
  echoNoteConfigured: boolean;
  /** 進行中チャンクを確定し、最終チャンクを emit する（onChunkReady 経由で逐次アップロードされる） */
  finalize: () => Promise<RoomRecording[]>;
  /** チャンク逐次アップロードのオーケストレーション */
  chunkUpload: ChunkUploadApi;
  /** 録音中か（最終チャンクの有無判定に使用） */
  isRecording: boolean;
  /** これまでに確定済みのチャンク数 */
  completedCount: number;
  /** 録音開始時刻(epoch ms)。モーダルを開いた瞬間の経過秒スナップショットに使う。 */
  recordingStartedAt: number | null;
  /** ローカル録画(getDisplayMedia)を停止しBlobをDLする。退出系操作の直前に呼ばれる。 */
  stopLocalRecording?: () => Promise<Blob | null>;
  /** 退出系操作の直前に呼ばれる任意フック（チャット履歴ダウンロード等）。 */
  onBeforeLeave?: () => void;
}

export function useEndSession({
  currentRoom,
  echoNoteConfigured,
  finalize,
  chunkUpload,
  isRecording,
  completedCount,
  recordingStartedAt,
  stopLocalRecording,
  onBeforeLeave,
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
      // 退出系すべてに先立ってチャット履歴をDL
      try {
        onBeforeLeave?.();
      } catch (err) {
        console.error('[end-session] onBeforeLeave failed:', err);
      }
      // 退出系すべてに先立ってローカル録画を停止＆DL
      if (stopLocalRecording) {
        try {
          await stopLocalRecording();
        } catch (err) {
          console.error('[end-session] local recording stop failed:', err);
        }
      }

      if (choice === 'leave-self') {
        await room.disconnect();
        window.location.href = '/api/auth/logout';
        return;
      }

      // end-all-discard: 全員退出 + 録音破棄（アップロードしない）
      if (choice === 'end-all-discard') {
        setUploading(true);
        setUploadProgress('セッションを終了しています…');
        try {
          await finalize();
          fetch('/api/end-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName: currentRoom }),
          }).catch((err) => console.error('[end-session] error:', err));
          setUploadResult({ success: true, discarded: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setUploadResult({ success: false, error: msg });
        } finally {
          setUploading(false);
        }
        return;
      }

      // end-all-with-summary（チャンク式：チャンクは録音中に逐次アップロード済み）
      setUploading(true);
      setUploadProgress(
        echoNoteConfigured ? '録音を停止し、最終チャンクを送信中…' : 'セッションを終了しています…'
      );
      try {
        const totalChunks = completedCount + (isRecording ? 1 : 0);
        // 1. 最終チャンクを emit（onChunkReady でアップロード開始）
        await finalize();

        // 2. 全員退出シグナル送信（アップロード継続中に並行）
        fetch('/api/end-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName: currentRoom }),
        }).catch((err) => console.error('[end-session] error:', err));

        // 3. 録音なしなら早期return
        if (totalChunks === 0) {
          setUploadResult({ success: true });
          return;
        }
        if (!echoNoteConfigured) {
          setUploadResult({
            success: false,
            error: 'EchoNoteが未設定のため録音は送信されませんでした。退出は完了しています。',
          });
          return;
        }

        // 4. in-flight 完了待ち＋失敗分リトライ
        setUploadProgress(`${totalChunks}件のチャンクをEchoNoteへ送信中…`);
        const { failed, viewUrl } = await chunkUpload.waitAndRetry();

        if (failed > 0) {
          setUploadResult({
            success: false,
            error: `${failed}件のチャンクが送信できませんでした。再度「もう一度送信する」をお試しください。`,
          });
        } else {
          setUploadResult({ success: true, viewUrl });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[end-session] failed:', err);
        setUploadResult({ success: false, error: msg });
      } finally {
        setUploading(false);
      }
    },
    [
      room,
      finalize,
      chunkUpload,
      currentRoom,
      echoNoteConfigured,
      isRecording,
      completedCount,
      stopLocalRecording,
      onBeforeLeave,
    ]
  );

  const handleCloseEndModal = useCallback(() => {
    setEndModalOpen(false);
    setUploadResult(null);
    setUploadProgress('');
    if (uploadResult?.success) {
      room.disconnect().finally(() => {
        window.location.href = '/api/auth/logout';
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
