'use client';

import { useEffect, useRef, useState } from 'react';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';
import { UplinkWatchdog, type UplinkEvent } from '@/lib/uplink-watchdog';
import { switchToTls } from '@/lib/connection-test';
import { rememberTls, shouldStartWithTls } from '@/lib/prefer-tls';

export interface UplinkNotice {
  tone: 'error' | 'info';
  message: string;
  /** しばらくしたら自動で消す */
  autoHide?: boolean;
}

/** 切り替えても直らないときに本人へ出す案内 */
const LOCAL_HINT =
  '画面のワイヤレス投影（キャスト）を止める、5 GHz の Wi-Fi か有線に替える、などで直ることがあります。';

function noticeFor(event: UplinkEvent): UplinkNotice | null {
  switch (event.type) {
    case 'video-paused':
      return {
        tone: 'info',
        message: '通信が不安定なため、あなたのカメラ映像を一時的に止めて、音声を優先しています。\n安定したら自動で戻します。',
      };
    case 'video-resumed':
      return event.error
        ? { tone: 'error', message: 'カメラ映像を戻せませんでした。カメラのボタンで ON にしてください。' }
        : { tone: 'info', message: '通信が安定したので、カメラ映像を戻しました。', autoHide: true };
    case 'stalled':
      if (event.willSwitch) {
        return { tone: 'error', message: '通信が不安定です。接続方式を切り替えています…' };
      }
      return { tone: 'error', message: `通信が不安定で、あなたの映像と音声が届きにくくなっています。\n${LOCAL_HINT}` };
    case 'switched':
      return event.ok
        ? { tone: 'info', message: '接続方式を切り替えました。映像と音声が届くようになりました。', autoHide: true }
        : { tone: 'error', message: `接続方式を切り替えましたが、まだ届きにくい状態です。\n${LOCAL_HINT}` };
    case 'recovered':
      return null;
  }
}

/**
 * 通話中の劣化を見張り、映像を止めて音声を守り、TLS 中継へ切り替える (lib/uplink-watchdog.ts)。
 * 切り替えで直った端末は覚えておき、次の入室から最初に TLS 中継へ切り替える (lib/prefer-tls.ts)。
 * 本人への案内と、開発側への記録 (/api/call-incident → Discord) を出す。
 * 開発環境では URL に ?simulateStall を付けると、入室 10 秒後に劣化したものとして流れを試せる。
 */
export function useUplinkWatchdog(room: Room, roomName: string, isRecording: boolean) {
  const [notice, setNotice] = useState<UplinkNotice | null>(null);
  const recordingRef = useRef(isRecording);
  useEffect(() => {
    recordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const simulateStall =
      process.env.NODE_ENV !== 'production' && new URLSearchParams(window.location.search).has('simulateStall');
    const watchdog = new UplinkWatchdog(room, {
      simulateStall,
      canPauseVideo: () => !recordingRef.current,
      onEvent: (event) => {
        if (event.type === 'switched' && event.ok) rememberTls();
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
    const stop = watchdog.start();

    // 前に TLS 中継で直った端末は、入室したらすぐ TLS 中継へ切り替える
    let cancelled = false;
    const startWithTls = () => {
      if (cancelled || !shouldStartWithTls()) return;
      cancelled = true;
      console.info('[uplink] 前回 TLS 中継で直った端末のため、TLS 中継へ切り替えます');
      void switchToTls(room, 20_000).catch((e) => console.warn('[uplink] TLS 中継への切り替えに失敗', e));
    };
    if (room.state === ConnectionState.Connected) startWithTls();
    else room.once(RoomEvent.Connected, startWithTls);

    return () => {
      cancelled = true;
      room.off(RoomEvent.Connected, startWithTls);
      stop();
    };
  }, [room, roomName]);

  useEffect(() => {
    if (!notice?.autoHide) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  return { notice, dismiss: () => setNotice(null) };
}
