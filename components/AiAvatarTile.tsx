'use client';

import { useEffect, useRef } from 'react';
import type { AiTileState } from '@/lib/studio-participants';

/**
 * AI 参加者のアバタータイル（要件§7）。
 *
 * - idle: 静止アバター
 * - speaking: RMS レベルに応じたリング拡大 + グロー（100ms 更新で十分。60fps 不要）
 * - error: グレーアウト + 小さな警告バッジ（録画に映る前提で控えめに）
 */
export function AiAvatarTile({ state, compact = false }: { state: AiTileState; compact?: boolean }) {
  const { info, visualState } = state;
  const speaking = visualState === 'speaking';
  const error = visualState === 'error';
  // RMS は state に載せていない（再レンダリング多発を避けるため）。
  // リングの拡大は描画フレーム側で transform だけ書き換える。
  const ringRef = useRef<HTMLSpanElement>(null);
  const getLevel = state.getLevel;
  useEffect(() => {
    const el = ringRef.current;
    if (!el || !speaking) return;
    let raf = 0;
    const tick = () => {
      // 背景タブでは描く意味が無いので止める
      if (!document.hidden) {
        el.style.transform = `scale(${1 + Math.min(getLevel(), 1) * 0.12})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speaking, getLevel]);

  return (
    <div
      className={`relative flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-stone-800 to-stone-900 ${
        error ? 'opacity-60 grayscale' : ''
      }`}
    >
      <div className="relative flex items-center justify-center">
        {/* speaking リング */}
        <span
          ref={ringRef}
          aria-hidden
          className={`absolute rounded-full transition-transform duration-100 ${
            compact ? 'h-10 w-10' : 'h-28 w-28'
          } ${speaking ? 'bg-emerald-400/25 ring-2 ring-emerald-400/70' : 'bg-transparent'}`}
        />
        <span
          className={`relative flex items-center justify-center rounded-full bg-stone-700 ${
            compact ? 'h-8 w-8 text-lg' : 'h-24 w-24 text-5xl'
          }`}
          style={speaking ? { boxShadow: '0 0 24px rgba(52, 211, 153, 0.45)' } : undefined}
          role="img"
          aria-label={info.displayName}
        >
          {info.avatar}
        </span>
      </div>
      {!compact && (
        <span className="text-lg font-medium text-stone-300">{info.displayName}</span>
      )}
      {error && (
        <span
          className={`absolute rounded-md bg-red-900/80 font-medium text-red-100 ${
            compact
              ? 'right-1 top-1 px-1 py-0.5 text-[9px]'
              : 'right-2 top-2 px-2 py-1 text-xs'
          }`}
        >
          ⚠ 音声ソース切断
        </span>
      )}
    </div>
  );
}
