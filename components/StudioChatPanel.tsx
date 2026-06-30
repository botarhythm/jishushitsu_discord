'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import type { ReceivedChatMessage } from '@livekit/components-react';
import type { SendTextOptions } from 'livekit-client';

interface StudioChatPanelProps {
  /** 表示中か。false の間も実装上マウントし続け、未読数を数えてバッジに反映する */
  open: boolean;
  /** 最小化 (左パネルを閉じる)。再表示は収録バーのチャットボタンから */
  onClose: () => void;
  onUnreadChange?: (count: number) => void;
  chatMessages: ReceivedChatMessage[];
  send: (message: string, options?: SendTextOptions) => Promise<ReceivedChatMessage>;
  isSending: boolean;
}

/**
 * 収録モード専用のチャットパネル。
 *
 * - ステージ (16:9, Region Capture のクロップ対象) の左に並ぶ flex 兄弟として配置するため、
 *   録画矩形に重ならない = 収録には映らない。
 * - 邪魔なときはヘッダーの「－」で最小化でき、収録バーのチャットボタンから再表示する。
 * - 最小化中もマウントし続けて未読数を数え、バッジへ反映する (ChatPanel と同じ方式)。
 */
export function StudioChatPanel({
  open,
  onClose,
  onUnreadChange,
  chatMessages,
  send,
  isSending,
}: StudioChatPanelProps) {
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
      console.error('[StudioChatPanel] send failed', e);
    }
  };

  // 最小化中はレイアウトから外す (ステージが全幅へ広がる)。未読カウントの hook は上で実行済み。
  if (!open) return null;

  return (
    <aside className="z-30 flex h-full w-80 max-w-[85vw] shrink-0 flex-col border-r border-stone-700 bg-stone-900/95 shadow-2xl backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-stone-700 px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-stone-100">チャット</h2>
          <span className="rounded bg-stone-700/80 px-1.5 py-0.5 text-[10px] text-stone-400">
            収録には映りません
          </span>
        </div>
        <button
          onClick={onClose}
          className="rounded-md px-2 py-1 text-stone-400 hover:bg-stone-700 hover:text-stone-200"
          aria-label="チャットを最小化"
          title="最小化"
        >
          －
        </button>
      </div>

      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {chatMessages.length === 0 && (
          <p className="py-8 text-center text-xs text-stone-500">メッセージはまだありません</p>
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
                  isSelf ? 'bg-amber-600 text-white' : 'bg-stone-700 text-stone-100'
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
