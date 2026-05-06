'use client';

import { useEffect, useState } from 'react';

/**
 * 録音中であることを示す赤ドット + 経過時間表示。
 * ヘッダ右上または講師ダッシュボードに置く想定。
 */
export function RecordingIndicator({
  isRecording,
  startedAt,
}: {
  isRecording: boolean;
  startedAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRecording) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRecording]);

  if (!isRecording || !startedAt) return null;

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
      <span className="font-mono text-stone-300">{mm}:{ss}</span>
    </div>
  );
}
