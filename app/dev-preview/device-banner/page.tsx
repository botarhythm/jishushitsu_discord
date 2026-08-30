'use client';

/**
 * カメラ/マイク権限エラーバナーの見た目確認用ページ（開発時のみ）。
 *
 * describeMediaDeviceFailure は navigator.userAgent で端末別の手順文を出し分けるため、
 * DevTools / ブラウザのデバイスエミュレーション (Android UA) に切り替えてリロードすると
 * Pixel 実機と同じ文言を確認できる。本番ビルドでは 404 になる。
 */

import { useEffect, useMemo, useState } from 'react';
import { notFound } from 'next/navigation';
import { DeviceErrorBanner } from '@/components/DeviceErrorBanner';
import { describeMediaDeviceFailure, isPermissionFailure } from '@/lib/media-device-error';

export default function DevPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  const [dismissed, setDismissed] = useState(false);
  const permissionError = useMemo(
    () => new DOMException('Permission denied', 'NotAllowedError'),
    []
  );
  // 文言は UA (navigator) 依存なので SSR とクライアントで食い違う。
  // hydration mismatch を避けるためマウント後に計算する。
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setMessage(describeMediaDeviceFailure(permissionError, 'カメラとマイク'));
  }, [permissionError]);
  if (message === null) return null;

  return (
    <div className="min-h-screen bg-stone-900 p-6 text-stone-200">
      <h1 className="mb-2 text-lg font-bold">DeviceErrorBanner プレビュー (権限拒否)</h1>
      <p className="mb-4 text-sm text-stone-400">
        UA: {typeof navigator !== 'undefined' ? navigator.userAgent : '(SSR)'}
      </p>
      <p className="text-sm text-stone-400">
        isPermissionFailure = {String(isPermissionFailure(permissionError))}
      </p>
      {dismissed ? (
        <button
          className="mt-4 rounded bg-stone-700 px-3 py-1.5 text-sm"
          onClick={() => setDismissed(false)}
        >
          バナーを再表示
        </button>
      ) : (
        <DeviceErrorBanner message={message} showReload onDismiss={() => setDismissed(true)} />
      )}
    </div>
  );
}
