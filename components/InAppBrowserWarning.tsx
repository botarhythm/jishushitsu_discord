'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'in_app_browser_warning_dismissed';

/**
 * LINE・Instagram・Facebook 等のアプリ内蔵ブラウザ (WebView) は、ホストアプリが
 * カメラ/マイク権限の仲介を実装していないことが多く、getUserMedia が権限ダイアログすら
 * 出さずに失敗する。結果「カメラボタンを押しても反応がない」ように見える
 * (Pixel 8a 等の実機で確認済み)。
 *
 * User-Agent の既知トークンで検出し、Chrome 等の通常ブラウザで開き直すよう促す。
 * 誤検知を避けるため許可リスト方式 (未知の UA は警告しない) にしている。
 */
const IN_APP_BROWSER_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'LINE', pattern: /\bLine\//i },
  { name: 'Instagram', pattern: /\bInstagram\b/i },
  { name: 'Facebook', pattern: /FBAN|FBAV|FB_IAB/i },
  { name: 'Twitter(X)', pattern: /\bTwitter\b/i },
  { name: 'KakaoTalk', pattern: /KAKAOTALK/i },
  { name: 'WeChat', pattern: /MicroMessenger/i },
  { name: 'NAVER', pattern: /NAVER\(/i },
  { name: 'TikTok', pattern: /\bmusical_ly\b|\bTikTok\b/i },
];

function detectInAppBrowser(userAgent: string): string | null {
  const hit = IN_APP_BROWSER_PATTERNS.find(({ pattern }) => pattern.test(userAgent));
  return hit ? hit.name : null;
}

export function InAppBrowserWarning() {
  const [appName, setAppName] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem(STORAGE_KEY) === '1') return;
    const detected = detectInAppBrowser(navigator.userAgent);
    if (!detected) return;
    // setState を microtask に逃がし、effect body 内での同期 setState を回避
    // (MobileHostWarning と同じパターン)。
    queueMicrotask(() => setAppName(detected));
  }, []);

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setAppName(null);
  };

  if (!appName) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-amber-600 px-4 py-2 text-sm text-white shadow-lg">
      <div className="mx-auto flex max-w-2xl items-start gap-3">
        <span aria-hidden>⚠️</span>
        <p className="flex-1 leading-relaxed">
          {appName}内のブラウザで開いています。カメラ/マイクが使えない場合があります。
          右上のメニューから「他のブラウザで開く」を選ぶか、URLをコピーしてChromeで開き直してください。
        </p>
        <button
          onClick={handleDismiss}
          className="rounded-md px-1.5 py-0.5 text-white/80 hover:bg-black/10 hover:text-white"
          aria-label="閉じる"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
