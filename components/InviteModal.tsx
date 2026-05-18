'use client';

import { useEffect, useState } from 'react';

interface InviteModalProps {
  onClose: () => void;
}

interface ChannelStatus {
  discord: boolean;
  slack: boolean;
}

interface InviteTokenResponse {
  url: string;
  expiresAt: number;
}

/**
 * セッション中に講師が受講生を招待するためのモーダル。
 * - 招待リンクは `/api/invite-token` で都度発行 (1 回限り・約 2h で失効)
 * - 受講生は Discord 認証不要、リンク先で名前入力すれば入室できる
 * - メッセージを編集して、メール / Discord / Slack / コピー のいずれかで送信できる
 */
export function InviteModal({ onClose }: InviteModalProps) {
  const [participantUrl, setParticipantUrl] = useState<string>('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const [status, setStatus] = useState<ChannelStatus>({ discord: false, slack: false });
  const [busy, setBusy] = useState<null | 'discord' | 'slack' | 'copy'>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/invite')
      .then((r) => r.json())
      .then((d: ChannelStatus) => setStatus(d))
      .catch(() => setStatus({ discord: false, slack: false }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/invite-token', { method: 'POST' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || `招待リンクの発行に失敗 (${res.status})`);
        }
        const data: InviteTokenResponse = await res.json();
        if (cancelled) return;
        setParticipantUrl(data.url);
        setMessage(buildDefaultMessage(data.url));
      } catch (err) {
        if (cancelled) return;
        setTokenError(err instanceof Error ? err.message : '招待リンクの発行に失敗しました');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sendVia = async (method: 'discord' | 'slack') => {
    setBusy(method);
    setFeedback(null);
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFeedback({
        ok: true,
        text: `${method === 'discord' ? 'Discord' : 'Slack'} に送信しました`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedback({ ok: false, text: msg });
    } finally {
      setBusy(null);
    }
  };

  const sendViaMail = () => {
    const subject = encodeURIComponent('【デジタル原っぱ大学 自習室】参加のご案内');
    const body = encodeURIComponent(message);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const copyMessage = async () => {
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(message);
      setFeedback({ ok: true, text: 'クリップボードにコピーしました' });
    } catch {
      setFeedback({ ok: false, text: 'コピーに失敗しました' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-8 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-stone-900">受講生を招待</h2>
            <p className="text-xs text-stone-500">
              このリンクは 1 回限り (退出すると無効) です
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-stone-400 hover:bg-stone-100"
            aria-label="閉じる"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {tokenError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {tokenError}
          </div>
        ) : !participantUrl ? (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
            招待リンクを発行中…
          </div>
        ) : (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={7}
            className="w-full rounded-lg border border-stone-300 bg-white p-3 text-sm font-mono text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ActionButton
            onClick={sendViaMail}
            icon="✉️"
            label="メール"
            disabled={!participantUrl}
          />
          <ActionButton
            onClick={() => sendVia('discord')}
            icon="💬"
            label="Discord"
            disabled={!participantUrl || !status.discord || busy !== null}
            busy={busy === 'discord'}
            disabledHint={!status.discord ? '未設定' : undefined}
          />
          <ActionButton
            onClick={() => sendVia('slack')}
            icon="💼"
            label="Slack"
            disabled={!participantUrl || !status.slack || busy !== null}
            busy={busy === 'slack'}
            disabledHint={!status.slack ? '未設定' : undefined}
          />
          <ActionButton
            onClick={copyMessage}
            icon="📋"
            label="コピー"
            busy={busy === 'copy'}
            disabled={!participantUrl || busy !== null}
          />
        </div>

        {feedback && (
          <p
            className={`mt-3 text-xs ${
              feedback.ok ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {feedback.text}
          </p>
        )}

        {!status.discord && !status.slack && (
          <p className="mt-3 text-[11px] text-stone-400">
            Discord / Slack 連携は <code>DISCORD_WEBHOOK_URL</code> /{' '}
            <code>SLACK_WEBHOOK_URL</code> を環境変数で設定すると有効化されます。
          </p>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
  disabled,
  busy,
  disabledHint,
}: {
  onClick: () => void;
  icon: string;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  disabledHint?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center gap-1 rounded-lg border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 active:scale-95"
      title={disabledHint}
    >
      <span className="text-lg leading-none">{icon}</span>
      <span>{busy ? '送信中…' : label}</span>
      {disabledHint && <span className="text-[10px] text-stone-400">{disabledHint}</span>}
    </button>
  );
}

function buildDefaultMessage(participantUrl: string): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `【デジタル原っぱ大学 自習室のお知らせ】

日時: ${yyyy}-${mm}-${dd}
参加URL (1 回限り・退出後は無効): ${participantUrl}

リンクを開いてお名前を入力するとご参加いただけます。
ブラウザのマイク・カメラ権限を許可してください（推奨ブラウザ: Chrome 最新版）。`;
}
