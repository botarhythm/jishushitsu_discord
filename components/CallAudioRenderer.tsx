'use client';

import { AudioTrack, useLocalParticipant, useTracks } from '@livekit/components-react';
import { Track, type Participant } from 'livekit-client';
import { isAiLiveKitIdentity } from '@/lib/ai/livekit-participant';

function aiOwnerIdentity(participant: Participant): string | null {
  try {
    return (JSON.parse(participant.metadata ?? '{}') as { ownerIdentity?: string }).ownerIdentity ?? null;
  } catch {
    return null;
  }
}

/**
 * 通話音声の再生。LiveKit の RoomAudioRenderer と同じトラック集合を再生し、
 * 自分が起動した ChatGPT の音声だけ音量を制御できるようにしたもの。
 *
 * ChatGPT を起動した講師 PC では、Windows の「このデバイスを聴く」で ChatGPT の声を
 * 直接モニタしている (monitorAiLocally=false) ことがある。そこへ LiveKit 経由の
 * 同じ声を重ねると遅延つきで二重に聞こえ、スピーカー使用時は物理マイク → VoiceMeeter
 * → ChatGPT の耳へ回り込んで自己ループになる (FR-004)。
 *
 * 音量 0 は RoomAudioRenderer 外から RemoteAudioTrack.setVolume(0) を呼ぶ方式では
 * 効かない: attach 前に呼ぶと livekit-client の `if (this.elementVolume)` が 0 を
 * 偽として扱い、後から attach された audio 要素へ適用されない。AudioTrack の volume
 * prop は attach と同じコミットの後続 effect で適用されるため、こちらを使う。
 * muted (= 購読停止) は使わない — 録画が同じ MediaStreamTrack を読むため。
 */
export function CallAudioRenderer({ silenceOwnAi }: { silenceOwnAi: boolean }) {
  const { localParticipant } = useLocalParticipant();
  const tracks = useTracks(
    [Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown],
    { updateOnlyOn: [], onlySubscribed: true }
  ).filter((ref) => !ref.participant.isLocal && ref.publication.kind === Track.Kind.Audio);

  return (
    <div style={{ display: 'none' }}>
      {tracks.map((trackRef) => {
        const isAi = isAiLiveKitIdentity(trackRef.participant.identity);
        const silenced =
          isAi &&
          silenceOwnAi &&
          aiOwnerIdentity(trackRef.participant) === localParticipant.identity;
        return (
          <AudioTrack
            key={`${trackRef.participant.identity}:${trackRef.publication.trackSid}`}
            trackRef={trackRef}
            // AI 以外は RoomAudioRenderer と同じく未指定。AI は 0/1 を明示する
            // (undefined に戻すと effect が何もしないため、0 のまま残る)
            volume={isAi ? (silenced ? 0 : 1) : undefined}
          />
        );
      })}
    </div>
  );
}
