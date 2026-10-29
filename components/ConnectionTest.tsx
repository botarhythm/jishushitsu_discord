'use client';

import { useCallback, useRef, useState } from 'react';
import { CheckStatus, ConnectionCheck, type CheckInfo } from 'livekit-client';
import {
  ACK_GAP_LIMIT_SEC,
  reconnectsWhileMeasuring,
  runUploadTest,
  STALLED_AUDIO_KBPS,
  STALLED_VIDEO_KBPS,
  type UploadMode,
  type UploadResult,
  type UploadSample,
} from '@/lib/connection-test';

/** 送信の持続検査の長さ。2026-10-29 は接続直後から止まっていたので、20 秒あれば再現する */
const UPLOAD_SECONDS = 20;

/** SDK 標準の検査。カメラ・マイクの検査は機器の許可を求めるので含めない */
const SDK_CHECKS: { key: keyof ConnectionCheck; label: string }[] = [
  { key: 'checkWebsocket', label: 'サーバーへの接続（WebSocket）' },
  { key: 'checkWebRTC', label: '映像・音声の通り道（WebRTC）' },
  { key: 'checkTURN', label: '中継サーバー経由の接続（TURN）' },
  { key: 'checkReconnect', label: '切れたときの再接続' },
  // SDK には UDP を強制する手段がなく、「UDP」側は自動接続のまま測られる
  { key: 'checkConnectionProtocol', label: '自動接続と TCP の送信比較（各 10 秒）' },
  { key: 'checkCloudRegion', label: '近い拠点と応答時間' },
];

const UPLOAD_MODES: UploadMode[] = ['auto', 'relay', 'tls'];

const UPLOAD_LABEL: Record<UploadMode, string> = {
  auto: `送信の持続（自動接続・${UPLOAD_SECONDS} 秒）`,
  relay: `送信の持続（中継・UDP・${UPLOAD_SECONDS} 秒）`,
  tls: `送信の持続（中継・TLS／TCP 443・${UPLOAD_SECONDS} 秒）`,
};

/** その経路が UDP / TCP のどちらで運ばれたか。自動接続は実際に選ばれた経路で決まる */
function transportOf(r: UploadResult): 'UDP' | 'TCP' | null {
  if (r.mode === 'relay') return 'UDP';
  if (r.mode === 'tls') return 'TCP';
  if (/\budp\b/.test(r.path)) return 'UDP';
  if (/\btcp\b/.test(r.path)) return 'TCP';
  return null;
}

type Phase = 'idle' | 'running' | 'done';

const STATUS_TEXT: Record<CheckStatus, string> = {
  [CheckStatus.IDLE]: '待機',
  [CheckStatus.RUNNING]: '実行中',
  [CheckStatus.SKIPPED]: '省略',
  [CheckStatus.SUCCESS]: '成功',
  [CheckStatus.FAILED]: '失敗',
};

function uploadVerdict(r: UploadResult): { ok: boolean; text: string } {
  if (r.error) return { ok: false, text: `接続できませんでした（${r.error}）` };
  if (r.mode === 'tls' && !/tls/.test(r.path)) {
    return { ok: false, text: `TLS の中継に切り替わりませんでした（経路 ${r.path}）` };
  }
  const rates = `音声 ${r.medianAudioKbps} kbps・映像 ${r.medianVideoKbps ?? '測定外'} kbps`;
  // 送り出せていても、サーバーから受信の報告が戻らなければ届いていない
  if (r.neverAcked) {
    return { ok: false, text: `サーバーに届いたことを確認できません（受信の報告なし。送り出し ${rates}）` };
  }
  if (r.maxAckGapSec >= ACK_GAP_LIMIT_SEC) {
    return {
      ok: false,
      text: `サーバーからの受信の報告が ${r.maxAckGapSec} 秒途絶えました（届いていない時間があります。送り出し ${rates}）`,
    };
  }
  if (r.medianAudioKbps < STALLED_AUDIO_KBPS) {
    return { ok: false, text: `送信がほぼ止まっています（${rates}）` };
  }
  if (r.medianVideoKbps != null && r.medianVideoKbps < STALLED_VIDEO_KBPS) {
    return { ok: false, text: `映像の送信がほぼ止まっています（${rates}）` };
  }
  if (r.disconnected) return { ok: false, text: '送信中に接続が切れました' };
  const midReconnects = reconnectsWhileMeasuring(r);
  if (midReconnects > 0) {
    return { ok: false, text: `送信中に接続を張り直しました（${midReconnects} 回）` };
  }
  if ((r.maxRttMs ?? 0) > 1000) {
    return { ok: false, text: `送れていますが、遅延が最大 ${r.maxRttMs} ms まで延びました` };
  }
  return { ok: true, text: `正常に送れています（${rates}）` };
}

