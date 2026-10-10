'use client';

import { useState } from 'react';

export type EndSessionChoice = 'end-all' | 'leave-self';

interface EndSessionModalProps {
  ending: boolean;
  endResult?: { success: true } | { success: false; error: string } | null;
  onChoose: (choice: EndSessionChoice) => void;
  onClose: () => void;
}

/**
 * Zoom 風の「セッションを終了しますか？」モーダル。
 *
 * - 「全員終了」: 全員退出
 * - 「自分だけ退出」: 講師だけ退出（受講生は自習室に残る）
 * - 「キャンセル」: 何もせず閉じる
 *
 * どの退出でも、録画中ならタブ録画を停止してファイルを保存してから退出する (useEndSession)。
 */
export function EndSessionModal({ ending, endResult, onChoose, onClose }: EndSessionModalProps) {
  // confirmingEndAll はモーダルがマウント中だけ有効。
  // 親が条件レンダリングで unmount するため、再オープン時は自動的にリセットされる。
  const [confirmingEndAll, setConfirmingEndAll] = useState(false);

  if (endResult?.success) {
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">セッションを終了しました</h2>
          <p className="text-sm text-stone-700 mb-4">退出処理が完了しました。</p>
          <button
            onClick={onClose}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            閉じる
          </button>
        </Panel>
      </Backdrop>
    );
  }

  if (endResult && !endResult.success) {
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-red-700 mb-2">終了処理に失敗しました</h2>
          <p className="text-sm text-stone-700 mb-4">{endResult.error}</p>
          <button
            onClick={() => onChoose('end-all')}
            className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2"
          >
            もう一度試す
          </button>
          <button
            onClick={onClose}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            キャンセル
          </button>
        </Panel>
      </Backdrop>
    );
  }

  if (ending) {
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">終了処理中...</h2>
          <p className="text-sm text-stone-700 mb-4">
            セッションを終了しています。この画面を閉じないでください。
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-500" />
          </div>
        </Panel>
      </Backdrop>
    );
  }

  if (confirmingEndAll) {
    return (
      <Backdrop onBackdropClick={onClose}>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">本当に全員終了しますか？</h2>
          <p className="text-sm text-stone-700 mb-2">受講生も全員退出させます。</p>
          <button
            onClick={() => onChoose('end-all')}
            className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2"
          >
            全員終了する
          </button>
          <button
            onClick={() => setConfirmingEndAll(false)}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            戻る
          </button>
        </Panel>
      </Backdrop>
    );
  }

  return (
    <Backdrop onBackdropClick={onClose}>
      <Panel>
        <h2 className="text-lg font-bold text-stone-900 mb-4">セッションを終了しますか？</h2>

        <button
          onClick={() => setConfirmingEndAll(true)}
          className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2 text-left"
        >
          <div className="font-semibold">全員終了</div>
          <div className="text-xs opacity-90 mt-0.5">受講生も含めて全員が退出します</div>
        </button>

        <button
          onClick={() => onChoose('leave-self')}
          className="block w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50 mb-2 text-left"
        >
          <div className="font-semibold">自分だけ退出</div>
          <div className="text-xs text-stone-500 mt-0.5">受講生は自習室に残ります</div>
        </button>

        <button
          onClick={onClose}
          className="block w-full rounded-lg px-4 py-3 text-sm font-medium text-stone-500 hover:bg-stone-50"
        >
          キャンセル
        </button>
      </Panel>
    </Backdrop>
  );
}

function Backdrop({
  children,
  onBackdropClick,
}: {
  children: React.ReactNode;
  onBackdropClick?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onBackdropClick}
    >
      {children}
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
