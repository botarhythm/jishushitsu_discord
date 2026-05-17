/**
 * Discord OAuth2 helper
 *
 * scope: identify (ユーザー情報) + guilds.members.read (特定guildでのrole確認)
 */

const DISCORD_API = 'https://discord.com/api';

export const DISCORD_OAUTH_SCOPES = ['identify', 'guilds.members.read'].join(' ');

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  /** 表示名 (Discord 2023+ の global_name 仕様) */
  global_name?: string | null;
  avatar?: string | null;
  discriminator?: string;
}

export interface DiscordGuildMember {
  /** メンバーが持つロールIDのリスト */
  roles: string[];
  user?: DiscordUser;
  nick?: string | null;
}

/** Discord 認可URL を組み立てる */
export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: 'code',
    scope: DISCORD_OAUTH_SCOPES,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    prompt: 'consent',
  });
  return `${DISCORD_API}/oauth2/authorize?${params.toString()}`;
}

/** 認可codeをaccess_tokenに交換 */
export async function exchangeCodeForToken(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

/** access_token でログイン中ユーザー情報を取得 */
export async function fetchCurrentUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /users/@me failed: ${res.status}`);
  }
  return res.json();
}

/**
 * 特定 guild における member 情報を取得。
 * 404 = そのguildのメンバーではない、として null を返す。
 */
export async function fetchGuildMember(
  accessToken: string,
  guildId: string
): Promise<DiscordGuildMember | null> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Discord guild member fetch failed: ${res.status}`);
  }
  return res.json();
}

/** 表示用の名前を確定 (global_name優先) */
export function resolveDisplayName(user: DiscordUser, member?: DiscordGuildMember | null): string {
  return (
    (member?.nick && member.nick.trim()) ||
    (user.global_name && user.global_name.trim()) ||
    user.username
  );
}

/** アバターURLを構築 (nullの場合は default avatar) */
export function resolveAvatarUrl(user: DiscordUser): string | undefined {
  if (!user.avatar) return undefined;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}
