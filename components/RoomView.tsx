'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useRoomContext,
  useParticipants,
  useLocalParticipant,
  useDataChannel,
  useChat,
  useTracks,
  isTrackReference,
} from '@livekit/components-react';
import { Track, RoomEvent } from 'livekit-client';
import { downloadChatHistory } from '@/lib/chat-export';
import { RoomName, UserRole, ParticipantMetadata, ROOM_LABELS, mergeParticipantMetadata } from '@/lib/types';
import InstructorDashboard from './InstructorDashboard';
import { useSessionRecorder } from '@/hooks/useSessionRecorder';
import { useChunkUpload } from '@/hooks/useChunkUpload';
import { useRoomsStatus } from '@/hooks/useRoomsStatus';
import { useEndSession } from '@/hooks/useEndSession';
import { useAutoLogout } from '@/hooks/useAutoLogout';
import { useLocalRecording, type RecordingQuality } from '@/hooks/useLocalRecording';
import { EndSessionModal } from './EndSessionModal';
import { RecordingIndicator } from './RecordingIndicator';
import { RecordingToast } from './RecordingToast';
import { MobileHostWarning } from './MobileHostWarning';
import { InviteModal } from './InviteModal';
import { ParticipantGrid } from './ParticipantGrid';
import { BreakoutList } from './BreakoutList';
import { ControlBar } from './ControlBar';
import { StudioStage, type StudioLayout, STUDIO_LAYOUT_SLOTS } from './StudioStage';
import { StudioBar } from './StudioBar';
import { AutoLogoutModal } from './AutoLogoutModal';
import { ChatPanel } from './ChatPanel';
import { DeviceSettingsModal } from './DeviceSettingsModal';

type InitialRec = 'off' | 'audio' | 'screen' | 'both';

interface RoomViewProps {
  token: string;
  livekitUrl: string;
  participantName: string;
  role: UserRole;
  /** 招待リンク参加のゲストか (true ならブレイクアウト一覧を非表示) */
  isGuest?: boolean;
  currentRoom: RoomName;
  /** 入室直後に自動 ON にする録音/録画 (招待トークン由来) */
  initialRec?: InitialRec;
  onRoomChange: (room: RoomName) => void;
}

