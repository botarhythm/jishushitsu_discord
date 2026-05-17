import { NextResponse } from 'next/server';
import { hasEchoNoteConfigForDiscordId } from '@/lib/echonote';
import { requireInstructor } from '@/lib/auth-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 講師の EchoNote 設定状態を返す（UI で「録音→要約に対応」表示の判定用）。
 * 認証は session Cookie。
 */
export async function POST() {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  const configured = hasEchoNoteConfigForDiscordId(auth.session.discordId);
  return NextResponse.json({
    configured,
    instructorName: auth.session.displayName,
  });
}
