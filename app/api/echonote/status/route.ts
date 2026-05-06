import { NextRequest, NextResponse } from 'next/server';
import { resolveEchoNoteEndpoint } from '@/lib/echonote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 講師の EchoNote 設定状態を返す（UI で「録音→要約に対応」表示の判定用）。
 *
 * リクエスト: POST { instructorKey }
 * レスポンス: { configured: boolean, instructorName?: string }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const instructorKey = typeof body?.instructorKey === 'string' ? body.instructorKey : '';
  const endpoint = resolveEchoNoteEndpoint(instructorKey);
  if (!endpoint) {
    return NextResponse.json({ configured: false });
  }
  return NextResponse.json({ configured: true, instructorName: endpoint.instructorName });
}