export default function RoomView(props: RoomViewProps) {
  return (
    <LiveKitRoom
      key={props.currentRoom}
      token={props.token}
      serverUrl={props.livekitUrl}
      connect={true}
      audio={true}
      video={true}
      className="h-dvh flex flex-col bg-stone-900"
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
  isGuest = false,
  currentRoom,
  initialRec = 'off',
  onRoomChange,
}: RoomViewProps) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();

  // ルーム内に画面共有が存在するか (収録モードの自動レイアウト切替に使用)
  const screenShareTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const screenShareActive = screenShareTracks.some((t) => isTrackReference(t));
  const { roomsStatus } = useRoomsStatus();
  const [isMicOn, setIsMicOn] = useState(true);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [raisedHand, setRaisedHand] = useState(false);
  const [focusedParticipant, setFocusedParticipant] = useState<string | null>(null);
  const isInstructor = role === 'instructor';
  const isBreakout = currentRoom !== 'main';

  // ── EchoNote 設定確認 (アップロード先 API が利用可能か) ──
  const [echoNoteConfigured, setEchoNoteConfigured] = useState(false);
  useEffect(() => {
    if (!isInstructor) return;
    fetch('/api/echonote/status', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => setEchoNoteConfigured(!!d.configured))
      .catch(() => setEchoNoteConfigured(false));
  }, [isInstructor]);

  // ── 録音 (LiveKit 音声 mix → EchoNote 送信用) のユーザ制御 ──
  // initialRec に audio / both が含まれていれば入室時に自動 ON。以降はボタンで切替。
  const [audioRecordingOn, setAudioRecordingOn] = useState<boolean>(
    isInstructor && (initialRec === 'audio' || initialRec === 'both')
  );
  const recordingEnabled = isInstructor && audioRecordingOn;
  // チャンク逐次アップロードのオーケストレーション（30分ごと／ルーム移動／終了時に送信）
  const chunkUpload = useChunkUpload({ echoNoteConfigured });
  const {
    isRecording,
    currentRoomLabel,
    startedAt: recordingStartedAt,
    completedRecordings,
    finalize,
  } = useSessionRecorder({
    enabled: recordingEnabled,
    currentRoom,
    onChunkReady: chunkUpload.handleChunkReady,
  });
  const toggleAudioRecording = useCallback(() => {
    setAudioRecordingOn((v) => !v);
  }, []);

  // ── ローカル録画（全員対象。タブを録画して WebM 保存） ──
  const [recordingQuality, setRecordingQuality] = useState<RecordingQuality>('streaming');
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
      startLocalRecording(recordingQuality);
    }
  }, [isLocalRecording, startLocalRecording, stopLocalRecording, recordingQuality]);

  // initialRec に screen / both が指定されていれば入室時に 1 回だけ録画開始を試みる
  // (getDisplayMedia の権限ダイアログは出る — ブラウザのユーザジェスチャ要件は許可される)
  const autoScreenAttempted = useRef(false);
  useEffect(() => {
    if (autoScreenAttempted.current) return;
    if (initialRec !== 'screen' && initialRec !== 'both') return;
    autoScreenAttempted.current = true;
    startLocalRecording(recordingQuality).catch(() => {
      // 拒否されても無視 — ボタンから手動開始できる
    });
  }, [initialRec, startLocalRecording, recordingQuality]);

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

  // ── 収録モード（講師ローカルのUIのみ切替。録画は自タブキャプチャなので同期不要） ──
  const [studioMode, setStudioMode] = useState(false);
  const [studioLayout, setStudioLayout] = useState<StudioLayout>('split');
  const [studioSlots, setStudioSlots] = useState<(string | null)[]>([null, null]);
  const [showNameplates, setShowNameplates] = useState(true);
  // Region Capture のクロップ対象 (収録ステージ 16:9)。録画をこの矩形に固定する。
  const studioStageRef = useRef<HTMLDivElement>(null);

  // ホストから配信される収録コンポジション (受信側=非ホスト参加者が強制表示する)。
  const [remoteStudio, setRemoteStudio] = useState<{
    layout: StudioLayout;
    slots: (string | null)[];
    showNameplates: boolean;
  } | null>(null);

  const participantOptions = useMemo(
    () =>
      participants.map((p) => ({
        identity: p.identity,
        name: p.name?.trim() || p.identity,
      })),
    [participants]
  );

  const instructorIdentities = useMemo(
    () =>
      participants
        .filter((p) => {
          try {
            return (JSON.parse(p.metadata ?? '{}') as ParticipantMetadata & { role?: string }).role === 'instructor';
          } catch {
            return false;
          }
        })
        .map((p) => p.identity),
    [participants]
  );

  const enterStudio = useCallback(() => {
    // 空きスロットを「自分 → 他の講師」の順で自動補完。既存割当は尊重。
    const selfId = localParticipant.identity;
    const ordered = [selfId, ...instructorIdentities.filter((id) => id !== selfId)];
    setStudioSlots((prev) => {
      const next = [...prev];
      for (let i = 0; i < 2; i++) if (!next[i]) next[i] = ordered[i] ?? null;
      return next;
    });
    setStudioMode(true);
  }, [instructorIdentities, localParticipant.identity]);

  const changeStudioSlot = useCallback((index: number, identity: string | null) => {
    setStudioSlots((prev) => {
      const next = [...prev];
      next[index] = identity;
      return next;
    });
  }, []);

  // 収録モードに入った経緯が「ダッシュボードの録画ボタン」かどうか。
  // true の場合、録画停止でダッシュボード(通常画面)へ自動的に戻す。
  const studioViaRecordRef = useRef(false);

  // ダッシュボード(通常画面)の録画ボタン: 収録レイアウト(16:9)へ切替えてからクロップ録画開始。
  // getDisplayMedia はユーザジェスチャ内で同期的に呼ぶ必要があるため、enterStudio() 直後に
  // 同期呼び出しし、crop 対象はステージのマウント完了後 (getDisplayMedia 解決後) に関数で評価する。
  const startStudioRecording = useCallback(() => {
    studioViaRecordRef.current = true;
    enterStudio();
    startLocalRecording(recordingQuality, () => studioStageRef.current);
  }, [enterStudio, startLocalRecording, recordingQuality]);

  // ダッシュボードの録画ボタンのトグル (講師用)。
  const handleDashboardRecord = useCallback(() => {
    if (isLocalRecording) {
      stopLocalRecording();
    } else {
      startStudioRecording();
    }
  }, [isLocalRecording, stopLocalRecording, startStudioRecording]);

  // 収録バーの録画トグル。録画ボタン起点で入った収録モードは、停止でダッシュボードへ戻す。
  const toggleStudioRecording = useCallback(() => {
    if (isLocalRecording) {
      stopLocalRecording();
      if (studioViaRecordRef.current) {
        studioViaRecordRef.current = false;
        setStudioMode(false);
      }
    } else {
      startLocalRecording(recordingQuality, () => studioStageRef.current);
    }
  }, [isLocalRecording, startLocalRecording, stopLocalRecording, recordingQuality]);

  // 収録モード終了。録画中なら先に停止してから戻す (クロップ対象消失による空録画を防ぐ)。
  const exitStudio = useCallback(() => {
    if (isLocalRecording) stopLocalRecording();
    studioViaRecordRef.current = false;
    setStudioMode(false);
  }, [isLocalRecording, stopLocalRecording]);

  // 収録モード中に画面共有が始まったら自動で「画面共有メイン」に切替、
  // 終了したら元のレイアウトへ戻す (Zoom 風)。手動でレイアウトを変えればそれが優先される。
  const preShareLayoutRef = useRef<StudioLayout>('split');
  useEffect(() => {
    if (!studioMode) return;
    if (screenShareActive) {
      setStudioLayout((prev) => {
        if (prev !== 'screen-main') preShareLayoutRef.current = prev;
        return 'screen-main';
      });
    } else {
      setStudioLayout(preShareLayoutRef.current);
    }
  }, [studioMode, screenShareActive]);

  // ホストは収録モードの設定 (有効/レイアウト/出演者割当/名前表示) を全参加者へ配信し、
  // 全員の表示を強制同期する。設定変更時に送信し、後から入室した参加者にも再送する。
  useEffect(() => {
    if (!isInstructor) return;
    const publish = () => {
      const payload = JSON.stringify({
        type: 'studio-state',
        payload: {
          active: studioMode,
          layout: studioLayout,
          slots: studioSlots,
          showNameplates,
        },
      });
      room.localParticipant
        .publishData(new TextEncoder().encode(payload), { reliable: true })
        .catch(() => {});
    };
    publish();
    room.on(RoomEvent.ParticipantConnected, publish);
    return () => {
      room.off(RoomEvent.ParticipantConnected, publish);
    };
  }, [isInstructor, studioMode, studioLayout, studioSlots, showNameplates, room]);

  // ── チャットUI / デバイス設定UI ──
  const [chatOpen, setChatOpen] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false);
  const toggleChat = useCallback(() => setChatOpen((v) => !v), []);
  const openDeviceSettings = useCallback(() => setDeviceSettingsOpen(true), []);
  const closeDeviceSettings = useCallback(() => setDeviceSettingsOpen(false), []);

  // ── 招待モーダル (URL はモーダル内で /api/invite-token から取得) ──
  const [inviteOpen, setInviteOpen] = useState(false);
  const openInvite = useCallback(() => setInviteOpen(true), []);
  const closeInvite = useCallback(() => setInviteOpen(false), []);

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
    finalize,
    chunkUpload,
    isRecording,
    completedCount: completedRecordings.length,
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
      } else if (data.type === 'set-mic') {
        // 講師からのマイク制御指示。本人操作と同じソフトミュートなので、後から再度ONにできる。
        const enabled = !!(data.payload && data.payload.enabled);
        localParticipant.setMicrophoneEnabled(enabled).catch(() => {});
        setIsMicOn(enabled);
      } else if (data.type === 'studio-state') {
        // ホストの収録コンポジションを全参加者に強制適用 (自分がホスト中の studio は別途優先)
        if (data.payload?.active) {
          setRemoteStudio({
            layout: data.payload.layout as StudioLayout,
            slots: data.payload.slots as (string | null)[],
            showNameplates: !!data.payload.showNameplates,
          });
        } else {
          setRemoteStudio(null);
        }
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
    // 既存 metadata（role / currentRoom / discordId）を保持したまま挙手状態のみ更新する
    const metadata = mergeParticipantMetadata(localParticipant.metadata, {
      raisedHand: newState,
      raisedAt: newState ? new Date().toISOString() : null,
    });
    await localParticipant.setMetadata(metadata);
    setRaisedHand(newState);
  }, [localParticipant, raisedHand]);

  // 講師が対象参加者のマイクをON/OFFする（data-channel ソフトミュート）。
  // クライアント側 publishData は講師ブラウザで届かないことがあるため、移動機能と
  // 同じくサーバー側 sendData 経由（/api/set-participant-mic）で配信する。
  // サーバー強制ミュートと違い、ON指示で参加者本人のマイクを再開できる。
  const setParticipantMic = useCallback(
    async (participantIdentity: string, enabled: boolean) => {
      try {
        const res = await fetch('/api/set-participant-mic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ participantIdentity, roomName: currentRoom, enabled }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`マイク操作に失敗しました: ${err.error ?? res.status}`);
        }
      } catch (e) {
        console.error('set-participant-mic failed:', e);
        alert('マイク操作に失敗しました。もう一度お試しください。');
      }
    },
    [currentRoom]
  );

  const returnToMain = useCallback(() => {
    onRoomChange('main');
  }, [onRoomChange]);

  // 受講生用「退出」: 録画停止 → チャット履歴 DL → LiveKit 切断 → session Cookie 削除
  const handleStudentLeave = useCallback(() => {
    if (!window.confirm('自習室から退出します。よろしいですか?')) return;
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

  // ── 収録モード表示（講師のみ）。通常レイアウトを丸ごと差し替える ──
  if (isInstructor && studioMode) {
    return (
      <div className="relative h-dvh w-screen overflow-hidden bg-black">
        <StudioStage
          layout={studioLayout}
          slotIdentities={studioSlots.slice(0, STUDIO_LAYOUT_SLOTS[studioLayout])}
          showNameplates={showNameplates}
          stageRef={studioStageRef}
        />
        <StudioBar
          isMicOn={isMicOn}
          isCameraOn={isCameraOn}
          isScreenSharing={isScreenSharing}
          isLocalRecording={isLocalRecording}
          recordingQuality={recordingQuality}
          layout={studioLayout}
          slotIdentities={studioSlots}
          participantOptions={participantOptions}
          showNameplates={showNameplates}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleLocalRecording={toggleStudioRecording}
          onChangeRecordingQuality={setRecordingQuality}
          onChangeLayout={setStudioLayout}
          onChangeSlot={changeStudioSlot}
          onToggleNameplates={() => setShowNameplates((v) => !v)}
          onExitStudio={exitStudio}
          onEndSession={!isBreakout ? openEndModal : undefined}
        />

        {/* デバイス設定 / 終了モーダルは収録モードでも利用可能 */}
        {deviceSettingsOpen && <DeviceSettingsModal onClose={closeDeviceSettings} />}
        {endModalOpen && (
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

  return (
    <div className={`flex h-dvh overflow-hidden theme-${currentRoom}`}>
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

        {/* メインビュー: ホストが配信中はその収録コンポジションを全参加者に強制表示 */}
        <div className="flex-1 min-h-0 overflow-auto p-3 relative">
          {remoteStudio ? (
            <StudioStage
              layout={remoteStudio.layout}
              slotIdentities={remoteStudio.slots.slice(
                0,
                STUDIO_LAYOUT_SLOTS[remoteStudio.layout]
              )}
              showNameplates={remoteStudio.showNameplates}
            />
          ) : (
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
          )}
        </div>

        {/* Breakout list (受講生のみ / メインルーム時。講師は右の講師ダッシュボードと重複するため非表示) */}
        {!isBreakout && !isGuest && !remoteStudio && !isInstructor && (
          <BreakoutList onJoin={onRoomChange} roomsStatus={roomsStatus} />
        )}

        {/* Control bar */}
        <ControlBar
          isMicOn={isMicOn}
          isCameraOn={isCameraOn}
          isScreenSharing={isScreenSharing}
          raisedHand={raisedHand}
          isInstructor={isInstructor}
          isBreakout={isBreakout}
          isLocalRecording={isLocalRecording}
          isAudioRecording={isRecording}
          showAudioRecordingButton={isInstructor && echoNoteConfigured}
          onEndSession={isInstructor && !isBreakout ? openEndModal : undefined}
          recordingQuality={recordingQuality}
          onChangeRecordingQuality={setRecordingQuality}
          isChatOpen={chatOpen}
          chatUnreadCount={chatUnread}
          onToggleMic={toggleMic}
          onToggleCamera={toggleCamera}
          onToggleScreenShare={toggleScreenShare}
          onToggleRaiseHand={toggleRaiseHand}
          onToggleLocalRecording={isInstructor ? handleDashboardRecord : toggleLocalRecording}
          onToggleAudioRecording={toggleAudioRecording}
          onToggleChat={toggleChat}
          onOpenDeviceSettings={openDeviceSettings}
          onReturnToMain={returnToMain}
          onLeave={handleStudentLeave}
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
          drawerOpen={dashboardOpen}
          onCloseDrawer={() => setDashboardOpen(false)}
          roomsStatus={roomsStatus}
          onEnterStudio={enterStudio}
          onMoveInstructor={onRoomChange}
          onSetParticipantMic={setParticipantMic}
        />
      )}

      {/* モバイルホスト向け警告（モバイル時のみ自動表示） */}
      <MobileHostWarning isInstructor={isInstructor} />

      {/* 録音/録画ステータストースト (全員) */}
      <RecordingToast audioOn={isRecording} screenOn={isLocalRecording} />

      {/* 招待モーダル（講師のみ） */}
      {isInstructor && inviteOpen && <InviteModal onClose={closeInvite} />}

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
