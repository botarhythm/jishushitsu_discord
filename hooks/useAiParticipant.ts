'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionState, DisconnectReason, Room as LiveKitRoom, RoomEvent, Track, type Room } from 'livekit-client';
import {
  aiAudioTrackName,
  classifyAudioPublication,
  type AiParticipantConfig,
  type AiParticipantInfo,
  type AiTileState,
  type StudioAiDescriptor,
} from '@/lib/studio-participants';
import type { AiParticipantProvider, AiProviderStatus } from '@/lib/ai/provider';
import { DesktopChatGPTProvider } from '@/lib/ai/desktop-chatgpt-provider';
import { FakeAiProvider } from '@/lib/ai/fake-provider';
import { ChatGptInputMixer } from '@/lib/ai/chatgpt-input-mixer';
import { RmsSpeakingDetector } from '@/lib/ai/speaking-detector';
import { recordSessionEvent } from '@/lib/session-clock';
import { AI_LIVEKIT_IDENTITY } from '@/lib/ai/livekit-participant';

/** AI 参加者の固定 ID。再接続・トラック差し替えでも不変（要件§26） */
export const AI_PARTICIPANT_ID = 'chatgpt';

/**
 * Provider factory。
 * Provider 実装（Desktop/Fake/将来の API Provider）を import してよいのはこの factory だけ
 * （AC-006: 新 Provider 追加時に変更されるのは factory とセットアップフォームのみ）。
 *
 * sourceDeviceId に 'fake' を指定すると FakeAiProvider（880Hz トーン）になる。
 * ChatGPT / 仮想デバイスなしで結合テストをするための開発用フック。
 */
function createProvider(
  info: AiParticipantInfo,
  getDeviceId: () => string | null
): AiParticipantProvider {
  if (getDeviceId() === 'fake') {
    return new FakeAiProvider(info, 880);
  }
  return new DesktopChatGPTProvider(info, getDeviceId);
}

interface UseAiParticipantOptions {
  room: Room | null;
  /** AI 参加者を有効にするか（セットアップUIのオプトイン。false なら一切のコードパスが走らない） */
  enabled: boolean;
  config: AiParticipantConfig;
  /** 接続喪失・競合時に外側の開始許可を破棄する */
  onTerminalFailure?: (message: string) => void;
}

export interface UseAiParticipantResult {
  status: AiProviderStatus;
  /** publish が失敗した（録画は継続・リモート配信のみ不成立）ときの別状態表示用 */
  publishFailed: boolean;
  /** ホスト側の AI タイル状態。無効時は null */
  tile: AiTileState | null;
  /** room metadata で全参加者に配信する記述子。無効時は null */
  descriptor: StudioAiDescriptor | null;
  /** ChatGPT 入力ミキサーの起動に失敗したときの理由（送出経路が死んでいる） */
  inputMixerError: string | null;
  /** 自己ループ検査中に送出を止めるためのスイッチ */
  setInputMixerSendEnabled: (on: boolean) => void;
  /** 検査用: ミキサーのローカルマイク混入を直接切り替える (設定は変えない) */
  setInputMixerIncludeLocalMic: (on: boolean) => void;
  /** 送出経路の内部状態を取得する（切り分け用。未起動なら null） */
  getInputMixerDiagnostics: () => ReturnType<ChatGptInputMixer["getDiagnostics"]> | null;
}

/**
 * AI 参加者のライフサイクル管理（ホスト側）。
 *
 * enabled の間:
 *  - Provider を connect し音声トラックを取得
 *  - AudioTrackRegistry に登録（録画ミキサーが動的に mix）
 *  - LiveKit に publish（リモート人間参加者が AI の声を聞けるように）
 *  - ホストのモニタ用 <audio>（既定出力=ヘッドホン）で AI の声をホストにも聞かせる
 *  - config.sinkDeviceId があれば ChatGPT 入力ミキサー（人間の声 → CABLE-B）を起動
 *
 * 障害分離（要件§26 / NFR-006）: トラック消失で status=error になっても録画・収録は
 * 継続する。reconnect() で同一 ID のまま復帰する。
 */
