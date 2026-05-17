import { NextRequest, NextResponse } from 'next/server';
import { resolveEchoNoteEndpointByDiscordId } from '@/lib/echonote';
import { requireInstructor } from '@/lib/auth-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 自習室で録音した音声を、講師ごとの EchoNote へ転送するサーバープロキシ。
 *
 * 認証: session Cookie (instructor 必須)
 * クライアントはマルチパートで以下を送る:
 *   - file:         音声 Blob（webm/opus 等）
 *   - clientName:   任意（クライアント名 / 受講者名 / セッション名）
 *   - memo:         任意（補足）
 *   - sessionDate:  任意（YYYYMMDD）
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'multipart/form-data が必要です' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file フィールドが必要です' }, { status: 400 });
  }

  const endpoint = resolveEchoNoteEndpointByDiscordId(auth.session.discordId);
  if (!endpoint) {
    return NextResponse.json(
      {
        error:
          'EchoNoteが未設定です。INSTRUCTOR_<N>_DISCORD_ID にこの講師の Discord User ID を設定し、URL/TOKENを併設してください。',
      },
      { status: 412 }
    );
  }

  // EchoNote へ転送する form を組み直す
  const forward = new FormData();
  forward.append('file', file, file.name || 'recording.webm');
  forward.append('source', 'digihara_jishushitsu');
  forward.append('clientName', form.get('clientName')?.toString() || '自習室');
  const memo = form.get('memo')?.toString();
  if (memo) forward.append('memo', memo);
  const sessionDate = form.get('sessionDate')?.toString();
  if (sessionDate) forward.append('sessionDate', sessionDate);

  try {
    const url = new URL('/api/ingest', endpoint.url).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}` },
      body: forward,
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      return NextResponse.json(
        { error: data?.error || `EchoNote転送に失敗しました (HTTP ${res.status})`, detail: data },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[echonote-upload] forward error:', err);
    return NextResponse.json(
      { error: `EchoNoteへの接続に失敗しました: ${msg}` },
      { status: 502 }
    );
  }
}
