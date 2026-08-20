'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  assembleRecording,
  deleteRecordingSession,
  listUnfinishedSessions,
  pruneOldSessions,
  type RecordingSessionMeta,
} from '@/lib/recording-store';
import { injectWebmSeekMetadata } from '@/lib/webm-seek-metadata';
import { buildRecordingFilename, downloadBlobAs } from '@/lib/recording-file';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `約${h}時間${m}分`;
  return `約${m}分`;
}

function formatStartedAt(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 前回の録画が正常に終了していないときに、復旧するか捨てるかを尋ねるバナー。
 *
 * 録画中のチャンクは IndexedDB へ逐次保存されており、ブラウザやPCごと落ちても
 * そこまでの映像は残っている。ただし放っておけば次の録画で埋もれてディスクを
 * 食うだけなので、起動時に必ず「保存するか捨てるか」を決めてもらう。
 */
export default function RecordingRecoveryPrompt() {
  const [sessions, setSessions] = useState<RecordingSessionMeta[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 放置された残骸を先に掃除してから、復旧対象だけを拾う
      await pruneOldSessions();
      const found = await listUnfinishedSessions();
      if (!cancelled) setSessions(found);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const recover = useCallback(async (meta: RecordingSessionMeta) => {
    setBusyId(meta.id);
    setError(null);
    try {
      const raw = await assembleRecording(meta.id);
      if (!raw) {
        setError('復旧データを読み出せませんでした。');
        return;
      }
      // 通常の停止と同じく、編集ソフトで開けるようインデックスを付けてから保存する。
      // 途中で切れたファイルは Cues 構築に失敗することがあるので、失敗しても生で保存する。
      const blob = raw.type.includes('webm')
        ? await injectWebmSeekMetadata(raw).catch(() => raw)
        : raw;
      downloadBlobAs(
        blob,
        buildRecordingFilename(meta.filePrefix, blob.type, new Date(meta.startedAt), '_復旧')
      );
      await deleteRecordingSession(meta.id);
      setSessions((prev) => prev.filter((s) => s.id !== meta.id));
    } catch (e) {
      console.error('[RecordingRecoveryPrompt] 復旧に失敗', e);
      setError('復旧に失敗しました。ブラウザを再起動してもう一度お試しください。');
    } finally {
      setBusyId(null);
    }
  }, []);

  const discard = useCallback(async (meta: RecordingSessionMeta) => {
    if (
      !confirm(
        `${formatStartedAt(meta.startedAt)} の録画（${formatBytes(meta.bytes)}）を削除します。元に戻せません。`
      )
    ) {
      return;
    }
    setBusyId(meta.id);
    try {
      await deleteRecordingSession(meta.id);
      setSessions((prev) => prev.filter((s) => s.id !== meta.id));
    } finally {
      setBusyId(null);
    }
  }, []);

  if (sessions.length === 0) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="w-full max-w-md rounded-2xl border border-amber-700/60 bg-stone-900 p-4 shadow-2xl">
        <p className="text-sm font-semibold text-stone-100">
          前回の録画が保存されないまま終了しています
        </p>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-stone-400">
          ブラウザが強制終了したときに残ったデータです。保存すると通常の録画と同じ
          WebM ファイルとしてダウンロードされます。
        </p>

        <ul className="mt-3 space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="rounded-lg bg-stone-800 px-3 py-2">
              <p className="text-xs font-medium text-stone-200">
                {formatStartedAt(s.startedAt)} 開始
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-stone-400">
                {formatDuration(s.updatedAt - s.startedAt)} / {formatBytes(s.bytes)}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => void recover(s)}
                  disabled={busyId !== null}
                  className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {busyId === s.id ? '保存中…' : '保存する'}
                </button>
                <button
                  onClick={() => void discard(s)}
                  disabled={busyId !== null}
                  className="rounded-lg bg-stone-700 px-3 py-1.5 text-xs font-medium text-stone-200 hover:bg-stone-600 disabled:opacity-50"
                >
                  破棄
                </button>
              </div>
            </li>
          ))}
        </ul>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}
