'use client';

import {
  findCableMonitorInput,
  findCablePlaybackForCapture,
  type DeviceOption,
} from '@/lib/audio-devices';

interface Props {
  inputs: DeviceOption[];
  outputs: DeviceOption[];
  sourceDeviceId: string | null;
  sinkDeviceId: string | null;
}

/**
 * 「どこで何を選べばよいか」をデバイス名まで具体的に示す早見表。
 *
 * この構成は OS 側の設定に依存しており、しかも ChatGPT の再起動などで外れる。
 * 「確認してください」と書くだけでは利用者が何を選ぶべきか分からないため、
 * 現在の選択から導ける**正解のデバイス名**をそのまま画面に出す。
 */
export function AiRequiredSettings({ inputs, outputs, sourceDeviceId, sinkDeviceId }: Props) {
  const source = inputs.find((d) => d.deviceId === sourceDeviceId) ?? null;
  const sink = outputs.find((d) => d.deviceId === sinkDeviceId) ?? null;

  // ChatGPT の出力先 = AI 音声ソース(録音側)と対になる再生側
  const chatgptOutput = source ? findCablePlaybackForCapture(source, outputs) : null;
  // ChatGPT の入力元 = 送出先(再生側)と対になる録音側
  const chatgptInput = sink ? findCableMonitorInput(sink, inputs) : null;

  const rows: { where: string; what: string; value: string | null; note?: string }[] = [
    {
      where: '音量ミキサー → ChatGPT',
      what: '出力デバイス',
      value: chatgptOutput?.label ?? null,
      note: '似た名前の別デバイスに注意（CABLE In 16ch など）',
    },
    {
      where: 'mmsys.cpl → 録音タブ',
      what: '既定の通信デバイス',
      value: chatgptInput?.label ?? null,
      note: 'ChatGPT はここを「耳」として使う',
    },
  ];

  return (
    <div className="mb-3 rounded-xl border border-sky-800/60 bg-sky-950/30 p-3">
      <p className="mb-2 text-xs font-medium text-sky-200">
        Windows 側で選ぶべきデバイス
      </p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.where} className="text-[11px] leading-relaxed">
            <span className="text-stone-400">{r.where}</span>
            <span className="text-stone-500"> の </span>
            <span className="text-stone-400">{r.what}</span>
            <span className="text-stone-500"> → </span>
            {r.value ? (
              <code className="rounded bg-stone-800 px-1.5 py-0.5 text-sky-200">{r.value}</code>
            ) : (
              <span className="text-stone-500">（上の選択が済むと表示されます）</span>
            )}
            {r.note && <p className="ml-2 text-stone-500">※ {r.note}</p>}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] leading-relaxed text-stone-500">
        ChatGPT を再起動すると出力デバイスが戻ることがあります。収録前チェックが失敗したら、
        まずここの2つを見比べてください。
      </p>
    </div>
  );
}
