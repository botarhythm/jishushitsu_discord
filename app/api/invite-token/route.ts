import { NextRequest, NextResponse } from 'next/server';
import { requireInstructor } from '@/lib/auth-guard';
import { issueInviteToken } from '@/lib/invite-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 講師が「招待リンク」を発行する。
 * 受講生はこのリンクを開くと、Discord 認証不要で名前入力 → ルーム参加できる。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  const { token, expiresAt } = await issueInviteToken('main');
  const origin = request.nextUrl.origin;
  const url = `${origin}/join/${token}`;

  return NextResponse.json({ url, expiresAt });
}
