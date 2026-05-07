'use client';

/**
 * 講師タイル下部中央に配置するセッション終了ボタン。
 * 自分の映像領域の上に重ねるフローティング要素として描画される。
 */
export function EndSessionButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 sm:bottom-3 z-10 flex justify-center">
      <button
        onClick={onClick}
        className="pointer-events-auto group flex items-center gap-2 rounded-full bg-red-600/90 px-5 py-3 sm:px-4 sm:py-2 text-sm font-medium text-white shadow-lg backdrop-blur-sm hover:bg-red-700 active:scale-95 transition-all min-h-[44px]"
        aria-label="セッションを終了"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
        <span>セッション終了</span>
      </button>
    </div>
  );
}
