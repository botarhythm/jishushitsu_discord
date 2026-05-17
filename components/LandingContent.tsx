'use client';

import { useSearchParams } from 'next/navigation';

export default function LandingContent() {
  const searchParams = useSearchParams();
  const authError = searchParams.get('auth_error');

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-50 via-green-50 to-amber-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-stone-900 font-noto-sans-jp mb-2">
            デジタル原っぱ大学
          </h1>
          <p className="text-lg md:text-xl text-green-700 font-noto-sans-jp font-medium">
            自習室
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-8 md:p-10">
          {authError && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm font-noto-sans-jp">{authError}</p>
            </div>
          )}

          <p className="text-sm text-stone-700 font-noto-sans-jp mb-6 leading-relaxed">
            このアプリは Discord アカウントでログインします。
            <br />
            <span className="text-xs text-stone-500">
              対象の Discord サーバーに参加しているメンバーのみご利用いただけます。
            </span>
          </p>

          <a
            href="/api/auth/discord/start"
            className="block w-full text-center py-3 bg-[#5865F2] text-white font-medium rounded-lg hover:bg-[#4752C4] active:scale-[0.98] transition font-noto-sans-jp"
          >
            Discordでログイン
          </a>

          <div className="md:hidden mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-xs text-amber-800 font-noto-sans-jp leading-relaxed">
              スマートフォンからご利用の場合、画面共有はご利用いただけません。聴講のみ可能です。
            </p>
          </div>

          <details className="mt-8 border-t border-stone-200 pt-6">
            <summary className="cursor-pointer text-sm font-medium text-stone-700 hover:text-stone-900 font-noto-sans-jp">
              ブラウザの権限について
            </summary>
            <div className="mt-4 space-y-3 text-xs text-stone-600 font-noto-sans-jp leading-relaxed">
              <p>
                <span className="font-medium">マイク・カメラ権限:</span> 初回接続時、ブラウザがマイクとカメラのアクセス許可を求めます。「許可」を選択してください。
              </p>
              <p>
                <span className="font-medium">画面共有:</span> 画面を共有する場合は、別途許可が必要です。講師の指示に従ってください。
              </p>
              <p>
                <span className="font-medium">権限を拒否した場合:</span> ブラウザの設定からサイト権限を変更できます。
              </p>
            </div>
          </details>
        </div>

        <p className="text-center text-xs text-stone-500 mt-6 font-noto-sans-jp">
          © デジタル原っぱ大学
        </p>
      </div>
    </div>
  );
}
