'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordingQuality } from '@/hooks/useLocalRecording';
import {
  STUDIO_LAYOUT_LABELS,
  STUDIO_LAYOUT_SLOTS,
  type StudioLayout,
} from './StudioStage';

export interface StudioParticipantOption {
  identity: string;
  name: string;
}

interface StudioBarProps {
  isMicOn: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isLocalRecording: boolean;
  recordingQuality: RecordingQuality;
  layout: StudioLayout;
  slotIdentities: (string | null)[];
  participantOptions: StudioParticipantOption[];
  showNameplates: boolean;
  showAudience: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleLocalRecording: () => void;
  onChangeRecordingQuality: (q: RecordingQuality) => void;
  onChangeLayout: (l: StudioLayout) => void;
  onChangeSlot: (index: number, identity: string | null) => void;
  onToggleNameplates: () => void;
  onToggleAudience: () => void;
  onExitStudio: () => void;
  onEndSession?: () => void;
}

/**
 * 収録モード用の自動格納コントロールバー。
 * - マウス移動で出現し、無操作 3 秒でフェードアウト。
 * - バー上にポインタがある間は維持。
 * - 録画フレーム下端のレターボックス領域に重なるが、フェード中は透明なので映り込まない。
 */
export function StudioBar(props: StudioBarProps) {
  const {
    isMicOn,
    isCameraOn,
    isScreenSharing,
    isLocalRecording,
    recordingQuality,
    layout,
    slotIdentities,
    participantOptions,
    showNameplates,
    showAudience,
    onToggleMic,
    onToggleCamera,
    onToggleScreenShare,
    onToggleLocalRecording,
    onChangeRecordingQuality,
    onChangeLayout,
    onChangeSlot,
    onToggleNameplates,
    onToggleAudience,
    onExitStudio,
    onEndSession,
  } = props;

  const [visible, setVisible] = useState(true);
  const hoveringRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!hoveringRef.current) setVisible(false);
    }, 3000);
  }, []);

  useEffect(() => {
    const onMove = () => {
      setVisible(true);
      scheduleHide();
    };
    window.addEventListener('mousemove', onMove);
    scheduleHide();
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [scheduleHide]);

  const slotCount = STUDIO_LAYOUT_SLOTS[layout];

  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      onMouseEnter={() => {
        hoveringRef.current = true;
        setVisible(true);
      }}
      onMouseLeave={() => {
        hoveringRef.current = false;
        scheduleHide();
      }}
    >
      <div className="flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl border border-stone-700/70 bg-stone-900/85 px-3 py-2 shadow-2xl backdrop-blur-md">
        {/* メディア制御 */}
        <BarButton active={isMicOn} label={isMicOn ? 'マイクON' : 'マイクOFF'} onClick={onToggleMic}>
          {isMicOn ? '🎤' : '🔇'}
        </BarButton>
        <BarButton active={isCameraOn} label={isCameraOn ? 'カメラON' : 'カメラOFF'} onClick={onToggleCamera}>
          {isCameraOn ? '📹' : '🚫'}
        </BarButton>
        <BarButton active={isScreenSharing} label="画面共有" onClick={onToggleScreenShare}>
          🖥️
        </BarButton>

        <Divider />

        {/* 録画 */}
        <BarButton
          active={isLocalRecording}
          danger={isLocalRecording}
          label={isLocalRecording ? '録画停止' : '録画開始'}
          onClick={onToggleLocalRecording}
        >
          {isLocalRecording ? '⏹️' : '🎥'}
        </BarButton>
        <select
          value={recordingQuality}
          onChange={(e) => onChangeRecordingQuality(e.target.value as RecordingQuality)}
          disabled={isLocalRecording}
          className="rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-xs text-stone-200 disabled:opacity-50"
          aria-label="録画品質"
          title="録画開始前に品質を選択"
        >
          <option value="streaming">配信向け 720p</option>
          <option value="standard">標準 1080p</option>
          <option value="high">高画質</option>
        </select>

        <Divider />

        {/* レイアウト */}
        <select
          value={layout}
          onChange={(e) => onChangeLayout(e.target.value as StudioLayout)}
          className="rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-xs text-stone-200"
          aria-label="レイアウト"
          title="収録レイアウト"
        >
          {(Object.keys(STUDIO_LAYOUT_LABELS) as StudioLayout[]).map((l) => (
            <option key={l} value={l}>
              {STUDIO_LAYOUT_LABELS[l]}
            </option>
          ))}
        </select>

        {/* 出演者スロット割当（speaker レイアウトは主役/サブのラベル表示） */}
        {Array.from({ length: slotCount }).map((_, i) => {
          const slotName =
            layout === 'speaker'
              ? (['主役(ゲスト)', 'サブ1', 'サブ2'][i] ?? `枠${i + 1}`)
              : `出演者${i + 1}`;
          return (
            <select
              key={i}
              value={slotIdentities[i] ?? ''}
              onChange={(e) => onChangeSlot(i, e.target.value || null)}
              className="max-w-[9rem] rounded-lg border border-stone-600 bg-stone-800 px-2 py-1.5 text-xs text-stone-200"
              aria-label={slotName}
              title={slotName}
            >
              <option value="">{slotName}: 未割当</option>
              {participantOptions.map((p) => (
                <option key={p.identity} value={p.identity}>
                  {p.name}
                </option>
              ))}
            </select>
          );
        })}

        <BarButton active={showNameplates} label="名前表示" onClick={onToggleNameplates}>
          🏷️
        </BarButton>
        <BarButton active={showAudience} label="視聴者を下段に表示" onClick={onToggleAudience}>
          👥
        </BarButton>

        <Divider />

        {/* 退出系 */}
        <button
          onClick={onExitStudio}
          className="rounded-lg bg-stone-700 px-3 py-2 text-xs font-medium text-stone-200 hover:bg-stone-600"
        >
          収録モード終了
        </button>
        {onEndSession && (
          <button
            onClick={onEndSession}
            className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500"
          >
            セッション終了
          </button>
        )}
      </div>
    </div>
  );
}

function BarButton({
  children,
  label,
  onClick,
  active = false,
  danger = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-10 min-w-[2.5rem] items-center justify-center rounded-lg px-2 text-base transition-colors ${
        danger
          ? 'bg-amber-600 text-white animate-pulse'
          : active
            ? 'bg-stone-700 text-white'
            : 'bg-stone-800 text-stone-400 hover:bg-stone-700 hover:text-stone-200'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px flex-shrink-0 bg-stone-700" aria-hidden />;
}
