'use client';

import { useCallback, useState } from 'react';
import {
  detectSignal,
  findCableMonitorInput,
  findCablePlaybackForCapture,
  suggestAiSourceInput,
  suggestPhysicalMicInput,
  suggestSendSinkOutput,
  type DeviceOption,
} from '@/lib/audio-devices';
import { isLoopbackCaptureLabel } from '@/lib/studio-participants';
import { resumeAllAudioContexts } from '@/lib/audio-runtime';

type CheckId = 'source' | 'mic' | 'mixer' | 'receive' | 'send' | 'loop';

interface CheckResult {
  status: 'idle' | 'running' | 'pass' | 'fail' | 'skip';
  detail?: string;
  fix?: string;
}

const CHECK_LABELS: Record<CheckId, string> = {
  source: 'AI 音声ソースを開ける',
  mic: '通話マイクが物理マイク',
  mixer: '送出経路が動作している',
  receive: 'ChatGPT の声がアプリに届く',
  send: 'あなたの声が ChatGPT に届く',
  loop: 'AI の声が ChatGPT に戻っていない',
};

const INITIAL: Record<CheckId, CheckResult> = {
  source: { status: 'idle' },
  mic: { status: 'idle' },
  mixer: { status: 'idle' },
  receive: { status: 'idle' },
  send: { status: 'idle' },
  loop: { status: 'idle' },
};

interface Props {
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  sourceDeviceId: string | null;
  sinkDeviceId: string | null;
  micLabel: string | null;
  mixerRunning: boolean;
  mixerHasMic: boolean;
  /** AI 参加者が有効か。無効時は送出経路が動いていないので該当項目を飛ばす */
  aiEnabled: boolean;
  setSendEnabled: (on: boolean) => void;
  onAllPassed: () => void;
}

/**
 * 収録前チェック。
 *
 * 経路が複数の OS 設定に依存しており、どれか1つ崩れると無音かハウリングになる。
 * 壊れる頻度自体はアプリ側から下げられないため、**崩れた箇所を数十秒で名指しできる**
 * ことを狙う。実機検証では原因特定に数時間かかっており、そこがこの機能の解決対象。
 */
