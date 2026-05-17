import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCodeForToken,
  fetchCurrentUser,
  fetchGuildMember,
  resolveAvatarUrl,
  resolveDisplayName,
} from '@/lib/discord';
import {
  consumeOAuthStateCookie,
  setSessionCookie,
  signSession,
  type UserRole,
} from '@/lib/session';

/**
 * Discord OAuth2 callback。
 * 1. state を検証 (CSRF対策)
 * 2. code → access_token に交換
 * 3. /users/@me と /users/@me/guilds/{guild}/member を取得
 * 4. 対象guildのメンバーでなければ拒否
 * 5. 講師ロール所持で role=instructor、なければ student として session発行
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return redirectToError(request, `Discord認証がキャンセルされました (${errorParam})`);
  }
  if (!code || !state) {
    return redirectToError(request, '認可コードまたはstateが不正です');
  }

  const expectedState = await consumeOAuthStateCookie();
  if (!expectedState || expectedState !== state) {
    return redirectToError(request, 'stateが一致しません。もう一度ログインしてください');
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const guildId = process.env.DISCORD_GUILD_ID;
  const instructorRoleId = process.env.DISCORD_INSTRUCTOR_ROLE_ID;

  if (!clientId || !clientSecret || !guildId) {
    return redirectToError(request, 'サーバー設定エラー（Discord OAuth未設定）');
  }

  const redirectUri = `${url.origin}/api/auth/discord/callback`;

  try {
    const tokenRes = await exchangeCodeForToken({
      clientId,
      clientSecret,
      code,
      redirectUri,
    });

    const [user, member] = await Promise.all([
      fetchCurrentUser(tokenRes.access_token),
      fetchGuildMember(tokenRes.access_token, guildId),
    ]);

    if (!member) {
      return redirectToError(
        request,
        'このアカウントは対象のDiscordサーバーに参加していません'
      );
    }

    const role: UserRole =
      instructorRoleId && member.roles.includes(instructorRoleId)
        ? 'instructor'
        : 'student';

    const displayName = resolveDisplayName(user, member);
    const avatarUrl = resolveAvatarUrl(user);

    const jwt = await signSession({
      discordId: user.id,
      displayName,
      avatarUrl,
      role,
    });
    await setSessionCookie(jwt);

    return NextResponse.redirect(new URL('/room', url.origin));
  } catch (err) {
    console.error('[auth/callback] failed:', err);
    return redirectToError(request, '認証中にエラーが発生しました');
  }
}

function redirectToError(request: NextRequest, message: string): NextResponse {
  const url = new URL('/', request.nextUrl.origin);
  url.searchParams.set('auth_error', message);
  return NextResponse.redirect(url);
}
