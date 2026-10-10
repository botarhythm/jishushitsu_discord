import { NextRequest, NextResponse } from 'next/server';
import { requireInstructor } from '@/lib/auth-guard';
import {
  DEFAULT_INVITE_TTL_HOURS,
  isInviteTtlHours,
  issueInviteToken,
} from '@/lib/invite-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IssueBody {
  ttlHours?: unknown;
}

/**
 * 招待リンクを発行する (Discord 講師セッション必須)。
 *
 * - role は student 固定 (講師権限をリンクで共有しない)
 * - リンクは講師が今いる回 (セッションの space) に固定される
 * - 期限は body.ttlHours で選ぶ (INVITE_TTL_CHOICES_HOURS のいずれか。既定 24h)
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  const body: IssueBody = await request.json().catch(() => ({}));
  if (body.ttlHours !== undefined && !isInviteTtlHours(body.ttlHours)) {
    return NextResponse.json({ error: 'ttlHours が不正です' }, { status: 400 });
  }
  const ttlHours = isInviteTtlHours(body.ttlHours) ? body.ttlHours : DEFAULT_INVITE_TTL_HOURS;
  const space = auth.session.space ?? '';

  const { token, expiresAt } = await issueInviteToken({
    role: 'student',
    space,
    ttlHours,
  });
  const origin = request.nextUrl.origin;
  // openExternalBrowser=1 は LINE アプリ内ブラウザの公式パラメータで、リンクを
  // タップした時点で端末の既定ブラウザ (Chrome/Safari) で開かせる。LINE の WebView は
  // カメラ/マイク権限を仲介できず参加に失敗するため、招待リンクには常に付与する。
  // LINE 以外のアプリ・ブラウザではこのパラメータは単に無視される (join ページは
  // クエリを読まない)。
  const url = `${origin}/join/${token}?openExternalBrowser=1`;

  return NextResponse.json({ url, expiresAt, ttlHours, space });
}
