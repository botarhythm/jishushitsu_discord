'use client';

interface ControlBarProps {
  isMicOn: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  raisedHand: boolean;
  isInstructor: boolean;
  isBreakout: boolean;
  isLocalRecording: boolean;
  isChatOpen: boolean;
  chatUnreadCount: number;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleRaiseHand: () => void;
  onToggleLocalRecording: () => void;
  onToggleChat: () => void;
  onOpenDeviceSettings: () => void;
  onReturnToMain: () => void;
  onEndBreakout: () => void;
}

export function ControlBar({
  isMicOn,
  isCameraOn,
  isScreenSharing,
  raisedHand,
  isInstructor,
  isBreakout,
  isLocalRecording,
  isChatOpen,
  chatUnreadCount,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleRaiseHand,
  onToggleLocalRecording,
  onToggleChat,
  onOpenDeviceSettings,
  onReturnToMain,
  onEndBreakout,
}: ControlBarProps) {
  return (
    <div className="flex items-center justify-center gap-3 px-4 py-3 bg-stone-800 border-t border-stone-700">
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

      <button
        onClick={onToggleLocalRecording}
        className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
          isLocalRecording
            ? 'bg-red-600 text-white shadow-lg shadow-red-500/30 animate-pulse'
            : 'bg-stone-700 text-stone-400 hover:bg-stone-600 hover:text-stone-300'
        }`}
        aria-label={isLocalRecording ? '録画を停止して保存' : 'ローカル録画を開始'}
        aria-pressed={isLocalRecording}
      >
        <span className="text-lg">{isLocalRecording ? '⏹️' : '⏺️'}</span>
        <span>{isLocalRecording ? '録画停止' : '録画'}</span>
      </button>

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

      {isInstructor && isBreakout && (
        <button
          onClick={onEndBreakout}
          className="flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium bg-red-600 text-white hover:bg-red-500 transition-colors"
        >
          <span className="text-lg">⏹️</span>
          <span>終了してメインへ</span>
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
