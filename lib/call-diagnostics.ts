import { RoomEvent, Track, type Room } from 'livekit-client';

const WINDOW_MS = 5 * 60_000;
const SAMPLE_MS = 2000;
type Raw = Record<string, unknown>;
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const choice = (v: unknown, allowed: string[]) => typeof v === 'string' && allowed.includes(v) ? v : null;
const delta = (a: Raw, b: Raw | undefined, key: string) => {
  const x = number(a[key]), y = number(b?.[key]);
  return x !== null && y !== null && x >= y ? x - y : null;
};

/** Explicit allowlist: never export raw RTCStats, track/device IDs, SDP or addresses. */
export function audioMetrics(current: Raw, previous?: Raw) {
  const validPrevious = previous && number(current.timestamp) !== null &&
    number(previous.timestamp) !== null && Number(current.timestamp) > Number(previous.timestamp)
    ? previous : undefined;
  const emitted = delta(current, validPrevious, 'jitterBufferEmittedCount');
  const average = (key: string) => {
    const total = delta(current, validPrevious, key);
    return emitted && total !== null ? Math.round(1000 * total / emitted) : null;
  };
  const secondsMs = (key: string) => {
    const value = number(current[key]);
    return value !== null ? Math.round(value * 1000) : null;
  };
  return {
    type: choice(current.type, ['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp']),
    received: delta(current, validPrevious, 'packetsReceived'),
    sent: delta(current, validPrevious, 'packetsSent'),
    lost: delta(current, validPrevious, 'packetsLost'),
    bytesReceived: delta(current, validPrevious, 'bytesReceived'),
    bytesSent: delta(current, validPrevious, 'bytesSent'),
    concealedSamples: delta(current, validPrevious, 'concealedSamples'),
    totalSamples: delta(current, validPrevious, 'totalSamplesReceived'),
    jitterMs: secondsMs('jitter'),
    rttMs: secondsMs('roundTripTime'),
    bufferMs: average('jitterBufferDelay'),
    targetMs: average('jitterBufferTargetDelay'),
    minimumMs: average('jitterBufferMinimumDelay'),
  };
}

