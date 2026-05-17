'use client';

interface AutoLogoutModalProps {
  /** 自動退出までの残り時間(ms) */
  remainingMs: number;
  onContinue: () => void;
}

/**
 * 入室から一定時間経過時に表示する継続確認モーダル。
 * 「続けます」を押さずに猶予が尽きると、呼び出し側が自動退出処理を行う。
 */
export function AutoLogoutModal({ remainingMs, onContinue }: AutoLogoutModalProps) {
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="auto-logout-title"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl text-center">
        <h2 id="auto-logout-title" className="text-lg font-bold text-stone-900 mb-2">
          自習を継続しますか？
        </h2>
        <p className="text-sm text-stone-700 mb-4 leading-relaxed">
          入室から1時間が経過しました。
          <br />
          このまま反応がない場合、退出漏れとして自動的に退出します。
        </p>

        <div className="mb-5 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-xs text-amber-700">自動退出まで</p>
          <p className="text-3xl font-mono font-bold text-amber-700 mt-1 tabular-nums">
            {mm}:{ss}
          </p>
        </div>

        <button
          onClick={onContinue}
          autoFocus
          className="block w-full rounded-lg bg-green-600 px-4 py-3 text-sm font-medium text-white hover:bg-green-700 active:scale-[0.98] transition"
        >
          続けます
        </button>
      </div>
    </div>
  );
}