export function useAiParticipant({
  room,
  enabled,
  config,
  onTerminalFailure,
}: UseAiParticipantOptions): UseAiParticipantResult {
  const [status, setStatus] = useState<AiProviderStatus>('disconnected');
  const [publishFailed, setPublishFailed] = useState(false);
  const [inputMixerError, setInputMixerError] = useState<string | null>(null);
  // isSpeaking だけ state。level は 100ms ごとに変わるので ref に置き、
  // 描画ループから読ませて再レンダリングを起こさない。
  const [isSpeaking, setIsSpeaking] = useState(false);
  const levelRef = useRef(0);
  const getLevel = useCallback(() => levelRef.current, []);

  const mixerRef = useRef<ChatGptInputMixer | null>(null);
  const terminateRuntimeRef = useRef<((message: string) => void) | null>(null);
  const aiRoomRef = useRef<LiveKitRoom | null>(null);
  const generationRef = useRef(0);
  const wasSpeakingRef = useRef(false);

  const configRef = useRef(config);
  const onTerminalFailureRef = useRef(onTerminalFailure);

  const info = useMemo<AiParticipantInfo>(
    () => ({ id: AI_PARTICIPANT_ID, displayName: config.displayName, avatar: config.avatar }),
    [config.displayName, config.avatar]
  );
  const infoRef = useRef(info);
  useEffect(() => {
    configRef.current = config;
    infoRef.current = info;
    onTerminalFailureRef.current = onTerminalFailure;
  }, [config, info, onTerminalFailure]);

  const trackName = aiAudioTrackName(AI_PARTICIPANT_ID);

  // ── Provider ライフサイクル ──
  useEffect(() => {
    if (!enabled || !room) {
      queueMicrotask(() => {
        setStatus('disconnected');
        setPublishFailed(false);
        setInputMixerError(null);
      });
      return;
    }

    let cancelled = false;
    let stopPromise: Promise<void> | null = null;
    let terminal = false;
    let ownedAiRoom: LiveKitRoom | null = null;
    let ownedPublishedTrack: MediaStreamTrack | null = null;
    let releaseRoomWait: (() => void) | null = null;
    const generation = ++generationRef.current;
    const provider = createProvider(infoRef.current, () => configRef.current.sourceDeviceId);

    const isCurrent = () => !cancelled && !terminal && generationRef.current === generation;

    const stopRuntime = async () => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        releaseRoomWait?.();
        releaseRoomWait = null;
        const aiRoom = ownedAiRoom;
        const publishedTrack = ownedPublishedTrack;
        ownedPublishedTrack = null;
        ownedAiRoom = null;
        if (aiRoomRef.current === aiRoom) aiRoomRef.current = null;
        if (aiRoom && publishedTrack) {
          await aiRoom.localParticipant.unpublishTrack(publishedTrack, false).catch(() => {});
        }
        await provider.disconnect().catch(() => {});
        if (aiRoom) await aiRoom.disconnect(false).catch(() => {});
      })();
      try {
        await stopPromise;
      } finally {
        stopPromise = null;
      }
    };

    const failRuntime = (message: string) => {
      if (!isCurrent()) return;
      terminal = true;
      generationRef.current += 1;
      setInputMixerError(message);
      setStatus('error');
      setPublishFailed(true);
      onTerminalFailureRef.current?.(message);
      void stopRuntime();
    };
    terminateRuntimeRef.current = failRuntime;
    const onHumanReconnecting = () => {
      failRuntime('通話ルームの接続が切れました。復旧後に手動でChatGPTを再開してください。');
    };
    room.on(RoomEvent.Reconnecting, onHumanReconnecting);
    room.on(RoomEvent.Disconnected, onHumanReconnecting);

    const offStatus = provider.onStatusChange((s) => {
      if (!isCurrent()) return;
      if (s === 'error' || s === 'disconnected') {
        recordSessionEvent({ type: "participant_error", participantId: AI_PARTICIPANT_ID });
        failRuntime('ChatGPT音声ソースが切断されました。停止してから明示的に再開してください。');
        return;
      }
      // connected は LiveKit publish 完了後にだけ表示し、入力ミキサーもその時点で起動する。
      if (s !== 'connected') setStatus(s);
    });
    const offSpeaking = provider.onSpeaking((s) => {
      if (cancelled) return;
      levelRef.current = s.level;
      // 同じ真偽値なら React 側で bail out されるため、再レンダリングは
      // 発話の開始/終了の瞬間だけになる。
      setIsSpeaking(s.isSpeaking);
      if (s.isSpeaking !== wasSpeakingRef.current) {
        wasSpeakingRef.current = s.isSpeaking;
        recordSessionEvent({
          type: s.isSpeaking ? "speaking_started" : "speaking_stopped",
          participantId: AI_PARTICIPANT_ID,
        });
      }
    });

    (async () => {
      try {
        setStatus('connecting');
        setInputMixerError(null);
        setPublishFailed(false);
        if (room.state !== ConnectionState.Connected) {
          await new Promise<void>((resolve) => {
            const onConnected = () => {
              room.off(RoomEvent.Connected, onConnected);
              releaseRoomWait = null;
              resolve();
            };
            releaseRoomWait = () => {
              room.off(RoomEvent.Connected, onConnected);
              resolve();
            };
            room.once(RoomEvent.Connected, onConnected);
          });
        }
        if (!isCurrent()) {
          await stopRuntime();
          return;
        }
        const response = await fetch('/api/ai-participant-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            roomName: room.name,
            displayName: infoRef.current.displayName,
            avatar: infoRef.current.avatar,
          }),
        });
        const tokenResult = (await response.json().catch(() => ({}))) as {
          token?: string;
          livekitUrl?: string;
          error?: string;
        };
        if (!response.ok || !tokenResult.token || !tokenResult.livekitUrl) {
          throw new Error(tokenResult.error || `AI参加トークンの取得に失敗しました (${response.status})`);
        }
        if (!isCurrent()) {
          await stopRuntime();
          return;
        }

        const aiRoom = new LiveKitRoom();
        ownedAiRoom = aiRoom;
        aiRoomRef.current = aiRoom;
        aiRoom.on(RoomEvent.Reconnecting, () => {
          if (cancelled || terminal || stopPromise) return;
          failRuntime('ChatGPT参加者の接続が切れました。自動再取得せず停止しました。');
        });
        aiRoom.on(RoomEvent.Disconnected, (reason) => {
          if (stopPromise || !isCurrent()) return;
          failRuntime(
            reason === DisconnectReason.DUPLICATE_IDENTITY
              ? '別の操作でChatGPT参加者が置き換えられました。競合を確認して手動で再開してください。'
              : 'ChatGPT参加者が切断されました。手動で再開してください。'
          );
        });
        await aiRoom.connect(tokenResult.livekitUrl, tokenResult.token, { autoSubscribe: false });
        if (!isCurrent()) {
          await stopRuntime();
          return;
        }
        await provider.connect();
        if (!isCurrent()) {
          await stopRuntime();
          // 先行 cleanup が getUserMedia 完了前に終わっていた場合も、遅れて取得した
          // capture をこの時点でもう一度確実に閉じる。
          await provider.disconnect().catch(() => {});
          return;
        }
        const track = provider.getAudioTrack();
        if (!track) throw new Error('ChatGPT音声トラックを取得できませんでした');
        try {
          await aiRoom.localParticipant.publishTrack(track, {
            name: trackName,
            source: Track.Source.Unknown,
            dtx: false,
          });
          if (!isCurrent()) {
            await aiRoom.localParticipant.unpublishTrack(track, false).catch(() => {});
            await stopRuntime();
            await provider.disconnect().catch(() => {});
            return;
          }
          ownedPublishedTrack = track;
          setPublishFailed(false);
        } catch (e) {
          console.error('[useAiParticipant] AI音声の publish に失敗', e);
          throw e;
        }
        if (isCurrent()) setStatus(provider.status);
      } catch (e) {
        console.error('[useAiParticipant] AI音声ソースの接続に失敗', e);
        if (isCurrent()) {
          failRuntime(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (generationRef.current === generation) generationRef.current += 1;
      offStatus();
      offSpeaking();
      room.off(RoomEvent.Reconnecting, onHumanReconnecting);
      room.off(RoomEvent.Disconnected, onHumanReconnecting);
      void stopRuntime();
      if (terminateRuntimeRef.current === failRuntime) terminateRuntimeRef.current = null;
      setStatus('disconnected');
      setPublishFailed(false);
      levelRef.current = 0;
      setIsSpeaking(false);
    };
  }, [enabled, room, trackName, config.sourceDeviceId]);

  // ── ChatGPT 入力ミキサー（人間の声 → CABLE-B → ChatGPT 入力）──
  const sinkDeviceId = enabled && status === 'connected' ? config.sinkDeviceId : null;
  useEffect(() => {
    if (!room || !sinkDeviceId) return;
    const mixer = new ChatGptInputMixer();
    mixerRef.current = mixer;
    queueMicrotask(() => setInputMixerError(null));
    mixer
      .start(room, sinkDeviceId, {
        includeLocalMic: configRef.current.sendLocalMic !== false,
      })
      .catch((e) => {
        if (mixerRef.current !== mixer) return;
        console.error('[useAiParticipant] ChatGPT入力ミキサーの起動に失敗', e);
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        terminateRuntimeRef.current?.(`ChatGPTへの送出経路を開始できませんでした: ${message}`);
      });
    return () => {
      mixer.stop();
      if (mixerRef.current === mixer) mixerRef.current = null;
    };
  }, [room, sinkDeviceId]);

  // ── チェックボックスの稼働中反映 (Codex レビュー #5) ──
  // start/attach 時のスナップショットだけだと、AI 有効化後にチェックを変えても
  // 実際の配線が追従せず、UI と実挙動が食い違う (2026-08-20 のハウリングの原因)。
  const sendLocalMicOn = config.sendLocalMic !== false;
  useEffect(() => {
    mixerRef.current?.setIncludeLocalMic(sendLocalMicOn);
  }, [sendLocalMicOn]);

  const tile: AiTileState | null = enabled
    ? {
        info,
        visualState: status === 'error' ? 'error' : isSpeaking ? 'speaking' : 'idle',
        getLevel,
      }
    : null;

  // descriptor は room metadata 配信の effect 依存に入るため、必ずメモ化する。
  // 毎レンダリング新しいオブジェクトを作ると、発話検出(100ms周期)の再描画ごとに
  // 配信APIが呼ばれ、LiveKit へ毎秒10回級のリクエストを投げてしまう。
  const descriptor = useMemo<StudioAiDescriptor | null>(
    () =>
      enabled
        ? {
            id: AI_PARTICIPANT_ID,
            ownerIdentity: AI_LIVEKIT_IDENTITY,
            trackName,
            displayName: info.displayName,
            avatar: info.avatar,
            providerKind: "desktop",
          }
        : null,
    [enabled, trackName, info.displayName, info.avatar]
  );

  /**
   * 検査用: ミキサーのローカルマイク混入を直接切り替える。
   * 設定 (sendLocalMic) は変えない — プリフライトが「アプリ経路を試すために
   * 一時的にマイクを通す」ときに使い、判定が確定してから設定へ反映する
   * (Codex 第3巡 #5: 設定の fire-and-forget 反映を待って測るのは競合する)。
   */
  const setInputMixerIncludeLocalMic = useCallback((on: boolean) => {
    mixerRef.current?.setIncludeLocalMic(on);
  }, []);

  const setInputMixerSendEnabled = useCallback((on: boolean) => {
    mixerRef.current?.setSendEnabled(on);
  }, []);

  const getInputMixerDiagnostics = useCallback(
    () => mixerRef.current?.getDiagnostics() ?? null,
    []
  );

  return {
    status,
    publishFailed,
    inputMixerError,
    setInputMixerSendEnabled,
    setInputMixerIncludeLocalMic,
    getInputMixerDiagnostics,
    tile,
    descriptor,
  };
}