/** 3 つの持続検査の組み合わせから、次に何を疑うかを出す */
function overallVerdict(uploads: Partial<Record<UploadMode, UploadResult>>): string | null {
  const results = UPLOAD_MODES.map((m) => uploads[m]);
  if (results.some((r) => !r)) return null;
  const done = results as UploadResult[];
  const ok = done.filter((r) => uploadVerdict(r).ok);
  const bad = done.filter((r) => !uploadVerdict(r).ok);
  if (!bad.length) return '今は正常です。症状が出ているときにもう一度実行してください。';
  if (!ok.length) return 'どの経路でも送れていません。この PC か回線の上り全体を疑ってください。';

  const auto = uploads.auto!;
  const autoOk = uploadVerdict(auto).ok;
  const udpBad = bad.some((r) => transportOf(r) === 'UDP');
  const tcpOk = ok.some((r) => transportOf(r) === 'TCP');
  const parts: string[] = [];
  if (udpBad && tcpOk) {
    parts.push('UDP の経路で詰まり、TCP の経路では送れています。この PC・回線から LiveKit への UDP が絞られている可能性が高いです。');
  } else {
    parts.push(
      `送れた経路：${ok.map((r) => UPLOAD_LABEL[r.mode]).join('、')}。` +
        `詰まった経路：${bad.map((r) => UPLOAD_LABEL[r.mode]).join('、')}。`
    );
  }
  if (autoOk) {
    parts.push(`自動接続は ${transportOf(auto) ?? '不明な経路'} を選んで送れているので、今の通話への影響は小さいと考えられます。`);
  } else if (uploads.tls && uploadVerdict(uploads.tls).ok) {
    parts.push('自動接続も詰まっています。TLS（TCP 443）の中継に切り替えれば通話できる見込みです。');
  }
  return parts.join('');
}

function formatSamples(samples: UploadSample[]): string {
  return samples
    .map(
      (s) =>
        `${s.t}s=a${s.audioKbps}+v${s.videoKbps}kbps` +
        (s.rttMs != null ? `/rtt${s.rttMs}` : '') +
        (s.remoteRttMs != null ? `/rr${s.remoteRttMs}` : '') +
        (s.ackGapSec >= 3 ? `/報告なし${s.ackGapSec}s` : '') +
        (s.limitation ? `/${s.limitation}` : '') +
        (s.hidden ? '/裏' : '')
    )
    .join(' ');
}

