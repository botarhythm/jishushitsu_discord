export const AI_LIVEKIT_IDENTITY = 'ai-participant:chatgpt';
export const AI_PARTICIPANT_METADATA = {
  role: 'ai',
  kind: 'ai',
  avatar: '🤖',
} as const;

export function isAiLiveKitIdentity(identity: string): boolean {
  return identity === AI_LIVEKIT_IDENTITY;
}
