'use client';

import { useEffect, useState } from 'react';

/**
 * 録音中であることを示す赤ドット + 経過時間 + 録音中のルーム表示。
 */
export function RecordingIndicator({
  isRecording,
  startedAt,
  roomLabel,
  completedCount,
}: {
  isRecording: boolean;
  startedAt: number | null;
  roomLabel?: string;
  completedCount?: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRecording]);

  if (!isRecording || !startedAt) {
    if (completedCount && completedCount > 0) {
      return (
        <div className="flex items-center gap-1.5 rounded-full bg-stone-700/40 border border-stone-600 px-2.5 py-1 text-xs text-stone-300">
          <span className="font-medium">未送信録音 {completedCount}件</span>
        </div>
      );
    }
    return null;
  }

  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const ss = String(elapsedSec % 60).padStart(2, '0');

  return (
    <div className="flex items-center gap-1.5 rounded-full bg-red-600/20 border border-red-600/40 px-2.5 py-1 text-xs text-red-300">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
      </span>
      <span className="font-medium">録音中</span>
      {roomLabel && (
        <span className="rounded bg-red-500/30 px-1 py-0.5 text-[10px] font-medium text-red-100">
          {roomLabel}
        </span>
      )}
      <span className="font-mono text-stone-300">
        {mm}:{ss}
      </span>
      {completedCount !== undefined && completedCount > 0 && (
        <span className="text-[10px] text-stone-400">+{completedCount}件待機中</span>
      )}
    </div>
  );
}
