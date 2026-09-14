import {
  findCableMonitorInput,
  findCablePlaybackForCapture,
  normalizeLabel,
  suggestAiSourceInput,
  suggestPhysicalMicInput,
  suggestSendSinkOutput,
  type DeviceOption,
} from '@/lib/audio-devices';
import type { AiParticipantConfig } from '@/lib/studio-participants';

/**
 * この PC で「どこに何を設定すべきか」を、**現在の選択とは無関係に**
 * 接続されているデバイスだけから決める。
 *
 * 従来は現在の選択から逆算していたが、それだと選択が間違っているときに
 * 間違った OS 設定を案内してしまう（例: 送出先に CABLE Input を選んでいると
 * 「録音の既定の通信デバイスは CABLE Output」という誤った指示が出る）。
 * 設定を始める前に正解を提示するのが目的なので、入力は列挙結果のみに限る。
 */

export type WiringMode = 'voicemeeter' | 'dual-cable' | 'single-cable' | 'unknown';

export interface WiringPlan {
  mode: WiringMode;
  /** 「この PC の構成」として画面に出す短い名前 */
  modeLabel: string;
  /** ① AI 音声ソース（ChatGPT の声が出てくる録音側） */
  source: DeviceOption | null;
  /** 通話マイク（物理マイク） */
  mic: DeviceOption | null;
  /** ② ChatGPT への送出先。簡易構成では null（＝「使用しない」が正解） */
  sink: DeviceOption | null;
  /** 音量ミキサー → ChatGPT の「出力デバイス」に指定すべき再生デバイス */
  chatgptOutput: DeviceOption | null;
  /** mmsys.cpl → 録音タブ →「既定の通信デバイス」に指定すべき録音デバイス */
  chatgptInput: DeviceOption | null;
}

const MODE_LABEL: Record<WiringMode, string> = {
  voicemeeter: 'VoiceMeeter + VB-CABLE（推奨構成）',
  'dual-cable': 'VB-CABLE 2本',
  'single-cable': 'VB-CABLE 1本（簡易構成・相手の声は ChatGPT に届きません）',
  unknown: '仮想ケーブルが見つかりません',
};

export function buildWiringPlan(inputs: DeviceOption[], outputs: DeviceOption[]): WiringPlan {
  const source = suggestAiSourceInput(inputs);
  const mic = suggestPhysicalMicInput(inputs);

  // ChatGPT の声の出口は、AI 音声ソース（録音側）と対になる再生側で決まる
  const chatgptOutput = source ? findCablePlaybackForCapture(source, outputs) : null;

  const hasVoicemeeterSink = outputs.some((d) =>
    normalizeLabel(d.label).startsWith('voicemeeter input')
  );

  let mode: WiringMode;
  let sink: DeviceOption | null;

  if (hasVoicemeeterSink) {
    // VoiceMeeter があるなら 2本目の道はそれ。CABLE は ChatGPT の声専用に空ける
    sink = suggestSendSinkOutput(outputs);
    mode = 'voicemeeter';
  } else {
    // ChatGPT の声が通るケーブルとは別のケーブルを探す。
    // 同じケーブルの裏表（CABLE Output ⇔ CABLE Input）を送出先に選ぶと、
    // ChatGPT の声がそのまま ChatGPT の耳へ戻る自己ループになる。
    sink =
      outputs.find(
        (d) =>
          d.recommended &&
          d.deviceId !== chatgptOutput?.deviceId &&
          !normalizeLabel(d.label).includes('16ch')
      ) ?? null;
    mode = sink ? 'dual-cable' : 'single-cable';
  }

  if (!source) {
    mode = 'unknown';
    sink = null;
  }

  // 簡易構成では ChatGPT はこちらの物理マイクを直接聞く
  const chatgptInput = sink ? findCableMonitorInput(sink, inputs) : mode === 'unknown' ? null : mic;

  return {
    mode,
    modeLabel: MODE_LABEL[mode],
    source,
    mic,
    sink,
    chatgptOutput,
    chatgptInput,
  };
}

/** 現在の選択が推奨と一致しているか。null 同士（＝「使用しない」）も一致とみなす */
export function matchesPlan(currentId: string | null, planned: DeviceOption | null): boolean {
  return (currentId ?? null) === (planned?.deviceId ?? null);
}

/**
 * 推奨構成に合わせるための設定差分（アプリ内で持つ設定のみ。通話マイクは含まない）。
 * 既に一致している項目は含めないので、空なら変更不要。
 *
 * VoiceMeeter 推奨構成は「物理マイクは VoiceMeeter から常時 ChatGPT へ」
 * 「ChatGPT の声は CABLE Output の『このデバイスを聴く』で常時モニタ」が前提なので、
 * sendLocalMic と monitorAiLocally をどちらも false にする。monitorAiLocally が
 * true のままだと、Windows のモニタとアプリの再生で ChatGPT の声が二重になる。
 *
 * 仮想ケーブルが見つからない (mode=unknown) ときは空を返す。デバイス名を読む権限が
 * 無いだけでも unknown になるため、ここで送出先を null に書き換えると設定を壊す。
 */
export function recommendedConfigPatch(
  plan: WiringPlan,
  config: AiParticipantConfig
): Partial<AiParticipantConfig> {
  if (plan.mode === 'unknown') return {};
  const patch: Partial<AiParticipantConfig> = {};
  if (plan.source && !matchesPlan(config.sourceDeviceId, plan.source)) {
    patch.sourceDeviceId = plan.source.deviceId;
    patch.sourceDeviceLabel = plan.source.label;
  }
  if (!matchesPlan(config.sinkDeviceId, plan.sink)) {
    patch.sinkDeviceId = plan.sink?.deviceId ?? null;
    patch.sinkDeviceLabel = plan.sink?.label;
  }
  const plannedSendLocalMic = plan.mode !== 'voicemeeter';
  if ((config.sendLocalMic !== false) !== plannedSendLocalMic) {
    patch.sendLocalMic = plannedSendLocalMic;
  }
  if (plan.mode === 'voicemeeter' && config.monitorAiLocally !== false) {
    patch.monitorAiLocally = false;
  }
  return patch;
}

/** 差分が配線（検証記録の指紋）に触れるか。触れるなら検証記録を失効させる */
export function patchTouchesAiWiring(patch: Partial<AiParticipantConfig>): boolean {
  return 'sourceDeviceId' in patch || 'sinkDeviceId' in patch || 'sendLocalMic' in patch;
}

/** 推奨の通話マイクへ切り替える必要があるか */
export function needsPlannedMicSwitch(plan: WiringPlan, activeMicId: string | null): boolean {
  return plan.mode !== 'unknown' && !!plan.mic && plan.mic.deviceId !== activeMicId;
}