export function AiPreflightPanel({
  inputs,
  outputs,
  sourceDeviceId,
  sinkDeviceId,
  micLabel,
  mixerRunning,
  mixerHasMic,
  aiEnabled,
  setSendEnabled,
  onAllPassed,
}: Props) {
  const [checks, setChecks] = useState<Record<CheckId, CheckResult>>(INITIAL);
  const [running, setRunning] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [probeLevel, setProbeLevel] = useState(0);
  const [probeLeft, setProbeLeft] = useState(0);
  const onProbe = (level: number, remainingMs: number) => {
    setProbeLevel(level);
    setProbeLeft(Math.ceil(remainingMs / 1000));
  };

  const set = (id: CheckId, r: CheckResult) =>
    setChecks((prev) => ({ ...prev, [id]: r }));

  const run = useCallback(async () => {
    const srcDev = inputs.find((d) => d.deviceId === sourceDeviceId) ?? null;
    const expectedChatGptOutput = srcDev ? findCablePlaybackForCapture(srcDev, outputs) : null;
    setRunning(true);
    setChecks(INITIAL);
    void resumeAllAudioContexts();
    try {
      // 1. AI 音声ソースを開けるか
      set('source', { status: 'running' });
      if (!sourceDeviceId) {
        const suggested = suggestAiSourceInput(inputs);
        set('source', {
          status: 'fail',
          detail: '未選択',
          fix: suggested
            ? `① で「${suggested.label}」を選んでください`
            : '① で AI 音声ソースを選んでください（ChatGPT の出力先に指定した仮想ケーブルの録音側）',
        });
        return;
      }
      const src = inputs.find((d) => d.deviceId === sourceDeviceId);
      if (!src) {
        set('source', {
          status: 'fail',
          detail: 'デバイスが見つかりません',
          fix: '仮想ケーブルが無効化されています。Windows のサウンド設定で有効に戻してください',
        });
        return;
      }
      set('source', { status: 'pass', detail: src.label });

      // 2. 通話マイクが物理マイクか
      set('mic', { status: 'running' });
      if (!micLabel) {
        set('mic', {
          status: 'fail',
          detail: '未取得',
          fix: suggestPhysicalMicInput(inputs)
            ? `通話マイクに「${suggestPhysicalMicInput(inputs)!.label}」を選び直してください（マイクが OFF になっていませんか）`
            : '通話マイクを選び直してください（マイクが OFF になっていませんか）',
        });
        return;
      }
      if (isLoopbackCaptureLabel(micLabel)) {
        set('mic', {
          status: 'fail',
          detail: micLabel,
          fix: suggestPhysicalMicInput(inputs)
            ? `録音デバイスが選ばれています。「${suggestPhysicalMicInput(inputs)!.label}」に変更してください`
            : '録音デバイスが選ばれています。物理マイク（マイク配列など）に変更してください',
        });
        return;
      }
      set('mic', { status: 'pass', detail: micLabel });

      // 3. 送出経路が動作しているか
      set('mixer', { status: 'running' });
      if (!aiEnabled) {
        // 送出経路は AI 参加者を有効にしてから起動する。無効のまま必須にすると
        // 「有効化にはチェック通過が必要 / チェック通過には有効化が必要」で詰む。
        set('mixer', { status: 'skip', detail: '有効化後に確認します' });
      } else
      if (!sinkDeviceId) {
        const suggested = suggestSendSinkOutput(outputs);
        set('mixer', {
          status: 'skip',
          detail: suggested ? `送出先が未設定（② で「${suggested.label}」）` : '送出先が未設定',
        });
      } else if (!mixerRunning || !mixerHasMic) {
        set('mixer', {
          status: 'fail',
          detail: !mixerRunning ? '音声処理が停止しています' : 'マイクが接続されていません',
          fix: '画面を一度クリックしてから、通話マイクを選び直してください',
        });
        return;
      } else {
        set('mixer', { status: 'pass' });
      }

      // 4. ChatGPT の声がアプリに届くか（ユーザー操作が要る）
      set('receive', { status: 'running' });
      setPrompt('ChatGPT にテキストで「何か話して」と打ち込んでください（検出した時点で次へ進みます）');
      const recv = await detectSignal(sourceDeviceId, 15000, 0.015, onProbe);
      setPrompt(null);
      if (!recv.detected) {
        set('receive', {
          status: 'fail',
          detail: recv.error ?? '信号を検出できません',
          fix: expectedChatGptOutput
            ? `音量ミキサーで ChatGPT の「出力デバイス」を「${expectedChatGptOutput.label}」にしてください`
            : 'ChatGPT の出力を、AI 音声ソースと対になる仮想ケーブルの再生側に設定してください',
        });
        return;
      }
      set('receive', { status: 'pass' });

      // 5・6. 送出先が設定されている場合のみ
      if (!sinkDeviceId) {
        set('send', { status: 'skip', detail: '送出先が未設定' });
        set('loop', { status: 'skip', detail: '送出先が未設定' });
      } else {
        const sink = outputs.find((d) => d.deviceId === sinkDeviceId);
        const monitor = sink ? findCableMonitorInput(sink, inputs) : null;
        if (!monitor) {
          set('send', {
            status: 'fail',
            detail: '監視入力を特定できません',
            fix: suggestSendSinkOutput(outputs)
              ? `② の送出先に「${suggestSendSinkOutput(outputs)!.label}」を選んでください`
              : '送出先の選択を確認してください',
          });
          return;
        }

        if (!aiEnabled) {
          set('send', { status: 'skip', detail: '有効化後に確認します' });
        } else {
        // 5. あなたの声が ChatGPT へ届くか
        set('send', { status: 'running' });
        setPrompt('声が届いているか測ります。何か話してください（検出した時点で次へ進みます）');
        const sent = await detectSignal(monitor.deviceId, 15000, 0.015, onProbe);
        setPrompt(null);
        if (!sent.detected) {
          set('send', {
            status: 'fail',
            detail: '声が届いていません',
            fix: `VoiceMeeter を起動し Virtual Input の B を点灯させてください。あわせて ChatGPT の入力(既定の通信デバイス)が「${monitor.label}」になっているか確認してください`,
          });
          return;
        }
        set('send', { status: 'pass' });
        }

        // 6. AI の声が送出先に漏れていないか
        //
        // 物理マイクを VoiceMeeter 側で常時 B1 へ流す構成では、送出先は
        // 常にマイクの環境音を含む。「無音であること」は判定に使えないので、
        // 「AI が喋ったときだけレベルが上がるか」の差分で判定する。
        set('loop', { status: 'running' });
        if (aiEnabled) setSendEnabled(false);
        setPrompt('まず3秒間、誰も喋らないでください（基準値を測ります）');
        // しきい値を実質無限にして早期打ち切りを止め、区間のピークだけを測る
        const baseline = await detectSignal(monitor.deviceId, 3000, 999, onProbe);
        setPrompt('ChatGPT に話させてください。あなたは黙っていてください');
        const during = await detectSignal(monitor.deviceId, 8000, 999, onProbe);
        setSendEnabled(true);
        setPrompt(null);
        // 環境音の3倍かつ有意な大きさになったら「AI の声が回り込んでいる」と判定
        const leaked = during.peak > Math.max(baseline.peak * 3, 0.02);
        if (leaked) {
          set('loop', {
            status: 'fail',
            detail: `AI発話中にレベルが上昇 (基準 ${baseline.peak.toFixed(3)} → ${during.peak.toFixed(3)})`,
            fix: 'ヘッドホンの音量を下げてください。スピーカーを使っている場合はヘッドホンに変えてください（AI の声がマイクに回り込んでいます）',
          });
          return;
        }
        set('loop', { status: 'pass', detail: `基準 ${baseline.peak.toFixed(3)} / AI発話中 ${during.peak.toFixed(3)}` });
      }

      onAllPassed();
    } finally {
      setSendEnabled(true);
      setPrompt(null);
      setRunning(false);
    }
  }, [
    inputs,
    outputs,
    sourceDeviceId,
    sinkDeviceId,
    micLabel,
    mixerRunning,
    mixerHasMic,
    aiEnabled,
    setSendEnabled,
    onAllPassed,
  ]);

  const icon = (s: CheckResult['status']) =>
    s === 'pass' ? '✔' : s === 'fail' ? '✘' : s === 'running' ? '…' : s === 'skip' ? '−' : '○';

  const color = (s: CheckResult['status']) =>
    s === 'pass'
      ? 'text-emerald-400'
      : s === 'fail'
        ? 'text-red-300'
        : s === 'running'
          ? 'text-amber-300'
          : 'text-stone-500';

  return (
    <div className="rounded-xl border border-stone-700 bg-stone-800/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-stone-300">収録前チェック</span>
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-lg bg-stone-700 px-3 py-1 text-xs text-stone-200 hover:bg-stone-600 disabled:opacity-40"
        >
          {running ? '確認中…' : 'すべて確認'}
        </button>
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-stone-500">
        経路のどこが崩れているかを順に確認します。失敗した項目に対処法を表示します。
      </p>

      <ul className="space-y-1">
        {(Object.keys(CHECK_LABELS) as CheckId[]).map((id) => {
          const c = checks[id];
          return (
            <li key={id} className="text-[11px] leading-relaxed">
              <span className={color(c.status)}>
                {icon(c.status)} {CHECK_LABELS[id]}
                {c.detail ? `: ${c.detail}` : ''}
              </span>
              {c.status === 'fail' && c.fix && <p className="ml-4 text-red-200">→ {c.fix}</p>}
            </li>
          );
        })}
      </ul>

      {prompt && (
        <p className="mt-2 rounded-lg bg-amber-900/40 px-3 py-2 text-xs text-amber-100">
          {prompt}
        </p>
      )}

      {running && prompt && (
        <div className="mt-1">
          <div className="mb-1 flex items-center justify-between text-[11px] text-stone-400">
            <span>検出レベル</span>
            <span>残り {probeLeft} 秒</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-stone-800">
            <div
              className="h-full rounded bg-emerald-500 transition-[width] duration-100"
              style={{ width: `${Math.round(Math.min(probeLevel * 4, 1) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
