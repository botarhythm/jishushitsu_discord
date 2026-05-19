'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token ?? '';
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('お名前を入力してください');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/guest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `参加に失敗しました (${res.status})`);
      }
      router.replace('/room');
    } catch (err) {
      setError(err instanceof Error ? err.message : '予期しないエラー');
      setSubmitting(false);
    }
  };

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

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-lg p-8 md:p-10"
        >
          <p className="text-sm text-stone-700 font-noto-sans-jp mb-6 leading-relaxed">
            講師から共有された招待リンクで参加します。
            <br />
            <span className="text-xs text-stone-500">
              このリンクは一度退出すると無効になります。
            </span>
          </p>

          <label className="block text-sm font-medium text-stone-700 font-noto-sans-jp mb-2">
            お名前
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            maxLength={32}
            placeholder="例: 山田 太郎"
            className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-50"
            autoFocus
          />

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm font-noto-sans-jp">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="mt-6 block w-full text-center py-3 bg-green-700 text-white font-medium rounded-lg hover:bg-green-800 active:scale-[0.98] transition font-noto-sans-jp disabled:opacity-50"
          >
            {submitting ? '参加中…' : '自習室に入る'}
          </button>

          <div className="md:hidden mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-xs text-amber-800 font-noto-sans-jp leading-relaxed">
              スマートフォンからご利用の場合、画面共有はご利用いただけません。聴講のみ可能です。
            </p>
          </div>
        </form>

        <p className="text-center text-xs text-stone-500 mt-6 font-noto-sans-jp">
          © デジタル原っぱ大学
        </p>
      </div>
    </div>
  );
}
