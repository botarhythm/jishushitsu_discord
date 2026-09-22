import { RoomEvent, Track, type Room, type RemoteTrack } from 'livekit-client';

// A preference, not a hard cap: the browser still handles network jitter and A/V sync.
const TARGET_DELAY_MS = 100;

/** Keep studio video responsive without changing audio or disabling adaptive streaming. */
export function configureStudioVideoPlayout(room: Room): () => void {
  const restores = new Map<RemoteTrack, () => void>();
  const previousStats = new Map<RemoteTrack, Map<string, RTCInboundRtpStreamStats>>();
  let disposed = false;
  let sampling = false;

  const attach = (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Video || restores.has(track)) return;
    const receiver = track.receiver;
    if (!receiver) return;
    try {
      if ('jitterBufferTarget' in receiver) {
        const previous = receiver.jitterBufferTarget;
        receiver.jitterBufferTarget = TARGET_DELAY_MS;
        restores.set(track, () => { receiver.jitterBufferTarget = previous; });
      } else if ('playoutDelayHint' in receiver) {
        const legacy = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
        const previous = legacy.playoutDelayHint;
        legacy.playoutDelayHint = TARGET_DELAY_MS / 1000;
        restores.set(track, () => { legacy.playoutDelayHint = previous; });
      } else {
        restores.set(track, () => {});
      }
    } catch (error) {
      console.warn('[studio-video] Could not request low-latency playout', error);
    }
  };
  const detach = (track: RemoteTrack) => {
    try { restores.get(track)?.(); } catch { /* Receiver may have ended. */ }
    restores.delete(track);
    previousStats.delete(track);
  };
  const sync = () => {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.videoTrackPublications.values()) {
        if (publication.track) attach(publication.track);
      }
    }
  };

  // Only collect numeric transport diagnostics; no names, media or server writes.
  const sample = async () => {
    if (disposed || sampling) return;
    sampling = true;
    try {
      await Promise.all(Array.from(restores.keys(), async (track) => {
        try {
          const report = await track.getRTCStatsReport();
          if (disposed || !restores.has(track) || !report) return;
          const previous = previousStats.get(track) ?? new Map<string, RTCInboundRtpStreamStats>();
          report.forEach((raw) => {
            if (raw.type !== 'inbound-rtp' || raw.kind !== 'video') return;
            const stat = raw as RTCInboundRtpStreamStats;
            const before = previous.get(stat.id);
            previous.set(stat.id, stat);
            if (!before) return;
            const emitted = (stat.jitterBufferEmittedCount ?? 0) - (before.jitterBufferEmittedCount ?? 0);
            const decoded = (stat.framesDecoded ?? 0) - (before.framesDecoded ?? 0);
            const dropped = (stat.framesDropped ?? 0) - (before.framesDropped ?? 0);
            const bufferMs = emitted > 0
              ? 1000 * ((stat.jitterBufferDelay ?? 0) - (before.jitterBufferDelay ?? 0)) / emitted : null;
            const decodeMs = decoded > 0
              ? 1000 * ((stat.totalDecodeTime ?? 0) - (before.totalDecodeTime ?? 0)) / decoded : null;
            if ((bufferMs !== null && bufferMs > 250) || (decodeMs !== null && decodeMs > 40) || dropped > 5) {
              console.warn('[studio-video] Delayed remote video', { bufferMs, decodeMs, dropped, decoded });
            }
          });
          previousStats.set(track, previous);
        } catch { /* Stats are optional and tracks can end during a sample. */ }
      }));
    } finally { sampling = false; }
  };

  room.on(RoomEvent.TrackSubscribed, attach);
  room.on(RoomEvent.TrackUnsubscribed, detach);
  room.on(RoomEvent.Reconnected, sync);
  sync();
  void sample();
  const timer = setInterval(() => { void sample(); }, 5000);
  return () => {
    disposed = true;
    clearInterval(timer);
    room.off(RoomEvent.TrackSubscribed, attach);
    room.off(RoomEvent.TrackUnsubscribed, detach);
    room.off(RoomEvent.Reconnected, sync);
    for (const track of restores.keys()) detach(track);
  };
}
