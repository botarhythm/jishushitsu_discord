'use client';

import { useEffect, useState } from 'react';

interface InviteModalProps {
  participantUrl: string;
  onClose: () => void;
}

interface ChannelStatus {
  discord: boolean;
  slack: boolean;
}

/**
 * セッション中に講師が受講生を招待するためのモーダル。
 * メッセージを編集して、メール / Discord / Slack / コピー のいずれかで送信できる。
 */
export function InviteModal({ participantUrl, onClose }: InviteModalProps) {
  // 親が条件レンダリングで unmount するため、開く度に lazy init で fresh state になる。
  const [message, setMessage] = useState(() => buildDefaultMessage(participantUrl));
  const [status, setStatus] = useState<ChannelStatus>({ discord: false, slack: false });
  const [busy, setBusy] = useState<null | 'discord' | 'slack' | 'copy'>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    // 設定状態(Discord/Slack webhook)を取得。setState は async callback 内なので
    // react-hooks/set-state-in-effect には抵触しない。
    fetch('/api/invite')
      .then((r) => r.json())
      .then((d: ChannelStatus) => setStatus(d))
      .catch(() => setStatus({ discord: false, slack: false }));
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
              メッセージを編集して、お好きな方法で送信できます
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

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={7}
          className="w-full rounded-lg border border-stone-300 bg-white p-3 text-sm font-mono text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ActionButton onClick={sendViaMail} icon="✉️" label="メール" />
          <ActionButton
            onClick={() => sendVia('discord')}
            icon="💬"
            label="Discord"
            disabled={!status.discord || busy !== null}
            busy={busy === 'discord'}
            disabledHint={!status.discord ? '未設定' : undefined}
          />
          <ActionButton
            onClick={() => sendVia('slack')}
            icon="💼"
            label="Slack"
            disabled={!status.slack || busy !== null}
            busy={busy === 'slack'}
            disabledHint={!status.slack ? '未設定' : undefined}
          />
          <ActionButton
            onClick={copyMessage}
            icon="📋"
            label="コピー"
            busy={busy === 'copy'}
            disabled={busy !== null}
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
参加URL: ${participantUrl}

お名前を入力してご参加ください。
ブラウザのマイク・カメラ権限を許可してください（推奨ブラウザ: Chrome 最新版）。`;
}
