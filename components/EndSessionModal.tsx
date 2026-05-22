'use client';

import { useState } from 'react';

export type EndSessionChoice =
  | 'end-all-with-summary'
  | 'end-all-discard'
  | 'leave-self';

export interface RecordingSummary {
  /** ルームの表示名（例: "メインルーム"） */
  roomLabel: string;
  /** 録音時間（秒） */
  durationSec: number;
}

interface EndSessionModalProps {
  isRecording: boolean;
  echoNoteConfigured: boolean;
  uploading: boolean;
  uploadProgress?: string;
  uploadResult?:
    | { success: true; viewUrl?: string; discarded?: boolean }
    | { success: false; error: string }
    | null;
  /** 確定した録音の内訳（ルームごと） */
  completedSummaries?: RecordingSummary[];
  /** 進行中の録音のルーム名（あれば表示） */
  activeRoomLabel?: string;
  /** 進行中の録音の経過秒 */
  activeDurationSec?: number;
  onChoose: (choice: EndSessionChoice) => void;
  onClose: () => void;
}

/**
 * Zoom 風の「セッションを終了しますか？」モーダル。
 *
 * - 「全員終了 + 要約を生成」: 全員退出 + 録音をEchoNoteへ送信（要約生成）
 * - 「要約せず終了」: 全員退出 + 録音は破棄（EchoNoteへ送らない）
 * - 「自分だけ退出」: 講師だけ退出（受講生は自習室に残る）
 * - 「キャンセル」: 何もせず閉じる
 */
