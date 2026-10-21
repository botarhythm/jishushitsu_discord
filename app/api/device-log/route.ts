import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-guard';

/**
 * 参加者端末のマイク/カメラの失敗をサーバーログ (Vercel の Runtime Logs) に残す。
 *
 * スマホの不具合は手元で再現できず、端末のコンソールも見られないため、
 * ブラウザが返したエラー名・端末の権限状態・機器の一覧をここで受けて記録する。
 * `vercel logs` で `[device-log]` を検索して読む。保存はしない。
 */
const MAX_BODY_CHARS = 8_000;

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: 'too large' }, { status: 413 });
  }
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  console.info(
    '[device-log]',
    JSON.stringify({
      user: auth.session.displayName,
      role: auth.session.role,
      ua: request.headers.get('user-agent'),
      report,
    })
  );
  return NextResponse.json({ ok: true });
}
