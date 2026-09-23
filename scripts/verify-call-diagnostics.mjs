// Deterministic tests of the actual TypeScript collector; no call server or devices needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { RoomEvent } from 'livekit-client';
const require = createRequire(import.meta.url);
const source = ts.transpileModule(fs.readFileSync(new URL('../lib/call-diagnostics.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function setup() {
  let now = 0, nextId = 1;
  const intervals = new Map(), timeouts = new Map();
  const docEvents = new EventEmitter();
  const document = { hidden: false,
    addEventListener: docEvents.on.bind(docEvents), removeEventListener: docEvents.off.bind(docEvents) };
  const exports = {};
  vm.runInNewContext(source, { exports, require, Date, Map, Set, WeakMap, document,
    performance: { now: () => now },
    setInterval: (fn, ms) => { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: fn => { const id = nextId++; timeouts.set(id, fn); return id; },
    clearTimeout: id => timeouts.delete(id),
  });
  const room = Object.assign(new EventEmitter(), { state: 'connected', canPlaybackAudio: true,
    localParticipant: { audioTrackPublications: new Map() }, remoteParticipants: new Map() });
  const collector = new exports.CallDiagnostics(room);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { ...exports, room, collector, document, intervals, timeouts, docEvents, flush,
    advance: ms => { now += ms; },
    tick: async ms => { now += ms; for (const item of intervals.values()) if (item.ms === ms) item.fn(); await flush(); },
    json: () => JSON.parse(collector.exportJson()),
  };
}

function addTrack(env, report) {
  const track = { kind: 'audio', getRTCStatsReport: async () => report(),
    mediaStreamTrack: { enabled: true, readyState: 'live',
      getSettings: () => ({ sampleRate: 48000, channelCount: 1, echoCancellation: true,
        deviceId: 'SECRET-device', groupId: 'SECRET-group' }) } };
  const pub = { track, isMuted: false };
  env.room.remoteParticipants.set('SECRET-person', { audioTrackPublications: new Map([['SECRET-sid', pub]]) });
  return { track, pub };
}
const stats = (timestamp, count, delay = 0) => new Map([['SECRET-stat', {
  id: 'SECRET-stat', type: 'inbound-rtp', kind: 'audio', timestamp, packetsReceived: count,
  packetsLost: 0, jitter: 0, jitterBufferDelay: delay, jitterBufferEmittedCount: count,
  label: 'SECRET-label', address: 'SECRET-ip', audioLevel: 0.5,
}]]);

test('interval buffer and packet deltas, zero vs unavailable, counter resets', () => {
  const { audioMetrics } = setup();
  const previous = { timestamp: 1000, packetsReceived: 100, packetsLost: 0,
    jitterBufferDelay: 10, jitterBufferEmittedCount: 100 };
  const current = { timestamp: 3000, packetsReceived: 200, packetsLost: 0,
    jitterBufferDelay: 40, jitterBufferEmittedCount: 200, jitter: 0 };
  assert.equal(audioMetrics(current, previous).bufferMs, 300);
  assert.equal(audioMetrics(current, previous).received, 100);
  assert.equal(audioMetrics(current, previous).lost, 0);
  assert.equal(audioMetrics(current).received, null);
  assert.equal(audioMetrics(current).jitterMs, 0);
  assert.equal(audioMetrics(current).rttMs, null);
  assert.equal(audioMetrics({ ...current, packetsReceived: 50 }, previous).received, null);
  assert.equal(audioMetrics({ ...current, timestamp: 1000 }, previous).bufferMs, null);
  assert.equal(audioMetrics({ ...current, jitterBufferEmittedCount: 100 }, previous).bufferMs, null);
});

test('transport exposes only allowlisted values, never candidate addresses or IDs', () => {
  const { transportMetrics } = setup();
  const map = new Map([
    ['t', { type: 'transport', selectedCandidatePairId: 'SECRET-pair' }],
    ['SECRET-pair', { localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.02 }],
    ['local', { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls', address: 'SECRET-ip' }],
    ['remote', { candidateType: 'host', protocol: 'SECRET-protocol' }],
  ]);
  const result = transportMetrics(map);
  assert.equal(result.rttMs, 20);
  assert.equal(result.localType, 'relay');
  assert.equal(result.protocol, 'udp');
  assert.equal(result.relayProtocol, 'tls');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(transportMetrics(new Map()).rttMs, null);
});

test('silence does not raise an alarm; privacy whitelist applies to export', async () => {
  const env = setup();
  let time = 1000;
  addTrack(env, () => stats(time, 10));
  const stop = env.collector.start();
  await env.flush();
  time = 3000;
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'connected');
  assert.ok(!env.collector.exportJson().includes('SECRET'));
  assert.ok(!env.collector.exportJson().includes('audioLevel'));
  assert.equal(env.json().entries.at(-1).data.tracks[0].audio[0].received, 0);
  assert.ok(env.json().startedAt);
  stop();
  assert.equal(env.intervals.size, 0);
  assert.equal(env.timeouts.size, 0);
  assert.equal(env.room.eventNames().length, 0);
  assert.equal(env.docEvents.eventNames().length, 0);
});

test('buffer warning and reconnection are visible; muted tracks do not warn', async () => {
  const env = setup();
  let report = stats(1000, 100, 10);
  const { pub } = addTrack(env, () => report);
  const stop = env.collector.start();
  await env.flush();
  report = stats(3000, 200, 40);
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'audio-risk');
  pub.isMuted = true;
  report = stats(5000, 300, 70);
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'connected');
  env.room.state = 'reconnecting';
  env.room.emit(RoomEvent.ConnectionStateChanged);
  assert.equal(env.collector.getSnapshot().status, 'reconnecting');
  env.room.state = 'connected';
  env.room.emit(RoomEvent.ConnectionStateChanged);
  pub.isMuted = false;
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'connected');
  stop();
});

test('AI off and studio switch preserve marks and bounded history; expiry is enforced', () => {
  const env = setup();
  env.collector.setMode({ ai: true, videoRecording: false, audioRecording: false, studio: true });
  env.collector.mark();
  env.collector.setMode({ ai: false, videoRecording: false, audioRecording: false, studio: false });
  assert.equal(env.collector.getSnapshot().marks, 1);
  assert.equal(env.json().entries.filter(e => e.kind === 'mode').length, 2);
  for (let i = 0; i < 600; i++) env.collector.mark();
  assert.equal(env.json().entries.length, 500);
  env.advance(300001);
  assert.equal(env.json().entries.length, 0);
});

test('stats timeout recovers and a late completion after stop cannot publish', async () => {
  const env = setup();
  let resolve;
  const { track } = addTrack(env, () => new Promise(r => { resolve = r; }));
  const stop = env.collector.start();
  for (const fn of env.timeouts.values()) fn();
  await env.flush();
  assert.equal(env.collector.getSnapshot().status, 'unavailable');
  track.getRTCStatsReport = async () => stats(3000, 100);
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'connected');
  stop();
  const before = env.collector.exportJson();
  resolve(stats(1000, 10));
  await env.flush();
  assert.equal(env.collector.exportJson(), before);

  const next = setup();
  let resolveNext;
  addTrack(next, () => new Promise(r => { resolveNext = r; }));
  const stopNext = next.collector.start();
  stopNext();
  const count = next.json().entries.length;
  resolveNext(stats(1000, 10));
  await next.flush();
  assert.equal(next.json().entries.length, count);
  assert.equal(next.timeouts.size, 0);
});

test('foreground scheduling gaps are recorded; hidden tab is not labelled as a stall', async () => {
  const env = setup();
  const stop = env.collector.start();
  await env.flush();
  env.advance(2000);
  await env.tick(1000);
  await env.tick(2000);
  assert.equal(env.collector.getSnapshot().status, 'browser-gap');
  assert.equal(env.json().entries.filter(e => e.kind === 'browser-gap').length, 1);
  env.document.hidden = true;
  env.docEvents.emit('visibilitychange');
  env.advance(15000);
  await env.tick(1000);
  assert.equal(env.json().entries.filter(e => e.kind === 'browser-gap').length, 1);
  stop();
});

test('in-flight stats from before reconnection are discarded', async () => {
  const env = setup();
  let resolve;
  addTrack(env, () => new Promise(r => { resolve = r; }));
  const stop = env.collector.start();
  env.room.state = 'reconnecting';
  env.room.emit(RoomEvent.ConnectionStateChanged);
  env.room.state = 'connected';
  env.room.emit(RoomEvent.ConnectionStateChanged);
  resolve(stats(1000, 100, 30));
  await env.flush();
  assert.equal(env.json().entries.filter(e => e.kind === 'sample').length, 0);
  stop();
});
