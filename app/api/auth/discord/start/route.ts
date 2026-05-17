import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { buildAuthorizationUrl } from '@/lib/discord';
import { setOAuthStateCookie } from '@/lib/session';

/**
 * Discord OAuth2 開始エンドポイント。
 * ランダムなstateを発行してCookieに保存し、Discord認可URLへリダイレクトする。
 */
export async function GET(request: NextRequest) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: 'Server configuration error: DISCORD_CLIENT_ID missing' },
      { status: 500 }
    );
  }

  const origin = request.nextUrl.origin;
  const redirectUri = `${origin}/api/auth/discord/callback`;

  const state = randomBytes(24).toString('hex');
  await setOAuthStateCookie(state);

  const authorizeUrl = buildAuthorizationUrl({ clientId, redirectUri, state });

  return NextResponse.redirect(authorizeUrl);
}
