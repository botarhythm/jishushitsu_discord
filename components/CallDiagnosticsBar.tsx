'use client';

import { useState, useSyncExternalStore } from 'react';
import { type CallDiagnostics, type DiagnosticStatus } from '@/lib/call-diagnostics';
import { downloadBlobAs } from '@/lib/recording-file';

const labels: Record<DiagnosticStatus, string> = {
  collecting: '通話の状態を確認中', connected: '通話に接続中',
  reconnecting: '通話を再接続中です。声が届かない場合があります',
  disconnected: '通話の接続が切れています',
  'audio-risk': '音声の受信に遅れ・欠落の兆候があります',
  'browser-gap': 'ブラウザの処理間隔が一時的に空きました',
  unavailable: '通話に接続中・詳しい受信状態を取得できません',
};

/** In normal document flow, outside the recording stage; status changes never resize it. */
export function CallDiagnosticsBar({ diagnostics }: { diagnostics: CallDiagnostics }) {
  const { status, marks } = useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot, diagnostics.getSnapshot);
  const [error, setError] = useState(false);
  const save = () => {
    try {
      downloadBlobAs(new Blob([diagnostics.exportJson()], { type: 'application/json' }),
        `自習室_通話診断_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      setError(false);
    } catch { setError(true); }
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-stone-700 bg-stone-900 px-2 text-xs text-stone-200">
      <span role="status" className="min-w-0 flex-1 truncate" title={error ? '診断を保存できませんでした。再度お試しください' : labels[status]}>
        {error ? '診断を保存できませんでした。再度お試しください' : labels[status]}
      </span>
      <button type="button" onClick={diagnostics.mark}
        title="遅れた時点を記録します。直近5分の数値のみ。音声・参加者名は記録しません"
        className="shrink-0 rounded border border-stone-600 px-2 py-1 focus-visible:outline-2 focus-visible:outline-amber-400">
        今、遅れた<span className="tabular-nums">{marks > 0 ? `（${marks}）` : ''}</span>
      </button>
      <button type="button" onClick={save} title="直近5分の数値をJSON保存。サーバーには送信しません"
        className="shrink-0 rounded border border-stone-600 px-2 py-1 focus-visible:outline-2 focus-visible:outline-amber-400">
        診断を保存
      </button>
    </div>
  );
}
