'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
  RemoteTrack,
  Track,
  RoomEvent,
  type LocalTrackPublication,
  type RemoteTrackPublication,
} from 'livekit-client';
import { SessionAudioRecorder } from '@/lib/audio-recorder';
import type { RoomName } from '@/lib/types';

export interface RoomRecording {
  room: RoomName;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  startedAt: number;
  /** 同一ルーム内のチャンクをまとめる ID（ルームが変わると新しい ID） */
  sessionGroupId: string;
  /** グループ内のチャンク順序（0始まり） */
  chunkIndex: number;
  /** このチャンクで該当グループの送信が完了するか */
  isFinal: boolean;
}

interface UseSessionRecorderOptions {
  /** 録音を有効にするか（講師のみ true 想定） */
  enabled: boolean;
  /** 現在いるルーム（変わったら新しいグループとして録音し直す） */
  currentRoom: RoomName;
  /** チャンクが確定するたびに呼ばれる（即時アップロード用） */
  onChunkReady?: (chunk: RoomRecording) => void;
}

/** 30分ごとにチャンクをローテーションする */
const CHUNK_DURATION_MS = 30 * 60 * 1000;

/**
 * 自習室の音声を録音する hook（チャンク方式）。
 *
 * 特徴:
 *   - ルームごとに sessionGroupId を発行（メイン / 各BOで別グループ）
 *   - 同一ルーム内では 30分ごとにチャンク確定 → 即 onChunkReady で通知（アップロード可能）
 *   - 各チャンクは webm/opus などの完結したオーディオファイル
 *   - ルーム移動 or セッション終了で最終チャンクを isFinal=true で emit
 *
 * メリット:
 *   - 30分単位でアップロードされるためブラウザクラッシュ時の損失が最大30分
 *   - メモリ消費も常に小さく保たれる（200分セッションでも 10〜15MB 以下）
 */
