import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';

/** セッションCookieを削除してトップへ */
export async function POST(request: NextRequest) {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

/** GET でも叩けるようにしておく (リンク経由のログアウト用) */
export async function GET(request: NextRequest) {
  await clearSessionCookie();
  return NextResponse.redirect(new URL('/', request.nextUrl.origin));
}
