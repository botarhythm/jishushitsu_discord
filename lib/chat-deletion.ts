'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Room, TextStreamReader } from 'livekit-client';
import type { ReceivedChatMessage } from '@livekit/components-react';

/**
 * チャットの削除。
 *
 * LiveKit のチャットは各参加者の画面にだけ残り、サーバーには保存されない。
 * そのため削除は「この発言を消した」という知らせを全員に送り、受け取った側が
 * 自分の画面で本文を伏せる方式にする。知らせはチャット本体と同じテキストストリーム
 * （別トピック）で送る。
 *
 * 削除できるのは、発言者本人と講師。受け取った側でも送り手を確かめ、
 * 本人でも講師でもない人からの知らせは無視する。
 * 講師の判定は画面の他の箇所と同じく、参加者 metadata の role を使う。
 */
export const CHAT_DELETE_TOPIC = 'jishushitsu-chat-delete';

interface DeletePayload {
  id: string;
  author: string;
}

/** 発言を一意に表すキー。id はテキストストリームの id で、送り手・受け手で共通 */
export function chatMessageKey(m: ReceivedChatMessage): string {
  return `${m.from?.identity ?? ''}:${m.id}`;
}

function isInstructorIdentity(room: Room, identity: string): boolean {
  const p =
    identity === room.localParticipant.identity
      ? room.localParticipant
      : room.getParticipantByIdentity(identity);
  if (!p) return false;
  try {
    return (JSON.parse(p.metadata ?? '{}') as { role?: string }).role === 'instructor';
  } catch {
    return false;
  }
}

function parsePayload(text: string): DeletePayload | null {
  try {
    const v = JSON.parse(text) as Partial<DeletePayload>;
    if (typeof v.id !== 'string' || typeof v.author !== 'string') return null;
    return { id: v.id, author: v.author };
  } catch {
    return null;
  }
}

export function useChatDeletion(room: Room) {
  const [deletedKeys, setDeletedKeys] = useState<ReadonlySet<string>>(() => new Set());

  const markDeleted = useCallback((key: string) => {
    setDeletedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  useEffect(() => {
    const handler = async (reader: TextStreamReader, participantInfo: { identity: string }) => {
      const payload = parsePayload(await reader.readAll());
      if (!payload) return;
      const sender = participantInfo.identity;
      if (sender !== payload.author && !isInstructorIdentity(room, sender)) {
        console.warn('[chat-delete] ignored: sender is neither author nor instructor', sender);
        return;
      }
      markDeleted(`${payload.author}:${payload.id}`);
    };
    try {
      room.registerTextStreamHandler(CHAT_DELETE_TOPIC, (reader, info) => {
        handler(reader, info).catch((e) => console.warn('[chat-delete] receive failed', e));
      });
    } catch (e) {
      console.warn('[chat-delete] handler already registered', e);
    }
    return () => room.unregisterTextStreamHandler(CHAT_DELETE_TOPIC);
  }, [room, markDeleted]);

  const canDelete = useCallback(
    (m: ReceivedChatMessage): boolean => {
      const author = m.from?.identity;
      if (!author || !m.id) return false;
      const self = room.localParticipant.identity;
      return author === self || isInstructorIdentity(room, self);
    },
    [room]
  );

  const deleteMessage = useCallback(
    async (m: ReceivedChatMessage): Promise<void> => {
      const author = m.from?.identity;
      if (!author || !canDelete(m)) return;
      const payload: DeletePayload = { id: m.id, author };
      await room.localParticipant.sendText(JSON.stringify(payload), { topic: CHAT_DELETE_TOPIC });
      markDeleted(chatMessageKey(m));
    },
    [room, canDelete, markDeleted]
  );

  return { deletedKeys, canDelete, deleteMessage };
}
