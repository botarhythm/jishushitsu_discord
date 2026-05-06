import { NextRequest, NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';
import { TokenRequest, UserRole } from '@/lib/types';

const INSTRUCTOR_NAMES: Record<string, string> = {};

function getInstructorName(key: string): string | null {
  const motozawaKey = process.env.INSTRUCTOR_KEY_MOTOZAWA;
  const tsukakoshiKey = process.env.INSTRUCTOR_KEY_TSUKAKOSHI;
  if (motozawaKey && key === motozawaKey) return '元沢信昭';
  if (tsukakoshiKey && key === tsukakoshiKey) return '塚越暁';
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body: TokenRequest = await request.json();
    const { roomName, participantName, role, instructorKey } = body;

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !livekitUrl) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    if (!roomName || !participantName) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let resolvedName = participantName;
    let resolvedRole: UserRole = role ?? 'student';

    if (instructorKey) {
      const instructorName = getInstructorName(instructorKey);
      if (!instructorName) {
        return NextResponse.json({ error: 'Invalid instructor key' }, { status: 401 });
      }
      resolvedName = instructorName;
      resolvedRole = 'instructor';
    }

    // Sanitize name: strip tags and limit length
    resolvedName = resolvedName.replace(/<[^>]*>/g, '').substring(0, 20).trim();
    if (!resolvedName) {
      return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: resolvedName,
      name: resolvedName,
      metadata: JSON.stringify({ role: resolvedRole }),
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      ...(resolvedRole === 'instructor' && { roomAdmin: true }),
    });

    const token = await at.toJwt();

    return NextResponse.json({
      token,
      livekitUrl,
      participantName: resolvedName,
      role: resolvedRole,
    });
  } catch (error) {
    console.error('Token generation error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
