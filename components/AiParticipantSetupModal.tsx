'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import {
  AI_AVATAR_PRESETS,
  aiWiringFingerprint,
  type AiParticipantConfig,
} from '@/lib/studio-participants';
import type { AiProviderStatus } from '@/lib/ai/provider';
import { RmsSpeakingDetector } from '@/lib/ai/speaking-detector';
import { resumeAllAudioContexts } from '@/lib/audio-runtime';

interface AiParticipantSetupModalProps {
  room: Room | null;
  config: AiParticipantConfig;
  onChangeConfig: (config: AiParticipantConfig) => void;
  enabled: boolean;
  onChangeEnabled: (enabled: boolean) => void;
  aiStatus: AiProviderStatus;
  publishFailed: boolean;
  onReconnect: () => void;
  /** 録画中は有効化を許可しない（録画開始前に有効化しないとタブ音声二重化が起きるため） */
  isRecording: boolean;
  onClose: () => void;
}

interface DeviceOption {
  deviceId: string;
  groupId: string;
  label: string;
  recommended: boolean;
}

function isVirtualCableLabel(label: string): boolean {
  return /cable|vb-audio|virtual|voicemeeter|blackhole|loopback/i.test(label);
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 仮想ケーブルの「送出先 (playback)」に対応する「監視入力 (capture)」を特定する。
 *
 * 仮想ケーブルは Input(再生側)/Output(録音側) が対になっており、ラベルは
 * 例: "CABLE-B Input (VB-Audio Cable B)" ⇔ "CABLE-B Output (VB-Audio Cable B)"。
 * groupId は環境により共有されないことがあるため、ラベル対応を第一候補にする。
 */
function findCableMonitorInput(sink: DeviceOption, inputs: DeviceOption[]): DeviceOption | null {
  const expected = normalizeLabel(sink.label.replace(/\bInput\b/i, 'Output'));
  if (expected !== normalizeLabel(sink.label)) {
    const byLabel = inputs.find((d) => normalizeLabel(d.label) === expected);
    if (byLabel) return byLabel;
  }
  const byGroup = inputs.find((d) => d.groupId && d.groupId === sink.groupId);
  return byGroup ?? null;
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
  onChangeConfig,
  enabled,
  onChangeEnabled,
  aiStatus,
  publishFailed,
  onReconnect,
  isRecording,
  onClose,
}: AiParticipantSetupModalProps) {
  const [inputs, setInputs] = useState<DeviceOption[]>([]);
  const [outputs, setOutputs] = useState<DeviceOption[]>([]);
  const [previewLevel, setPreviewLevel] = useState(0);
  const [previewActive, setPreviewActive] = useState(false);
  const [previewSuspended, setPreviewSuspended] = useState(false);
  const [loopCheck, setLoopCheck] = useState<
    | { state: 'idle' }
    | { state: 'running'; secondsLeft: number }
    | { state: 'passed' }
    | { state: 'failed'; reason: string }
    | { state: 'unavailable'; reason: string }
  >({ state: 'idle' });
  const [manualConfirm, setManualConfirm] = useState(false);

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
      }
    })();
    return () => {
      cancelled = true;
      detector?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [config.sourceDeviceId]);

  // ── 物理マイク誤選択（二重取り込み）の検知 ──
  const micCollision = useMemo(() => {
    if (!room || !config.sourceDeviceId || config.sourceDeviceId === 'fake') return false;
    const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
      ?.mediaStreamTrack;
    if (!micTrack) return false;
    const settings = micTrack.getSettings();
    if (settings.deviceId && settings.deviceId === config.sourceDeviceId) return true;
    // 同一物理デバイスの別エンドポイントも groupId で検知する
    const selected = inputs.find((d) => d.deviceId === config.sourceDeviceId);
    if (settings.groupId && selected?.groupId && settings.groupId === selected.groupId) return true;
    return false;
  }, [room, config.sourceDeviceId, inputs]);

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
    let stream: MediaStream | null = null;
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
      } else {
        setLoopCheck({ state: 'passed' });
      }
    } catch (e) {
      console.warn('[AiSetup] ループ検査失敗', e);
      setLoopCheck({ state: 'unavailable', reason: '監視入力を開けませんでした' });
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  }, [inputs, outputs, config.sinkDeviceId, config.sourceDeviceId]);

  const loopSafe =
    !config.sinkDeviceId || loopCheck.state === 'passed' || manualConfirm;
  const canEnable =
    !!config.sourceDeviceId && loopSafe && !micCollision && !isRecording;

  const set = (patch: Partial<AiParticipantConfig>) => {
    const wiringChanged = 'sourceDeviceId' in patch || 'sinkDeviceId' in patch;
    onChangeConfig({
      ...config,
      ...patch,
      // 配線が変わったら検証済みフラグを落とす（次回もセットアップ必須に戻す）
      ...(wiringChanged ? { validatedFingerprint: null } : {}),
    });
    if (wiringChanged) {
      setLoopCheck({ state: 'idle' });
      setManualConfirm(false);
    }
  };

  /** 有効化。このとき現在の配線を「検証済み」として記録し、次回以降のワンクリック起動を許可する */
  const handleEnable = () => {
    void resumeAllAudioContexts();
    const validated = { ...config, validatedFingerprint: aiWiringFingerprint(config) };
    onChangeConfig(validated);
    onChangeEnabled(true);
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

        {/* 表示名・アバター */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <label className="block text-xs text-stone-400">
            表示名
            <input
              type="text"
              value={config.displayName}
              maxLength={32}
              onChange={(e) => set({ displayName: e.target.value })}
              className="mt-1 w-full rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-sm text-stone-100"
            />
          </label>
          <div className="block text-xs text-stone-400">
            アバター
            <div className="mt-1 flex gap-1">
              {AI_AVATAR_PRESETS.map((a) => (
                <button
                  key={a}
                  onClick={() => set({ avatar: a })}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-lg ${
                    config.avatar === a
                      ? 'bg-amber-600/60 ring-1 ring-amber-400'
                      : 'bg-stone-800 hover:bg-stone-700'
                  }`}
                  aria-label={`アバター ${a}`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 音声ソース選択 */}
        <label className="mb-1 block text-xs text-stone-400">
          AI 音声ソース (ChatGPT の出力が流れる仮想デバイス。例: CABLE-A Output)
        </label>
        <select
          value={config.sourceDeviceId ?? ''}
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
            ⚠ 選択中のデバイスは通話マイクと同一です。あなたの声が二重に録音されます。
            仮想ケーブル (CABLE Output 等) を選択してください。
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
        </div>

        {/* ChatGPT への送出先 */}
        <label className="mb-1 block text-xs text-stone-400">
          ChatGPT への送出先 (ChatGPT の入力に設定した仮想デバイス。例: CABLE-B Input) — 任意
        </label>
        <select
          value={config.sinkDeviceId ?? ''}
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

        {/* プリフライト */}
        <div className="mb-4 rounded-xl border border-stone-700 bg-stone-800/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-stone-300">
              プリフライト: 自己ループ検査
            </span>
            <button
              onClick={() => void runLoopCheck()}
              disabled={loopCheck.state === 'running' || !config.sinkDeviceId}
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
            この検査中はまだ ChatGPT にあなたの声は届きません。ChatGPT
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
                  onChange={(e) => setManualConfirm(e.target.checked)}
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
                onChange={(e) => setManualConfirm(e.target.checked)}
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
          {isRecording && !enabled && (
            <span className="text-xs text-amber-300">録画中は有効化できません</span>
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
              onClick={handleEnable}
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
