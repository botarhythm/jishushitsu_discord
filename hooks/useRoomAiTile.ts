'use client';

import { useParticipants, useRoomContext } from '@livekit/components-react';
import { isAiLiveKitIdentity } from '@/lib/ai/livekit-participant';
import { aiAudioTrackName, type AiTileState } from '@/lib/studio-participants';
import { AI_PARTICIPANT_ID, useRemoteAiTile } from './useAiParticipant';

/** AIを起動したPCや収録ホストに依存せず、同じルームのAIを表示する。 */
export function useRoomAiTile(localTile?: AiTileState | null): AiTileState | null {
  const room = useRoomContext();
  const participants = useParticipants();
  const ai = participants.find((participant) => isAiLiveKitIdentity(participant.identity));
  const remoteTile = useRemoteAiTile(room, ai ? {
    id: AI_PARTICIPANT_ID,
    ownerIdentity: ai.identity,
    trackName: aiAudioTrackName(AI_PARTICIPANT_ID),
    displayName: ai.name?.trim() || 'ChatGPT',
    avatar: '🤖',
    providerKind: 'desktop',
  } : null);
  return localTile ?? remoteTile;
}
