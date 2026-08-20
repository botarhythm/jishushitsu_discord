'use client';

import { useState } from 'react';

/**
 * 手順書に差し込むスクリーンショット。
 *
 * 画像ファイルがまだ置かれていない間は、代わりに置き場所を示す枠を出す。
 * 手順書としては画像が無くても読めるようにしておき、後から
 * `public/help/ai-participant/` に png を置けば自動的に表示される。
 */
export function Shot({ src, caption }: { src: string; caption: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <figure className="my-5 rounded-lg border border-dashed border-stone-700 bg-stone-900/60 px-4 py-6 text-center">
        <p className="text-sm text-stone-400">{caption}</p>
        <p className="mt-1 text-xs text-stone-600">
          スクリーンショット未設置 —{' '}
          <code className="rounded bg-stone-800 px-1 py-0.5">public{src}</code> に置くと表示されます
        </p>
      </figure>
    );
  }

  return (
    <figure className="my-5">
      {/* 手順書の挿絵。実寸が環境によって違うため next/image ではなく素の img で扱う */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={caption}
        onError={() => setFailed(true)}
        className="w-full rounded-lg border border-stone-800"
      />
      <figcaption className="mt-2 text-center text-xs text-stone-500">{caption}</figcaption>
    </figure>
  );
}
