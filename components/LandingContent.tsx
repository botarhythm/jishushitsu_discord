'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import type { TokenResponse, UserRole } from '@/lib/types';

export default function LandingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [isInstructor, setIsInstructor] = useState<boolean>(false);

  const role: UserRole = searchParams.get('role') === 'instructor' ? 'instructor' : 'student';
  const instructorKey = searchParams.get('key');

  // 講師の自動ログイン処理
  useEffect(() => {
    if (role === 'instructor' && instructorKey) {
      const loginAsInstructor = async () => {
        try {
          // setState は async コールバック内に置く: effect body での同期 setState を回避。
          setIsInstructor(true);
          setIsLoading(true);
          const response = await fetch('/api/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              roomName: 'main',
              participantName: '講師',
              role: 'instructor',
              instructorKey,
            }),
          });

          if (!response.ok) {
            throw new Error('トークン取得に失敗しました');
          }

          const data: TokenResponse = await response.json();

          // sessionStorageに保存
          sessionStorage.setItem('lk_token', data.token);
          sessionStorage.setItem('lk_url', data.livekitUrl);
          sessionStorage.setItem('lk_name', data.participantName || '講師');
          sessionStorage.setItem('lk_role', 'instructor');
          sessionStorage.setItem('lk_room', 'main');
          if (instructorKey) sessionStorage.setItem('lk_instructor_key', instructorKey);

          // ルームに遷移
          router.push('/room');
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : '予期しないエラーが発生しました';
          setError(errorMessage);
          setIsLoading(false);
        }
      };

      loginAsInstructor();
    }
  }, [role, instructorKey, router]);

  const sanitizeName = (input: string): string => {
    return input.replace(/[<>'"&]/g, '');
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();

    // バリデーション
    if (!trimmedName) {
      setError('お名前を入力してください');
      return;
    }

    if (trimmedName.length > 20) {
      setError('お名前は20文字以内で入力してください');
      return;
    }

    const sanitizedName = sanitizeName(trimmedName);

    try {
      setIsLoading(true);
      const response = await fetch('/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          roomName: 'main',
          participantName: sanitizedName,
          role: 'student',
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'トークン取得に失敗しました');
      }

      const data: TokenResponse = await response.json();

      // sessionStorageに保存
      sessionStorage.setItem('lk_token', data.token);
      sessionStorage.setItem('lk_url', data.livekitUrl);
      sessionStorage.setItem('lk_name', data.participantName || sanitizedName);
      sessionStorage.setItem('lk_role', 'student');
      sessionStorage.setItem('lk_room', 'main');

      // ルームに遷移
      router.push('/room');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '予期しないエラーが発生しました';
      setError(errorMessage);
      setIsLoading(false);
    }
  };

  if (isInstructor && isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-50">
        <div className="text-center">
          <p className="text-stone-600 font-noto-sans-jp">接続中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-50 via-green-50 to-amber-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-md">
        {/* ヘッダー */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-stone-900 font-noto-sans-jp mb-2">
            デジタル原っぱ大学
          </h1>
          <p className="text-lg md:text-xl text-green-700 font-noto-sans-jp font-medium">
            自習室
          </p>
        </div>

        {/* フォームカード */}
        <div className="bg-white rounded-2xl shadow-lg p-8 md:p-10">
          {/* エラーメッセージ */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm font-noto-sans-jp">{error}</p>
            </div>
          )}

          {/* 名前入力フォーム */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-stone-700 mb-2 font-noto-sans-jp">
                お名前
              </label>
              <input
                id="name"
                type="text"
                placeholder="お名前を入力してください"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
                maxLength={20}
                className="w-full px-4 py-3 border border-stone-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent disabled:bg-stone-50 disabled:cursor-not-allowed font-noto-sans-jp"
              />
              <p className="text-xs text-stone-500 mt-1 font-noto-sans-jp">
                {name.length}/20文字
              </p>
            </div>

            <button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="w-full py-3 bg-gradient-to-r from-green-600 to-green-700 text-white font-medium rounded-lg hover:from-green-700 hover:to-green-800 transition-all disabled:from-stone-300 disabled:to-stone-400 disabled:cursor-not-allowed font-noto-sans-jp"
            >
              {isLoading ? '接続中...' : '参加する'}
            </button>
          </form>

          {/* スマホ注意書き */}
          <div className="md:hidden mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-xs text-amber-800 font-noto-sans-jp leading-relaxed">
              スマートフォンからご利用の場合、画面共有はご利用いただけません。聴講のみ可能です。
            </p>
          </div>

          {/* ブラウザ権限ガイド */}
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

        {/* フッター */}
        <p className="text-center text-xs text-stone-500 mt-6 font-noto-sans-jp">
          © デジタル原っぱ大学
        </p>
      </div>
    </div>
  );
}
