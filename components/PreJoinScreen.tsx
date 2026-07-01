'use client';

import { useState } from 'react';

export interface PreJoinChoice {
  micOn: boolean;
  cameraOn: boolean;
}

interface PreJoinScreenProps {
  participantName: string;
  onJoin: (choice: PreJoinChoice) => void;
}

// 44バイトヘッダのみ (data長0) の無音WAV。参加ボタンのユーザー操作内で一度再生しておくと、
// ブラウザの自動再生ポリシーが解除され、入室後にリモート参加者の音声が自動再生できるようになる。
// これが無いと、特にマイク/カメラOFF (自分がメディアをキャプチャしていない) の参加で
// 「映像は出るが音声が聞こえない」状態になる (Android Chrome / iOS Safari 共通)。
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * 入室前のワンタップ画面。
 * - 「参加する」タップで音声の自動再生ロックを解除する (SILENT_WAV を参照)。
 * - マイク/カメラの初期ON/OFFをここで選べるようにし、「オフで視聴だけ参加」を正式にサポートする
 *   (従来は権限拒否でしかオフにできず、エラー扱いになっていた)。
 */
export function PreJoinScreen({ participantName, onJoin }: PreJoinScreenProps) {
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [joining, setJoining] = useState(false);

  const handleJoin = () => {
    setJoining(true);
    // 自動再生ロックの解除。失敗しても入室は続行 (入室後の StartAudioBanner が保険になる)。
    try {
      const audio = new Audio(SILENT_WAV);
      const p = audio.play();
      if (p) p.then(() => audio.pause()).catch(() => {});
    } catch {
      // ignore
    }
    onJoin({ micOn, cameraOn });
  };

  return (
    <div className="min-h-dvh bg-gradient-to-br from-stone-50 via-green-50 to-amber-50 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-stone-900 font-noto-sans-jp mb-1">
            自習室に参加
          </h1>
          <p className="text-sm text-stone-500 font-noto-sans-jp">
            {participantName} として参加します
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg p-6 md:p-8">
          <p className="text-sm text-stone-700 font-noto-sans-jp mb-5 leading-relaxed">
            マイクとカメラの初期状態を選んで参加してください。
            <br />
            <span className="text-xs text-stone-500">参加後もいつでも切り替えられます。</span>
          </p>

          <div className="space-y-3 mb-6">
            <DeviceToggle
              label="マイク"
              onIcon="🎤"
              offIcon="🔇"
              enabled={micOn}
              onToggle={() => setMicOn((v) => !v)}
            />
            <DeviceToggle
              label="カメラ"
              onIcon="📷"
              offIcon="📵"
              enabled={cameraOn}
              onToggle={() => setCameraOn((v) => !v)}
            />
          </div>

          <button
            type="button"
            onClick={handleJoin}
            disabled={joining}
            className="block w-full text-center py-3 bg-green-700 text-white font-medium rounded-lg hover:bg-green-800 active:scale-[0.98] transition font-noto-sans-jp disabled:opacity-50"
          >
            {joining ? '接続中…' : '参加する'}
          </button>

          <p className="mt-4 text-[11px] text-stone-400 font-noto-sans-jp leading-relaxed">
            マイク・カメラをオフにすると、映像・音声を送信せず視聴のみで参加できます。電車内など周囲が気になる場面でもご利用いただけます。
          </p>
        </div>
      </div>
    </div>
  );
}

function DeviceToggle({
  label,
  onIcon,
  offIcon,
  enabled,
  onToggle,
}: {
  label: string;
  onIcon: string;
  offIcon: string;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      className={`flex w-full items-center justify-between rounded-lg border px-4 py-3 transition-colors ${
        enabled
          ? 'border-green-300 bg-green-50 text-stone-800'
          : 'border-stone-300 bg-stone-100 text-stone-500'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium font-noto-sans-jp">
        <span className="text-lg">{enabled ? onIcon : offIcon}</span>
        {label}
      </span>
      <span
        className={`text-xs font-bold ${enabled ? 'text-green-700' : 'text-stone-400'}`}
      >
        {enabled ? 'ON' : 'OFF'}
      </span>
    </button>
  );
}
