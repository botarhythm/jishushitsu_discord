'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useParticipants,
  useLocalParticipant,
  useDataChannel,
  useChat,
} from '@livekit/components-react';
import { downloadChatHistory } from '@/lib/chat-export';
import { RoomName, UserRole, ParticipantMetadata, ROOM_LABELS } from '@/lib/types';
import InstructorDashboard from './InstructorDashboard';
import { useSessionRecorder } from '@/hooks/useSessionRecorder';
import { useEndSession } from '@/hooks/useEndSession';
import { useAutoLogout } from '@/hooks/useAutoLogout';
import { useLocalRecording } from '@/hooks/useLocalRecording';
import { EndSessionButton } from './EndSessionButton';
import { EndSessionModal } from './EndSessionModal';
import { RecordingIndicator } from './RecordingIndicator';
import { MobileHostWarning } from './MobileHostWarning';
import { InviteModal } from './InviteModal';
import { ParticipantGrid } from './ParticipantGrid';
import { BreakoutList } from './BreakoutList';
import { ControlBar } from './ControlBar';
import { PresenceToast } from './PresenceToast';
import { AutoLogoutModal } from './AutoLogoutModal';
import { ChatPanel } from './ChatPanel';
import { DeviceSettingsModal } from './DeviceSettingsModal';

interface RoomViewProps {
  token: string;
  livekitUrl: string;
  participantName: string;
  role: UserRole;
  currentRoom: RoomName;
  onRoomChange: (room: RoomName) => void;
}

export default function RoomView(props: RoomViewProps) {
  return (
    <LiveKitRoom
      token={props.token}
      serverUrl={props.livekitUrl}
      connect={true}
      audio={true}
      video={false}
      className="h-screen flex flex-col bg-stone-900"
      options={{ adaptiveStream: true, dynacast: true }}
    >
      <RoomAudioRenderer />
      <RoomInner {...props} />
    </LiveKitRoom>
  );
}