export function EndSessionModal({
  isRecording,
  echoNoteConfigured,
  uploading,
  uploadProgress,
  uploadResult,
  completedSummaries = [],
  activeRoomLabel,
  activeDurationSec,
  onChoose,
  onClose,
}: EndSessionModalProps) {
  // confirmingEndAll/confirmingDiscard はモーダルがマウント中だけ有効。
  // 親が条件レンダリングで unmount するため、再オープン時は自動的にリセットされる。
  const [confirmingEndAll, setConfirmingEndAll] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // アップロード成功時
  if (uploadResult?.success) {
    const isDiscarded = uploadResult.discarded === true;
    const sentToEchoNote = echoNoteConfigured && !!uploadResult.viewUrl && !isDiscarded;
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">
            {isDiscarded ? '録音を破棄して終了しました' : 'セッションを終了しました'}
          </h2>
          <p className="text-sm text-stone-700 mb-4">
            {isDiscarded
              ? '録音データは保存されていません。'
              : sentToEchoNote
                ? '録音を EchoNote に送信しました。文字起こしと要約は数分〜十数分で完了します。'
                : '退出処理が完了しました。'}
          </p>
          {uploadResult.viewUrl && !isDiscarded && (
            <a
              href={uploadResult.viewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full text-center rounded-lg bg-green-600 px-4 py-3 text-sm font-medium text-white hover:bg-green-700 mb-2"
            >
              EchoNote で結果を見る
            </a>
          )}
          <button
            onClick={onClose}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            閉じる
          </button>
        </Panel>
      </Backdrop>
    );
  }

  // アップロード失敗時
  if (uploadResult && !uploadResult.success) {
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-red-700 mb-2">送信に失敗しました</h2>
          <p className="text-sm text-stone-700 mb-2">{uploadResult.error}</p>
          <p className="text-xs text-stone-500 mb-4">
            録音データはブラウザに残っています。再度お試しいただくか、画面を閉じる前に管理者へご連絡ください。
          </p>
          <button
            onClick={() => onChoose('end-all-with-summary')}
            className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2"
          >
            もう一度送信する
          </button>
          <button
            onClick={onClose}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            キャンセル
          </button>
        </Panel>
      </Backdrop>
    );
  }

  // アップロード中
  if (uploading) {
    return (
      <Backdrop>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">
            {echoNoteConfigured ? '送信中...' : '終了処理中...'}
          </h2>
          <p className="text-sm text-stone-700 mb-4">
            {uploadProgress ||
              (echoNoteConfigured
                ? '録音をEchoNoteへ送信しています。この画面を閉じないでください。'
                : 'セッションを終了しています。この画面を閉じないでください。')}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-500" />
          </div>
        </Panel>
      </Backdrop>
    );
  }

  // 「要約せず終了」の確認ステップ
  if (confirmingDiscard) {
    const totalRecordings = completedSummaries.length + (isRecording ? 1 : 0);
    return (
      <Backdrop onBackdropClick={onClose}>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">
            録音を破棄して終了しますか？
          </h2>
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-sm text-red-800 leading-relaxed">
              <strong className="font-semibold">⚠ 録音データは保存されません。</strong>
              <br />
              文字起こし・AI要約も生成されません。
            </p>
            {totalRecordings > 0 && (
              <p className="mt-2 text-xs text-red-700">
                これまでの録音 {totalRecordings} 件はすべて破棄されます。元に戻せません。
              </p>
            )}
          </div>
          <p className="mb-4 text-xs text-stone-600">
            機密性の高い会話で録音を残したくない時にお使いください。
          </p>
          <button
            onClick={() => onChoose('end-all-discard')}
            className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2"
          >
            録音を破棄して終了する
          </button>
          <button
            onClick={() => setConfirmingDiscard(false)}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            戻る
          </button>
        </Panel>
      </Backdrop>
    );
  }

  // 「全員終了」の確認ステップ
  if (confirmingEndAll) {
    return (
      <Backdrop onBackdropClick={onClose}>
        <Panel>
          <h2 className="text-lg font-bold text-stone-900 mb-2">本当に全員終了しますか？</h2>
          <p className="text-sm text-stone-700 mb-2">
            受講生も全員退出させます。
            {echoNoteConfigured && isRecording && (
              <span> 録音はEchoNoteに送られ、文字起こしと要約が自動で生成されます。</span>
            )}
          </p>
          <button
            onClick={() => onChoose('end-all-with-summary')}
            className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2"
          >
            全員終了する
          </button>
          <button
            onClick={() => setConfirmingEndAll(false)}
            className="block w-full rounded-lg border border-stone-300 px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            戻る
          </button>
        </Panel>
      </Backdrop>
    );
  }

  // 通常モーダル（最初の表示）
  const totalRecordings = completedSummaries.length + (isRecording ? 1 : 0);
  return (
    <Backdrop onBackdropClick={onClose}>
      <Panel>
        <h2 className="text-lg font-bold text-stone-900 mb-1">セッションを終了しますか？</h2>
        {totalRecordings > 0 ? (
          <div className="mb-4 rounded-lg bg-stone-50 p-3 border border-stone-200">
            <p className="text-xs text-stone-500 mb-1.5">これまでの録音（{totalRecordings}件）</p>
            <ul className="space-y-1 text-xs text-stone-700">
              {completedSummaries.map((s, i) => (
                <li key={i} className="flex justify-between">
                  <span>{s.roomLabel}</span>
                  <span className="font-mono text-stone-500">{formatDuration(s.durationSec)}</span>
                </li>
              ))}
              {isRecording && activeRoomLabel && (
                <li className="flex justify-between text-red-600">
                  <span>● {activeRoomLabel}（録音中）</span>
                  <span className="font-mono">{formatDuration(activeDurationSec || 0)}</span>
                </li>
              )}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-stone-500 mb-4">録音は行われていません</p>
        )}

        <button
          onClick={() => setConfirmingEndAll(true)}
          className="block w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-700 mb-2 text-left"
        >
          <div className="font-semibold">全員終了 {echoNoteConfigured && isRecording ? '+ 要約を生成' : ''}</div>
          <div className="text-xs opacity-90 mt-0.5">
            {echoNoteConfigured && isRecording
              ? '受講生も退出。録音はEchoNoteへ送信され要約されます'
              : '受講生も含めて全員が退出します'}
          </div>
        </button>

        {(isRecording || completedSummaries.length > 0) && (
          <button
            onClick={() => setConfirmingDiscard(true)}
            className="block w-full rounded-lg border border-red-300 bg-white px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-50 mb-2 text-left"
          >
            <div className="font-semibold">要約せず終了（録音を破棄）</div>
            <div className="text-xs text-red-600/80 mt-0.5">
              全員退出。録音データは保存されません（機密会話の場合に）
            </div>
          </button>
        )}

        <button
          onClick={() => onChoose('leave-self')}
          className="block w-full rounded-lg border border-stone-300 bg-white px-4 py-3 text-sm font-medium text-stone-700 hover:bg-stone-50 mb-2 text-left"
        >
          <div className="font-semibold">自分だけ退出</div>
          <div className="text-xs text-stone-500 mt-0.5">
            受講生は自習室に残ります（録音は中断されます）
          </div>
        </button>

        <button
          onClick={onClose}
          className="block w-full rounded-lg px-4 py-3 text-sm font-medium text-stone-500 hover:bg-stone-50"
        >
          キャンセル
        </button>
      </Panel>
    </Backdrop>
  );
}

function Backdrop({
  children,
  onBackdropClick,
}: {
  children: React.ReactNode;
  onBackdropClick?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onBackdropClick}
    >
      {children}
    </div>
  );
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}
