'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room, RemoteParticipant, RemoteTrack, RemoteTrackPublication } from 'livekit-client';
import { RoomEvent, Track } from 'livekit-client';
import { describeDisplayMediaFailure, isDisplayMediaSupported } from '@/lib/media-device-error';

/**
 * ts-ebml (と Buffer polyfill) をロードする。
 * ts-ebml は Node の Buffer グローバルに依存しているため、ブラウザでは事前に polyfill する。
 *
 * 注意: ts-ebml が依存する ebml パッケージはブラウザ向けエントリが壊れており、
 * next.config.ts の turbopack.resolveAlias で ESM ビルドへ張り替えないと
 * この import 自体がモジュール評価時に throw する (その場合 Duration/Cues の無い
 * 「編集ソフトで開けない WebM」が保存されてしまう)。録画開始時に preload して
 * 失敗を早期に検知する。
 */
async function loadTsEbml() {
  if (typeof window !== 'undefined' && typeof (window as unknown as { Buffer?: unknown }).Buffer === 'undefined') {
    const { Buffer } = await import('buffer');
    (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
  }
  return import('ts-ebml');
}

/**
 * MediaRecorder の WebM 出力に SeekHead / Cues / Duration を注入して
 * 編集ソフトで開ける「シーク可能な WebM」に変換する。
 */
async function injectWebmSeekMetadata(blob: Blob): Promise<Blob> {
  const { Decoder, tools, Reader } = await loadTsEbml();
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;
  const buf = await blob.arrayBuffer();
  const elms = decoder.decode(buf);
  elms.forEach((elm) => reader.read(elm));
  reader.stop();
  const refinedMetadataBuf = tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues
  );
  // 長尺録画は数百 MB になるため、本体は ArrayBuffer.slice (即コピー) ではなく
  // Blob.slice (遅延参照) で切り出してメモリピークを倍増させない。
  const body = blob.slice(reader.metadataSize);
  return new Blob([refinedMetadataBuf, body], { type: blob.type });
}

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
  }, []);

  const downloadBlob = useCallback(
    (blob: Blob) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const ts =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const ext = blob.type.includes('webm')
        ? 'webm'
        : blob.type.includes('mp4')
          ? 'mp4'
          : 'webm';
      const fname = `${filePrefix}_${ts}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    [filePrefix]
  );

  const stop = useCallback(async (): Promise<Blob | null> => {
    const r = resourcesRef.current;
    if (!r || r.recorder.state === 'inactive') {
      cleanup();
      setIsRecording(false);
      setStartedAt(null);
      return null;
    }
    return new Promise<Blob | null>((resolve) => {
      r.recorder.onstop = async () => {
        const rawBlob = new Blob(r.chunks, { type: r.recorder.mimeType });
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
        downloadBlob(seekable);
        cleanup();
        setIsRecording(false);
        setStartedAt(null);
        resolve(seekable);
      };
      r.recorder.stop();
    });
  }, [cleanup, downloadBlob]);

  stopRef.current = stop;

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

    const willMixAudio = includeMicrophone || !!room;
    if (willMixAudio) {
      audioContext = new AudioContext();
      audioDestination = audioContext.createMediaStreamDestination();

      // タブ音声があれば足す
      const tabAudioTracks = displayStream.getAudioTracks();
      if (tabAudioTracks.length > 0 && audioContext && audioDestination) {
        try {
          const tabSrc = audioContext.createMediaStreamSource(
            new MediaStream(tabAudioTracks)
          );
          tabSrc.connect(audioDestination);
        } catch (e) {
          console.warn('[useLocalRecording] タブ音声接続失敗', e);
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
          if (localMicNode) {
            try {
              localMicNode.source.disconnect();
            } catch {
              // ignore
            }
            localMicNode = null;
          }
          try {
            const source = audioContext.createMediaStreamSource(new MediaStream([mst]));
            source.connect(audioDestination);
            localMicNode = { track: mst, source };
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
        try {
          const source = audioContext.createMediaStreamSource(ms);
          source.connect(audioDestination);
          remoteAudioNodes.set(key, { identity: participant.identity, trackSid: track.sid ?? '', source, stream: ms });
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
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
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
