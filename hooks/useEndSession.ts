'use client';

import { useCallback, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import type { RoomName } from '@/lib/types';
import type { EndSessionChoice } from '@/components/EndSessionModal';

export type EndResult = { success: true } | { success: false; error: string };

interface UseEndSessionOptions {
  currentRoom: RoomName;
  /** ローカル録画(getDisplayMedia)を停止しBlobをDLする。退出系操作の直前に呼ばれる。 */
  stopLocalRecording?: () => Promise<Blob | null>;
  /** 退出系操作の直前に呼ばれる任意フック（チャット履歴ダウンロード等）。 */
  onBeforeLeave?: () => void;
}

export function useEndSession({
  currentRoom,
  stopLocalRecording,
  onBeforeLeave,
}: UseEndSessionOptions) {
  const room = useRoomContext();
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endResult, setEndResult] = useState<EndResult | null>(null);

  const openEndModal = useCallback(() => {
    setEndModalOpen(true);
  }, []);

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

      // end-all: 全員に退出シグナルを送る
      setEnding(true);
      try {
        const res = await fetch('/api/end-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName: currentRoom }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `終了処理に失敗しました (${res.status})`);
        }
        setEndResult({ success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[end-session] failed:', err);
        setEndResult({ success: false, error: msg });
      } finally {
        setEnding(false);
      }
    },
    [room, currentRoom, stopLocalRecording, onBeforeLeave]
  );

  const handleCloseEndModal = useCallback(() => {
    setEndModalOpen(false);
    setEndResult(null);
    if (endResult?.success) {
      room.disconnect().finally(() => {
        window.location.href = '/api/auth/logout';
      });
    }
  }, [endResult, room]);

  return {
    endModalOpen,
    openEndModal,
    ending,
    endResult,
    handleEndChoice,
    handleCloseEndModal,
  };
}
