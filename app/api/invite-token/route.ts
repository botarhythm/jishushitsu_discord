import { NextRequest, NextResponse } from 'next/server';
import { requireInstructor } from '@/lib/auth-guard';
import { issueInviteToken, type InitialRecMode } from '@/lib/invite-token';
import type { UserRole } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface IssueBody {
  role?: string;
  initialRec?: string;
}

function isRole(v: unknown): v is UserRole {
  return v === 'instructor' || v === 'student';
}

function isInitialRec(v: unknown): v is InitialRecMode {
  return v === 'off' || v === 'audio' || v === 'screen' || v === 'both';
}

/**
 * 招待リンクを発行する。
 *
 * 2 つの認証経路:
 *   - Discord 講師セッション (Cookie) — 既存
 *   - サーバー間呼び出し (X-Service-Secret ヘッダー) — EchoNote 連携用
 *
 * サーバー間呼び出しでは role を任意に指定可能 (instructor / student)。
 * Discord 経由は student 固定 (講師が受講生を招待するシナリオ)。
 */
export async function POST(request: NextRequest) {
  const serviceSecret = process.env.SERVICE_SHARED_SECRET;
  const headerSecret = request.headers.get('x-service-secret');
  const isS2S = !!serviceSecret && !!headerSecret && headerSecret === serviceSecret;

  let role: UserRole = 'student';
  let initialRec: InitialRecMode = 'off';

  if (isS2S) {
    const body: IssueBody = await request.json().catch(() => ({}));
    if (isRole(body.role)) role = body.role;
    if (isInitialRec(body.initialRec)) initialRec = body.initialRec;
  } else {
    const auth = await requireInstructor();
    if (!auth.ok) return auth.response;
    // 講師セッションからの発行は student のみ (instructor を共有しない)
    role = 'student';
  }

  const { token, expiresAt } = await issueInviteToken({
    roomName: 'main',
    role,
    initialRec,
  });
  const origin = request.nextUrl.origin;
  const url = `${origin}/join/${token}`;

  return NextResponse.json({ url, token, expiresAt, role, initialRec });
}
