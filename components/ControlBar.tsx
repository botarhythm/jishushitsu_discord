'use client';

import type { RecordingQuality } from '@/hooks/useLocalRecording';

interface ControlBarProps {
  isMicOn: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  raisedHand: boolean;
  isInstructor: boolean;
  isBreakout: boolean;
  isLocalRecording: boolean;
  /** true の間は録画ボタンを無効化する (iPhone等 getDisplayMedia 非対応環境向け) */
  recordingUnsupported?: boolean;
  isAudioRecording: boolean;
  showAudioRecordingButton: boolean;
  /** 講師がメインルームに居る場合に表示するセッション終了ボタンのコールバック */
  onEndSession?: () => void;
  recordingQuality: RecordingQuality;
  onChangeRecordingQuality: (q: RecordingQuality) => void;
  isChatOpen: boolean;
  chatUnreadCount: number;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleRaiseHand: () => void;
  onToggleLocalRecording: () => void;
  onToggleAudioRecording: () => void;
  onToggleChat: () => void;
  onOpenDeviceSettings: () => void;
  onReturnToMain: () => void;
  /** 受講生用の退出ボタン */
  onLeave: () => void;
}

export function ControlBar({
  isMicOn,
  isCameraOn,
  isScreenSharing,
  raisedHand,
  isInstructor,
  isBreakout,
  isLocalRecording,
  recordingUnsupported = false,
  isAudioRecording,
  showAudioRecordingButton,
  onEndSession,
  recordingQuality,
  onChangeRecordingQuality,
  isChatOpen,
  chatUnreadCount,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRaiseHand,
  onToggleLocalRecording,
  onToggleAudioRecording,
  onToggleChat,
  onOpenDeviceSettings,
  onReturnToMain,
  onLeave,
}: ControlBarProps) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 px-4 py-3 bg-stone-800 border-t border-stone-700">
      <ControlButton
        label={isMicOn ? 'マイクOFF' : 'マイクON'}
        active={isMicOn}
        icon={isMicOn ? '🎤' : '🔇'}
        onClick={onToggleMic}
      />
      <ControlButton
        label={isCameraOn ? 'カメラOFF' : 'カメラON'}
        active={isCameraOn}
        icon={isCameraOn ? '📷' : '📵'}
        onClick={onToggleCamera}
      />
      <ControlButton
        label={isScreenSharing ? '共有停止' : '画面共有'}
        active={isScreenSharing}
        icon="🖥️"
        onClick={onToggleScreenShare}
      />

      <button
        onClick={onOpenDeviceSettings}
        className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300 transition-colors"
        aria-label="入力デバイスを選択"
      >
        <span className="text-lg">⚙️</span>
        <span>設定</span>
      </button>

      <button
        onClick={onToggleChat}
        className={`relative flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
          isChatOpen
            ? 'bg-stone-600 text-white'
            : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
        }`}
        aria-label={isChatOpen ? 'チャットを閉じる' : 'チャットを開く'}
        aria-pressed={isChatOpen}
      >
        <span className="text-lg">💬</span>
        <span>チャット</span>
        {chatUnreadCount > 0 && !isChatOpen && (
          <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {chatUnreadCount > 9 ? '9+' : chatUnreadCount}
          </span>
        )}
      </button>

      <div className="flex flex-col items-center gap-1">
        <button
          onClick={onToggleLocalRecording}
          disabled={recordingUnsupported}
          className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
            recordingUnsupported
              ? 'cursor-not-allowed bg-stone-800/50 text-stone-600'
              : isLocalRecording
                ? 'bg-amber-600 text-white shadow-lg shadow-amber-500/30 animate-pulse'
                : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
          }`}
          aria-label={
            recordingUnsupported
              ? 'お使いの端末・ブラウザは録画に対応していません'
              : isLocalRecording
                ? '録画を停止して保存'
                : 'ローカル録画を開始'
          }
          title={recordingUnsupported ? 'お使いの端末・ブラウザは録画に対応していません' : undefined}
          aria-pressed={isLocalRecording}
        >
          <span className="text-lg">{isLocalRecording ? '⏹️' : '🎥'}</span>
          <span>{isLocalRecording ? '録画停止' : '録画'}</span>
        </button>
        <select
          value={recordingQuality}
          onChange={(e) => onChangeRecordingQuality(e.target.value as RecordingQuality)}
          disabled={isLocalRecording}
          className="text-[10px] bg-stone-700 text-stone-300 rounded px-1 py-0.5 border border-stone-600 disabled:opacity-50 disabled:cursor-not-allowed"
          aria-label="録画品質"
          title="録画開始前に品質を選択"
        >
          <option value="streaming">配信向け 720p</option>
          <option value="standard">標準 1080p</option>
          <option value="high">高画質 (大容量)</option>
        </select>
      </div>

      {showAudioRecordingButton && (
        <button
          onClick={onToggleAudioRecording}
          className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
            isAudioRecording
              ? 'bg-red-600 text-white shadow-lg shadow-red-500/30 animate-pulse'
              : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
          }`}
          aria-label={isAudioRecording ? '録音を停止' : '録音を開始'}
          aria-pressed={isAudioRecording}
        >
          <span className="text-lg">{isAudioRecording ? '⏹️' : '🎙️'}</span>
          <span>{isAudioRecording ? '録音停止' : '録音'}</span>
        </button>
      )}

      {!isInstructor && !isBreakout && (
        <button
          onClick={onToggleRaiseHand}
          className={`flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium transition-all ${
            raisedHand
              ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/30'
              : 'bg-stone-700 text-stone-300 hover:bg-stone-600'
          }`}
          aria-label={raisedHand ? '挙手を取り消す' : '挙手する'}
          aria-pressed={raisedHand}
        >
          <span className="text-lg">✋</span>
          <span>{raisedHand ? '挙手中' : '挙手'}</span>
        </button>
      )}

      {isBreakout && (
        <button
          onClick={onReturnToMain}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-stone-700 text-stone-300 hover:bg-stone-600 transition-colors"
        >
          <span className="text-lg">🚪</span>
          <span>メインに戻る</span>
        </button>
      )}

      {!isInstructor && !isBreakout && (
        <button
          onClick={onLeave}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
          aria-label="自習室から退出"
        >
          <span className="text-lg">🚪</span>
          <span>退出</span>
        </button>
      )}

      {isInstructor && !isBreakout && onEndSession && (
        <button
          onClick={onEndSession}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
          aria-label="セッションを終了"
        >
          <span className="text-lg">⏹️</span>
          <span>セッション終了</span>
        </button>
      )}
    </div>
  );
}

function ControlButton({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
        active
          ? 'bg-stone-600 text-white'
          : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
      }`}
    >
      <span className="text-lg">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
