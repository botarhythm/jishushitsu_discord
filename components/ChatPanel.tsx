'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import type { ReceivedChatMessage } from '@livekit/components-react';
import type { SendTextOptions } from 'livekit-client';

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  onUnreadChange?: (count: number) => void;
  chatMessages: ReceivedChatMessage[];
  send: (message: string, options?: SendTextOptions) => Promise<ReceivedChatMessage>;
  isSending: boolean;
}

export function ChatPanel({
  open,
  onClose,
  onUnreadChange,
  chatMessages,
  send,
  isSending,
}: ChatPanelProps) {
  const { localParticipant } = useLocalParticipant();
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeenRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    lastSeenRef.current = chatMessages.length;
    onUnreadChange?.(0);
  }, [chatMessages.length, open, onUnreadChange]);

  useEffect(() => {
    if (open) return;
    const unread = Math.max(0, chatMessages.length - lastSeenRef.current);
    onUnreadChange?.(unread);
  }, [chatMessages.length, open, onUnreadChange]);

  const handleSend = async () => {
    const msg = text.trim();
    if (!msg || isSending) return;
    setText('');
    try {
      await send(msg);
    } catch (e) {
      console.error('[ChatPanel] send failed', e);
    }
  };

  if (!open) return null;

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-stone-700 bg-stone-800 shadow-2xl sm:static sm:z-auto sm:max-w-xs">
      <div className="flex items-center justify-between border-b border-stone-700 px-4 py-2">
        <h2 className="text-sm font-semibold text-stone-100">チャット</h2>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-stone-400 hover:bg-stone-700 hover:text-stone-200"
          aria-label="チャットを閉じる"
        >
          ✕
        </button>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {chatMessages.length === 0 && (
          <p className="text-center text-xs text-stone-500 py-8">
            メッセージはまだありません
          </p>
        )}
        {chatMessages.map((m) => {
          const isSelf = m.from?.identity === localParticipant?.identity;
          const name = m.from?.name || m.from?.identity || '匿名';
          const time = new Date(m.timestamp).toLocaleTimeString('ja-JP', {
            hour: '2-digit',
            minute: '2-digit',
          });
          return (
            <div
              key={`${m.timestamp}-${m.from?.identity ?? 'x'}`}
              className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}
            >
              <div className="flex items-baseline gap-2 text-[10px] text-stone-500">
                <span className="font-medium text-stone-400">{isSelf ? '自分' : name}</span>
                <span>{time}</span>
              </div>
              <div
                className={`mt-0.5 max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ${
                  isSelf
                    ? 'bg-amber-600 text-white'
                    : 'bg-stone-700 text-stone-100'
                }`}
              >
                {m.message}
              </div>
            </div>
          );
        })}
      </div>

      <form
        className="flex items-end gap-2 border-t border-stone-700 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="メッセージを入力 (Enterで送信 / Shift+Enterで改行)"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-stone-600 bg-stone-900 px-3 py-1.5 text-sm text-stone-100 placeholder:text-stone-500 focus:border-amber-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={isSending || !text.trim()}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-stone-600"
        >
          送信
        </button>
      </form>
    </aside>
  );
}