export default function ConnectionTest() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckInfo>>({});
  const [uploads, setUploads] = useState<Partial<Record<UploadMode, UploadResult>>>({});
  const [live, setLive] = useState<Partial<Record<UploadMode, UploadSample[]>>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = useRef(false);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase('running');
    setError(null);
    setChecks({});
    setUploads({});
    setLive({});
    setCopied(false);
    setStartedAt(new Date().toLocaleString('ja-JP'));
    try {
      const res = await fetch('/api/connection-test-token', { method: 'POST' });
      if (res.status === 401) throw new Error('ログインしてから開いてください。');
      if (!res.ok) throw new Error(`テスト用の鍵を発行できませんでした（${res.status}）`);
      const { token, livekitUrl } = (await res.json()) as { token: string; livekitUrl: string };

      const checker = new ConnectionCheck(livekitUrl, token);
      for (const c of SDK_CHECKS) {
        setRunning(c.label);
        const run = checker[c.key] as () => Promise<CheckInfo>;
        try {
          const info = await run.call(checker);
          setChecks((prev) => ({ ...prev, [c.label]: info }));
        } catch (e) {
          setChecks((prev) => ({
            ...prev,
            [c.label]: {
              name: c.label,
              description: c.label,
              status: CheckStatus.FAILED,
              logs: [{ level: 'error', message: e instanceof Error ? e.message : String(e) }],
            },
          }));
        }
      }

      for (const mode of UPLOAD_MODES) {
        setRunning(UPLOAD_LABEL[mode]);
        const result = await runUploadTest(livekitUrl, token, mode, UPLOAD_SECONDS, (s) =>
          setLive((prev) => ({ ...prev, [mode]: [...(prev[mode] ?? []), s] }))
        );
        setUploads((prev) => ({ ...prev, [mode]: result }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
      setPhase('done');
      busy.current = false;
    }
  }, []);

  const summaryText = useCallback(() => {
    const lines = [
      `自習室 接続テスト ${startedAt ?? ''}`,
      `ブラウザ: ${navigator.userAgent}`,
      '',
      ...SDK_CHECKS.map((c) => {
        const info = checks[c.label];
        if (!info) return `- ${c.label}: 未実行`;
        const logs = info.logs.map((l) => `${l.level === 'info' ? '' : `[${l.level}] `}${l.message}`).join(' / ');
        return `- ${c.label}: ${STATUS_TEXT[info.status]}${logs ? `（${logs}）` : ''}`;
      }),
      ...UPLOAD_MODES.map((m) => {
        const r = uploads[m];
        if (!r) return `- ${UPLOAD_LABEL[m]}: 未実行`;
        return (
          `- ${UPLOAD_LABEL[m]}: ${uploadVerdict(r).text} / 経路 ${r.path} / ` +
          `RTT 中央 ${r.medianRttMs ?? '-'}ms 最大 ${r.maxRttMs ?? '-'}ms / 受信報告の途絶 最大 ${r.maxAckGapSec}s / 再接続 ${r.reconnects}` +
          (r.reconnectAtSec.length
            ? `（${r.reconnectAtSec.join(', ')}s、測定開始 ${r.measureStartSec ?? '-'}s）`
            : '') +
          `\n  ${formatSamples(r.samples)}`
        );
      }),
      '',
      `判定: ${overallVerdict(uploads) ?? '未完了'}`,
    ];
    return lines.join('\n');
  }, [checks, startedAt, uploads]);

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(summaryText());
    setCopied(true);
  }, [summaryText]);

  const verdict = overallVerdict(uploads);

  return (
    <div className="min-h-dvh bg-stone-950">
      <main className="mx-auto max-w-3xl px-5 py-10 text-stone-200 [word-break:auto-phrase]">
        <header className="mb-8">
          <h1 className="text-pretty text-2xl font-bold text-stone-100">接続テスト</h1>
          <p className="mt-3 max-w-[50em] text-pretty text-sm leading-relaxed text-stone-400">
            {'この PC から自習室のサーバー（LiveKit）へ、映像と音声を送れるかを調べます。' +
              'テスト用の別の部屋を使うので、通話中に実行しても通話は切れません。' +
              '所要時間は 3 分ほどです。カメラとマイクは使いません。'}
          </p>
          <p className="mt-2 max-w-[50em] text-pretty text-sm leading-relaxed text-stone-400">
            {'映像が固まる・声が届かないときに実行し、終わったら「結果をコピー」で開発側へ送ってください。' +
              '実行中はこの画面を表示したままにしてください。（裏に回すと映像の測定が無効になります）'}
          </p>
        </header>

        <div className="mb-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={run}
            disabled={phase === 'running'}
            className="rounded-md bg-amber-500 px-5 py-2.5 text-sm font-semibold text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === 'running' ? '実行中…' : phase === 'done' ? 'もう一度実行' : 'テストを始める'}
          </button>
          {phase === 'done' && !error && (
            <button
              type="button"
              onClick={copy}
              className="rounded-md border border-stone-600 px-5 py-2.5 text-sm font-semibold text-stone-100 hover:bg-stone-800"
            >
              {copied ? 'コピーしました' : '結果をコピー'}
            </button>
          )}
          {running && <span className="text-sm text-stone-400">{running} を実行中</span>}
        </div>

        {error && (
          <p role="alert" className="mb-6 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {verdict && (
          <p className="mb-6 rounded-md border border-sky-900/60 bg-sky-950/30 px-4 py-3 text-pretty text-sm leading-relaxed text-sky-100">
            {verdict}
          </p>
        )}

        {phase !== 'idle' && (
          <ol className="space-y-3">
            {SDK_CHECKS.map((c) => {
              const info = checks[c.label];
              const status = info?.status ?? (running === c.label ? CheckStatus.RUNNING : CheckStatus.IDLE);
              return (
                <ResultRow key={c.label} label={c.label} status={status}>
                  {info?.logs.map((l, i) => (
                    <li key={i} className={l.level === 'info' ? 'text-stone-400' : 'text-amber-300'}>
                      {l.message}
                    </li>
                  ))}
                </ResultRow>
              );
            })}
            {UPLOAD_MODES.map((m) => {
              const r = uploads[m];
              const samples = r?.samples ?? live[m] ?? [];
              const status = r
                ? uploadVerdict(r).ok
                  ? CheckStatus.SUCCESS
                  : CheckStatus.FAILED
                : running === UPLOAD_LABEL[m]
                  ? CheckStatus.RUNNING
                  : CheckStatus.IDLE;
              return (
                <ResultRow key={m} label={UPLOAD_LABEL[m]} status={status}>
                  {r && (
                    <li className="text-stone-300">
                      {uploadVerdict(r).text}。経路 {r.path}、往復遅延 中央 {r.medianRttMs ?? '-'} ms・最大{' '}
                      {r.maxRttMs ?? '-'} ms、受信の報告の途絶 最大 {r.maxAckGapSec} 秒
                      {r.reconnectAtSec.length > 0 &&
                        `、再接続 ${r.reconnectAtSec.join(', ')} 秒（測定開始 ${r.measureStartSec ?? '-'} 秒）`}
                    </li>
                  )}
                  {samples.length > 0 && (
                    <li className="font-mono text-xs tabular-nums text-stone-500">{formatSamples(samples)}</li>
                  )}
                </ResultRow>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}

const STATUS_STYLE: Record<CheckStatus, string> = {
  [CheckStatus.IDLE]: 'text-stone-500',
  [CheckStatus.RUNNING]: 'text-sky-300',
  [CheckStatus.SKIPPED]: 'text-stone-400',
  [CheckStatus.SUCCESS]: 'text-emerald-400',
  [CheckStatus.FAILED]: 'text-red-400',
};

function ResultRow({
  label,
  status,
  children,
}: {
  label: string;
  status: CheckStatus;
  children?: React.ReactNode;
}) {
  return (
    <li className="rounded-md border border-stone-800 bg-stone-900/60 px-4 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-medium text-stone-100">{label}</span>
        <span className={`shrink-0 text-sm font-semibold ${STATUS_STYLE[status]}`}>{STATUS_TEXT[status]}</span>
      </div>
      {children && <ul className="mt-1.5 space-y-0.5 text-xs leading-relaxed">{children}</ul>}
    </li>
  );
}
