'use client';

import { useEffect, useState } from 'react';

interface InviteModalProps {
  onClose: () => void;
}

interface InviteTokenResponse {
  url: string;
  expiresAt: number;
  space: string;
}

const TTL_CHOICES = [2, 6, 24, 72] as const;
type TtlHours = (typeof TTL_CHOICES)[number];
const DEFAULT_TTL: TtlHours = 24;

/**
 * セッション中に講師が参加者を招待するためのモーダル。
 * - 招待リンクは `/api/invite-token` で発行する。期限は 2h / 6h / 24h / 72h から選ぶ
 * - 1 人 1 リンク。同じリンクで入り直せる。無効にするときは参加者を退出させる操作から行う
 * - リンクは講師が今いる「回」に固定される。授業と収録は回を分ける
 * - 参加者は Discord 認証不要、リンク先で名前入力すれば入室できる
 */
export function InviteModal({ onClose }: InviteModalProps) {
  const [participantUrl, setParticipantUrl] = useState<string>('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [message, setMessage] = useState<string>('');
  const [copying, setCopying] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [ttlHours, setTtlHours] = useState<TtlHours>(DEFAULT_TTL);
  const [issuing, setIssuing] = useState(false);
  const [space, setSpace] = useState<string | null>(null);
  const [spaceDraft, setSpaceDraft] = useState('');
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [switchingSpace, setSwitchingSpace] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/space')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { space: string }) => {
        if (cancelled) return;
        setSpace(d.space);
        setSpaceDraft(d.space);
      })
      .catch(() => {
        if (!cancelled) setSpace('');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const issueLink = async () => {
    setIssuing(true);
    setTokenError(null);
    setFeedback(null);
    try {
      const res = await fetch('/api/invite-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlHours }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `招待リンクの発行に失敗 (${res.status})`);
      }
      const data: InviteTokenResponse = await res.json();
      setParticipantUrl(data.url);
      setMessage(buildDefaultMessage(data.url, data.expiresAt));
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : '招待リンクの発行に失敗しました');
    } finally {
      setIssuing(false);
    }
  };

  const switchSpace = async () => {
    const next = spaceDraft.trim().toLowerCase();
    if (next === space) return;
    if (
      !confirm(
        `回を「${next || '既定'}」に切り替えます。\n` +
          'いったん退室して、新しい回の部屋に入り直します。よろしいですか？'
      )
    ) {
      return;
    }
    setSwitchingSpace(true);
    setSpaceError(null);
    try {
      const res = await fetch('/api/space', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ space: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `回の切り替えに失敗 (${res.status})`);
      }
      window.location.reload();
    } catch (err) {
      setSpaceError(err instanceof Error ? err.message : '回の切り替えに失敗しました');
      setSwitchingSpace(false);
    }
  };

  const sendViaMail = () => {
    const subject = encodeURIComponent('【デジタル原っぱ大学 自習室】参加のご案内');
    const body = encodeURIComponent(message);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  };

  const copyMessage = async () => {
    setCopying(true);
    try {
      await navigator.clipboard.writeText(message);
      setFeedback({ ok: true, text: 'クリップボードにコピーしました' });
    } catch {
      setFeedback({ ok: false, text: 'コピーに失敗しました' });
    } finally {
      setCopying(false);
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
            <h2 className="text-base font-bold text-stone-900">参加者を招待</h2>
            <p className="text-xs text-stone-500">
              1 人に 1 リンクを渡してください。同じリンクで入り直せます
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

        <section className="mb-4 rounded-lg border border-stone-200 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-stone-700">回</span>
            <span className="text-xs text-stone-500">
              いま: {space === null ? '確認中…' : space || '既定 (授業)'}
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={spaceDraft}
              onChange={(e) => setSpaceDraft(e.target.value)}
              placeholder="例: podcast-1010 (空欄で既定)"
              maxLength={32}
              aria-label="回ID"
              className="min-w-0 flex-1 rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-mono text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <button
              onClick={switchSpace}
              disabled={
                space === null || switchingSpace || spaceDraft.trim().toLowerCase() === space
              }
              className="shrink-0 rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {switchingSpace ? '切り替え中…' : 'この回に切り替え'}
            </button>
          </div>
          <p className="mt-2 text-[11px] text-stone-500">
            リンクは今いる回に固定されます。授業と収録は回を分けてください (英小文字・数字・ハイフン)。
          </p>
          {spaceError && <p className="mt-1 text-xs text-red-600">{spaceError}</p>}
        </section>

        <div className="mb-3 flex items-center gap-2">
          <label htmlFor="invite-ttl" className="text-xs font-semibold text-stone-700">
            有効期限
          </label>
          <select
            id="invite-ttl"
            value={ttlHours}
            onChange={(e) => setTtlHours(Number(e.target.value) as TtlHours)}
            className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
          >
            {TTL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h} 時間
              </option>
            ))}
          </select>
          <button
            onClick={issueLink}
            disabled={issuing || switchingSpace}
            className="ml-auto rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {issuing ? '発行中…' : participantUrl ? 'もう 1 本発行' : 'リンクを発行'}
          </button>
        </div>

        {tokenError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {tokenError}
          </div>
        ) : !participantUrl ? (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm text-stone-500">
            期限を選んで「リンクを発行」を押してください
          </div>
        ) : (
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={7}
            className="w-full rounded-lg border border-stone-300 bg-white p-3 text-sm font-mono text-stone-800 focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <ActionButton
            onClick={sendViaMail}
            icon="✉️"
            label="メール"
            disabled={!participantUrl}
          />
          <ActionButton
            onClick={copyMessage}
            icon="📋"
            label="コピー"
            busy={copying}
            disabled={!participantUrl || copying}
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

        <p className="mt-3 text-[11px] text-stone-400">
          リンクをコピーして、Discord・メール・任意のチャットなど好きな場所に貼り付けて共有できます。
        </p>
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

function formatDateTime(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function buildDefaultMessage(participantUrl: string, expiresAt: number): string {
  return `【デジタル原っぱ大学 自習室のお知らせ】

参加URL (あなた専用・${formatDateTime(new Date(expiresAt * 1000))} まで有効): ${participantUrl}

リンクを開いてお名前を入力するとご参加いただけます。
ブラウザのマイク・カメラ権限を許可してください（推奨ブラウザ: Chrome 最新版）。`;
}