/**
 * リモート側（非ホスト参加者）の AI タイル状態。
 *
 * room metadata で配信された descriptor から「ownerIdentity が一致する participant の
 * trackName 完全一致トラック」を解決し、そのトラックへのローカル RMS で speaking を判定する
 * （追加のシグナリング不要。要件§8）。
 */
export function useRemoteAiTile(
  room: Room | null,
  descriptor: StudioAiDescriptor | null
): AiTileState | null {
  // isSpeaking だけ state。level は 100ms ごとに変わるので ref に置き、
  // 描画ループから読ませて再レンダリングを起こさない。
  const [isSpeaking, setIsSpeaking] = useState(false);
  const levelRef = useRef(0);
  const getLevel = useCallback(() => levelRef.current, []);
  const [trackFound, setTrackFound] = useState(false);

  const descriptorKey = descriptor
    ? `${descriptor.ownerIdentity} ${descriptor.trackName}`
    : null;

  useEffect(() => {
    if (!room || !descriptor) return;

    let detector: RmsSpeakingDetector | null = null;
    let attachedTrackId: string | null = null;

    const resolveTrack = (): MediaStreamTrack | null => {
      const owner = Array.from(room.remoteParticipants.values()).find(
        (p) => p.identity === descriptor.ownerIdentity
      );
      if (!owner) return null;
      for (const pub of owner.audioTrackPublications.values()) {
        // trackName の完全一致 + AI 分類の両方を要求（trackName 偽装への防御はサーバー側
        // descriptor 検証と組で成立する。track SID は再publishで変わるため使わない）
        if (pub.trackName === descriptor.trackName && classifyAudioPublication(pub) === 'ai') {
          return pub.track?.mediaStreamTrack ?? null;
        }
      }
      return null;
    };

    const sync = () => {
      const track = resolveTrack();
      if (track && track.id !== attachedTrackId) {
        detector?.stop();
        detector = new RmsSpeakingDetector(track);
        detector.start((s) => {
          levelRef.current = s.level;
          setIsSpeaking(s.isSpeaking);
        });
        attachedTrackId = track.id;
        setTrackFound(true);
      } else if (!track && attachedTrackId) {
        detector?.stop();
        detector = null;
        attachedTrackId = null;
        levelRef.current = 0;
        setIsSpeaking(false);
        setTrackFound(false);
      } else if (!track) {
        setTrackFound(false);
      }
    };

    sync();
    room.on(RoomEvent.TrackSubscribed, sync);
    room.on(RoomEvent.TrackUnsubscribed, sync);
    room.on(RoomEvent.ParticipantConnected, sync);
    room.on(RoomEvent.ParticipantDisconnected, sync);
    return () => {
      room.off(RoomEvent.TrackSubscribed, sync);
      room.off(RoomEvent.TrackUnsubscribed, sync);
      room.off(RoomEvent.ParticipantConnected, sync);
      room.off(RoomEvent.ParticipantDisconnected, sync);
      detector?.stop();
      levelRef.current = 0;
      setIsSpeaking(false);
      setTrackFound(false);
    };
    // descriptor はオブジェクトなので内容キーで比較する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, descriptorKey]);

  if (!descriptor) return null;
  return {
    info: {
      id: descriptor.id,
      displayName: descriptor.displayName,
      avatar: descriptor.avatar,
    },
    // トラック未解決 (ホスト側エラーで unpublish された等) は idle 表示に留める
    visualState: trackFound && isSpeaking ? 'speaking' : 'idle',
    getLevel,
  };
}
