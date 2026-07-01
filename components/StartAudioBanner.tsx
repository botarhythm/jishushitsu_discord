'use client';

import { useRoomContext, useStartAudio } from '@livekit/components-react';

/**
 * iOS Safari 等の自動再生ポリシーでリモート参加者の音声がブロックされた場合に表示する。
 * ブロック中は canPlayAudio が false になり、ボタンをタップして startAudio() を呼ぶまで
 * 何のエラーも出ずに「無音のまま」になる (LiveKit の RoomAudioRenderer 単体では検知できない)。
 * useStartAudio はブロック解除時に自動で canPlayAudio を true に切り替える。
 */
export function StartAudioBanner() {
  const room = useRoomContext();
  const { mergedProps, canPlayAudio } = useStartAudio({ room, props: {} });

  if (canPlayAudio) return null;

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-50 w-full max-w-md -translate-x-1/2 px-4">
      <button
        {...mergedProps}
        className="pointer-events-auto flex w-full items-center justify-center gap-2 rounded-xl border border-amber-400/60 bg-amber-600 px-4 py-3 text-sm font-semibold text-white shadow-2xl hover:bg-amber-500 active:scale-[0.98]"
      >
        <span aria-hidden>🔊</span>
        タップして音声を有効にする
      </button>
    </div>
  );
}
