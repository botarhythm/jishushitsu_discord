'use client';

interface DeviceErrorBannerProps {
  message: string;
  onDismiss: () => void;
  /** 権限拒否など「ブラウザ設定の変更 → 再読み込み」で直る失敗のとき true。
      ブラウザの設定画面へは Web からリンクできないため、案内文の手順を実行した後の
      最終ステップ (再読み込み) だけをボタンとして提供する。 */
  showReload?: boolean;
}

/** カメラ/マイク取得失敗を伝える警告バナー。通常レイアウト/収録モードの両方で使う。 */
export function DeviceErrorBanner({ message, onDismiss, showReload = false }: DeviceErrorBannerProps) {
  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-50 w-full max-w-md -translate-x-1/2 px-4">
      <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-950/95 p-3 text-sm text-red-100 shadow-2xl backdrop-blur-sm">
        <span className="text-lg" aria-hidden>
          ⚠️
        </span>
        <div className="flex-1">
          <p className="whitespace-pre-line leading-relaxed">{message}</p>
          {showReload && (
            <button
              onClick={() => window.location.reload()}
              className="mt-2 rounded-lg bg-red-800/80 px-3 py-1.5 text-xs font-medium text-red-50 hover:bg-red-700"
            >
              設定を変更したら再読み込み
            </button>
          )}
        </div>
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
