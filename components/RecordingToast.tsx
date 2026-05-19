'use client';

import { useEffect, useRef, useState } from 'react';

interface RecordingToastProps {
  audioOn: boolean;
  screenOn: boolean;
}

interface Flash {
  kind: 'start' | 'stop';
  label: string;
  /** flash 識別用 - timeout キャンセル制御に使う */
  nonce: number;
}

/**
 * 画面右下に「録音中」「録画中」のステータスを表示する常駐トースト。
 *
 * - 開始/停止の瞬間は一時的に強めにフラッシュ (背景色 + アニメーション)
 * - 進行中はバッジで常時表示し、ユーザが収録状態を見失わないようにする
 * - どちらも OFF の場合は何も描画しない
 */
export function RecordingToast({ audioOn, screenOn }: RecordingToastProps) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const prevAudioRef = useRef(audioOn);
  const prevScreenRef = useRef(screenOn);

  useEffect(() => {
    const prevAudio = prevAudioRef.current;
    const prevScreen = prevScreenRef.current;
    let next: Flash | null = null;
    if (audioOn !== prevAudio) {
      next = {
        kind: audioOn ? 'start' : 'stop',
        label: audioOn ? '録音を開始しました' : '録音を停止しました',
        nonce: Date.now(),
      };
    } else if (screenOn !== prevScreen) {
      next = {
        kind: screenOn ? 'start' : 'stop',
        label: screenOn ? '録画を開始しました' : '録画を停止しました',
        nonce: Date.now(),
      };
    }
    prevAudioRef.current = audioOn;
    prevScreenRef.current = screenOn;

    if (!next) return;
    setFlash(next);
    const captured = next.nonce;
    const t = setTimeout(() => {
      setFlash((f) => (f && f.nonce === captured ? null : f));
    }, 2500);
    return () => clearTimeout(t);
  }, [audioOn, screenOn]);

  if (!audioOn && !screenOn && !flash) return null;

  return (
    <div className="pointer-events-none fixed bottom-20 right-4 z-50 flex flex-col items-end gap-2 md:bottom-24 md:right-6">
      {flash && (
        <div
          className={`pointer-events-none rounded-lg px-3 py-2 text-sm font-medium text-white shadow-lg backdrop-blur ${
            flash.kind === 'start' ? 'bg-red-600/90' : 'bg-stone-700/90'
          }`}
          role="status"
          aria-live="polite"
        >
          {flash.label}
        </div>
      )}

      {(audioOn || screenOn) && (
        <div className="flex gap-2">
          {audioOn && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/60 bg-red-600/30 px-2.5 py-1 text-xs font-medium text-red-100 shadow-md backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-400" />
              </span>
              録音中
            </span>
          )}
          {screenOn && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-600/30 px-2.5 py-1 text-xs font-medium text-amber-100 shadow-md backdrop-blur">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-300" />
              </span>
              録画中
            </span>
          )}
        </div>
      )}
    </div>
  );
}
