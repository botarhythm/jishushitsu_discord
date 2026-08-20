'use client';

import { useCallback, useState } from 'react';
import {
  detectSignal,
  envelopeCorrelation,
  measureEnvelope,
  startToneProbe,
  findCableMonitorInput,
  findCablePlaybackForCapture,
  suggestAiSourceInput,
  suggestPhysicalMicInput,
  suggestSendSinkOutput,
  type DeviceOption,
} from '@/lib/audio-devices';
import {
  isLoopbackCaptureLabel,
  type AiParticipantConfig,
} from '@/lib/studio-participants';
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
  /** 通話マイクの deviceId (声の相関判定に使う。null なら相関判定は行わない) */
  micDeviceId: string | null;
  /** 検査から導けた設定を自動で反映する (sendLocalMic の自動判定) */
  onAutoConfig: (patch: Partial<AiParticipantConfig>) => void;
  /** 検査を実行できない理由 (録画中・他検査の実行中)。null 以外なら実行を拒否する */
  disabledReason: string | null;
  /** 音を出す・測る区間の占有を親へ通知する (検査の相互排他) */
  onBusyChange: (busy: boolean) => void;
  /**
   * skip を含まず全項目 pass のときだけ呼ばれる。
   * 引数は「検査した配線」の指紋 — 呼ばれた側は現在の配線と一致するときだけ
   * 検証済みとして扱う (検査中の配線変更で新配線を誤って検証済みにしない)
   */
  onAllPassed: (wiringFingerprint: string) => void;
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
  micDeviceId,
  setSendEnabled,
  onAutoConfig,
  disabledReason,
  onBusyChange,
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
    // UI の disabled に頼らない論理ガード。録画中のテストトーンは収録と
    // LiveKit 配信に混入するため、入口で拒否する (Codex 第2巡 #6)
    if (disabledReason) return;
    onBusyChange(true);
    setRunning(true);
    setChecks(INITIAL);
    void resumeAllAudioContexts();
    // この実行が検査する配線。完了時にこの指紋を渡し、途中で配線が変わって
    // いたら結果を無効にする (Codex 第2巡 #4)
    const wiringFp = `${sourceDeviceId ?? ''}|${sinkDeviceId ?? ''}`;
    // skip を含む「全通過」は検証済みとして扱わない (skip は pass ではない。Codex レビュー #6)
    let skipped = false;
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
        skipped = true;
        set('mixer', { status: 'skip', detail: '有効化後に確認します' });
      } else
      if (!sinkDeviceId) {
        const suggested = suggestSendSinkOutput(outputs);
        skipped = true;
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

      // 4. ChatGPT の声がアプリに届くか
      //
      // まずテストトーンで仮想ケーブルの疎通を機械判定する (ChatGPT 不要・約3秒)。
      // 疎通していれば、次に ChatGPT の実出力設定を人の操作で確認する。
      // こう分けると「ケーブルが壊れている」と「ChatGPT の出力先が違う」を
      // 別々に名指しできる (Codex レビュー #9)。
      set('receive', { status: 'running', detail: '自動: 仮想ケーブルの疎通を確認中…' });
      if (expectedChatGptOutput) {
        // トーンが「実際に鳴り始めてから」測る。開始を待たずに測ると、
        // トーンより先に計測が終わって偽陰性になる (Codex 第2巡 #1)
        const probe = startToneProbe(expectedChatGptOutput.deviceId);
        try {
          const startedResult = await probe.started;
          if (!startedResult.ok) {
            set('receive', {
              status: 'fail',
              detail: `テストトーンを出せません: ${startedResult.error ?? '不明'}`,
              fix: `再生デバイス「${expectedChatGptOutput.label}」が無効化されていないか確認してください`,
            });
            return;
          }
          const pipe = await detectSignal(sourceDeviceId, 3000, 0.02, onProbe);
          if (pipe.error) {
            set('receive', {
              status: 'fail',
              detail: `AI 音声ソースを開けません: ${pipe.error}`,
              fix: '① のデバイスが他のアプリに占有されていないか確認してください',
            });
            return;
          }
          if (!pipe.detected) {
            set('receive', {
              status: 'fail',
              detail: 'テストトーンが AI 音声ソースに届きません',
              fix: '仮想ケーブル自体が疎通していません。PC を再起動するか、VB-CABLE を再インストールしてください',
            });
            return;
          }
        } finally {
          probe.stop();
        }
      }
      setPrompt('ChatGPT にテキストで「何か話して」と打ち込んでください（検出した時点で次へ進みます）');
      const recv = await detectSignal(sourceDeviceId, 15000, 0.015, onProbe);
      setPrompt(null);
      if (!recv.detected) {
        set('receive', {
          status: 'fail',
          detail: recv.error ?? '信号を検出できません（ケーブル自体は疎通しています）',
          fix: expectedChatGptOutput
            ? `音量ミキサーで ChatGPT の「出力デバイス」を「${expectedChatGptOutput.label}」にしてください`
            : 'ChatGPT の出力を、AI 音声ソースと対になる仮想ケーブルの再生側に設定してください',
        });
        return;
      }
      set('receive', { status: 'pass' });

      // 5・6. 送出先が設定されている場合のみ
      if (!sinkDeviceId) {
        skipped = true;
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

        // 5. あなたの声が ChatGPT へ届くか + 送出経路の自動判定
        //
        // まずアプリからの送出を止めた状態で話してもらい、監視入力と物理マイクの
        // 音量包絡線の相関を取る。相関が高ければ「本人の声が VoiceMeeter 経由で
        // 届いている」と確定でき、sendLocalMic を自動で OFF にする。
        // 音の有無 (RMS 閾値) だけでは ChatGPT の返答・他人の声・環境音と
        // 区別できないため、相関が取れないときは設定を自動変更しない
        // (Codex 第2巡 #7)。
        set('send', { status: 'running' });
        setSendEnabled(false);
        setPrompt('声の経路を判定します。8秒ほど話し続けてください（静かな場所で）');
        const micEnvP = micDeviceId ? measureEnvelope(micDeviceId, 8000) : Promise.resolve(null);
        const monEnvA = await measureEnvelope(monitor.deviceId, 8000, onProbe);
        const micEnvA = await micEnvP;
        if (monEnvA.error) {
          setPrompt(null);
          set('send', {
            status: 'fail',
            detail: `監視入力を開けません: ${monEnvA.error}`,
            fix: 'Windows のサウンド設定で監視入力が無効化されていないか確認してください',
          });
          return;
        }
        const reachedExternal = monEnvA.peak >= 0.015;
        const corrExternal =
          reachedExternal && micEnvA && !micEnvA.error
            ? envelopeCorrelation(micEnvA.env, monEnvA.env)
            : 0;
        if (reachedExternal && corrExternal >= 0.5) {
          onAutoConfig({ sendLocalMic: false });
          setPrompt(null);
          set('send', {
            status: 'pass',
            detail: `VoiceMeeter 経由で届いています (相関 ${corrExternal.toFixed(2)}。アプリからの送出は自動で OFF にしました)`,
          });
        } else if (reachedExternal) {
          // 音はあるが本人の声と確認できない。設定は変えず、判定不能として続行
          setPrompt(null);
          set('send', {
            status: 'fail',
            detail: `監視入力に音がありますが、あなたの声との相関を確認できません (相関 ${corrExternal.toFixed(2)})`,
            fix: 'ChatGPT や他の音源を止め、静かな環境でもう一度実行してください。設定は変更していません',
          });
          return;
        } else if (aiEnabled) {
          // 外部経路では届いていない。アプリ経由を試す。
          // 保存済み設定が sendLocalMic=false のままだとミキサーがマイクを
          // 含めず、アプリ経路が正しくても検出できない。テストの前に ON を
          // 反映させる (稼働中反映の effect が数十ms で追従する)
          onAutoConfig({ sendLocalMic: true });
          setSendEnabled(true);
          setPrompt('アプリ経由を試します。もう一度8秒ほど話し続けてください');
          const micEnvP2 = micDeviceId ? measureEnvelope(micDeviceId, 8000) : Promise.resolve(null);
          const monEnvB = await measureEnvelope(monitor.deviceId, 8000, onProbe);
          const micEnvB = await micEnvP2;
          setPrompt(null);
          const reachedApp = monEnvB.peak >= 0.015;
          const corrApp =
            reachedApp && micEnvB && !micEnvB.error
              ? envelopeCorrelation(micEnvB.env, monEnvB.env)
              : 0;
          if (!reachedApp || (micEnvB && !micEnvB.error && corrApp < 0.5)) {
            set('send', {
              status: 'fail',
              detail: reachedApp
                ? `音はありますが、あなたの声と確認できません (相関 ${corrApp.toFixed(2)})`
                : '声が届いていません',
              fix: `VoiceMeeter を起動し Virtual Input の B を点灯させてください。あわせて ChatGPT の入力(既定の通信デバイス)が「${monitor.label}」になっているか確認してください`,
            });
            return;
          }
          set('send', {
            status: 'pass',
            detail: `アプリ経由で届いています (相関 ${corrApp.toFixed(2)}。アプリからの送出は自動で ON にしました)`,
          });
        } else {
          setPrompt(null);
          set('send', {
            status: 'fail',
            detail: '声が届いていません（AI が無効のためアプリ経路は試せません）',
            fix: 'VoiceMeeter の Hardware Input 1 にマイクを割り当て、B を点灯させてください',
          });
          return;
        }

        // 6. AI の声が ChatGPT の耳へ戻っていないか（全自動・約7秒）
        //
        // ChatGPT に喋らせる代わりに、AI 音声経路の入口 (CABLE Input 等) へ
        // テストトーンを流し、送出先の監視入力で観測されないことを確認する。
        // 物理マイクは常時 B1 に流れているため「無音」は判定に使えない —
        // 基準値との差分で判定する。利用者の操作は「静かにしている」だけ。
        set('loop', { status: 'running', detail: '自動検査中…' });
        setSendEnabled(false);
        setPrompt('自己ループを自動検査します。7秒ほどお静かに…');
        const baseline = await detectSignal(monitor.deviceId, 2000, 999, onProbe);
        if (baseline.error) {
          setPrompt(null);
          set('loop', {
            status: 'fail',
            detail: `監視入力を開けません: ${baseline.error}`,
            fix: 'Windows のサウンド設定で監視入力が無効化されていないか確認してください',
          });
          return;
        }
        let during = { detected: false, peak: 0 } as Awaited<ReturnType<typeof detectSignal>>;
        if (expectedChatGptOutput) {
          const probe = startToneProbe(expectedChatGptOutput.deviceId);
          try {
            const startedResult = await probe.started;
            if (!startedResult.ok) {
              // トーンを出せないまま「漏れ無し」を出すと、鳴っていないだけの
              // 偽合格になる (Codex 第2巡 #1)。判定不能として止める
              setPrompt(null);
              set('loop', {
                status: 'fail',
                detail: `テストトーンを出せません: ${startedResult.error ?? '不明'}`,
                fix: '検査を続行できません。もう一度実行してください',
              });
              return;
            }
            during = await detectSignal(monitor.deviceId, 4500, 999, onProbe);
          } finally {
            probe.stop();
          }
          if (during.error) {
            setPrompt(null);
            set('loop', {
              status: 'fail',
              detail: `監視入力を開けません: ${during.error}`,
              fix: 'Windows のサウンド設定で監視入力が無効化されていないか確認してください',
            });
            return;
          }
        } else {
          // 対の再生側が見つからない環境では従来どおり ChatGPT に喋らせて測る
          setPrompt('ChatGPT に話させてください。あなたは黙っていてください');
          during = await detectSignal(monitor.deviceId, 8000, 999, onProbe);
        }
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

      if (!skipped) onAllPassed(wiringFp);
    } finally {
      setSendEnabled(true);
      setPrompt(null);
      setRunning(false);
      onBusyChange(false);
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
    micDeviceId,
    setSendEnabled,
    onAutoConfig,
    disabledReason,
    onBusyChange,
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
          disabled={running || !!disabledReason}
          title={disabledReason ?? undefined}
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
