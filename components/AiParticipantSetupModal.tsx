'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import {
  aiWiringFingerprint,
  isLoopbackCaptureLabel,
  type AiParticipantConfig,
} from '@/lib/studio-participants';
import type { AiProviderStatus } from '@/lib/ai/provider';
import { RmsSpeakingDetector } from '@/lib/ai/speaking-detector';
import { resumeAllAudioContexts } from '@/lib/audio-runtime';
import {
  findCableMonitorInput,
  findCablePlaybackForCapture,
  isVirtualCableLabel,
  playToneProbe,
  type DeviceOption,
} from '@/lib/audio-devices';
import { AiPreflightPanel } from './AiPreflightPanel';
import { AiRequiredSettings } from './AiRequiredSettings';

interface AiParticipantSetupModalProps {
  room: Room | null;
  config: AiParticipantConfig;
  /**
   * 設定の書き込み。patch だけを渡す (全体スナップショットは渡さない —
   * 古い state で他フィールドを巻き戻す事故の恒久対策)。
   * @returns localStorage へ保存できたか
   */
  onPatchConfig: (patch: Partial<AiParticipantConfig>) => Promise<boolean>;
  enabled: boolean;
  onChangeEnabled: (enabled: boolean) => void;
  aiStatus: AiProviderStatus;
  publishFailed: boolean;
  inputMixerError: string | null;
  setInputMixerSendEnabled: (on: boolean) => void;
  /** 検査用: ミキサーのローカルマイク混入を直接切り替える (設定は変えない) */
  setInputMixerIncludeLocalMic: (on: boolean) => void;
  getInputMixerDiagnostics: () => {
    contextState: string;
    localMic: { label: string; enabled: boolean; muted: boolean } | null;
    blockedMicLabel: string | null;
    remoteCount: number;
  } | null;
  onReconnect: () => void;
  /** 録画中は有効化を許可しない（録画開始前に有効化しないとタブ音声二重化が起きるため） */
  isRecording: boolean;
  onClose: () => void;
}

/**
 * AI 参加者（ChatGPT デスクトップ音声）のセットアップモーダル（要件§19）。
 *
 * - AI 音声ソース（audioinput）の選択とレベルメーター
 * - ChatGPT への送出先（audiooutput = CABLE-B Input）の選択
 * - プリフライト: 自己ループ検査（AI のみ発声時に送出先モニタが無音であること）
 * - 物理マイク誤選択（二重取り込み）の警告
 * - ChatGPT アカウント認証 UI は作らない（要件§19）
 */
