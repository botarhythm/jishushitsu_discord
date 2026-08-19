'use client';

import type { AiTileState } from '@/lib/studio-participants';

/**
 * AI 参加者のアバタータイル（要件§7）。
 *
 * - idle: 静止アバター
 * - speaking: RMS レベルに応じたリング拡大 + グロー（100ms 更新で十分。60fps 不要）
 * - error: グレーアウト + 小さな警告バッジ（録画に映る前提で控えめに）
 */
export function AiAvatarTile({ state, compact = false }: { state: AiTileState; compact?: boolean }) {
  const { info, visualState, level } = state;
  const speaking = visualState === 'speaking';
  const error = visualState === 'error';
  const scale = speaking ? 1 + Math.min(level, 1) * 0.12 : 1;

  return (
    <div
      className={`relative flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-stone-800 to-stone-900 ${
        error ? 'opacity-60 grayscale' : ''
      }`}
    >
      <div className="relative flex items-center justify-center">
        {/* speaking リング */}
        <span
          aria-hidden
          className={`absolute rounded-full transition-transform duration-100 ${
            compact ? 'h-10 w-10' : 'h-28 w-28'
          } ${speaking ? 'bg-emerald-400/25 ring-2 ring-emerald-400/70' : 'bg-transparent'}`}
          style={{ transform: `scale(${scale})` }}
        />
        <span
          className={`relative flex items-center justify-center rounded-full bg-stone-700 ${
            compact ? 'h-8 w-8 text-lg' : 'h-24 w-24 text-5xl'
          }`}
          style={
            speaking
              ? { boxShadow: `0 0 ${12 + level * 24}px rgba(52, 211, 153, 0.45)` }
              : undefined
          }
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
