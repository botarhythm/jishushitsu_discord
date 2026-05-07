'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'mobile_host_warning_dismissed';

/**
 * ホストがモバイルで入室した場合に1回だけ表示する警告ダイアログ。
 *
 * 録音はブラウザ（MediaRecorder）で行われるため、モバイル特有の制約がある:
 * - iOS Safari は画面ロック・別アプリ切替で AudioContext が suspend → 録音停止
 * - タブをバックグラウンドにすると同様
 * - iOS は MediaRecorder が iOS 14.5+ 必須
 *
 * 「了解した」を押すと sessionStorage に記録され、同セッション中は再表示されない。
 */
export function MobileHostWarning({ isInstructor }: { isInstructor: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isInstructor) return;
    if (typeof window === 'undefined') return;
    const dismissed = sessionStorage.getItem(STORAGE_KEY) === '1';
    if (dismissed) return;
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (isMobile) setShow(true);
  }, [isInstructor]);

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-2xl" aria-hidden>📱</span>
          <h2 className="text-base font-bold text-stone-900">
            モバイル端末でのご利用について
          </h2>
        </div>

        <div className="mb-4 space-y-2 text-sm text-stone-700 leading-relaxed">
          <p className="font-medium text-amber-700">
            ホストはPC（Chrome等）の利用を推奨します。
          </p>
          <p>
            モバイルだと、以下の場面で録音が中断されます:
          </p>
          <ul className="list-disc pl-5 text-xs text-stone-600 space-y-0.5">
            <li>画面をロックした時</li>
            <li>別のアプリに切り替えた時</li>
            <li>ブラウザを閉じた時</li>
          </ul>
          <p className="text-xs text-stone-500 pt-1">
            セッション中は画面を表示し続けて、ブラウザから離れないようにしてください。
          </p>
        </div>

        <button
          onClick={handleDismiss}
          className="block w-full rounded-lg bg-amber-600 px-4 py-3 text-sm font-medium text-white hover:bg-amber-700 active:scale-95"
        >
          了解しました
        </button>
      </div>
    </div>
  );
}
