import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-guard';

/**
 * 通話中の劣化と、映像の一時停止・TURN/TLS への自動切り替えの結果を記録する (lib/uplink-watchdog.ts)。
 *
 * Vercel のログは数時間で読めなくなるため、CALL_INCIDENT_WEBHOOK_URL があれば Discord にも送る。
 * 受け取るのは決めた項目の数値と短い文字列だけ。映像・音声・IP アドレスは扱わない。
 */
const MAX_BODY_CHARS = 2_000;
const EVENTS = ['stalled', 'switched', 'recovered', 'video-paused', 'video-resumed'] as const;
const REASONS: Record<string, string> = {
  quality: '接続品質が Poor 以下',
  rtt: '往復遅延が 1 秒以上',
  'no-ack': 'サーバーの受信報告が戻らない',
};
type IncidentEvent = (typeof EVENTS)[number];

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: 'too large' }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const event = EVENTS.find((e) => e === body.type);
  if (!event) return NextResponse.json({ error: 'unknown event' }, { status: 400 });

  const incident = {
    event,
    user: auth.session.displayName,
    role: auth.session.role,
    room: str(body.room, 40),
    path: str(body.path, 60),
    rttMs: num(body.rttMs),
    stalledSec: num(body.stalledSec),
    pausedSec: num(body.pausedSec),
    reason: str(body.reason, 20),
    quality: str(body.quality, 20),
    willSwitch: typeof body.willSwitch === 'boolean' ? body.willSwitch : null,
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    error: str(body.error, 200),
    ua: request.headers.get('user-agent')?.slice(0, 200) ?? null,
  };
  console.info('[call-incident]', JSON.stringify(incident));

  const webhook = process.env.CALL_INCIDENT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 表示名に @ が含まれても誰にも通知が飛ばないようにする
        body: JSON.stringify({ content: formatMessage(incident), allowed_mentions: { parse: [] } }),
      });
    } catch (e) {
      console.warn('[call-incident] webhook failed', e instanceof Error ? e.message : e);
    }
  }
  return NextResponse.json({ ok: true });
}

function formatMessage(i: {
  event: IncidentEvent;
  user: string;
  role: string;
  room: string | null;
  path: string | null;
  rttMs: number | null;
  stalledSec: number | null;
  pausedSec: number | null;
  reason: string | null;
  quality: string | null;
  willSwitch: boolean | null;
  ok: boolean | null;
  error: string | null;
  ua: string | null;
}): string {
  const who = `${i.user}（${i.role === 'instructor' ? '講師' : '受講生'}・${i.room ?? '-'}）`;
  const at = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const browser = /Edg\/[\d.]+|Chrome\/[\d.]+|Firefox\/[\d.]+|Version\/[\d.]+ Safari/.exec(i.ua ?? '')?.[0] ?? '不明';
  const detail = `経路 ${i.path ?? '不明'}・品質 ${i.quality ?? '-'}・往復遅延 ${i.rttMs ?? '-'} ms・${browser}`;
  const why = i.reason ? (REASONS[i.reason] ?? i.reason) : '理由不明';
  switch (i.event) {
    case 'stalled':
      return `🔴 ${at} ${who} の接続が ${i.stalledSec ?? '?'} 秒劣化しています（${why}）。${detail}。` +
        (i.willSwitch ? 'TLS 中継へ切り替えます。' : '（切り替えは済み、または TLS 中継で使用中）');
    case 'switched':
      return i.ok
        ? `🟢 ${at} ${who} TLS 中継へ切り替え、届くようになりました。${detail}`
        : `🟠 ${at} ${who} TLS 中継へ切り替えましたが、まだ劣化しています。${detail}` +
            (i.error ? `（${i.error}）` : '');
    case 'recovered':
      return `🟢 ${at} ${who} 接続が ${i.stalledSec ?? '?'} 秒ぶりに戻りました。${detail}`;
    case 'video-paused':
      return `🟡 ${at} ${who} のカメラ映像を止め、音声を優先しました（${why}）。${detail}`;
    case 'video-resumed':
      return i.error
        ? `🟠 ${at} ${who} のカメラ映像を ${i.pausedSec ?? '?'} 秒ぶりに戻そうとして失敗しました（${i.error}）。${detail}`
        : `🟢 ${at} ${who} のカメラ映像を ${i.pausedSec ?? '?'} 秒ぶりに戻しました。${detail}`;
  }
}
