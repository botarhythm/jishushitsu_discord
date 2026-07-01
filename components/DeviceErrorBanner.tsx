'use client';

interface DeviceErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

/** カメラ/マイク取得失敗を伝える警告バナー。通常レイアウト/収録モードの両方で使う。 */
export function DeviceErrorBanner({ message, onDismiss }: DeviceErrorBannerProps) {
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-50 w-full max-w-md -translate-x-1/2 px-4">
      <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-950/95 p-3 text-sm text-red-100 shadow-2xl backdrop-blur-sm">
        <span className="text-lg" aria-hidden>
          ⚠️
        </span>
        <p className="flex-1 whitespace-pre-line leading-relaxed">{message}</p>
        <button
          onClick={onDismiss}
          className="rounded-md px-1.5 py-0.5 text-red-300 hover:bg-red-900/60 hover:text-red-100"
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
