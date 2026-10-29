'use client';

import { useEffect, useState } from 'react';
import type { Room } from 'livekit-client';
import { UplinkWatchdog, type UplinkEvent } from '@/lib/uplink-watchdog';

export interface UplinkNotice {
  tone: 'error' | 'info';
  message: string;
}

/** 送信停止のときに本人へ出す案内。原因の多くは PC・Wi-Fi 側にある */
const LOCAL_HINT =
  '画面のワイヤレス投影（キャスト）を止める、5 GHz の Wi-Fi か有線に替える、などで直ることがあります。';

function noticeFor(event: UplinkEvent): UplinkNotice | null {
  switch (event.type) {
    case 'stalled':
      return event.willSwitch
        ? { tone: 'error', message: 'あなたの映像と音声が相手に届いていません。\n接続方式を切り替えています…' }
        : { tone: 'error', message: `あなたの映像と音声が相手に届いていません。\n${LOCAL_HINT}` };
    case 'switched':
      return event.ok
        ? { tone: 'info', message: '接続方式を切り替えました。映像と音声が届くようになりました。' }
        : { tone: 'error', message: `接続方式を切り替えましたが、まだ届いていません。\n${LOCAL_HINT}` };
    case 'recovered':
      return null;
  }
}

/**
 * 通話中の送信停止を見張り、止まったら TLS 中継へ切り替える (lib/uplink-watchdog.ts)。
 * 本人への案内と、開発側への記録 (/api/call-incident → Discord) を出す。
 * 開発環境では URL に ?simulateStall を付けると、入室 10 秒後に停止したものとして流れを試せる。
 */
export function useUplinkWatchdog(room: Room, roomName: string) {
  const [notice, setNotice] = useState<UplinkNotice | null>(null);

  useEffect(() => {
    const simulateStall =
      process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).has('simulateStall');
    const watchdog = new UplinkWatchdog(room, {
      simulateStall,
      onEvent: (event) => {
        const next = noticeFor(event);
        setNotice((prev) => (event.type === 'recovered' ? null : next ?? prev));
        void fetch('/api/call-incident', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...event, room: roomName }),
          keepalive: true,
        }).catch(() => {});
      },
    });
    return watchdog.start();
  }, [room, roomName]);

  // 「届くようになった」はしばらくしたら自動で消す
  useEffect(() => {
    if (notice?.tone !== 'info') return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  return { notice, dismiss: () => setNotice(null) };
}
