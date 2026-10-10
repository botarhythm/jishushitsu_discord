import { NextRequest, NextResponse } from 'next/server';
import { requireInstructor, requireSession } from '@/lib/auth-guard';
import { getSessionExpiresAt, setSessionCookie, signSession } from '@/lib/session';
import { normalizeSpace } from '@/lib/space';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 現在の回を返す */
export async function GET() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;
  return NextResponse.json({ space: auth.session.space ?? '' });
}

/**
 * 講師が自分の回を切り替える (Discord 講師のみ)。
 * 切り替え後は /api/token が新しい回の部屋のトークンを返すので、クライアントは入り直す。
 * 招待リンクのゲストは自分の回を変えられない (リンクの回に固定)。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;
  if (auth.session.kind === 'guest') {
    return NextResponse.json({ error: '招待リンクの参加者は回を変更できません' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const space = normalizeSpace((body as { space?: unknown }).space);
  if (space === null) {
    return NextResponse.json(
      { error: '回ID は英小文字・数字・ハイフンで 32 文字までです' },
      { status: 400 }
    );
  }

  const expiresAt = await getSessionExpiresAt();
  const jwt = await signSession(
    { ...auth.session, space },
    expiresAt ? { expiresAt } : {}
  );
  await setSessionCookie(jwt);
  return NextResponse.json({ space });
}
