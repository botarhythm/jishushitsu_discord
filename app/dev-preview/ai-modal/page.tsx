'use client';

/**
 * 設定モーダルの見た目確認用ページ（開発時のみ）。
 *
 * 手順書のスクリーンショットはここから Playwright で撮る。実機の音声デバイスに
 * 依存すると撮影のたびに人手が要るので、デバイス一覧をスタブして実物どおりの
 * 選択肢を出す。本番ビルドでは 404 になる。
 *
 * 撮影: `node scripts/capture-help-shots.mjs`（dev サーバー起動中に実行）
 */

import { useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { AiParticipantSetupModal } from '@/components/AiParticipantSetupModal';
import { DEFAULT_AI_CONFIG, type AiParticipantConfig } from '@/lib/studio-participants';

const FAKE_DEVICES: MediaDeviceInfo[] = [
  { deviceId: 'src', groupId: 'g1', kind: 'audioinput', label: 'CABLE Output (VB-Audio Virtual Cable)' },
  { deviceId: 'mic', groupId: 'g2', kind: 'audioinput', label: 'マイク配列 (Realtek(R) Audio)' },
  { deviceId: 'b1', groupId: 'g3', kind: 'audioinput', label: 'Voicemeeter Out B1 (VB-Audio Voicemeeter VAIO)' },
  { deviceId: 'sink', groupId: 'g3', kind: 'audiooutput', label: 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)' },
  { deviceId: 'cablein', groupId: 'g1', kind: 'audiooutput', label: 'CABLE Input (VB-Audio Virtual Cable)' },
  { deviceId: 'hp', groupId: 'g4', kind: 'audiooutput', label: 'ヘッドホン (soundcore P40i)' },
].map((d) => ({ ...d, toJSON: () => d }) as MediaDeviceInfo);

export default function DevPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<AiParticipantConfig>({
    ...DEFAULT_AI_CONFIG,
    sourceDeviceId: 'src',
    sourceDeviceLabel: 'CABLE Output (VB-Audio Virtual Cable)',
    sinkDeviceId: 'sink',
    sinkDeviceLabel: 'Voicemeeter Input (VB-Audio Voicemeeter VAIO)',
    sendLocalMic: false,
    monitorAiLocally: false,
  });

  const [room, setRoom] = useState<unknown>(null);

  useEffect(() => {
    // モーダルがマウントされる前にデバイス列挙と取得を差し替える。
    // getUserMedia は例外ではなく「無音の実ストリーム」を返す — 例外にすると
    // 手順書の挿絵に赤いエラーが写り込んでしまう。
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    const makeSilentStream = () => ctx.createMediaStreamDestination().stream;

    const md = navigator.mediaDevices as unknown as Record<string, unknown>;
    md.enumerateDevices = async () => FAKE_DEVICES;
    md.getUserMedia = async () => makeSilentStream();

    // 通話マイクの表示は LiveKit の Room 経由なので、最小限の形だけ用意する
    const micTrack = makeSilentStream().getAudioTracks()[0];
    Object.defineProperty(micTrack, 'label', {
      value: 'マイク配列 (Realtek(R) Audio)',
    });
    micTrack.getSettings = () => ({ deviceId: 'mic', groupId: 'g2' });
    queueMicrotask(() => {
      setRoom({
        localParticipant: {
          getTrackPublication: () => ({ track: { mediaStreamTrack: micTrack } }),
        },
      });
      setReady(true);
    });
  }, []);

  if (!ready) return <div className="h-dvh bg-stone-950" />;

  return (
    <div className="h-dvh bg-stone-950">
      <AiParticipantSetupModal
        room={room as never}
        config={config}
        onPatchConfig={async (patch) => {
          setConfig((prev) => ({ ...prev, ...patch }));
          return true;
        }}
        enabled
        onChangeEnabled={() => {}}
        aiStatus="connected"
        publishFailed={false}
        inputMixerError={null}
        setInputMixerSendEnabled={() => {}}
        setInputMixerIncludeLocalMic={() => {}}
        getInputMixerDiagnostics={() => ({
          contextState: 'running',
          localMic: null,
          blockedMicLabel: null,
          remoteCount: 0,
        })}
        onReconnect={() => {}}
        isRecording={false}
        onClose={() => {}}
      />
    </div>
  );
}
