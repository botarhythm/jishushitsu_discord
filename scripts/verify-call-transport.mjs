// Opt-in real Cloud test. Uses synthetic media in isolated rooms, never microphones.
// node scripts/verify-call-transport.mjs --live
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { chromium } from 'playwright';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { AudioPresets } from 'livekit-client';
import nextEnv from '@next/env';

if (!process.argv.includes('--live')) {
  console.log('Pass --live to test synthetic media against configured LiveKit Cloud.');
  process.exit(0);
}
nextEnv.loadEnvConfig(process.cwd());
const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
assert.ok(url && key && secret, 'LiveKit environment is required');
const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/call-media-options.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: createRequire(import.meta.url) });
const options = exports.createCallRoomOptions();
const participantCount = Number(process.env.CALL_TEST_PARTICIPANTS ?? 4);
assert.ok([2, 3, 4].includes(participantCount));
const sdk = fs.readFileSync('node_modules/livekit-client/dist/livekit-client.umd.js');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/sdk.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/sdk.js' ? sdk : '<!doctype html><body><script src="/sdk.js"></script></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const service = new RoomServiceClient(url, key, secret);
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'] });
  const scenarios = [
    { name: 'previous-audio-auto', mode: 'auto', roomOptions: { ...options,
      publishDefaults: { ...options.publishDefaults, audioPreset: AudioPresets.musicHighQuality } } },
    { name: 'conversation-auto', mode: 'auto', roomOptions: options },
    { name: 'conversation-relay', mode: 'relay', roomOptions: options },
  ];
  for (const scenario of scenarios.filter(item => !process.env.CALL_TEST_SCENARIO || item.name === process.env.CALL_TEST_SCENARIO)) {
    const roomName = `call-verification-${randomUUID()}`;
    const contexts = [];
    try {
      await service.createRoom({ name: roomName, emptyTimeout: 60, maxParticipants: 4 });
      const pages = [];
      for (let index = 0; index < participantCount; index++) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        await page.goto(origin);
        const access = new AccessToken(key, secret, { identity: `synthetic-${index}`, ttl: 120 });
        access.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
        const token = await access.toJwt();
        await page.evaluate(async ({ url, token, roomOptions, connectOptions, index }) => {
          const LK = window.LivekitClient;
          LK.setLogLevel('silent');
          const room = new LK.Room(roomOptions);
          window.room = room;
          window.connectionEvents = [];
          room.on(LK.RoomEvent.ConnectionStateChanged, state => window.connectionEvents.push(state));
          room.on(LK.RoomEvent.TrackSubscribed, track => {
            const element = track.attach();
            element.muted = true;
            document.body.appendChild(element);
            void element.play().catch(() => {});
          });
          await room.connect(url, token, connectOptions);
          const audio = new AudioContext({ sampleRate: 48000 });
          await audio.resume();
          const buffer = audio.createBuffer(1, 48000, 48000);
          const samples = buffer.getChannelData(0);
          let seed = index + 1;
          for (let i = 0; i < samples.length; i++) {
            seed = (1664525 * seed + 1013904223) >>> 0;
            samples[i] = (seed / 4294967296 - 0.5) * 0.15;
          }
          const noise = audio.createBufferSource();
          noise.buffer = buffer;
          noise.loop = true;
          const filter = audio.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 5000;
          const destination = audio.createMediaStreamDestination();
          noise.connect(filter).connect(destination);
          noise.start();
          const canvas = document.createElement('canvas');
          const resolution = roomOptions.videoCaptureDefaults.resolution;
          canvas.width = resolution.width;
          canvas.height = resolution.height;
          const drawing = canvas.getContext('2d');
          let frame = 0;
          setInterval(() => {
            drawing.fillStyle = `hsl(${frame++ % 360} 60% 40%)`;
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            drawing.fillStyle = 'white';
            drawing.fillRect(frame * 11 % canvas.width, 0, 60, canvas.height);
          }, 50);
          await room.localParticipant.publishTrack(destination.stream.getAudioTracks()[0], {
            source: LK.Track.Source.Microphone,
          });
          await room.localParticipant.publishTrack(canvas.captureStream(20).getVideoTracks()[0], {
            source: LK.Track.Source.Camera,
          });
          window.sample = async () => {
            const publications = [...room.localParticipant.audioTrackPublications.values(),
              ...[...room.remoteParticipants.values()].flatMap(p => [...p.audioTrackPublications.values()])];
            return Promise.all(publications.map(async pub => {
              const report = await pub.track.getRTCStatsReport();
              const rows = [...report.values()];
              const transport = rows.find(s => s.type === 'transport' && s.selectedCandidatePairId);
              const pair = transport && report.get(transport.selectedCandidatePairId);
              const candidate = pair && report.get(pair.localCandidateId);
              return { local: pub.track.isLocal, kind: pub.track.kind,
                candidateType: candidate?.candidateType, relayProtocol: candidate?.relayProtocol,
                rttMs: pair ? pair.currentRoundTripTime * 1000 : null,
                rtp: rows.filter(s => ['inbound-rtp', 'outbound-rtp'].includes(s.type) && s.kind === 'audio')
                  .map(s => ({ type: s.type, timestamp: s.timestamp, bytes: s.bytesSent ?? s.bytesReceived,
                    packets: s.packetsSent ?? s.packetsReceived, concealed: s.concealedSamples,
                    samples: s.totalSamplesReceived, delay: s.jitterBufferDelay, emitted: s.jitterBufferEmittedCount })) };
            }));
          };
        }, { url, token, roomOptions: scenario.roomOptions,
          // Relay forcing is only for comparing routes in isolated test rooms.
          connectOptions: scenario.mode === 'relay' ? { rtcConfig: { iceTransportPolicy: 'relay' } } : {}, index });
        pages.push(page);
      }
      await new Promise(resolve => setTimeout(resolve, 10000));
      const before = await pages[0].evaluate(() => window.sample());
      await new Promise(resolve => setTimeout(resolve, 10000));
      const after = await pages[0].evaluate(() => window.sample());
      const rows = after.map((row, index) => {
        const a = row.rtp[0], b = before[index]?.rtp[0];
        assert.ok(a && b && a.packets - b.packets > 100, 'Audio must continue flowing');
        if (scenario.mode === 'relay') assert.equal(row.candidateType, 'relay');
        return { direction: a.type, kbps: Math.round(8 * (a.bytes - b.bytes) / (a.timestamp - b.timestamp)),
          intervalMs: Math.round(a.timestamp - b.timestamp),
          packets: a.packets - b.packets, candidateType: row.candidateType,
          relayProtocol: row.relayProtocol ?? null, rttMs: Math.round(row.rttMs),
          concealment: a.samples > b.samples ? (a.concealed - b.concealed) / (a.samples - b.samples) : null,
          bufferMs: a.emitted > b.emitted ? Math.round(1000 * (a.delay - b.delay) / (a.emitted - b.emitted)) : null };
      });
      assert.equal(rows.filter(row => row.direction === 'inbound-rtp').length, participantCount - 1);
      const events = await pages[0].evaluate(() => window.connectionEvents);
      assert.ok(!events.includes('reconnecting'));
      const qualityPassed = rows.filter(row => row.direction === 'inbound-rtp')
        .every(row => row.concealment !== null && row.concealment < 0.05 && row.bufferMs < 300);
      const result = { scenario: scenario.name, qualityPassed, audio: rows, events };
      results.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      results.push({ scenario: scenario.name, qualityPassed: false, error: 'connection-or-media-test-failed' });
      throw error;
    } finally {
      for (const context of contexts) await context.close();
      // Only ever delete the unique test room created in this iteration.
      assert.ok(roomName.startsWith('call-verification-'));
      await service.deleteRoom(roomName);
    }
  }
  assert.ok(results.filter(result => result.scenario.startsWith('conversation-'))
    .every(result => result.qualityPassed), 'Call quality thresholds not met; inspect saved numeric results');
} finally {
  fs.mkdirSync('output/playwright', { recursive: true });
  fs.writeFileSync(`output/playwright/call-transport-${Date.now()}.json`, JSON.stringify({
    at: new Date().toISOString(), synthetic: true, participants: participantCount, results,
  }, null, 2));
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
