import { NextRequest, NextResponse } from 'next/server';
import { resolveEchoNoteEndpoint } from '@/lib/echonote';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 自習室で録音した音声を、講師ごとの EchoNote へ転送するサーバープロキシ。
 *
 * クライアントはマルチパートで以下を送る:
 *   - file:         音声 Blob（webm/opus 等）
 *   - instructorKey: 講師認証キー（form フィールド・本文側）
 *   - clientName:   任意（クライアント名 / 受講者名 / セッション名）
 *   - memo:         任意（補足）
 *   - sessionDate:  任意（YYYYMMDD）
 *
 * サーバー側で:
 *   1. instructorKey から該当講師の EchoNote URL+token を引く
 *   2. EchoNote の /api/ingest に Bearer 付きで multipart 転送
 *   3. EchoNote のレスポンスをそのまま返す
 *
 * これにより EchoNote の ingest token はブラウザに露出しない。
 */
export async function POST(request: NextRequest) {
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

  const instructorKey = form.get('instructorKey')?.toString() || '';
  const endpoint = resolveEchoNoteEndpoint(instructorKey);
  if (!endpoint) {
    return NextResponse.json(
      {
        error:
          'EchoNoteが未設定です。あなたの講師アカウントに ECHONOTE_URL/ECHONOTE_TOKEN を環境変数で設定してください。',
      },
      { status: 412 }
    );
  }

  // EchoNote へ転送するための form を組み直す（instructorKey はサーバー内部のみで使い、外には渡さない）
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
      // EchoNote 側が JSON 以外を返した場合はそのまま raw として返す
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
