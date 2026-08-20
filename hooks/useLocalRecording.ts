'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';
import { describeDisplayMediaFailure, isDisplayMediaSupported } from '@/lib/media-device-error';
import type { AudioTrackRegistry } from '@/lib/audio-track-registry';
import {
  startSessionClock,
  stopSessionClock,
  recordSessionEvent,
  summarizeSessionEvents,
} from '@/lib/session-clock';
import { injectWebmSeekMetadata, loadTsEbml } from '@/lib/webm-seek-metadata';
import { buildRecordingFilename, downloadBlobAs } from '@/lib/recording-file';
import { estimateStorageHeadroom, RecordingChunkWriter } from '@/lib/recording-store';
import { describeRecordingHealth, RecordingHealthMonitor } from '@/lib/recording-health';

export type RecordingQuality = 'streaming' | 'standard' | 'high';

interface QualityPreset {
  width: number;
  height: number;
  frameRate: number;
  videoBitsPerSecond: number;
}

const QUALITY_PRESETS: Record<RecordingQuality, QualityPreset | null> = {
  // ストリーミング配信に最適 (720p / 24fps / ~1.5 Mbps)
  streaming: { width: 1280, height: 720, frameRate: 24, videoBitsPerSecond: 1_500_000 },
  // 標準 (1080p / 30fps / ~2.5 Mbps)
  standard: { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 2_500_000 },
  // ネイティブ解像度・高ビットレート (ファイルサイズ大)
  high: null,
};

interface UseLocalRecordingOptions {
  filePrefix?: string;
  includeMicrophone?: boolean;
  /** LiveKit Room。渡すとリモート参加者の音声を mix する */
  room?: Room | null;
  /**
   * cropTarget を渡したのに Region Capture が有効化できなかった (非対応 or 失敗) 瞬間に呼ばれる。
   * タブ全体が録画されるため、呼び出し側はクロップ矩形外に表示している
   * 「録画に映ってはいけない」UI (例: 収録モードのチャットパネル) を直ちに閉じること。
   */
  onRegionCaptureUnavailable?: () => void;
  /**
   * Recorder が参加者を知らずに追加音声（AI 参加者等）を受け取るための汎用レジストリ。
   * 録画開始時に現在のトラックを全て mix し、録画中の add/remove にも動的に追従する。
   */
  extraAudioTracks?: AudioTrackRegistry | null;
  /**
   * true のとき displayStream のタブ音声を録画ミキサーに接続しない（単一取り込みポリシー）。
   *
   * タブ音声には RoomAudioRenderer が再生しているリモート音声・AI モニタ音声が含まれ、
   * 明示的にミックスしているリモートトラック/追加トラックと構造的に二重になる。
   * AI 参加者を有効にした収録ではこれを true にし、録画入力を
   * 「ローカルマイク + リモートトラック + extraAudioTracks」の明示トラックに一本化する。
   * false（既定）の場合は従来どおりタブ音声も mix する（既存挙動の保護）。
   */
  excludeTabAudio?: boolean;
}

interface RemoteAudioNode {
  identity: string;
  trackSid: string;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
}

interface RecordingResources {
  recorder: MediaRecorder;
  chunks: Blob[];
  displayStream: MediaStream;
  micStream: MediaStream | null;
  audioContext: AudioContext | null;
  audioDestination: MediaStreamAudioDestinationNode | null;
  remoteAudioNodes: Map<string, RemoteAudioNode>;
  detachListeners: () => void;
  /**
   * 冪等な確定処理の完了 Promise。正常 stop / recorder.onerror のどこから
   * 停止しても finalize は1回だけ走り、全経路がこの Promise に合流する。
   */
  finalizePromise: Promise<Blob | null>;
  /** IndexedDB へのチャンク逐次保存 (クラッシュ復旧用)。使えない環境では null */
  chunkWriterPromise: Promise<RecordingChunkWriter | null>;
}

/**
 * ローカル録画フック。
 *
 * - getDisplayMedia でタブ/画面を取得
 * - includeMicrophone のときローカルマイクも mix
 * - room を渡すと LiveKit のリモート参加者音声を全て mix（録画に他人の声を確実に入れる）
 */