function RoomInner({
  participantName,
  role,
  currentRoom,
  onRoomChange,
}: RoomViewProps) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [raisedHand, setRaisedHand] = useState(false);
  const [focusedParticipant, setFocusedParticipant] = useState<string | null>(null);
  const isInstructor = role === 'instructor';
  const isBreakout = currentRoom !== 'main';

  // ── EchoNote 設定確認（認証は Cookie 経由） ──
  // 先に echoNoteConfigured を確定させ、未設定なら音声録音自体を行わない（UIもシンプル化される）
  const [echoNoteConfigured, setEchoNoteConfigured] = useState(false);
  useEffect(() => {
    if (!isInstructor) return;
    fetch('/api/echonote/status', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => setEchoNoteConfigured(!!d.configured))
      .catch(() => setEchoNoteConfigured(false));
  }, [isInstructor]);

  // ── セッション録音（講師 かつ EchoNote 設定済みのときのみ） ──
  const recordingEnabled = isInstructor && echoNoteConfigured;
  const {
    isRecording,
    currentRoomLabel,
    startedAt: recordingStartedAt,
    completedRecordings,
    finalizeAll,
  } = useSessionRecorder({ enabled: recordingEnabled, currentRoom });

  // ── ローカル録画（全員対象。タブを録画して WebM 保存） ──
  const {
    isRecording: isLocalRecording,
    start: startLocalRecording,
    stop: stopLocalRecording,
    error: localRecordingError,
  } = useLocalRecording({ room });

  useEffect(() => {
    if (localRecordingError) {
      console.error('[useLocalRecording] error:', localRecordingError);
    }
  }, [localRecordingError]);

  const toggleLocalRecording = useCallback(() => {
    if (isLocalRecording) {
      stopLocalRecording();
    } else {
      startLocalRecording();
    }
  }, [isLocalRecording, startLocalRecording, stopLocalRecording]);

  // 退出処理の前に必ず録画を停止＆DLするためのラッパー
  const stopRecordingRef = useRef(stopLocalRecording);
  useEffect(() => {
    stopRecordingRef.current = stopLocalRecording;
  }, [stopLocalRecording]);

  // ── チャット ──
  const chat = useChat();
  const chatMessagesRef = useRef(chat.chatMessages);
  useEffect(() => {
    chatMessagesRef.current = chat.chatMessages;
  }, [chat.chatMessages]);
  const exportChatIfAny = useCallback(() => {
    try {
      downloadChatHistory(chatMessagesRef.current);
    } catch (e) {
      console.error('[chat-export] failed', e);
    }
  }, []);

  // ── 自動退出（受講生のみ。1時間経過で確認、5分応答なしで退出） ──
  const handleAutoLogout = useCallback(() => {
    exportChatIfAny();
    stopRecordingRef
      .current()
      .catch(() => {
        // ignore — 録画停止失敗でも退出続行
      })
      .finally(() => {
        room.disconnect().finally(() => {
          window.location.href = '/api/auth/logout';
        });
      });
  }, [room, exportChatIfAny]);

  const {
    promptOpen: autoLogoutPromptOpen,
    remainingMs: autoLogoutRemainingMs,
    confirmContinue: confirmAutoLogout,
  } = useAutoLogout({
    enabled: !isInstructor,
    onTimeout: handleAutoLogout,
  });

  // ── モバイル時のダッシュボードドロワー ──
  const [dashboardOpen, setDashboardOpen] = useState(false);

  // ── チャットUI / デバイス設定UI ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false);
  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const openDeviceSettings = useCallback(() => setDeviceSettingsOpen(true), []);
  const closeDeviceSettings = useCallback(() => setDeviceSettingsOpen(false), []);

  // ── 招待モーダル ──
  const [inviteState, setInviteState] = useState<{ open: boolean; url: string }>({
    open: false,
    url: '',
  });
  const openInvite = useCallback(() => {
    setInviteState({
      open: true,
      url: `${window.location.protocol}//${window.location.host}/`,
    });
  }, []);
  const closeInvite = useCallback(() => {
    setInviteState((prev) => ({ ...prev, open: false }));
  }, []);

  // ── 終了モーダル ──
  const {
    endModalOpen,
    openEndModal,
    endModalDurationSec,
    uploading,
    uploadProgress,
    uploadResult,
    handleEndChoice,
    handleCloseEndModal,
  } = useEndSession({
    currentRoom,
    echoNoteConfigured,
    finalizeAll,
    recordingStartedAt,
    stopLocalRecording,
    onBeforeLeave: exportChatIfAny,
  });

  // Handle incoming data channel messages (room move commands & end-session)
  useDataChannel((msg) => {
    try {
      const data = JSON.parse(new TextDecoder().decode(msg.payload));
      if (data.type === 'move-to-room') {
        onRoomChange(data.payload.targetRoom as RoomName);
      } else if (data.type === 'end-session') {
        if (!isInstructor) {
          alert('講師がセッションを終了しました。退出します。');
          exportChatIfAny();
          stopRecordingRef
            .current()
            .catch(() => {
              // ignore — 録画停止失敗でも退出
            })
            .finally(() => {
              room.disconnect().finally(() => {
                window.location.href = '/api/auth/logout';
              });
            });
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  const toggleMic = useCallback(async () => {
    await localParticipant.setMicrophoneEnabled(!isMicOn);
    setIsMicOn(!isMicOn);
  }, [localParticipant, isMicOn]);

  const toggleCamera = useCallback(async () => {
    await localParticipant.setCameraEnabled(!isCameraOn);
    setIsCameraOn(!isCameraOn);
  }, [localParticipant, isCameraOn]);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (isScreenSharing) {
        await localParticipant.setScreenShareEnabled(false);
      } else {
        await localParticipant.setScreenShareEnabled(true);
      }
      setIsScreenSharing(!isScreenSharing);
    } catch {
      setIsScreenSharing(false);
    }
  }, [localParticipant, isScreenSharing]);

  const toggleRaiseHand = useCallback(async () => {
    const newState = !raisedHand;
    const metadata: ParticipantMetadata = {
      raisedHand: newState,
      raisedAt: newState ? new Date().toISOString() : null,
    };
    await localParticipant.setMetadata(JSON.stringify(metadata));
    setRaisedHand(newState);
  }, [localParticipant, raisedHand]);

  const returnToMain = useCallback(() => {
    onRoomChange('main');
  }, [onRoomChange]);

  const handleEndBreakout = useCallback(async () => {
    const encoder = new TextEncoder();
    const message = JSON.stringify({ type: 'move-to-room', payload: { targetRoom: 'main' } });
    await room.localParticipant.publishData(encoder.encode(message), {
      reliable: true,
    });
    onRoomChange('main');
  }, [room, onRoomChange]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-stone-800 border-b border-stone-700">
          <div className="flex items-center gap-3">
            <span className="text-stone-300 text-sm font-medium">{ROOM_LABELS[currentRoom]}</span>
            {isBreakout && (
              <span className="text-xs bg-amber-600 text-white px-2 py-0.5 rounded-full">
                ブレイクアウト中
              </span>
            )}
            <RecordingIndicator
              isRecording={isRecording}
              startedAt={recordingStartedAt}
              roomLabel={currentRoomLabel ? ROOM_LABELS[currentRoomLabel] : undefined}
              completedCount={completedRecordings.length}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-stone-400 text-sm hidden sm:inline">{participantName}</span>
            {/* モバイル時のみ: ダッシュボード開閉ボタン（講師のみ） */}
            {isInstructor && (
              <button
                onClick={() => setDashboardOpen(true)}
                className="md:hidden inline-flex items-center gap-1 rounded-lg border border-stone-600 bg-stone-700 px-2.5 py-1.5 text-xs font-medium text-stone-200 hover:bg-stone-600 active:scale-95"
                aria-label="ダッシュボードを開く"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                ダッシュボード
              </button>
            )}
            {/* 招待ボタン（講師のみ） */}
            {isInstructor && (
              <button
                onClick={openInvite}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-600/60 bg-amber-700/30 px-2.5 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-700/50 active:scale-95"
                aria-label="受講生を招待"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <span className="hidden sm:inline">招待</span>
              </button>
            )}
          </div>
        </div>

        {/* Participant grid */}
        <div className="flex-1 overflow-auto p-3 relative">
          <ParticipantGrid
            focused={focusedParticipant}
            onFocus={setFocusedParticipant}
            instructorContext={
              isInstructor
                ? {
                    currentRoom,
                    selfIdentity: localParticipant.identity,
                  }
                : undefined
            }
          />
          {isInstructor && !isBreakout && (
            <EndSessionButton onClick={openEndModal} />
          )}
        </div>

        {/* Breakout list (main room only) */}
        {!isBreakout && <BreakoutList onJoin={onRoomChange} />}

        {/* Control bar */}
        <ControlBar
          isMicOn={isMicOn}
          isCameraOn={isCameraOn}
          isScreenSharing={isScreenSharing}
          raisedHand={raisedHand}
          isInstructor={isInstructor}
          isBreakout={isBreakout}
          isLocalRecording={isLocalRecording}
          isChatOpen={chatOpen}
          chatUnreadCount={chatUnread}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleRaiseHand={toggleRaiseHand}
          onToggleLocalRecording={toggleLocalRecording}
          onToggleChat={toggleChat}
          onOpenDeviceSettings={openDeviceSettings}
          onReturnToMain={returnToMain}
          onEndBreakout={handleEndBreakout}
        />
      </div>

      {/* Chat panel (全員) */}
      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        onUnreadChange={setChatUnread}
        chatMessages={chat.chatMessages}
        send={chat.send}
        isSending={chat.isSending}
      />

      {/* Device settings modal */}
      {deviceSettingsOpen && (
        <DeviceSettingsModal onClose={closeDeviceSettings} />
      )}

      {/* Instructor dashboard (instructor only) */}
      {isInstructor && (
        <InstructorDashboard
          participants={participants}
          currentRoom={currentRoom}
          instructorName={participantName}
          onMoveParticipant={onRoomChange}
          drawerOpen={dashboardOpen}
          onCloseDrawer={() => setDashboardOpen(false)}
        />
      )}

      {/* モバイルホスト向け警告（モバイル時のみ自動表示） */}
      <MobileHostWarning isInstructor={isInstructor} />

      {/* 入退室トースト通知 */}
      <PresenceToast />

      {/* 招待モーダル（講師のみ） */}
      {isInstructor && inviteState.open && (
        <InviteModal
          participantUrl={inviteState.url}
          onClose={closeInvite}
        />
      )}

      {/* 自動退出確認モーダル（受講生のみ） */}
      {autoLogoutPromptOpen && (
        <AutoLogoutModal
          remainingMs={autoLogoutRemainingMs}
          onContinue={confirmAutoLogout}
        />
      )}

      {/* End session modal (instructor only) */}
      {isInstructor && endModalOpen && (
        <EndSessionModal
          isRecording={isRecording}
          echoNoteConfigured={echoNoteConfigured}
          uploading={uploading}
          uploadProgress={uploadProgress}
          uploadResult={uploadResult}
          completedSummaries={completedRecordings.map((r) => ({
            roomLabel: ROOM_LABELS[r.room],
            durationSec: Math.floor(r.durationMs / 1000),
          }))}
          activeRoomLabel={currentRoomLabel ? ROOM_LABELS[currentRoomLabel] : undefined}
          activeDurationSec={endModalDurationSec}
          onChoose={handleEndChoice}
          onClose={handleCloseEndModal}
        />
      )}
    </div>
  );
}
