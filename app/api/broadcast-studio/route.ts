import { NextRequest, NextResponse } from 'next/server';
import { RoomServiceClient } from 'livekit-server-sdk';
import { requireInstructor } from '@/lib/auth-guard';

const KNOWN_LAYOUTS = new Set(['split', 'screen-main', 'solo', 'speaker', 'trio', 'triple']);
const MAX_SLOTS = 8;
const MAX_TOKEN_LENGTH = 256;
const MAX_BODY_BYTES = 8 * 1024;

interface AiDescriptorBody {
  id: string;
  ownerIdentity: string;
  trackName: string;
  displayName: string;
  avatar: string;
  providerKind: string;
}

interface BroadcastStudioRequest {
  /** 配信先ルーム（= 講師の現在ルーム） */
  roomName: string;
  /** 収録/講演モードを有効化するか（false で参加者のロックを解除） */
  active: boolean;
  layout: string;
  /** スロット順に並べた出演者トークン。null は空きスロット */
  slots: (string | null)[];
  showNameplates: boolean;
  /** 下段に視聴者サムネを表示するか（録画には含めない、表示のみ） */
  showAudience: boolean;
  /** 設定したホストの identity。受信側で自分の設定を無視する（ホストは studioMode で制御）のに使う */
  senderIdentity?: string;
  /**
   * v2 フィールド。schemaVersion が無い payload は旧クライアント (legacy) として
   * 従来どおり受理する（既存保護戦略）。
   */
  schemaVersion?: number;
  /** 単調増加のリビジョン。旧タブ・並行更新による巻き戻し上書きを拒否する */
  revision?: number;
  /** AI 参加者の記述子（AI 無効時は null/未指定） */
  ai?: AiDescriptorBody | null;
}

function validateAiDescriptor(ai: unknown): ai is AiDescriptorBody {
  if (!ai || typeof ai !== 'object') return false;
  const a = ai as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id || a.id.length > 64) return false;
  if (typeof a.ownerIdentity !== 'string' || !a.ownerIdentity || a.ownerIdentity.length > 128) return false;
  if (typeof a.trackName !== 'string' || a.trackName !== `ai-audio:${a.id}`) return false;
  if (typeof a.displayName !== 'string' || !a.displayName || a.displayName.length > 64) return false;
  if (typeof a.avatar !== 'string' || a.avatar.length > 16) return false;
  if (a.providerKind !== 'desktop') return false;
  return true;
}

function validateV2(body: BroadcastStudioRequest): string | null {
  if (!KNOWN_LAYOUTS.has(body.layout)) return `未知の layout: ${body.layout}`;
  if (!Array.isArray(body.slots) || body.slots.length > MAX_SLOTS) return 'slots が不正です';
  for (const s of body.slots) {
    if (s !== null && (typeof s !== 'string' || s.length > MAX_TOKEN_LENGTH)) {
      return 'slots に不正なトークンが含まれています';
    }
  }
  if (body.ai != null) {
    if (!validateAiDescriptor(body.ai)) return 'ai descriptor が不正です';
    // descriptor の整合: ai スロットトークンが descriptor.id と一致すること
    const aiTokens = body.slots.filter((s): s is string => !!s?.startsWith('ai:'));
    for (const t of aiTokens) {
      if (t !== `ai:${body.ai.id}`) return `未知の AI トークン: ${t}`;
    }
  } else {
    if (body.slots.some((s) => s?.startsWith('ai:'))) {
      return 'ai descriptor なしで AI トークンが slots に含まれています';
    }
  }
  if (body.revision != null && (typeof body.revision !== 'number' || !Number.isFinite(body.revision))) {
    return 'revision が不正です';
  }
  return null;
}

/**
 * 講師（ホスト）の収録/講演コンポジションをルーム内の全参加者へ強制配信する。
 *
 * 状態は LiveKit の **room metadata** に保存する。
 * データチャネル（sendData/publishData）の一発プッシュは、送信時に受信パスが未確立の
 * 後から入室した参加者を取りこぼし、再送もされない（次の設定変更まで届かない）。
 * room metadata なら参加者は接続時に現在値を必ず取得でき、変更は RoomMetadataChanged で
 * 全員へ再配布されるため、後入室・再接続でも確実に同期する。
 *
 * v2: payload の shape 検証・revision による巻き戻り拒否・既存 metadata との merge を行う
 * （認証強化ではなく状態破壊防止。送信者の身元確定は別課題）。
 */
export async function POST(request: NextRequest) {
  const auth = await requireInstructor();
  if (!auth.ok) return auth.response;

  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'payload が大きすぎます' }, { status: 413 });
    }
    const body: BroadcastStudioRequest = JSON.parse(raw);
    const { roomName, active, layout, slots, showNameplates, showAudience, senderIdentity } = body;

    if (!roomName || typeof roomName !== 'string' || roomName.length > 64) {
      return NextResponse.json({ error: 'roomName が必要です' }, { status: 400 });
    }

    const isV2 = typeof body.schemaVersion === 'number';
    if (isV2) {
      if (body.schemaVersion !== 2) {
        return NextResponse.json(
          { error: `未対応の schemaVersion: ${body.schemaVersion}` },
          { status: 400 }
        );
      }
      if (active) {
        const err = validateV2(body);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
    }

    const apiKey = process.env.LIVEKIT_API_KEY!;
    const apiSecret = process.env.LIVEKIT_API_SECRET!;
    const livekitUrl = process.env.LIVEKIT_URL!;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

    // 既存 metadata を parse し、`studio` キーだけを merge 更新する（全上書きしない）。
    // 併せて revision の巻き戻り（旧タブ・並行更新による古い payload）を拒否する。
    let existing: Record<string, unknown> = {};
    let existingRevision: number | null = null;
    try {
      const rooms = await roomService.listRooms([roomName]);
      const current = rooms[0]?.metadata;
      if (current) {
        existing = JSON.parse(current) as Record<string, unknown>;
        const st = existing.studio as { revision?: number } | null | undefined;
        if (st && typeof st.revision === 'number') existingRevision = st.revision;
      }
    } catch {
      // metadata が未設定/非JSON の場合は空から開始
      existing = {};
    }

    if (
      isV2 &&
      typeof body.revision === 'number' &&
      existingRevision !== null &&
      body.revision <= existingRevision
    ) {
      return NextResponse.json(
        { error: 'conflict', detail: 'より新しい studio 状態が既に配信されています' },
        { status: 409 }
      );
    }

    const metadata = JSON.stringify({
      ...existing,
      studio: active
        ? {
            active: true,
            layout,
            slots,
            showNameplates: !!showNameplates,
            showAudience: !!showAudience,
            host: senderIdentity ?? null,
            ...(isV2
              ? {
                  schemaVersion: 2,
                  revision: body.revision ?? null,
                  ai: body.ai ?? null,
                }
              : {}),
          }
        : null,
    });

    await roomService.updateRoomMetadata(roomName, metadata);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Broadcast studio error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