export function useSessionRecorder({
  enabled,
  currentRoom,
  onChunkReady,
}: UseSessionRecorderOptions) {
  const room = useRoomContext();
  const recorderRef = useRef<SessionAudioRecorder | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const groupIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);

  const [isRecording, setIsRecording] = useState(false);
  const [currentRoomLabel, setCurrentRoomLabel] = useState<RoomName | null>(null);
  // この録音セグメント（ルーム単位）の開始時刻。録音インジケータの経過表示に使う。
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [completedRecordings, setCompletedRecordings] = useState<RoomRecording[]>([]);
  const [error, setError] = useState<string | null>(null);

  // onChunkReady を ref で保持（依存配列に入れると effect が頻繁に再実行されるため）
  const onChunkReadyRef = useRef(onChunkReady);
  useEffect(() => {
    onChunkReadyRef.current = onChunkReady;
  }, [onChunkReady]);

  useEffect(() => {
    if (!enabled || !room) return;

    let cancelled = false;
    let rotationTimer: ReturnType<typeof setInterval> | null = null;

    const thisRoom = currentRoom;

    // 新しいグループを開始
    const groupId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    groupIdRef.current = groupId;
    chunkIndexRef.current = 0;

    /** 現在の参加者の音声トラックを録音先にすべて接続 */
    const subscribeAllToRecorder = (recorder: SessionAudioRecorder) => {
      const localPub = room.localParticipant.getTrackPublication(
        Track.Source.Microphone
      ) as LocalTrackPublication | undefined;
      if (localPub?.track?.mediaStreamTrack) {
        recorder.addTrack(`local-${localPub.trackSid}`, localPub.track.mediaStreamTrack);
      }
      room.remoteParticipants.forEach((p) => {
        p.audioTrackPublications.forEach((pub) => {
          if (pub.track?.mediaStreamTrack) {
            recorder.addTrack(`remote-${pub.trackSid}`, pub.track.mediaStreamTrack);
          }
        });
      });
    };

    // 新しい参加者・トラックが入ってきたら録音先に追加
    const handleTrackSubscribed = (
      track: RemoteTrack,
      publication: RemoteTrackPublication
    ) => {
      if (track.kind === Track.Kind.Audio && track.mediaStreamTrack) {
        recorderRef.current?.addTrack(`remote-${publication.trackSid}`, track.mediaStreamTrack);
      }
    };
    const handleTrackUnsubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication
    ) => {
      recorderRef.current?.removeTrack(`remote-${publication.trackSid}`);
    };
    const handleLocalTrackPublished = (publication: LocalTrackPublication) => {
      if (
        publication.track?.kind === Track.Kind.Audio &&
        publication.track.mediaStreamTrack
      ) {
        recorderRef.current?.addTrack(`local-${publication.trackSid}`, publication.track.mediaStreamTrack);
      }
    };

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);

    /** 確定したチャンクを完了一覧に追加し、onChunkReady で通知する */
    const emitChunk = (
      blob: Blob,
      mimeType: string,
      durationMs: number,
      startedAt: number,
      chunkIndex: number,
      isFinal: boolean
    ) => {
      if (durationMs < 1000) return; // 1秒未満は誤検知として捨てる
      const chunk: RoomRecording = {
        room: thisRoom,
        blob,
        mimeType,
        durationMs,
        startedAt,
        sessionGroupId: groupId,
        chunkIndex,
        isFinal,
      };
      if (!cancelled) {
        setCompletedRecordings((prev) => [...prev, chunk]);
      }
      try {
        onChunkReadyRef.current?.(chunk);
      } catch (err) {
        console.error('[recorder] onChunkReady callback error:', err);
      }
    };

    /** 新しい SessionAudioRecorder を起動して、録音開始 */
    const startNewRecorder = async (): Promise<SessionAudioRecorder | null> => {
      const audioRecorder = new SessionAudioRecorder();
      try {
        await audioRecorder.start();
        if (cancelled) {
          audioRecorder.abort();
          return null;
        }
        recorderRef.current = audioRecorder;
        startedAtRef.current = Date.now();
        subscribeAllToRecorder(audioRecorder);
        setIsRecording(true);
        setCurrentRoomLabel(thisRoom);
        return audioRecorder;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[recorder] start failed:', err);
        setError(`録音を開始できませんでした: ${msg}`);
        return null;
      }
    };

    /** ローテーション：現在のチャンクを確定 → 新チャンクで録音継続 */
    const rotate = async () => {
      if (cancelled) return;
      const oldRecorder = recorderRef.current;
      const oldStartedAt = startedAtRef.current;
      const oldChunkIndex = chunkIndexRef.current;
      if (!oldRecorder || !oldStartedAt) return;

      // 次チャンク用にindex先行更新
      chunkIndexRef.current += 1;
      // 新レコーダーを先に立ち上げる（録音の中断時間を最小化）
      await startNewRecorder();
      // 旧レコーダーを確定
      try {
        const result = await oldRecorder.stopAndFinalize();
        emitChunk(
          result.blob,
          result.mimeType,
          result.durationMs,
          oldStartedAt,
          oldChunkIndex,
          /* isFinal */ false
        );
      } catch (err) {
        console.error('[recorder] rotation finalize failed:', err);
      }
    };

    // 起動シーケンス
    (async () => {
      const r = await startNewRecorder();
      if (!r || cancelled) return;
      // セグメント開始時刻を記録（effect body ではなく async 内なので set-state-in-effect を回避）
      setStartedAt(startedAtRef.current);
      rotationTimer = setInterval(rotate, CHUNK_DURATION_MS);
    })();

    return () => {
      cancelled = true;
      if (rotationTimer) clearInterval(rotationTimer);
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);

      // 現在のチャンクを最終チャンクとして確定（fire-and-forget）
      const recorder = recorderRef.current;
      const startedAt = startedAtRef.current;
      const chunkIndex = chunkIndexRef.current;

      if (recorder?.isRecording && startedAt) {
        recorder
          .stopAndFinalize()
          .then((result) => {
            emitChunk(
              result.blob,
              result.mimeType,
              result.durationMs,
              startedAt,
              chunkIndex,
              /* isFinal */ true
            );
          })
          .catch((err) => console.error('[recorder] cleanup finalize failed:', err));
      } else {
        recorder?.abort();
      }

      if (recorderRef.current === recorder) {
        recorderRef.current = null;
        startedAtRef.current = null;
      }
      setIsRecording(false);
      setCurrentRoomLabel(null);
      setStartedAt(null);
    };
  }, [enabled, currentRoom, room]);

  // タブを閉じる前の警告
  useEffect(() => {
    if (!isRecording && completedRecordings.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '録音中または未送信の録音があります。タブを閉じると失われます。';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isRecording, completedRecordings.length]);

  /**
   * 進行中の録音を確定してクローズし、最終チャンクを isFinal=true で emit する。
   * 戻り値はこの呼び出しまでに完了した全チャンク（既に emit 済み）。
   */
  const finalize = useCallback(async (): Promise<RoomRecording[]> => {
    const recorder = recorderRef.current;
    const startedAt = startedAtRef.current;
    const chunkIndex = chunkIndexRef.current;
    const groupId = groupIdRef.current;
    const accumulated = [...completedRecordings];

    if (recorder?.isRecording && startedAt && groupId) {
      try {
        const result = await recorder.stopAndFinalize();
        if (result.durationMs >= 1000) {
          // currentRoomLabel から room を取得（state は最新のはず）
          const currentRoom = currentRoomLabel;
          if (currentRoom) {
            const chunk: RoomRecording = {
              room: currentRoom,
              blob: result.blob,
              mimeType: result.mimeType,
              durationMs: result.durationMs,
              startedAt,
              sessionGroupId: groupId,
              chunkIndex,
              isFinal: true,
            };
            accumulated.push(chunk);
            setCompletedRecordings((prev) => [...prev, chunk]);
            try {
              onChunkReadyRef.current?.(chunk);
            } catch (err) {
              console.error('[recorder] onChunkReady callback error:', err);
            }
          }
        }
      } catch (err) {
        console.error('[recorder] finalize failed:', err);
      } finally {
        recorderRef.current = null;
        startedAtRef.current = null;
        setIsRecording(false);
      }
    }
    return accumulated;
  }, [completedRecordings, currentRoomLabel]);

  return {
    isRecording,
    currentRoomLabel,
    startedAt,
    completedRecordings,
    error,
    finalize,
    /** 後方互換: 既存コードが finalizeAll を呼んでいる箇所への対応 */
    finalizeAll: finalize,
  };
}
