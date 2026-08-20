'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track, RoomEvent, type Room } from 'livekit-client';
import type { AudioTrackRegistry } from '@/lib/audio-track-registry';
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
  /** 録画ミキサーへ渡す汎用レジストリ（useLocalRecording の extraAudioTracks と同一インスタンス） */
  registry: AudioTrackRegistry;
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
  /** 送出経路の内部状態を取得する（切り分け用。未起動なら null） */
  getInputMixerDiagnostics: () => ReturnType<ChatGptInputMixer["getDiagnostics"]> | null;
  /** エラー後の再接続（同一 participant ID のまま新トラック取得 → registry → publish） */
  reconnect: () => Promise<void>;
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
  registry,
}: UseAiParticipantOptions): UseAiParticipantResult {
  const [status, setStatus] = useState<AiProviderStatus>('disconnected');
  const [publishFailed, setPublishFailed] = useState(false);
  const [inputMixerError, setInputMixerError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState({ isSpeaking: false, level: 0 });

  const providerRef = useRef<AiParticipantProvider | null>(null);
  const mixerRef = useRef<ChatGptInputMixer | null>(null);
  const monitorElRef = useRef<HTMLAudioElement | null>(null);
  const publishedTrackRef = useRef<MediaStreamTrack | null>(null);
  const wasSpeakingRef = useRef(false);

  const configRef = useRef(config);

  const info = useMemo<AiParticipantInfo>(
    () => ({ id: AI_PARTICIPANT_ID, displayName: config.displayName, avatar: config.avatar }),
    [config.displayName, config.avatar]
  );
  const infoRef = useRef(info);
  useEffect(() => {
    configRef.current = config;
    infoRef.current = info;
  }, [config, info]);

  const trackName = aiAudioTrackName(AI_PARTICIPANT_ID);

  /** track を registry / publish / モニタへ配線する（connect・reconnect 共通） */
  const attachTrack = useCallback(
    async (track: MediaStreamTrack) => {
      registry.add(AI_PARTICIPANT_ID, track);

      // ホストのモニタ (既定出力=ヘッドホン)。LiveKit のローカル publish はホスト自身では
      // 再生されないため、これが無いとホストだけ AI の声が聞こえない。
      // ChatGPT 入力ミキサー (CABLE-B) とは独立した経路 — AI の声は CABLE-B に入らない。
      // Windows 側でモニタしている構成ではアプリは再生しない（二重再生の防止）
      const monitorLocally = configRef.current.monitorAiLocally !== false;
      if (!monitorLocally) {
        if (monitorElRef.current) monitorElRef.current.srcObject = null;
      } else {
      if (!monitorElRef.current) {
        const el = document.createElement('audio');
        el.style.display = 'none';
        el.autoplay = true;
        document.body.appendChild(el);
        monitorElRef.current = el;
      }
      monitorElRef.current.srcObject = new MediaStream([track]);
      monitorElRef.current.play().catch(() => {
        // autoplay 制限は StartAudioBanner のユーザー操作で解除される
      });
      }

      // LiveKit へ publish。失敗しても録画は継続する（別状態で表示）。
      if (room) {
        try {
          await room.localParticipant.publishTrack(track, {
            name: trackName,
            source: Track.Source.Unknown,
            dtx: false,
          });
          publishedTrackRef.current = track;
          setPublishFailed(false);
        } catch (e) {
          console.error('[useAiParticipant] AI音声の publish に失敗 (録画は継続)', e);
          setPublishFailed(true);
        }
      }
    },
    [registry, room, trackName]
  );

  /** publish / registry / モニタから track を外す。Provider の track 自体は止めない（オーナーは Provider） */
  const detachTrack = useCallback(async () => {
    registry.remove(AI_PARTICIPANT_ID);
    if (monitorElRef.current) {
      monitorElRef.current.srcObject = null;
    }
    const track = publishedTrackRef.current;
    publishedTrackRef.current = null;
    if (room && track) {
      try {
        // stopOnUnpublish=false: トラックの stop 権限は Provider が持つ。
        // ここで stop すると録画ミキサー側の入力まで死ぬ。
        await room.localParticipant.unpublishTrack(track, false);
      } catch {
        // room 切断済み等は無視
      }
    }
  }, [registry, room]);

  // ── Provider ライフサイクル ──
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const provider = createProvider(infoRef.current, () => configRef.current.sourceDeviceId);
    providerRef.current = provider;

    const offStatus = provider.onStatusChange((s) => {
      if (cancelled) return;
      setStatus(s);
      if (s === 'error') {
        recordSessionEvent({ type: "participant_error", participantId: AI_PARTICIPANT_ID });
        // 障害分離: 録画ミキサー/リモート配信から外すだけ。収録は継続する。
        void detachTrack();
      }
    });
    const offSpeaking = provider.onSpeaking((s) => {
      if (cancelled) return;
      setSpeaking({ isSpeaking: s.isSpeaking, level: s.level });
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
        await provider.connect();
        if (cancelled) return;
        const track = provider.getAudioTrack();
        if (track) await attachTrack(track);
        if (!cancelled) setStatus(provider.status);
      } catch (e) {
        console.error('[useAiParticipant] AI音声ソースの接続に失敗', e);
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      offStatus();
      offSpeaking();
      void detachTrack().finally(() => provider.disconnect().catch(() => {}));
      providerRef.current = null;
      if (monitorElRef.current) {
        monitorElRef.current.remove();
        monitorElRef.current = null;
      }
      setStatus('disconnected');
      setPublishFailed(false);
      setSpeaking({ isSpeaking: false, level: 0 });
    };
    // config の deviceId 変更は reconnect で反映する（有効中の自動再接続はしない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, room, registry]);

  // ── ChatGPT 入力ミキサー（人間の声 → CABLE-B → ChatGPT 入力）──
  const sinkDeviceId = enabled ? config.sinkDeviceId : null;
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
      console.error('[useAiParticipant] ChatGPT入力ミキサーの起動に失敗', e);
      setInputMixerError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    });
    return () => {
      mixer.stop();
      if (mixerRef.current === mixer) mixerRef.current = null;
    };
  }, [room, sinkDeviceId]);

  /** 再接続: 同一 participant ID のまま「新トラック取得 → registry → publish」の順で復帰 */
  const reconnect = useCallback(async () => {
    const provider = providerRef.current;
    if (!provider) return;
    try {
      setStatus('connecting');
      await provider.connect();
      const track = provider.getAudioTrack();
      if (track) await attachTrack(track);
      recordSessionEvent({ type: "track_replaced", participantId: AI_PARTICIPANT_ID });
      setStatus(provider.status);
    } catch (e) {
      console.error('[useAiParticipant] 再接続に失敗', e);
      setStatus('error');
    }
  }, [attachTrack]);

  const tile: AiTileState | null = enabled
    ? {
        info,
        visualState: status === 'error' ? 'error' : speaking.isSpeaking ? 'speaking' : 'idle',
        level: speaking.level,
      }
    : null;

  // descriptor は room metadata 配信の effect 依存に入るため、必ずメモ化する。
  // 毎レンダリング新しいオブジェクトを作ると、発話検出(100ms周期)の再描画ごとに
  // 配信APIが呼ばれ、LiveKit へ毎秒10回級のリクエストを投げてしまう。
  const localIdentity = room?.localParticipant.identity ?? null;
  const descriptor = useMemo<StudioAiDescriptor | null>(
    () =>
      enabled && localIdentity
        ? {
            id: AI_PARTICIPANT_ID,
            ownerIdentity: localIdentity,
            trackName,
            displayName: info.displayName,
            avatar: info.avatar,
            providerKind: "desktop",
          }
        : null,
    [enabled, localIdentity, trackName, info.displayName, info.avatar]
  );

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
    getInputMixerDiagnostics,
    tile,
    descriptor,
    reconnect,
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
  const [speaking, setSpeaking] = useState({ isSpeaking: false, level: 0 });
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
        detector.start((s) => setSpeaking({ isSpeaking: s.isSpeaking, level: s.level }));
        attachedTrackId = track.id;
        setTrackFound(true);
      } else if (!track && attachedTrackId) {
        detector?.stop();
        detector = null;
        attachedTrackId = null;
        setSpeaking({ isSpeaking: false, level: 0 });
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
      setSpeaking({ isSpeaking: false, level: 0 });
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
    visualState: trackFound && speaking.isSpeaking ? 'speaking' : 'idle',
    level: speaking.level,
  };
}
