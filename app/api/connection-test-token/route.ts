import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { requireSession } from '@/lib/auth-guard';
import { livekitIdentityFor } from '@/lib/session';

/**
 * 接続テスト (/connection-test) 専用の LiveKit トークンを発行する。
 *
 * 本番の部屋 (main / bo-N / <回>--…) とは名前が重ならない使い捨ての部屋に入る。
 * identity も本番と分けるので、通話中に実行しても DUPLICATE_IDENTITY で
 * 本人の通話が切られることはない。
 */
export async function POST() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const { session } = auth;
  const suffix = crypto.randomUUID().slice(0, 8);
  const room = `conntest-${suffix}`;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: `${livekitIdentityFor(session)}#conntest-${suffix}`,
    name: `${session.displayName.substring(0, 20)}（接続テスト）`,
    ttl: '15m',
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });

  return NextResponse.json({ token: await at.toJwt(), livekitUrl, room });
}
