'use client';

import { useEffect } from 'react';
import { useMediaDeviceSelect } from '@livekit/components-react';

interface DeviceSettingsModalProps {
  onClose: () => void;
}

export function DeviceSettingsModal({ onClose }: DeviceSettingsModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-stone-800 border border-stone-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-700 px-5 py-3">
          <h2 className="text-base font-semibold text-stone-100">入力デバイス設定</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-stone-400 hover:bg-stone-700 hover:text-stone-200"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <DeviceSelect kind="audioinput" label="マイク" />
          <DeviceSelect kind="videoinput" label="カメラ" />
          <p className="text-xs text-stone-500 leading-relaxed">
            USB接続のカメラ・マイクが一覧に出ない場合は、ブラウザの権限ダイアログで一度許可してください。
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-stone-700 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-stone-700 px-4 py-1.5 text-sm font-medium text-stone-200 hover:bg-stone-600"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

function DeviceSelect({ kind, label }: { kind: MediaDeviceKind; label: string }) {
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    requestPermissions: true,
  });

  return (
    <label className="block">
      <span className="block text-xs font-medium text-stone-300 mb-1">{label}</span>
      <select
        value={activeDeviceId || ''}
        onChange={(e) => setActiveMediaDevice(e.target.value)}
        className="w-full rounded-lg border border-stone-600 bg-stone-900 px-3 py-2 text-sm text-stone-100 focus:border-amber-500 focus:outline-none"
      >
        {devices.length === 0 && <option value="">(デバイスなし)</option>}
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
