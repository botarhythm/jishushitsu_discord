'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import {
  aiWiringFingerprint,
  isLoopbackCaptureLabel,
  DEFAULT_AI_CONFIG,
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
import { buildWiringPlan, matchesPlan } from '@/lib/ai-wiring-plan';
import { AiPreflightPanel } from './AiPreflightPanel';
import { AiWiringPlanPanel, type PlanTarget } from './AiWiringPlanPanel';

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
   * 表示名はローカルバッファで持つ。
   *
   * config を直接 value にすると、1文字ごとの非同期な保存往復と
   * sanitizeAiConfig の .trim() / 既定値フォールバックが重なり、
   * IME 変換中に値が巻き戻って caret が飛ぶ（実機で入力不能になった）。
   * 表示は常にこのバッファを使い、config へは編集のたびに書き戻す。
   */
  const [nameDraft, setNameDraft] = useState(config.displayName);
  const nameEditingRef = useRef(false);
  useEffect(() => {
    if (!nameEditingRef.current) setNameDraft(config.displayName);
  }, [config.displayName]);

  /**
   * この PC の推奨配線。接続デバイスだけから決まる「正解」を先に提示するために使う
   * （現在の選択から逆算すると、選択が間違っているときに誤った案内が出る）。
   */
  const plan = useMemo(() => buildWiringPlan(inputs, outputs), [inputs, outputs]);

  const applyPlanTarget = (target: PlanTarget) => {
    if (target === 'source') {
      if (plan.source) {
        set({ sourceDeviceId: plan.source.deviceId, sourceDeviceLabel: plan.source.label });
      }
    } else if (target === 'sink') {
      set({ sinkDeviceId: plan.sink?.deviceId ?? null, sinkDeviceLabel: plan.sink?.label });
    } else if (plan.mic) {
      void switchMic(plan.mic.deviceId);
    }
  };

  const applyPlanAll = () => {
    const patch: Partial<AiParticipantConfig> = {};
    if (plan.source && !matchesPlan(config.sourceDeviceId, plan.source)) {
      patch.sourceDeviceId = plan.source.deviceId;
      patch.sourceDeviceLabel = plan.source.label;
    }
    if (!matchesPlan(config.sinkDeviceId, plan.sink)) {
      patch.sinkDeviceId = plan.sink?.deviceId ?? null;
      patch.sinkDeviceLabel = plan.sink?.label;
    }
    if (Object.keys(patch).length > 0) set(patch);
    if (plan.mic && plan.mic.deviceId !== (micInfo?.deviceId ?? null)) {
      void switchMic(plan.mic.deviceId);
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
      {/* ヘッダーとフッターを固定し、中身だけスクロールさせる。
          長い設定画面でも「今どういう状態か」と「有効化ボタン」を見失わない */}
      <div className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-stone-700 bg-stone-900 shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-stone-800 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-balance text-base font-semibold text-stone-100">
              AI 参加者 (ChatGPT)
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span
                className={`text-sm font-medium ${
                  !enabled
                    ? 'text-stone-400'
                    : aiStatus === 'connected'
                      ? 'text-emerald-400'
                      : aiStatus === 'error'
                        ? 'text-red-400'
                        : 'text-stone-400'
                }`}
              >
                {enabled ? statusLabel[aiStatus] : '無効'}
              </span>
              {publishFailed && (
                <span className="rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-200">
                  配信失敗 (他の参加者に AI 音声が届いていません)
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
          </div>
          <button
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-lg px-2 py-1 text-stone-400 hover:bg-stone-800 hover:text-stone-200"
            aria-label="閉じる"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {persistFailed && (
            <Alert tone="error">
              設定をブラウザに保存できませんでした（プライベートモード等）。
              この設定はタブを閉じると消えます。
            </Alert>
          )}

          <SectionTitle step={1}>デバイスを選ぶ</SectionTitle>

          <AiWiringPlanPanel
            plan={plan}
            currentSourceId={config.sourceDeviceId}
            currentMicId={micInfo?.deviceId ?? null}
            currentSinkId={config.sinkDeviceId}
            onApply={applyPlanTarget}
            onApplyAll={applyPlanAll}
            busy={probeBusy || switchingMic}
          />

          <Field
            htmlFor="ai-source"
            label="① AI 音声ソース"
            hint="ChatGPT の声が出てくる側。ChatGPT の「出力デバイス」に指定した仮想ケーブルの録音側を選びます。"
            help={
              <>
                例: <Code>CABLE Output</Code> / <Code>CABLE-A Output</Code>。
                <strong className="font-medium text-stone-200">◎ がこの PC での推奨</strong>
                、★ は仮想ケーブル系の候補（推奨とは限りません）です。
                <br />
                レベルメーターは ChatGPT が実際に喋ったときだけ振れます。ChatGPT
                に話しかけても反応しないのは正常です（あなたの声は「AI 参加者を
                有効にする」を押した時点から届きます）。ここでの確認は
                <strong className="font-medium text-stone-200">
                  ChatGPT にテキストで話しかけて
                </strong>
                音声で返答させてください。
              </>
            }
          >
            <select
              id="ai-source"
              value={config.sourceDeviceId ?? ''}
              disabled={probeBusy}
              onChange={(e) => {
                const d = inputs.find((x) => x.deviceId === e.target.value);
                set({
                  sourceDeviceId: e.target.value || null,
                  sourceDeviceLabel: d?.label,
                });
              }}
              className={selectClass}
            >
              <option value="">未選択</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {optionPrefix(d, plan.source)}
                  {d.label}
                </option>
              ))}
            </select>

            <PlanHint
              recommendedLabel={plan.source?.label ?? null}
              matched={matchesPlan(config.sourceDeviceId, plan.source)}
              onApply={() => applyPlanTarget('source')}
              disabled={probeBusy}
            />

            {micCollision && (
              <Alert tone="error">
                選択中のデバイスは通話に使っているマイク
                {micInfo?.label ? `（${micInfo.label}）` : ''}
                と同一です。あなたの声が二重に録音されます。仮想ケーブル (CABLE Output 等)
                を選択してください。
              </Alert>
            )}
            {sourceIsSinkMonitor && (
              <Alert tone="error">
                AI 音声ソースに「ChatGPT への送出先」と同じ経路を選んでいます。そちらは
                <strong className="font-medium">こちらの声を送る側</strong>なので、ChatGPT
                の声が出てくる側 (CABLE Output 等) を選んでください。
              </Alert>
            )}

            <Meter
              label="音声レベル"
              level={previewLevel}
              color="bg-emerald-500"
              status={
                previewSuspended
                  ? { text: '⏸ 解析停止中 (画面をクリック)', tone: 'warn' }
                  : previewActive
                    ? { text: '● 検出中', tone: 'ok' }
                    : { text: '○ 無音', tone: 'idle' }
              }
            />
            {previewError && <Alert tone="error">このデバイスを開けませんでした: {previewError}</Alert>}
          </Field>

          <Field
            htmlFor="ai-mic"
            label="通話マイク"
            hint="あなたの声を拾うデバイス。ChatGPT へはここから送られます。"
            help={
              <>
                ⚠ が付くものは録音デバイス（再生音を録るもの）で、マイクには使えません。
                物理マイク（マイク配列など）を選んでください。
              </>
            }
          >
            <select
              id="ai-mic"
              value={micInfo?.deviceId ?? ''}
              disabled={switchingMic}
              onChange={(e) => void switchMic(e.target.value)}
              className={`${selectClass} disabled:opacity-50`}
            >
              {!micInfo && <option value="">(マイク未取得)</option>}
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {isLoopbackCaptureLabel(d.label)
                    ? '⚠ '
                    : plan.mic && d.deviceId === plan.mic.deviceId
                      ? '◎ '
                      : ''}
                  {d.label}
                </option>
              ))}
            </select>

            <PlanHint
              recommendedLabel={plan.mic?.label ?? null}
              matched={matchesPlan(micInfo?.deviceId ?? null, plan.mic)}
              onApply={() => applyPlanTarget('mic')}
              disabled={switchingMic}
            />
          </Field>

          <Field
            htmlFor="ai-sink"
            label="② ChatGPT への送出先"
            hint="こちらの声を送る側。ChatGPT の「入力デバイス」に指定した仮想デバイスの再生側を選びます。"
            help={
              <>
                例: <Code>Voicemeeter Input</Code> / <Code>CABLE-B Input</Code>
                <br />
                設定すると、あなたと相手の声だけをアプリ内でミックスして ChatGPT
                の耳へ届けます（AI 自身の声は構造的に混ざりません）。
              </>
            }
          >
            <select
              id="ai-sink"
              value={config.sinkDeviceId ?? ''}
              disabled={probeBusy}
              onChange={(e) => {
                const d = outputs.find((x) => x.deviceId === e.target.value);
                set({
                  sinkDeviceId: e.target.value || null,
                  sinkDeviceLabel: d?.label,
                });
              }}
              className={selectClass}
            >
              <option value="">使用しない (外部でルーティング済み)</option>
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {optionPrefix(d, plan.sink)}
                  {d.label}
                </option>
              ))}
            </select>

            <PlanHint
              recommendedLabel={plan.sink?.label ?? '使用しない'}
              matched={matchesPlan(config.sinkDeviceId, plan.sink)}
              onApply={() => applyPlanTarget('sink')}
              disabled={probeBusy}
            />
          </Field>

          <div className="mb-5 space-y-2.5 rounded-lg border border-stone-800 bg-stone-950/40 p-3">
            <p className="text-xs text-stone-400">
              二重送出・二重再生を避けるための設定です。
              <strong className="font-medium text-stone-300">
                1つ目は収録前チェックが自動で設定します
              </strong>
              。
            </p>

            <CheckLine
              checked={config.sendLocalMic === false}
              onChange={(v) => set({ sendLocalMic: !v })}
              title="あなたの声は VoiceMeeter 側で常時 ChatGPT に送っている"
              sub="アプリからは送らない"
              help="物理マイクを VoiceMeeter のハードウェア入力から B1 へ流している構成でオンにします。アプリを起動していなくても他の通話アプリが普通にマイクを使えます。オフにすると、あなたの声が ChatGPT に二重に届きます。"
            />

            <CheckLine
              checked={config.monitorAiLocally === false}
              onChange={(v) => set({ monitorAiLocally: !v })}
              title="ChatGPT の声は Windows 側で常時モニタしている"
              sub="アプリからは再生しない"
              help="録音タブで AI 音声ソースの「このデバイスを聴く」を有効にしている場合にオンにします。アプリを起動していなくても ChatGPT の声が聞こえるため、ChatGPT を普段どおり単体で使えます。オフにすると二重に聞こえます。"
            >
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={
                    listenTestPlaying ||
                    !config.sourceDeviceId ||
                    enabled ||
                    isRecording ||
                    probeBusy
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
                  className="rounded-lg bg-stone-700 px-2.5 py-1 text-xs font-medium text-stone-200 hover:bg-stone-600 disabled:opacity-40"
                >
                  {listenTestPlaying ? '♪ 再生中…' : '♪ 試聴テスト (2秒)'}
                </button>
                <span className="text-xs text-stone-400">
                  {enabled
                    ? 'AI を OFF にすると使えます'
                    : '音が聞こえたらオンにしてください'}
                </span>
              </div>
            </CheckLine>
          </div>
          <Field htmlFor="ai-name" label="表示名" hint="ステージの名札に出る名前です。">
            <input
              id="ai-name"
              type="text"
              value={nameDraft}
              maxLength={32}
              onFocus={() => {
                nameEditingRef.current = true;
              }}
              onCompositionStart={() => {
                nameEditingRef.current = true;
              }}
              onChange={(e) => {
                setNameDraft(e.target.value);
                set({ displayName: e.target.value });
              }}
              onCompositionEnd={(e) => {
                const v = e.currentTarget.value;
                setNameDraft(v);
                set({ displayName: v });
              }}
              onBlur={(e) => {
                nameEditingRef.current = false;
                // state ではなく DOM の値を読む。直前の入力が反映される前に
                // blur が来ると、state 経由では1つ古い値を掴む
                const v = e.currentTarget.value.trim().slice(0, 32) || DEFAULT_AI_CONFIG.displayName;
                setNameDraft(v);
                if (v !== config.displayName) set({ displayName: v });
              }}
              className={selectClass}
            />
          </Field>

          <SectionTitle step={2}>動作を確認する</SectionTitle>

          <div className="mb-4">
            <AiPreflightPanel
              inputs={inputs}
              outputs={outputs}
              sourceDeviceId={config.sourceDeviceId}
              sinkDeviceId={config.sinkDeviceId}
              micLabel={micInfo?.label ?? null}
              mixerRunning={mixerDiag?.contextState === 'running'}
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

          {enabled && monitorDeviceId && (
            <div className="mb-4 rounded-xl border border-stone-700 bg-stone-800/60 p-3">
              <Meter
                label="送出モニタ (あなたの声が ChatGPT に届いているか)"
                level={sendLevel}
                color="bg-sky-500"
                status={
                  sendActive
                    ? { text: '● 届いています', tone: 'ok' }
                    : { text: '○ 無音', tone: 'idle' }
                }
              />
              {inputMixerError && (
                <Alert tone="error">送出経路を開けませんでした: {inputMixerError}</Alert>
              )}
              {mixerDiag?.blockedMicLabel && (
                <Alert tone="error">
                  通話マイクが録音デバイス「{mixerDiag.blockedMicLabel}」になっています。
                  これは再生音をそのまま録るもので、あなたの声は入らず AI の声が ChatGPT
                  へ戻ってハウリングします。安全のため送出を止めました。Windows
                  の既定の録音デバイスを
                  <strong className="font-medium">物理マイク（マイク配列など）</strong>
                  に変更してください。
                </Alert>
              )}
              {mixerDiag && (
                <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-stone-400">音声処理</dt>
                  <dd
                    className={
                      mixerDiag.contextState === 'running' ? 'text-emerald-400' : 'text-red-300'
                    }
                  >
                    {mixerDiag.contextState}
                  </dd>
                  <dt className="text-stone-400">あなたのマイク</dt>
                  <dd
                    className={
                      mixerDiag.localMic
                        ? 'text-stone-200'
                        : config.sendLocalMic === false
                          ? 'text-stone-400'
                          : 'text-red-300'
                    }
                  >
                    {mixerDiag.localMic?.label ||
                      (config.sendLocalMic === false
                        ? 'VoiceMeeter が送信中 (アプリからは送らない)'
                        : '未接続')}
                  </dd>
                  <dt className="text-stone-400">相手の声</dt>
                  <dd
                    className={`tabular-nums ${
                      mixerDiag.remoteCount > 0 ? 'text-emerald-400' : 'text-stone-400'
                    }`}
                  >
                    {mixerDiag.remoteCount}人
                  </dd>
                </dl>
              )}
            </div>
          )}

          <div className="mb-4 rounded-xl border border-stone-700 bg-stone-800/60 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-stone-200">自己ループ検査</span>
              <button
                onClick={() => void runLoopCheck()}
                disabled={
                  loopCheck.state === 'running' || !config.sinkDeviceId || isRecording || probeBusy
                }
                className="shrink-0 rounded-lg bg-stone-700 px-3 py-1 text-xs font-medium text-stone-200 hover:bg-stone-600 disabled:opacity-40"
              >
                {loopCheck.state === 'running'
                  ? `検査中… ${loopCheck.secondsLeft}s`
                  : '検査を実行'}
              </button>
            </div>
            <p className="text-pretty text-xs leading-relaxed text-stone-300">
              上の「すべて確認」に同じ検査が自動で含まれます。個別に確かめたいときだけ使ってください。
            </p>
            <Help>
              ChatGPT に話させながら実行してください。AI の声が ChatGPT
              の耳（送出先）に漏れていないことを確認します。検査中はこちらの声の送出を
              自動的に止めます（8秒間 ChatGPT には届きません）。
            </Help>

            {loopCheck.state === 'passed' && (
              <p className="mt-2 text-xs text-emerald-400">✔ 合格: 自己ループはありません</p>
            )}
            {loopCheck.state === 'failed' && (
              <p className="mt-2 text-pretty text-xs leading-relaxed text-red-300">
                ✘ {loopCheck.reason}
              </p>
            )}
            {loopCheck.state === 'unavailable' && (
              <div className="mt-2 text-xs text-amber-200">
                <p className="text-pretty leading-relaxed">△ {loopCheck.reason}</p>
                <CheckLine
                  checked={manualConfirm}
                  onChange={(v) => {
                    setManualConfirm(v);
                    setVerifiedFp(v ? aiWiringFingerprint(configRef.current) : null);
                  }}
                  title="ChatGPT の声が ChatGPT 自身の入力に戻らないことを手動で確認しました"
                  tone="warn"
                />
              </div>
            )}
            {!config.sinkDeviceId && (
              <div className="mt-2">
                <CheckLine
                  checked={manualConfirm}
                  onChange={(v) => {
                    setManualConfirm(v);
                    setVerifiedFp(v ? aiWiringFingerprint(configRef.current) : null);
                  }}
                  title="外部ルーティングで ChatGPT の声が ChatGPT 自身の入力に戻らないことを確認しました"
                  tone="warn"
                />
              </div>
            )}
          </div>

          <SectionTitle>参考</SectionTitle>

          <details className="mt-3 rounded-xl border border-stone-800 bg-stone-950/40 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-stone-300">
              この画面について（4点）
            </summary>
            <ul className="mt-2 space-y-1.5 text-pretty text-xs leading-relaxed text-stone-300">
              <li>
                AI タイルは
                <strong className="font-medium text-stone-300">
                  この画面を再読み込みした参加者にのみ
                </strong>
                表示されます。有効化の前に、参加中のメンバーへページの再読み込みを依頼してください。
              </li>
              <li>録画開始前に有効化してください（録画中の有効化はできません）。</li>
              <li>ヘッドホン必須（スピーカー使用はエコーの原因になります）。</li>
              <li>
                一度有効化すると
                <strong className="font-medium text-stone-300">この配線を記憶</strong>
                し、次回からはダッシュボードの「🤖 ChatGPTつきで収録モードへ」でワンクリック起動できます。
                デバイスを変更すると記憶は破棄され、再びこの画面での確認が必要になります。
              </li>
            </ul>
          </details>

          <a
            href="/help/ai-participant"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-xs font-medium text-amber-400 underline-offset-4 hover:underline"
          >
            設定に迷ったら — セットアップ手順を開く
          </a>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-stone-800 px-5 py-3">
          {!enabled && enableBlockReason && (
            <span className="text-pretty text-xs leading-relaxed text-amber-300">
              {enableBlockReason}
            </span>
          )}
          {enabled ? (
            <button
              onClick={() => onChangeEnabled(false)}
              className="shrink-0 rounded-lg bg-stone-700 px-4 py-2 text-sm font-medium text-stone-200 hover:bg-stone-600"
            >
              AI 参加者を無効にする
            </button>
          ) : (
            <button
              onClick={() => void handleEnable()}
              disabled={!canEnable}
              className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              AI 参加者を有効にする
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/* ── 画面の部品 ──────────────────────────────────────────
 * この設定画面は「1画面に情報が多すぎて操作対象が埋もれる」のが最大の問題だった。
 * 部品を切り出して、①ラベルと本文の階層を作る ②長い説明は既定で畳む
 * ③本文を 11px から Tailwind 既定の text-xs へ戻す、の3点で読めるようにする。
 */

const selectClass =
  'w-full rounded-lg border border-stone-600 bg-stone-800 px-2.5 py-2 text-sm text-stone-100';

/** 選択肢の先頭に付ける印。◎ = この構成での推奨、★ = 仮想ケーブル系の候補 */
function optionPrefix(d: DeviceOption, recommended: DeviceOption | null): string {
  if (recommended && d.deviceId === recommended.deviceId) return '◎ ';
  return d.recommended ? '★ ' : '';
}

/**
 * 各選択欄の直下に「推奨はこれ」を出す。
 * 一致していれば静かに ✓ だけ、違っていれば名指し＋ワンクリック修正。
 */
function PlanHint({
  recommendedLabel,
  matched,
  onApply,
  disabled,
}: {
  recommendedLabel: string | null;
  matched: boolean;
  onApply: () => void;
  disabled?: boolean;
}) {
  if (!recommendedLabel) return null;
  if (matched) return <p className="mt-1.5 text-xs text-emerald-400">✓ 推奨どおりです</p>;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-amber-300">
        推奨: <code className="rounded bg-stone-800 px-1.5 py-0.5">{recommendedLabel}</code>
      </span>
      <button
        type="button"
        onClick={onApply}
        disabled={disabled}
        className="rounded border border-amber-700 px-2 py-0.5 font-medium text-amber-200 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-40"
      >
        これにする
      </button>
    </div>
  );
}

function SectionTitle({ step, children }: { step?: number; children: React.ReactNode }) {
  return (
    <h3 className="mb-3 mt-6 flex items-baseline gap-2 text-sm font-semibold text-stone-200 first:mt-0">
      {step != null && (
        <span className="tabular-nums text-xs font-bold text-amber-500">{step}</span>
      )}
      {children}
    </h3>
  );
}

function Field({
  htmlFor,
  label,
  hint,
  help,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-stone-200">
        {label}
      </label>
      {hint && (
        <p className="mb-1.5 mt-0.5 text-pretty text-xs leading-relaxed text-stone-300">{hint}</p>
      )}
      {children}
      {help && <Help>{help}</Help>}
    </div>
  );
}

/** 既定では畳んでおく補足。読まなくても操作できる情報はここへ入れる */
function Help({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-300">
        詳しく
      </summary>
      <div className="mt-1.5 text-pretty text-xs leading-relaxed text-stone-300">{children}</div>
    </details>
  );
}

function Alert({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }) {
  return (
    <p
      className={`mt-2 rounded-lg border px-3 py-2 text-pretty text-xs leading-relaxed ${
        tone === 'error'
          ? 'border-red-900/60 bg-red-950/40 text-red-200'
          : 'border-amber-900/60 bg-amber-950/40 text-amber-200'
      }`}
    >
      ⚠ {children}
    </p>
  );
}

function Meter({
  label,
  level,
  color,
  status,
}: {
  label: string;
  level: number;
  color: string;
  status: { text: string; tone: 'ok' | 'idle' | 'warn' };
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="text-stone-400">{label}</span>
        <span
          className={
            status.tone === 'ok'
              ? 'text-emerald-400'
              : status.tone === 'warn'
                ? 'text-amber-300'
                : 'text-stone-400'
          }
        >
          {status.text}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-stone-800">
        <div
          className={`h-full rounded ${color} transition-[width] duration-100`}
          style={{ width: `${Math.round(Math.min(level, 1) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** チェックボックス1行。長い説明は「詳しく」へ畳む */
function CheckLine({
  checked,
  onChange,
  title,
  sub,
  help,
  tone,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  sub?: string;
  help?: string;
  tone?: 'warn';
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-amber-600"
        />
        <span className="min-w-0">
          <span
            className={`block text-pretty text-xs font-medium leading-relaxed ${
              tone === 'warn' ? 'text-amber-200' : 'text-stone-200'
            }`}
          >
            {title}
          </span>
          {sub && <span className="block text-xs text-stone-400">{sub}</span>}
        </span>
      </label>
      {help && (
        <div className="ml-6">
          <Help>{help}</Help>
        </div>
      )}
      {children && <div className="ml-6">{children}</div>}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-stone-800 px-1 py-0.5 text-stone-300">{children}</code>;
}