export function AiParticipantSetupModal({
  room,
  config,
  onPatchConfig,
  enabled,
  onChangeEnabled,
  aiStatus,
  publishFailed,
  inputMixerError,
  setInputMixerSendEnabled,
  setInputMixerIncludeLocalMic,
  getInputMixerDiagnostics,
  onReconnect,
  isRecording,
  onClose,
}: AiParticipantSetupModalProps) {
  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [previewLevel, setPreviewLevel] = useState(0);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewSuspended, setPreviewSuspended] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loopCheck, setLoopCheck] = useState<
    | { state: 'idle' }
    | { state: 'running'; secondsLeft: number }
    | { state: 'passed' }
    | { state: 'failed'; reason: string }
    | { state: 'unavailable'; reason: string }
  >({ state: 'idle' });
  const [manualConfirm, setManualConfirm] = useState(false);
  /**
   * 検査・手動確認が「どの配線に対して」成立したかの指紋 (Codex 第4巡 #1)。
   * boolean で持つと、検証後に別タブから配線が変わっても合格状態が残る。
   * 有効化時は現在の配線とこの指紋の一致を要求するため、配線が変われば
   * storage イベントの順序に関係なく自動的に無効になる。
   */
  const [verifiedFp, setVerifiedFp] = useState<string | null>(null);
  // localStorage へ書けなかった (プライベートモード等)。設定がタブ限りになる警告
  const [persistFailed, setPersistFailed] = useState(false);
  // プリフライト完了時に「検査した配線」と「今の配線」の一致を確かめるための現在値
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  // 音を出す・測る検査は同時に1つだけ (送出ミュートの取り合い防止)。
  // 排他は ref による同期リースで行う — state だけだと反映前の一瞬に
  // 二重起動できてしまう (Codex 第3巡 #2)。state は UI の表示専用。
  const [probeBusy, setProbeBusy] = useState(false);
  const probeLeaseRef = useRef(false);
  const acquireProbe = useCallback((): boolean => {
    if (probeLeaseRef.current) return false;
    probeLeaseRef.current = true;
    setProbeBusy(true);
    return true;
  }, []);
  const releaseProbe = useCallback(() => {
    probeLeaseRef.current = false;
    setProbeBusy(false);
  }, []);
  // 「試聴テスト」(Windows 常時モニタの確認) の再生中フラグ
  const [listenTestPlaying, setListenTestPlaying] = useState(false);

  // ── デバイス列挙 ──
  const refreshDevices = useCallback(async () => {
    try {
      // label 取得にはメディア権限が必要。既に LiveKit がマイクを開いていれば付与済み。
      const devices = await navigator.mediaDevices.enumerateDevices();
      const toOption = (d: MediaDeviceInfo): DeviceOption => ({
        deviceId: d.deviceId,
        groupId: d.groupId,
        label: d.label || `デバイス (${d.deviceId.slice(0, 8)}…)`,
        recommended: isVirtualCableLabel(d.label),
      });
      const sortRec = (a: DeviceOption, b: DeviceOption) =>
        Number(b.recommended) - Number(a.recommended);
      setInputs(devices.filter((d) => d.kind === 'audioinput').map(toOption).sort(sortRec));
      setOutputs(devices.filter((d) => d.kind === 'audiooutput').map(toOption).sort(sortRec));
    } catch (e) {
      console.warn('[AiSetup] enumerateDevices 失敗', e);
    }
  }, []);

  useEffect(() => {
    // setState (async 内) を microtask に逃がし、effect body での同期 setState を回避
    queueMicrotask(() => void refreshDevices());
    const onChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  // ── 選択中ソースのプレビューメーター ──
  useEffect(() => {
    // setState を microtask に逃がし、effect body 内での同期 setState を回避 (既存パターン)
    queueMicrotask(() => {
      setPreviewLevel(0);
      setPreviewActive(false);
      setPreviewSuspended(false);
      setPreviewError(null);
    });
    const deviceId = config.sourceDeviceId;
    if (!deviceId || deviceId === 'fake') return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let detector: RmsSpeakingDetector | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) return;
        detector = new RmsSpeakingDetector(track);
        detector.start((s) => {
          setPreviewLevel(s.level);
          setPreviewActive(s.isSpeaking);
          setPreviewSuspended(s.suspended);
        });
        void resumeAllAudioContexts();
      } catch (e) {
        console.warn('[AiSetup] プレビュー取得失敗', e);
        setPreviewError(
          e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        );
      }
    })();
    return () => {
      cancelled = true;
      detector?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [config.sourceDeviceId]);

  // ── 物理マイク誤選択（二重取り込み）の検知 ──
  // 通話に使っているマイクの実体（診断表示にも使う）
  const [micInfo, setMicInfo] = useState<{
    label: string;
    deviceId: string;
    groupId: string;
  } | null>(null);
  useEffect(() => {
    const read = () => {
      const t = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack;
      if (!t) {
        setMicInfo(null);
        return;
      }
      const st = t.getSettings();
      setMicInfo({ label: t.label, deviceId: st.deviceId ?? "", groupId: st.groupId ?? "" });
    };
    const id = setInterval(read, 500);
    return () => clearInterval(id);
  }, [room]);

  // 通話マイクの切替（この画面から直せるようにする。収録バーの⚙️はモーダルに隠れるため）
  const [switchingMic, setSwitchingMic] = useState(false);
  const switchMic = async (deviceId: string) => {
    if (!room || !deviceId) return;
    setSwitchingMic(true);
    try {
      await room.switchActiveDevice("audioinput", deviceId);
    } catch (err) {
      console.error("[AiSetup] マイク切替に失敗", err);
    } finally {
      setSwitchingMic(false);
    }
  };

  // ── 物理マイク誤選択（二重取り込み）の検知 ──
  const micCollision = useMemo(() => {
    if (!config.sourceDeviceId || config.sourceDeviceId === "fake" || !micInfo) return false;
    // deviceId 一致は決定的
    if (micInfo.deviceId && micInfo.deviceId === config.sourceDeviceId) return true;
    const selected = inputs.find((d) => d.deviceId === config.sourceDeviceId);
    if (!selected) return false;
    // 同一物理デバイスの別エンドポイントを groupId で検知する。ただし仮想ケーブルは
    // 物理マイクではありえないので対象外にする（誤検知で有効化がブロックされるのを防ぐ）
    if (selected.recommended) return false;
    return !!micInfo.groupId && !!selected.groupId && micInfo.groupId === selected.groupId;
  }, [config.sourceDeviceId, inputs, micInfo]);

  // ── 送出経路の内部状態を定期取得（切り分け用）──
  const [mixerDiag, setMixerDiag] = useState<ReturnType<
    AiParticipantSetupModalProps["getInputMixerDiagnostics"]
  >>(null);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setMixerDiag(getInputMixerDiagnostics()), 500);
    return () => clearInterval(t);
  }, [enabled, getInputMixerDiagnostics]);

  // ── 送出モニタ ──
  // 送出先(ChatGPTの耳)の対になる録音側を監視し、こちらの声が実際に
  // 届いているかを可視化する。有効化するまでミキサーは動かないので無音が正常。
  const monitorDeviceId = useMemo(() => {
    if (!config.sinkDeviceId) return null;
    const sink = outputs.find((d) => d.deviceId === config.sinkDeviceId);
    if (!sink) return null;
    return findCableMonitorInput(sink, inputs)?.deviceId ?? null;
  }, [config.sinkDeviceId, inputs, outputs]);

  const [sendLevel, setSendLevel] = useState(0);
  const [sendActive, setSendActive] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setSendLevel(0);
      setSendActive(false);
    });
    if (!enabled || !monitorDeviceId) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let detector: RmsSpeakingDetector | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: { exact: monitorDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const track = stream.getAudioTracks()[0];
        if (!track) return;
        detector = new RmsSpeakingDetector(track);
        detector.start((s) => {
          setSendLevel(s.level);
          setSendActive(s.isSpeaking);
        });
      } catch (e) {
        console.warn("[AiSetup] 送出モニタ取得失敗", e);
      }
    })();
    return () => {
      cancelled = true;
      detector?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, monitorDeviceId]);

  // ループ検査ループから最新のプレビュー状態を読むための ref
  const previewActiveRef = useRef(false);
  useEffect(() => {
    previewActiveRef.current = previewActive;
  }, [previewActive]);

  // ── プリフライト: 自己ループ検査 ──
  // 「AI のみ発声」の間、送出先 (CABLE-B) 側のモニタ入力が無音であることを確認する。
  // この検査中は ChatGPT 入力ミキサーはまだ動いていないため、送出先で音が観測されたら
  // それは OS 側の配線 (「このデバイスを聴く」等) による漏れを意味する。
  const runLoopCheck = useCallback(async () => {
    // UI の disabled に頼らない論理ガード (録画中のトーンは収録と配信に混入する)
    if (isRecording) return;
    void resumeAllAudioContexts();
    const sink = outputs.find((d) => d.deviceId === config.sinkDeviceId);
    if (!sink) {
      setLoopCheck({ state: 'unavailable', reason: '送出先デバイスが未選択です' });
      return;
    }
    const monitorInput = findCableMonitorInput(sink, inputs);
    if (!monitorInput) {
      setLoopCheck({
        state: 'unavailable',
        reason:
          '送出先ケーブルの監視入力を自動特定できませんでした。ガイドどおりの配線を手動で確認してください。',
      });
      return;
    }
    // 送出先と AI 音声ソースが同じケーブルの両端だと、人間の声が AI 音声として
    // 二重に取り込まれ、ChatGPT には何も届かない。配線ミスとして明示的に弾く。
    if (monitorInput.deviceId === config.sourceDeviceId) {
      setLoopCheck({
        state: 'failed',
        reason:
          '送出先と AI 音声ソースが同じケーブルです。ChatGPT の出力用 (CABLE-A) と入力用 (CABLE-B) は別のケーブルを指定してください。',
      });
      return;
    }
    // 音を出す・測る区間はリースで排他する。前提検査はリース不要 (音を出さない)
    if (!acquireProbe()) return;
    // この検査が対象にした配線。完了時に一致しなければ結果を捨てる
    const wiringFpAtStart = aiWiringFingerprint(configRef.current);
    let stream: MediaStream | null = null;
    // 有効化後はこちらの声が送出経路に乗っているため、検査中だけ送出を止めて
    // 「OS 側の漏れ」だけを測る。止めないとマイクが拾った物音を漏れと誤判定する。
    setInputMixerSendEnabled(false);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: monitorInput.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('監視トラックなし');
      let aiActiveSamples = 0;
      let leakSamples = 0;
      const monitorDetector = new RmsSpeakingDetector(track, { startThreshold: 0.015 });
      let monitorSpeaking = false;
      monitorDetector.start((s) => {
        monitorSpeaking = s.isSpeaking;
      });
      const DURATION_S = 8;
      for (let sec = DURATION_S; sec > 0; sec--) {
        setLoopCheck({ state: 'running', secondsLeft: sec });
        await new Promise((r) => setTimeout(r, 1000));
        // AI が発声している間に送出先へ音が漏れていればループ
        if (previewActiveRef.current) {
          aiActiveSamples++;
          if (monitorSpeaking) leakSamples++;
        }
      }
      monitorDetector.stop();
      if (aiActiveSamples === 0) {
        setLoopCheck({
          state: 'failed',
          reason:
            '検査中に AI の発声を検出できませんでした。ChatGPT に何か話させながら再実行してください。',
        });
      } else if (leakSamples > 0) {
        setLoopCheck({
          state: 'failed',
          reason:
            'AI の音声が ChatGPT への送出先に漏れています（自己ループ）。配線を見直してください。',
        });
      } else if (wiringFpAtStart !== aiWiringFingerprint(configRef.current)) {
        // 検査中に配線が変わった (別タブ等)。古い配線の合格を新配線に付けない
        setLoopCheck({
          state: 'unavailable',
          reason: '検査中に配線が変更されました。もう一度実行してください。',
        });
      } else {
        setLoopCheck({ state: 'passed' });
        setVerifiedFp(wiringFpAtStart);
      }
    } catch (e) {
      console.warn('[AiSetup] ループ検査失敗', e);
      setLoopCheck({ state: 'unavailable', reason: '監視入力を開けませんでした' });
    } finally {
      setInputMixerSendEnabled(true);
      stream?.getTracks().forEach((t) => t.stop());
      releaseProbe();
    }
  }, [inputs, outputs, config.sinkDeviceId, config.sourceDeviceId, setInputMixerSendEnabled, isRecording, acquireProbe, releaseProbe]);

  // 送出先(ChatGPTの耳)の経路をAI音声ソースに選んでしまう取り違えの検出。
  // これをやると自分たちの声を「AIの声」として取り込むことになる。
  const sourceIsSinkMonitor = useMemo(() => {
    if (!config.sinkDeviceId || !config.sourceDeviceId) return false;
    const sink = outputs.find((d) => d.deviceId === config.sinkDeviceId);
    if (!sink) return false;
    return findCableMonitorInput(sink, inputs)?.deviceId === config.sourceDeviceId;
  }, [config.sinkDeviceId, config.sourceDeviceId, inputs, outputs]);

  const canEnable =
    !!config.sourceDeviceId && !micCollision && !sourceIsSinkMonitor && !isRecording;

  // ボタンが押せない理由を明示する（グレーアウトの理由が分からない状態を作らない）
  const enableBlockReason = !config.sourceDeviceId
    ? "① AI 音声ソースを選んでください"
    : micCollision || sourceIsSinkMonitor
      ? "上の警告を解消してください"
      : isRecording
        ? "録画中は有効化できません（録画を止めてから）"
        : null;

  const set = (patch: Partial<AiParticipantConfig>) => {
    const wiringChanged = 'sourceDeviceId' in patch || 'sinkDeviceId' in patch;
    // sendLocalMic は送出経路そのものを切り替えるため、変更したら検証済みを
    // 落として再検証に戻す (Codex 第2巡 #8。monitorAiLocally は聞こえ方だけ
    // なので落とさない)
    const invalidates = wiringChanged || 'sendLocalMic' in patch;
    void onPatchConfig({
      ...patch,
      ...(invalidates ? { validatedFingerprint: null } : {}),
    }).then((persisted) => setPersistFailed(!persisted));
    if (wiringChanged) {
      setLoopCheck({ state: 'idle' });
      setManualConfirm(false);
      setVerifiedFp(null);
    }
  };

  /**
   * 有効化。「検証済み」の指紋は、収録前チェック全通過・自己ループ検査合格・
   * 手動確認のいずれかを経たときだけ保存する。未検証のまま有効化はできる
   * (チェックは任意という運用) が、その場合は次回のワンクリック起動を許可しない
   * — 検証していない配線を「検証済み」として記録しない (Codex レビュー #6)。
   */
  const handleEnable = async () => {
    void resumeAllAudioContexts();
    // 検証は「今の配線に対して」成立していなければならない。指紋の一致で
    // 確かめるため、検証後に配線が変わっていれば (別タブ含む) 自動的に落ちる
    const verified = verifiedFp !== null && verifiedFp === aiWiringFingerprint(config);
    const persisted = await onPatchConfig({
      validatedFingerprint: verified ? aiWiringFingerprint(config) : null,
    });
    onChangeEnabled(true);
    if (!persisted) {
      // 有効化はする (今この場では使える) が、保存できていないことを見せてから
      // 閉じてもらう。黙って閉じると次回「設定が消えた」に見える
      setPersistFailed(true);
      return;
    }
    // 設定完了なのでそのまま閉じる（状態は StudioBar の 🤖 ボタンとステージのタイルで分かる）
    onClose();
  };

  const statusLabel: Record<AiProviderStatus, string> = {
    disconnected: '未接続',
    connecting: '接続中…',
    connected: '● 接続済み',
    error: '⚠ エラー (音声ソース切断)',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-stone-700 bg-stone-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-100">🤖 AI 参加者 (ChatGPT)</h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>

        <a
          href="/help/ai-participant"
          target="_blank"
          rel="noopener noreferrer"
          className="mb-4 block text-[11px] font-medium text-amber-400 underline-offset-4 hover:underline"
        >
          設定に迷ったら — セットアップ手順を開く
        </a>

        {persistFailed && (
          <p className="mb-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
            設定をブラウザに保存できませんでした（プライベートモード等）。
            この設定はタブを閉じると消えます。
          </p>
        )}

        {/* 状態表示 */}
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span
            className={
              aiStatus === 'connected'
                ? 'text-emerald-400'
                : aiStatus === 'error'
                  ? 'text-red-400'
                  : 'text-stone-400'
            }
          >
            {enabled ? statusLabel[aiStatus] : '無効'}
          </span>
          {publishFailed && (
            <span className="rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-200">
              録画中・配信失敗 (他の参加者にAI音声が届いていません)
            </span>
          )}
          {enabled && aiStatus === 'error' && (
            <button
              onClick={onReconnect}
              className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500"
            >
              再接続
            </button>
          )}
        </div>

        {/* 表示名。アバターは中央のエネルギー球で表現するため選択欄は持たない */}
        <label className="mb-4 block text-xs text-stone-400">
          表示名
          <input
            type="text"
            value={config.displayName}
            maxLength={32}
            onChange={(e) => set({ displayName: e.target.value })}
            className="mt-1 w-full rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-sm text-stone-100"
          />
        </label>

        {/* 音声ソース選択 */}
        <label className="mb-1 block text-xs text-stone-400">
          <strong className="text-stone-300">① AI 音声ソース</strong> — ChatGPT の声が<strong>出てくる</strong>側
          <br />
          ChatGPT の「出力デバイス」に指定した仮想ケーブルの録音側を選ぶ。
          例: <code>CABLE Output</code> / <code>CABLE-A Output</code>
        </label>
        <select
          value={config.sourceDeviceId ?? ''}
          disabled={probeBusy}
          onChange={(e) => {
            const d = inputs.find((x) => x.deviceId === e.target.value);
            set({
              sourceDeviceId: e.target.value || null,
              sourceDeviceLabel: d?.label,
            });
          }}
          className="mb-1 w-full rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-sm text-stone-200"
        >
          <option value="">未選択</option>
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.recommended ? '★ ' : ''}
              {d.label}
            </option>
          ))}
        </select>
        {micCollision && (
          <p className="mb-2 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
            ⚠ 選択中のデバイスは通話に使っているマイク
            {micInfo?.label ? `（${micInfo.label}）` : ""}
            と同一です。あなたの声が二重に録音されます。仮想ケーブル
            (CABLE Output 等) を選択してください。
          </p>
        )}
        {sourceIsSinkMonitor && (
          <p className="mb-2 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
            ⚠ AI 音声ソースに「ChatGPT への送出先」と同じ経路を選んでいます。
            そちらは<strong>こちらの声を送る側</strong>なので、ChatGPT の声が
            出てくる側 (CABLE Output 等) を選んでください。
          </p>
        )}

        {/* レベルメーター */}
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between text-xs text-stone-400">
            <span>音声レベル (ChatGPT に何か話させて確認)</span>
            <span className={previewActive ? 'text-emerald-400' : 'text-stone-500'}>
              {previewSuspended
                ? '⏸ 音声解析が停止中 (画面をクリック)'
                : previewActive
                  ? '● 検出中'
                  : '○ 無音'}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-stone-800">
            <div
              className="h-full rounded bg-emerald-500 transition-[width] duration-100"
              style={{ width: `${Math.round(Math.min(previewLevel, 1) * 100)}%` }}
            />
          </div>
          {previewError && (
            <p className="mt-1.5 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
              ⚠ このデバイスを開けませんでした: {previewError}
            </p>
          )}
          <p className="mt-1.5 text-[11px] leading-relaxed text-stone-500">
            ChatGPT に話しかけても反応しないのは正常です。あなたの声は
            「AI 参加者を有効にする」を押した時点から届きます。ここでの確認は
            <strong>ChatGPT にテキストで話しかけて</strong>音声で返答させてください。
          </p>
        </div>

        {/* ChatGPT への送出先 */}
        <label className="mb-1 block text-xs text-stone-400">
          通話マイク — あなたの声を拾うデバイス（ChatGPT へはここから送られます）
        </label>
        <select
          value={micInfo?.deviceId ?? ""}
          disabled={switchingMic}
          onChange={(e) => void switchMic(e.target.value)}
          className="mb-1 w-full rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-sm text-stone-200 disabled:opacity-50"
        >
          {!micInfo && <option value="">(マイク未取得)</option>}
          {inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {isLoopbackCaptureLabel(d.label) ? "⚠ " : ""}
              {d.label}
            </option>
          ))}
        </select>
        <p className="mb-4 text-[11px] leading-relaxed text-stone-500">
          ⚠ が付くものは録音デバイス（再生音を録るもの）で、マイクには使えません。
          物理マイク（マイク配列など）を選んでください。
        </p>

        <label className="mb-1 block text-xs text-stone-400">
          <strong className="text-stone-300">② ChatGPT への送出先</strong> — こちらの声を<strong>送る</strong>側（任意）
          <br />
          ChatGPT の「入力デバイス」に指定した仮想デバイスの再生側を選ぶ。
          例: <code>Voicemeeter Input</code> / <code>CABLE-B Input</code>
        </label>
        <select
          value={config.sinkDeviceId ?? ''}
          disabled={probeBusy}
          onChange={(e) => {
            const d = outputs.find((x) => x.deviceId === e.target.value);
            set({
              sinkDeviceId: e.target.value || null,
              sinkDeviceLabel: d?.label,
            });
          }}
          className="mb-2 w-full rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-sm text-stone-200"
        >
          <option value="">使用しない (外部でルーティング済み)</option>
          {outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.recommended ? '★ ' : ''}
              {d.label}
            </option>
          ))}
        </select>
        <p className="mb-3 text-[11px] leading-relaxed text-stone-500">
          設定すると、あなたと相手の声だけをアプリ内でミックスして ChatGPT
          の耳へ届けます（AI 自身の声は構造的に混ざりません）。
        </p>
        <label className="mb-3 flex items-start gap-2 text-[11px] leading-relaxed text-stone-400">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={config.sendLocalMic === false}
            onChange={(e) => set({ sendLocalMic: !e.target.checked })}
          />
          <span>
            あなたの声は <strong>VoiceMeeter 側で常時 ChatGPT に送っている</strong>
            （アプリからは送らない）
            <br />
            物理マイクを VoiceMeeter のハードウェア入力から B1 へ流している構成で
            チェックします。アプリを起動していなくても他の通話アプリが普通にマイクを
            使えるようになります。チェックしないと、あなたの声が ChatGPT に二重に届きます。
          </span>
        </label>
        <label className="mb-3 flex items-start gap-2 text-[11px] leading-relaxed text-stone-400">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={config.monitorAiLocally === false}
            onChange={(e) => set({ monitorAiLocally: !e.target.checked })}
          />
          <span>
            ChatGPT の声は <strong>Windows 側で常時モニタしている</strong>
            （アプリからは再生しない）
            <br />
            録音タブで AI 音声ソースの「このデバイスを聴く」を有効にしている場合に
            チェックします。<strong>アプリを起動していなくても ChatGPT の声が聞こえる</strong>
            ため、ChatGPT を普段どおり単体で使えます。チェックしないと二重に聞こえます。
            <br />
            <button
              type="button"
              disabled={
                listenTestPlaying || !config.sourceDeviceId || enabled || isRecording || probeBusy
              }
              onClick={() => {
                // AI 音声ソース (CABLE Output 等) の再生側へテストトーンを流す。
                // Windows の「このデバイスを聴く」が生きていれば音が聞こえるはず。
                // ブラウザからはモニタの有無を検出できないため、耳で判定してもらう。
                const src = inputs.find((d) => d.deviceId === config.sourceDeviceId);
                const playback = src ? findCablePlaybackForCapture(src, outputs) : null;
                if (!playback) return;
                setListenTestPlaying(true);
                void playToneProbe(playback.deviceId, 2000).finally(() =>
                  setListenTestPlaying(false)
                );
              }}
              className="mt-1 rounded bg-stone-700 px-2 py-1 text-[11px] text-stone-200 hover:bg-stone-600 disabled:opacity-40"
            >
              {listenTestPlaying ? '♪ 再生中…' : '♪ 試聴テスト (2秒)'}
            </button>{' '}
            <span className="text-stone-500">
              {enabled
                ? '試聴テストは AI を OFF にしてから（アプリ自身の再生と聞き分けられないため）'
                : '音が聞こえたら Windows 側モニタは生きています → チェックON'}
            </span>
          </span>
        </label>
        {enabled && monitorDeviceId && (
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between text-xs text-stone-400">
              <span>送出モニタ (あなたの声が ChatGPT に届いているか)</span>
              <span className={sendActive ? "text-emerald-400" : "text-stone-500"}>
                {sendActive ? "● 届いています" : "○ 無音"}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-stone-800">
              <div
                className="h-full rounded bg-sky-500 transition-[width] duration-100"
                style={{ width: `${Math.round(Math.min(sendLevel, 1) * 100)}%` }}
              />
            </div>
            {inputMixerError && (
              <p className="mt-1.5 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
                ⚠ 送出経路を開けませんでした: {inputMixerError}
              </p>
            )}
            {mixerDiag?.blockedMicLabel && (
              <p className="mt-1.5 rounded-lg bg-red-900/40 px-3 py-2 text-xs text-red-200">
                ⚠ 通話マイクが録音デバイス「{mixerDiag.blockedMicLabel}」になっています。
                これは再生音をそのまま録るもので、あなたの声は入らず AI の声が
                ChatGPT へ戻ってハウリングします。安全のため送出を止めました。
                Windows の既定の録音デバイスを<strong>物理マイク（マイク配列など）</strong>
                に変更してください。
              </p>
            )}
            {mixerDiag && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-stone-400">
                <span>
                  音声処理:{" "}
                  <b className={mixerDiag.contextState === "running" ? "text-emerald-400" : "text-red-300"}>
                    {mixerDiag.contextState}
                  </b>
                </span>
                <span>
                  あなたのマイク:{" "}
                  <b
                    className={
                      mixerDiag.localMic
                        ? "text-stone-200"
                        : config.sendLocalMic === false
                          ? "text-stone-400"
                          : "text-red-300"
                    }
                  >
                    {mixerDiag.localMic?.label ||
                      (config.sendLocalMic === false
                        ? "VoiceMeeter が送信中 (アプリからは送らない)"
                        : "未接続")}
                  </b>
                </span>
                <span>
                  相手の声:{" "}
                  <b className={mixerDiag.remoteCount > 0 ? "text-emerald-400" : "text-stone-500"}>
                    {mixerDiag.remoteCount}人
                  </b>
                </span>
              </div>
            )}
          </div>
        )}

        {/* プリフライト */}
        <AiRequiredSettings
          inputs={inputs}
          outputs={outputs}
          sourceDeviceId={config.sourceDeviceId}
          sinkDeviceId={config.sinkDeviceId}
        />
        <div className="mb-3">
          <AiPreflightPanel
            inputs={inputs}
            outputs={outputs}
            sourceDeviceId={config.sourceDeviceId}
            sinkDeviceId={config.sinkDeviceId}
            micLabel={micInfo?.label ?? null}
            mixerRunning={mixerDiag?.contextState === "running"}
            mixerHasMic={!!mixerDiag?.localMic}
            aiEnabled={enabled}
            getMicTrack={() =>
              room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
                ?.mediaStreamTrack ?? null
            }
            sendLocalMicOn={config.sendLocalMic !== false}
            setSendEnabled={setInputMixerSendEnabled}
            setMixerIncludeLocalMic={setInputMixerIncludeLocalMic}
            onAutoConfig={(patch) => set(patch)}
            disabledReason={
              isRecording
                ? '録画中は検査できません（テストトーンが収録と配信に入るため）'
                : probeBusy
                  ? '別の検査が実行中です'
                  : null
            }
            acquireProbe={acquireProbe}
            releaseProbe={releaseProbe}
            onAllPassed={(wiringFp) => {
              // 「検査した配線」の指紋を保存する。有効化時に現在の配線と照合する
              // ため、検査後に配線が変わっていれば自動的に無効になる
              setManualConfirm(true);
              setVerifiedFp(wiringFp);
            }}
          />
        </div>
        <div className="mb-4 rounded-xl border border-stone-700 bg-stone-800/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-stone-300">
              プリフライト: 自己ループ検査
            </span>
            <button
              onClick={() => void runLoopCheck()}
              disabled={
                loopCheck.state === 'running' || !config.sinkDeviceId || isRecording || probeBusy
              }
              className="rounded-lg bg-stone-700 px-3 py-1 text-xs text-stone-200 hover:bg-stone-600 disabled:opacity-40"
            >
              {loopCheck.state === 'running'
                ? `検査中… ${loopCheck.secondsLeft}s`
                : '検査を実行'}
            </button>
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-stone-500">
            ChatGPT に話させながら実行してください。AI の声が ChatGPT
            の耳（送出先）に漏れていないことを確認します。
            <br />
            検査中はこちらの声の送出を自動的に止めます（8秒間 ChatGPT には
            届きません）。ChatGPT にテキストで話しかけて音声で返答させながら実行してください。
            にテキストで話しかけて音声で返答させるか、音声モードを開始した直後の
            発話に合わせて実行してください。
          </p>
          {loopCheck.state === 'passed' && (
            <p className="text-xs text-emerald-400">✔ 合格: 自己ループはありません</p>
          )}
          {loopCheck.state === 'failed' && (
            <p className="text-xs text-red-300">✘ {loopCheck.reason}</p>
          )}
          {loopCheck.state === 'unavailable' && (
            <div className="text-xs text-amber-200">
              <p>△ {loopCheck.reason}</p>
              <label className="mt-1 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={manualConfirm}
                  onChange={(e) => {
                  setManualConfirm(e.target.checked);
                  setVerifiedFp(
                    e.target.checked ? aiWiringFingerprint(configRef.current) : null
                  );
                }}
                  className="mt-0.5"
                />
                <span>
                  セットアップガイドどおりに配線し、ChatGPT の声が ChatGPT
                  自身の入力に戻らないことを手動で確認しました
                </span>
              </label>
            </div>
          )}
          {!config.sinkDeviceId && (
            <label className="mt-1 flex items-start gap-2 text-xs text-amber-200">
              <input
                type="checkbox"
                checked={manualConfirm}
                onChange={(e) => {
                  setManualConfirm(e.target.checked);
                  setVerifiedFp(
                    e.target.checked ? aiWiringFingerprint(configRef.current) : null
                  );
                }}
                className="mt-0.5"
              />
              <span>
                外部ルーティングで ChatGPT の声が ChatGPT
                自身の入力に戻らないことを確認しました
              </span>
            </label>
          )}
        </div>

        {/* 注意書き */}
        <div className="mb-4 space-y-1 text-[11px] leading-relaxed text-stone-500">
          <p>
            ・AI タイルは<strong>この画面を再読み込みした参加者にのみ</strong>
            表示されます。有効化の前に、参加中のメンバーへページの再読み込みを依頼してください。
          </p>
          <p>・録画開始前に有効化してください（録画中の有効化はできません）。</p>
          <p>・ヘッドホン必須（スピーカー使用はエコーの原因になります）。</p>
          <p>
            ・一度有効化すると<strong>この配線を記憶</strong>し、次回からはダッシュボードの
            「AI参加者つきで収録開始」でワンクリック起動できます。デバイスを変更すると
            記憶は破棄され、再びこの画面での確認が必要になります。
          </p>
        </div>

        {/* 有効化 */}
        <div className="flex items-center justify-between gap-3">
          {!enabled && enableBlockReason && (
            <span className="text-xs text-amber-300">{enableBlockReason}</span>
          )}
          {enabled ? (
            <button
              onClick={() => onChangeEnabled(false)}
              className="ml-auto rounded-lg bg-stone-700 px-4 py-2 text-sm font-medium text-stone-200 hover:bg-stone-600"
            >
              AI 参加者を無効にする
            </button>
          ) : (
            <button
              onClick={() => void handleEnable()}
              disabled={!canEnable}
              className="ml-auto rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              AI 参加者を有効にする
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
