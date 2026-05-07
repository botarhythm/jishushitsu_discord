import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type InviteMethod = 'discord' | 'slack';

interface InviteBody {
  method?: string;
  message?: string;
}

/**
 * 自習室の招待メッセージを Discord/Slack の Webhook 経由で送信する。
 *
 * 設定:
 *   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy
 *   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
 *
 * メールは mailto: でクライアント完結、コピーはクライアントの clipboard API。
 */
export async function POST(request: NextRequest) {
  const body: InviteBody = await request.json().catch(() => ({}));
  const method = body.method as InviteMethod;
  const message = (body.message || '').toString().trim();

  if (!message) {
    return NextResponse.json({ error: 'message が空です' }, { status: 400 });
  }
  if (method !== 'discord' && method !== 'slack') {
    return NextResponse.json({ error: 'method は discord または slack' }, { status: 400 });
  }

  const webhookUrl =
    method === 'discord'
      ? process.env.DISCORD_WEBHOOK_URL
      : process.env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    return NextResponse.json(
      {
        error: `${method.toUpperCase()}_WEBHOOK_URL が未設定です。Webhookを作成して環境変数を設定してください。`,
      },
      { status: 412 }
    );
  }

  const payload =
    method === 'discord'
      ? { content: message, username: 'デジタル原っぱ大学 自習室' }
      : { text: message };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json(
        { error: `Webhook が ${res.status} を返しました: ${text.slice(0, 200)}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `送信に失敗: ${msg}` }, { status: 500 });
  }
}

/** 設定状態の取得（フロントから「設定済みかどうか」を判定するため） */
export async function GET() {
  return NextResponse.json({
    discord: !!process.env.DISCORD_WEBHOOK_URL,
    slack: !!process.env.SLACK_WEBHOOK_URL,
  });
}