export function transportMetrics(report: Map<string, Raw>) {
  const transport = [...report.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId);
  const pair = transport ? report.get(String(transport.selectedCandidatePairId)) : undefined;
  const local = pair ? report.get(String(pair.localCandidateId)) : undefined;
  const remote = pair ? report.get(String(pair.remoteCandidateId)) : undefined;
  const rtt = number(pair?.currentRoundTripTime);
  return {
    rttMs: rtt !== null ? Math.round(rtt * 1000) : null,
    protocol: choice(local?.protocol, ['udp', 'tcp']),
    relayProtocol: choice(local?.relayProtocol, ['udp', 'tcp', 'tls']),
    localType: choice(local?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
    remoteType: choice(remote?.candidateType, ['host', 'srflx', 'prflx', 'relay']),
    outgoingBitrate: number(pair?.availableOutgoingBitrate),
  };
}

export type DiagnosticStatus = 'collecting' | 'connected' | 'reconnecting' | 'disconnected' | 'audio-risk' | 'browser-gap' | 'unavailable';
type Entry = { atMs: number; kind: string; data: unknown };
export type CallMode = { ai: boolean; videoRecording: boolean; audioRecording: boolean; studio: boolean };

/** One instance per human Room, independent of recording and AI lifecycle. */
export class CallDiagnostics {
  private readonly started = performance.now();
  private readonly startedAt = new Date().toISOString();
  private entries: Entry[] = [];
  private listeners = new Set<() => void>();
  private snapshot: { status: DiagnosticStatus; marks: number } = { status: 'collecting', marks: 0 };
  private previous = new Map<string, Raw>();
  private ids = new WeakMap<object, number>();
  private nextId = 1;
  private generation = 0;
  private latestMode: CallMode | null = null;

  constructor(private readonly room: Room) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.snapshot;
  private update(status: DiagnosticStatus, marks = this.snapshot.marks) {
    if (status === this.snapshot.status && marks === this.snapshot.marks) return;
    this.snapshot = { status, marks };
    this.listeners.forEach(fn => fn());
  }
  private prune() {
    const cutoff = performance.now() - this.started - WINDOW_MS;
    this.entries = this.entries.filter(e => e.atMs >= cutoff).slice(-500);
  }
  private record(kind: string, data: unknown) {
    this.entries.push({ atMs: Math.round(performance.now() - this.started), kind, data });
    this.prune();
  }
  setMode(mode: CallMode) {
    if (JSON.stringify(mode) === JSON.stringify(this.latestMode)) return;
    this.latestMode = { ...mode };
    this.record('mode', this.latestMode);
  }
  mark = () => {
    this.record('user-mark', {});
    this.update(this.snapshot.status, this.snapshot.marks + 1);
  };
  exportJson = () => {
    this.prune();
    return JSON.stringify({ schemaVersion: 1, startedAt: this.startedAt, windowMs: WINDOW_MS, sampleMs: SAMPLE_MS,
      elapsedMs: Math.round(performance.now() - this.started), mode: this.latestMode,
      notes: 'Buffer and RTT are not end-to-end latency. Null means unavailable. Silence alone is not a fault.',
      entries: this.entries }, null, 2);
  };

  start(): () => void {
    const generation = ++this.generation;
    let busy = false;
    let gapUntil = 0;
    let expected = performance.now() + 1000;
    let wasHidden = document.hidden;
    let connectionVersion = 0;
    const current = () => generation === this.generation;
    const state = () => {
      connectionVersion++;
      const value = choice(this.room.state, ['connected', 'connecting', 'reconnecting', 'signalReconnecting', 'disconnected']);
      this.record('connection', { state: value });
      this.previous.clear();
      this.update(value === 'connected' || value === 'connecting' ? 'collecting' :
        value === 'disconnected' ? 'disconnected' : 'reconnecting');
    };
    const playback = () => this.record('playback', { allowed: this.room.canPlaybackAudio });
    const visibility = () => {
      wasHidden = document.hidden;
      expected = performance.now() + 1000;
      this.record('visibility', { hidden: wasHidden });
    };
    const device = (kind: string) => this.record('device-change', {
      kind: choice(kind, ['audioinput', 'audiooutput', 'videoinput']),
    });
    this.room.on(RoomEvent.ConnectionStateChanged, state);
    this.room.on(RoomEvent.AudioPlaybackStatusChanged, playback);
    this.room.on(RoomEvent.ActiveDeviceChanged, device);
    document.addEventListener('visibilitychange', visibility);
    state();
    playback();

    const heartbeat = setInterval(() => {
      const now = performance.now();
      const late = Math.max(0, now - expected);
      expected = now + 1000;
      if (!wasHidden && !document.hidden && late > 500) {
        this.record('browser-gap', { lateMs: Math.round(late) });
        gapUntil = now + 10_000;
      }
      wasHidden = document.hidden;
    }, 1000);

    const sample = async () => {
      if (busy || !current()) return;
      busy = true;
      const sampleConnection = connectionVersion;
      const validSample = () => current() && sampleConnection === connectionVersion;
      try {
        const publications = [
          ...this.room.localParticipant.audioTrackPublications.values(),
          ...[...this.room.remoteParticipants.values()].flatMap(p => [...p.audioTrackPublications.values()]),
        ].filter(p => p.track?.kind === Track.Kind.Audio);
        const liveKeys = new Set<string>();
        let risk = false;
        let reports = 0;
        const rows = await Promise.all(publications.slice(0, 24).map(async pub => {
          const track = pub.track!;
          let id = this.ids.get(track);
          if (!id) { id = this.nextId++; this.ids.set(track, id); }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // A hanging stats call must not block all future sampling.
            const report = await Promise.race([
              track.getRTCStatsReport(),
              new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
            ]);
            if (!validSample()) return null;
            if (!report) return { track: id, available: false };
            reports++;
            const raw = new Map<string, Raw>();
            report.forEach(s => raw.set(s.id, s as Raw));
            const audio = [...raw.values()].filter(s =>
              ['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp'].includes(String(s.type)) &&
              (s.kind === 'audio' || s.mediaType === 'audio'));
            const metrics = audio.map(s => {
              const key = `${id}:${s.id}`;
              liveKeys.add(key);
              const value = audioMetrics(s, this.previous.get(key));
              this.previous.set(key, s);
              // Heuristic attention thresholds, not an end-to-end latency diagnosis.
              if (!pub.isMuted && value.type === 'inbound-rtp') {
                const total = (value.received ?? 0) + (value.lost ?? 0);
                if ((value.bufferMs !== null && value.bufferMs > 250) ||
                    (total >= 20 && (value.lost ?? 0) / total > 0.1)) risk = true;
              }
              return value;
            });
            const settings = track.mediaStreamTrack.getSettings();
            return { track: id, available: true, muted: pub.isMuted,
              enabled: track.mediaStreamTrack.enabled,
              readyState: choice(track.mediaStreamTrack.readyState, ['live', 'ended']),
              settings: { sampleRate: number(settings.sampleRate), channelCount: number(settings.channelCount),
                echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null },
              audio: metrics, transport: transportMetrics(raw) };
          } catch { return { track: id, available: false }; }
          finally { if (timer) clearTimeout(timer); }
        }));
        if (!validSample()) return;
        for (const key of this.previous.keys()) if (!liveKeys.has(key)) this.previous.delete(key);
        this.record('sample', { hidden: document.hidden, mode: this.latestMode,
          tracks: rows.filter(Boolean), truncated: publications.length > 24 });
        this.update(this.room.state === 'disconnected' ? 'disconnected' :
          this.room.state === 'connecting' ? 'collecting' :
          this.room.state !== 'connected' ? 'reconnecting' : performance.now() < gapUntil ? 'browser-gap' :
          risk ? 'audio-risk' : publications.length > 0 && reports === 0 ? 'unavailable' : 'connected');
      } finally { busy = false; }
    };
    void sample();
    const interval = setInterval(() => { void sample(); }, SAMPLE_MS);
    return () => {
      ++this.generation;
      clearInterval(interval);
      clearInterval(heartbeat);
      this.room.off(RoomEvent.ConnectionStateChanged, state);
      this.room.off(RoomEvent.AudioPlaybackStatusChanged, playback);
      this.room.off(RoomEvent.ActiveDeviceChanged, device);
      document.removeEventListener('visibilitychange', visibility);
      this.previous.clear();
    };
  }
}
