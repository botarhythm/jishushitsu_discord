'use client';

import { useState } from 'react';
import type { ReceivedChatMessage } from '@livekit/components-react';
import { LinkifiedText } from './LinkifiedText';

export interface ChatDeletionProps {
  deletedKeys: ReadonlySet<string>;
  canDelete: (m: ReceivedChatMessage) => boolean;
  onDelete: (m: ReceivedChatMessage) => Promise<void>;
}

interface ChatMessageItemProps {
  message: ReceivedChatMessage;
  isSelf: boolean;
  deleted: boolean;
  canDelete: boolean;
  onDelete: (m: ReceivedChatMessage) => Promise<void>;
}

/** チャット 1 件分（名前・時刻・本文・削除）。ChatPanel と StudioChatPanel で共用 */
export function ChatMessageItem({ message: m, isSelf, deleted, canDelete, onDelete }: ChatMessageItemProps) {
  const [deleting, setDeleting] = useState(false);
  const name = m.from?.name || m.from?.identity || '匿名';
  const time = new Date(m.timestamp).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleDelete = async () => {
    const whose = isSelf ? 'このメッセージ' : `${name} さんのメッセージ`;
    if (!window.confirm(`${whose}を削除しますか？\n参加者全員の画面から消えます。`)) return;
    setDeleting(true);
    try {
      await onDelete(m);
    } catch (e) {
      console.error('[chat-delete] send failed', e);
      alert('削除できませんでした。もう一度お試しください。');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
      <div className="flex items-baseline gap-2 text-[10px] text-stone-500">
        <span className="font-medium text-stone-400">{isSelf ? '自分' : name}</span>
        <span>{time}</span>
        {canDelete && !deleted && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            className="rounded px-1 text-stone-500 hover:bg-stone-700 hover:text-red-300 disabled:opacity-50"
            aria-label={`${isSelf ? '自分' : name}の ${time} のメッセージを削除`}
          >
            {deleting ? '削除中…' : '削除'}
          </button>
        )}
      </div>
      {deleted ? (
        <div className="mt-0.5 max-w-[85%] rounded-2xl border border-stone-700 px-3 py-1.5 text-xs italic text-stone-500">
          メッセージは削除されました
        </div>
      ) : (
        <div
          className={`mt-0.5 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ${
            isSelf ? 'bg-amber-600 text-white' : 'bg-stone-700 text-stone-100'
          }`}
        >
          <LinkifiedText
            text={m.message}
            linkClassName={isSelf ? 'text-white hover:text-amber-100' : 'text-amber-300 hover:text-amber-200'}
          />
        </div>
      )}
    </div>
  );
}