export function useLocalRecording({
  filePrefix = '自習室',
  includeMicrophone = true,
  room = null,
  onRegionCaptureUnavailable,
  extraAudioTracks = null,
  excludeTabAudio = false,
}: UseLocalRecordingOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // navigator はサーバーでは存在しないため、SSR/ハイドレーション不整合を避けて
  // 楽観的に true から始め、マウント後 (クライアントのみ) に実際の対応状況へ補正する。
  const [isSupported, setIsSupported] = useState(true);
  useEffect(() => {
    // setState を microtask に逃がし、effect body 内での同期 setState を回避
    // (MobileHostWarning 等と同じパターン)。
    queueMicrotask(() => setIsSupported(isDisplayMediaSupported()));
  }, []);
  /**
   * cropTarget を渡して録画開始したとき、Region Capture (cropTo) が実際に有効化できたか。
   * - true: クロップ成功。指定要素の矩形外 (例: 収録モードのチャットパネル) は録画に映らない。
   * - false: cropTarget を渡したが API 非対応 or cropTo 失敗。タブ全体が録画され、
   *   矩形外の要素も映り込む。呼び出し側はこのとき矩形外に「映ってはいけない」UI
   *   (チャット等) を表示したままにしないよう警告・強制非表示する必要がある。
   * - null: cropTarget を渡していない (制約なし、または録画未開始)。
   */
  const [regionCaptureActive, setRegionCaptureActive] = useState<boolean | null>(null);

  const resourcesRef = useRef<RecordingResources | null>(null);
  const stopRef = useRef<() => Promise<Blob | null>>(() => Promise.resolve(null));
  // excludeTabAudio / extraAudioTracks は録画開始時点の最新値を使う（stale closure 回避）
  const excludeTabAudioRef = useRef(excludeTabAudio);
  const extraTracksRef = useRef(extraAudioTracks);
  const filePrefixRef = useRef(filePrefix);
  useEffect(() => {
    excludeTabAudioRef.current = excludeTabAudio;
    extraTracksRef.current = extraAudioTracks;
    filePrefixRef.current = filePrefix;
  }, [excludeTabAudio, extraAudioTracks, filePrefix]);

  const cleanup = useCallback(() => {
    const r = resourcesRef.current;
    if (!r) return;
    r.detachListeners();
    r.displayStream.getTracks().forEach((t) => t.stop());
    r.micStream?.getTracks().forEach((t) => t.stop());
    r.remoteAudioNodes.forEach((n) => {
      try {
        n.source.disconnect();
      } catch {
        // ignore
      }
    });
    r.remoteAudioNodes.clear();
    r.audioContext?.close().catch(() => {});
    resourcesRef.current = null;
    stopSessionClock();
  }, []);

  /** 録画開始時刻を名前に使う。復旧ファイルと同じ規則。 */
  const downloadBlob = useCallback(
    (blob: Blob, at: Date) => {
      downloadBlobAs(blob, buildRecordingFilename(filePrefix, blob.type, at));
    },
    [filePrefix]
  );

  const stop = useCallback(async (): Promise<Blob | null> => {
    const r = resourcesRef.current;
    if (!r) {
      setIsRecording(false);
      setStartedAt(null);
      return null;
    }
    // 確定処理 (finalize) は start() 時に recorder.onstop へ冪等に仕込んである。
    // ここでは停止要求を出して合流するだけ。onerror 経由で既に停止済みでも
    // finalizePromise は同じ結果を返す (二重確定しない)。
    try {
      if (r.recorder.state !== 'inactive') r.recorder.stop();
    } catch {
      // recorder が既に inactive の場合など。finalizePromise 側で回収される。
    }
    return r.finalizePromise;
  }, []);

  stopRef.current = stop;

  // 録画中のタブ閉じ/リロードを警告する。IndexedDB のバックアップから復旧はできるが、
  // 手間がかかるうえ最後の1秒分は欠けるため、まず止めるよう促す。
  useEffect(() => {
    if (!isRecording) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '録画中です。先に録画を停止してください。このまま閉じると、次回起動時に復旧操作が必要になります。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording]);

  const start = useCallback(async (
    quality: RecordingQuality = 'streaming',
    /**
     * Region Capture でクロップする対象要素 (収録ステージ等)。指定すると録画を要素の矩形=16:9に固定。
     * 関数を渡すと getDisplayMedia 解決後に評価する (録画開始と同時にステージをマウントする場合に対応)。
     */
    cropTarget?: HTMLElement | null | (() => HTMLElement | null),
  ) => {
    setError(null);
    setRegionCaptureActive(null);
    if (resourcesRef.current) return;

    // iOS Safari (iPhoneの全ブラウザがWebKitベースで同様) は getDisplayMedia 自体が
    // 存在しない。呼び出せば TypeError になり、生の英語メッセージがそのまま error state に
    // 入ってしまうため、先に feature-detect して分かりやすい日本語メッセージを返す。
    if (!isDisplayMediaSupported()) {
      setError('お使いの端末・ブラウザは画面録画に対応していません。パソコンのChrome・Edgeなどでお試しください。');
      return;
    }

    const preset = QUALITY_PRESETS[quality];

    // 録画対象は「セッション中の自習室タブそのもの」。
    // getDisplayMedia を呼んだ自タブは既定でピッカーから除外される (selfBrowserSurface=exclude)
    // ため、ピッカーで選ばせる方式だと自習室タブを選べない。
    // preferCurrentTab: true で自タブを直接キャプチャする (下の getDisplayMedia 参照)。
    // displaySurface: 'browser' はタブ面であることの明示。
    const videoConstraints: MediaTrackConstraints = preset
      ? {
          displaySurface: 'browser',
          width: { ideal: preset.width },
          height: { ideal: preset.height },
          frameRate: { ideal: preset.frameRate, max: preset.frameRate },
        }
      : { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 } };

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true,
        // 非標準だが Chromium 系で有効。型定義に無いので as 経由で付与。
        // preferCurrentTab: true → Chrome は「このタブを共有しますか?」確認のみを表示し、
        // 自習室タブの描画内容だけ (ツールバー・タブ帯・メニュー・他タブを除く) を直接録る。
        // 自タブを録るのが目的なので、selfBrowserSurface / surfaceSwitching /
        // monitorTypeSurfaces は併記しない (preferCurrentTab と競合し無効化されるため)。
        preferCurrentTab: true,
      } as DisplayMediaStreamOptions);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        // silent (ピッカーをキャンセルしただけ)
      } else {
        setError(describeDisplayMediaFailure(err));
      }
      return;
    }

    // Region Capture: 自タブキャプチャを指定要素の矩形にクロップする (Chromium 系)。
    // 収録ステージ (16:9) を渡すと、ウィンドウサイズに関わらず録画を厳密な 16:9 に固定できる。
    // 関数で渡された場合は getDisplayMedia 解決後の今の時点で評価 (ステージのマウント完了後)。
    const cropEl = typeof cropTarget === 'function' ? cropTarget() : cropTarget;
    if (cropEl) {
      const CropTargetCtor = (globalThis as unknown as {
        CropTarget?: { fromElement(e: Element): Promise<unknown> };
      }).CropTarget;
      const videoTrack = displayStream.getVideoTracks()[0] as
        | (MediaStreamTrack & { cropTo?: (t: unknown) => Promise<void> })
        | undefined;
      if (CropTargetCtor && videoTrack?.cropTo) {
        try {
          const ct = await CropTargetCtor.fromElement(cropEl);
          await videoTrack.cropTo(ct);
          setRegionCaptureActive(true);
        } catch (e) {
          console.warn(
            '[useLocalRecording] Region Capture (cropTo) に失敗。タブ全体のまま録画します。',
            e
          );
          setRegionCaptureActive(false);
          onRegionCaptureUnavailable?.();
        }
      } else {
        // CropTarget / cropTo 非対応ブラウザ (Chromium 系以外)。タブ全体のまま録画される。
        setRegionCaptureActive(false);
        onRegionCaptureUnavailable?.();
      }
    }

    let micStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let audioDestination: MediaStreamAudioDestinationNode | null = null;
    const remoteAudioNodes = new Map<string, RemoteAudioNode>();
    let finalStream = displayStream;
    let detachListeners: () => void = () => {};

    const extraRegistry = extraTracksRef.current;
    const willMixAudio = includeMicrophone || !!room || !!extraRegistry;
    if (willMixAudio) {
      // 48kHz 固定。WebRTC・MediaRecorder ともに 48kHz 前提で、途中に
      // サンプルレート変換が挟まると無駄な負荷になる。
      // なお解析系と違い、この context は録画専用として分けたままにする
      // （収録のオーディオスレッドを他の処理と取り合わせない）。
      try {
        audioContext = new AudioContext({ sampleRate: 48000 });
      } catch {
        audioContext = new AudioContext();
      }
      audioDestination = audioContext.createMediaStreamDestination();

      // 接続済みトラックの重複排除 (同じ MediaStreamTrack を複数経路で二重ミックスしない)
      const connectedTrackIds = new Set<string>();

      // タブ音声があれば足す。
      // ただし excludeTabAudio (単一取り込みポリシー) のときは接続しない —
      // タブ音声には RoomAudioRenderer が再生中のリモート音声等が含まれ、
      // 下の明示トラックミックスと構造的に二重になるため。
      if (!excludeTabAudioRef.current) {
        const tabAudioTracks = displayStream.getAudioTracks();
        if (tabAudioTracks.length > 0 && audioContext && audioDestination) {
          try {
            const tabSrc = audioContext.createMediaStreamSource(
              new MediaStream(tabAudioTracks)
            );
            tabSrc.connect(audioDestination);
            tabAudioTracks.forEach((t) => connectedTrackIds.add(t.id));
          } catch (e) {
            console.warn('[useLocalRecording] タブ音声接続失敗', e);
          }
        }
      }

      // ローカルマイク（自分の声）
      //
      // 自分の声はタブ音声にもリモートトラックにも含まれない（自分の声は自タブで再生
      // されないし、LiveKit のリモート購読対象でもない）。よってここで足さないと
      // 「収録に自分の声だけ入らない」状態になる。
      //
      // 以前は getUserMedia({audio:true}) で OS 既定のマイクを勝手に開いていたが、
      // アプリ内 (DeviceSettingsModal) で別のマイクを選んでいる場合、既定デバイスは
      // 別物・無効・ミュートのことがあり、その場合は無音 = 自分の声が録れない不具合になる。
      // そこで LiveKit にローカルマイクが publish 済みなら、その MediaStreamTrack
      // （= ユーザーが実際に選択し、他参加者が聞いているのと同一の音声）を優先して使う。
      // room が無い・マイク未publish のときのみ getUserMedia にフォールバックする。
      let detachLocalMicListener: () => void = () => {};
      if (includeMicrophone) {
        let localMicNode: { track: MediaStreamTrack; source: MediaStreamAudioSourceNode } | null = null;

        // LiveKit のローカルマイクトラックを録音先に接続する。
        // デバイス切替やミュート解除で republish されると mediaStreamTrack が差し替わるため、
        // 呼び直して張り替えられるようにしてある。接続できたら true。
        const connectLocalMic = (): boolean => {
          if (!room || !audioContext || !audioDestination) return false;
          const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
          const mst = pub?.track?.mediaStreamTrack;
          if (!mst) return false;
          if (localMicNode?.track === mst) return true; // 既に同じトラックを接続済み
          if (connectedTrackIds.has(mst.id)) return true; // 別経路で接続済み (二重ミックス防止)
          if (localMicNode) {
            try {
              localMicNode.source.disconnect();
            } catch {
              // ignore
            }
            connectedTrackIds.delete(localMicNode.track.id);
            localMicNode = null;
          }
          try {
            const source = audioContext.createMediaStreamSource(new MediaStream([mst]));
            source.connect(audioDestination);
            localMicNode = { track: mst, source };
            connectedTrackIds.add(mst.id);
            return true;
          } catch (e) {
            console.warn('[useLocalRecording] ローカルマイク接続失敗', e);
            return false;
          }
        };

        if (room) {
          // 録画開始時点でまだマイクが publish されていなくても（ミュート開始・publish遅延）、
          // デバイス切替 / ミュート解除で republish されたら張り直す。
          // room がある限りマイクは LiveKit 経由に一本化し、getUserMedia の既定デバイスを
          // 二重に開かない（別デバイスが混ざる / 二重音声を防ぐ）。
          connectLocalMic();
          const onLocalMicRepublished = () => {
            connectLocalMic();
          };
          room.on(RoomEvent.LocalTrackPublished, onLocalMicRepublished);
          detachLocalMicListener = () => {
            room.off(RoomEvent.LocalTrackPublished, onLocalMicRepublished);
          };
        } else {
          // room が無い単体録画のときのみ getUserMedia でマイクを取得する。
          try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micSrc = audioContext.createMediaStreamSource(micStream);
            micSrc.connect(audioDestination);
          } catch (micErr) {
            console.warn('[useLocalRecording] マイク取得失敗:', micErr);
          }
        }
      }

      // LiveKit リモート音声トラックを追加
      const addRemoteTrack = (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        participant: RemoteParticipant
      ) => {
        if (track.kind !== Track.Kind.Audio) return;
        if (!audioContext || !audioDestination) return;
        const ms = track.mediaStream ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : null);
        if (!ms) return;
        const key = `${participant.identity}:${track.sid ?? Math.random()}`;
        if (remoteAudioNodes.has(key)) return;
        const mstId = track.mediaStreamTrack?.id;
        if (mstId && connectedTrackIds.has(mstId)) return; // 二重ミックス防止
        try {
          const source = audioContext.createMediaStreamSource(ms);
          source.connect(audioDestination);
          remoteAudioNodes.set(key, { identity: participant.identity, trackSid: track.sid ?? '', source, stream: ms });
          if (mstId) connectedTrackIds.add(mstId);
        } catch (e) {
          console.warn('[useLocalRecording] リモート音声接続失敗', e);
        }
      };

      const removeRemoteTrack = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
        const sid = track.sid ?? '';
        for (const [key, node] of remoteAudioNodes) {
          if (node.identity === participant.identity && node.trackSid === sid) {
            try {
              node.source.disconnect();
            } catch {
              // ignore
            }
            node.stream.getAudioTracks().forEach((t) => connectedTrackIds.delete(t.id));
            remoteAudioNodes.delete(key);
          }
        }
      };

      if (room) {
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((pub) => {
            const t = pub.track;
            if (t && t.kind === Track.Kind.Audio) {
              addRemoteTrack(t as RemoteTrack, pub as RemoteTrackPublication, participant);
            }
          });
        });
        room.on(RoomEvent.TrackSubscribed, addRemoteTrack);
        room.on(RoomEvent.TrackUnsubscribed, removeRemoteTrack);
      }

      // 追加音声トラック (AI 参加者等)。Recorder はレジストリの中身が何かを知らない。
      // リモートトラックと同型の動的 add/remove で、録画中の差し替え (再接続) にも追従する。
      let detachExtraTracks: () => void = () => {};
      if (extraRegistry) {
        const extraNodes = new Map<string, { source: MediaStreamAudioSourceNode; trackId: string }>();
        const connectExtra = (id: string, track: MediaStreamTrack) => {
          if (!audioContext || !audioDestination) return;
          if (extraNodes.has(id)) return;
          if (connectedTrackIds.has(track.id)) return; // 二重ミックス防止
          try {
            const source = audioContext.createMediaStreamSource(new MediaStream([track]));
            source.connect(audioDestination);
            extraNodes.set(id, { source, trackId: track.id });
            connectedTrackIds.add(track.id);
          } catch (e) {
            console.warn('[useLocalRecording] 追加音声トラック接続失敗', e);
          }
        };
        const disconnectExtra = (id: string) => {
          const node = extraNodes.get(id);
          if (!node) return;
          try {
            node.source.disconnect();
          } catch {
            // ignore
          }
          connectedTrackIds.delete(node.trackId);
          extraNodes.delete(id);
        };
        extraRegistry.list().forEach(({ id, track }) => connectExtra(id, track));
        const unsubscribe = extraRegistry.subscribe((ev) => {
          if (ev.type === 'add' && ev.track) connectExtra(ev.id, ev.track);
          else if (ev.type === 'remove') disconnectExtra(ev.id);
        });
        detachExtraTracks = () => {
          unsubscribe();
          extraNodes.forEach((_node, id) => disconnectExtra(id));
        };
      }

      finalStream = new MediaStream([
        ...displayStream.getVideoTracks(),
        ...audioDestination.stream.getAudioTracks(),
      ]);

      detachListeners = () => {
        if (room) {
          room.off(RoomEvent.TrackSubscribed, addRemoteTrack);
          room.off(RoomEvent.TrackUnsubscribed, removeRemoteTrack);
        }
        detachLocalMicListener();
        detachExtraTracks();
      };
    }

    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const mimeType =
      candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

    let recorder: MediaRecorder;
    try {
      const recorderOptions: MediaRecorderOptions = { mimeType };
      if (preset) recorderOptions.videoBitsPerSecond = preset.videoBitsPerSecond;
      recorder = new MediaRecorder(finalStream, recorderOptions);
    } catch (recErr) {
      const msg = recErr instanceof Error ? recErr.message : String(recErr);
      setError(`録画開始に失敗しました: ${msg}`);
      displayStream.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      audioContext?.close().catch(() => {});
      detachListeners();
      return;
    }

    const chunks: Blob[] = [];
    // チャンクはメモリ(正本)と IndexedDB(保険)の両方へ積む。
    // IndexedDB 側はブラウザごと落ちたときに収録を全損させないためのバックアップで、
    // 書けなくても録画は続行する (writer 側で自己無効化する)。
    const recordingStartedAt = new Date();
    // 収録中に音声処理が詰まっていないかを測る（「音が飛び飛び」の原因切り分け用）
    const health = new RecordingHealthMonitor(audioContext);
    const chunkWriterPromise = RecordingChunkWriter.begin(
      { mimeType: recorder.mimeType, filePrefix: filePrefixRef.current, startedAt: recordingStartedAt.getTime() },
      (err) => {
        console.error('[useLocalRecording] 録画バックアップの保存に失敗', err);
        setError(
          '録画は継続していますが、自動バックアップを保存できませんでした。この録画中にブラウザが強制終了すると復旧できません。'
        );
      }
    );
    // 空き容量が少ないと長時間の収録の途中でバックアップが止まる。
    // 止まってから気付いても手遅れなので、開始時点で「何分ぶん残っているか」を伝える。
    void estimateStorageHeadroom().then((h) => {
      if (!h) return;
      const bytesPerSecond = ((preset?.videoBitsPerSecond ?? 2_500_000) + 128_000) / 8;
      const minutes = Math.floor((h.quota - h.usage) / bytesPerSecond / 60);
      if (minutes < 60) {
        setError(
          `録画の自動バックアップに使える空き容量は約${minutes}分ぶんです。これを超える収録ではバックアップが途中で止まります（録画そのものは続きます）。`
        );
      }
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      health.noteChunk();
      chunks.push(e.data);
      // 同一 Promise への then は登録順に実行されるため、チャンクの順序は保たれる。
      void chunkWriterPromise.then((w) => w?.append(e.data));
    };

    // ── 冪等な確定処理 ──
    // 正常 stop / recorder.onerror / トラック消失のどの経路から停止しても、
    // finalize は1回だけ実行され、ここまでのチャンクで WebM を確定・保存する。
    // ブラウザクラッシュ以外の障害でファイルを全損させないための集約点。
    let finalized = false;
    let resolveFinalize: (b: Blob | null) => void = () => {};
    const finalizePromise = new Promise<Blob | null>((resolve) => {
      resolveFinalize = resolve;
    });
    const finalize = async (reason: 'stop' | 'error') => {
      if (finalized) return;
      const healthReport = health.stop();
      console.info('[recording-health]', healthReport);
      recordSessionEvent({ type: "recording_stopped", reason });
      console.info("[session-clock]", summarizeSessionEvents());
      if (finalized) return;
      finalized = true;
      let result: Blob | null = null;
      try {
        if (chunks.length > 0) {
          const rawBlob = new Blob(chunks, { type: recorder.mimeType });
          // MediaRecorder の WebM は SeekHead / Cues / Duration が欠落しており
          // 編集ソフトでタイムラインを構築できない (シーク不能)。
          // ts-ebml でメタデータを注入し、シーク可能な WebM に変換してから保存。
          const seekable = rawBlob.type.includes('webm')
            ? await injectWebmSeekMetadata(rawBlob).catch((e) => {
                console.error('[useLocalRecording] シーク索引の付与に失敗。生のBlobを保存します。', e);
                // 生の WebM は尺情報・シーク索引が無く Canva 等の編集ソフトで
                // 開けない/変換が壊れることがある。黙って保存すると収録後に初めて
                // 気付くことになるため、ユーザーに見える形で警告する (保存自体は行う)。
                setError(
                  '録画ファイルは保存されましたが、編集ソフト用のインデックス付与に失敗しました。このファイルは Canva 等で正しく読み込めない可能性があります。'
                );
                return rawBlob;
              })
            : rawBlob;
          downloadBlob(seekable, recordingStartedAt);
          const healthMessage = describeRecordingHealth(healthReport);
          // 既に出ている警告（インデックス付与失敗など）のほうが具体的なので上書きしない
          if (healthMessage) setError((prev) => prev ?? healthMessage);
          result = seekable;
          if (reason === 'error') {
            setError('録画中にエラーが発生したため停止しました。ここまでの録画は保存済みです。');
          }
        } else if (reason === 'error') {
          setError('録画中にエラーが発生しました。保存できるデータがありませんでした。');
        }
      } finally {
        // 保存できたときだけバックアップを破棄する。保存に失敗した場合は
        // 次回起動時に復旧を促せるよう、あえて IndexedDB に残す。
        if (result || chunks.length === 0) {
          void chunkWriterPromise.then((w) => w?.discard());
        }
        cleanup();
        setIsRecording(false);
        setStartedAt(null);
        resolveFinalize(result);
      }
    };
    recorder.onstop = () => {
      void finalize('stop');
    };
    recorder.onerror = (ev) => {
      console.error('[useLocalRecording] MediaRecorder error', ev);
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop(); // onstop → finalize('stop') が走るが、メッセージは error 用に上書きする
          void finalizePromise.then(() => {});
          setError('録画中にエラーが発生したため停止しました。ここまでの録画は保存済みです。');
        } else {
          void finalize('error');
        }
      } catch {
        void finalize('error');
      }
    };

    resourcesRef.current = {
      recorder,
      chunks,
      displayStream,
      micStream,
      audioContext,
      audioDestination,
      remoteAudioNodes,
      detachListeners,
      finalizePromise,
      chunkWriterPromise,
    };

    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      stopRef.current();
    });

    // 停止時に使う ts-ebml を今のうちに preload しておく。バンドル都合等で
    // ロードできない場合、停止時まで黙っていると長時間の収録が丸ごと
    // 「編集ソフトで開けないファイル」になってから発覚するため、開始直後に警告する。
    loadTsEbml().catch((e) => {
      console.error('[useLocalRecording] ts-ebml のロードに失敗 (録画は継続します)', e);
      setError(
        '録画は継続しますが、保存ファイルへのインデックス付与機能が読み込めませんでした。保存された WebM は Canva 等で正しく読み込めない可能性があります。'
      );
    });

    // 収録ファイルの先頭を 0 とする単調増加クロックをここで確定する
    // (MediaRecorder.start() の直前。要件 FR-008 / NFR-005)
    startSessionClock();
    recordSessionEvent({ type: "recording_started" });
    health.start();
    recorder.start(1000);
    setStartedAt(Date.now());
    setIsRecording(true);
  }, [includeMicrophone, room, onRegionCaptureUnavailable]);

  return {
    isRecording,
    startedAt,
    error,
    regionCaptureActive,
    isSupported,
    start,
    stop,
  };
}
