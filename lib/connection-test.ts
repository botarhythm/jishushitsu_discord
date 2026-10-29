import { Room, RoomEvent, Track } from 'livekit-client';
import { createCallRoomOptions } from '@/lib/call-media-options';

/**
 * 接続テストの「送信の持続」検査。
 *
 * 2026-10-29 の障害は、接続 (UDP) は成立したのに上りの送信だけがほぼ止まる形だった
 * (docs/reviews/2026-10-29-livekit-session-analysis.md)。SDK の ConnectionCheck は
 * 10 秒の UDP/TCP 比較までなので、本番と同じ送信設定 (createCallRoomOptions) で
 * 映像と音声を送り続け、実際に出ていった量と往復遅延を数秒ごとに測る。
 *
 * 送信量はブラウザが送り出した量 (bytesSent) なので、それだけでは「届いたか」が分からない。
 * サーバー (SFU) が返す受信報告 (RTCP RR → remote-inbound-rtp) が途絶えていないかも見る。
 *
 * 'relay' は TURN 中継に固定（中継との間は UDP）、'tls' はさらに TURN/TLS (TCP 443) に切り替える。
 * UDP が詰まる環境で、どの経路なら通話を逃がせるかを見る。
 * SDK に UDP 直結を強制する手段 (force-udp) はないため、'auto' が何を選んだかは経路で読む。
 */
export type UploadMode = 'auto' | 'relay' | 'tls';

export interface UploadSample {
  /** 開始からの秒 */
  t: number;
  /** この区間の送信量（映像＋音声） */
  kbps: number;
  audioKbps: number;
  videoKbps: number;
  /** この区間にタブが裏に回っていた。裏ではタイマーが間引かれ、テスト映像のフレームが減る */
  hidden: boolean;
  rttMs: number | null;
  /** ブラウザが見積もった送信可能帯域 */
  availableKbps: number | null;
  /** 映像エンコーダが絞られている理由（bandwidth / cpu / none） */
  limitation: string | null;
  /** サーバーからの受信報告が最後に増えてからの秒。大きいほど「届いていない」 */
  ackGapSec: number;
  /** サーバーの受信報告から計算した往復遅延（音声） */
  remoteRttMs: number | null;
}

export interface UploadResult {
  mode: UploadMode;
  /** host / srflx / relay と、その通信方式 (udp / tcp、中継なら中継側の udp / tcp / tls) */
  path: string;
  samples: UploadSample[];
  medianKbps: number;
  minKbps: number;
  medianAudioKbps: number;
  /** タブが表に出ていた区間だけの映像の中央値。表の区間がなければ null */
  medianVideoKbps: number | null;
  medianRttMs: number | null;
  maxRttMs: number | null;
  /** 測定中に受信報告が途絶えた最長の秒数 */
  maxAckGapSec: number;
  /** 測定中に一度も受信報告がなかった（届いたことを確認できない） */
  neverAcked: boolean;
  reconnects: number;
  /** 接続開始からの秒。負の値は制御通信（WebSocket）だけの再接続 */
  reconnectAtSec: number[];
  /** 接続開始から送信の測定を始めるまでの秒。これより前の再接続は接続の確立中に起きたもの */
  measureStartSec: number | null;
  disconnected: boolean;
  error?: string;
}

const SAMPLE_MS = 2000;

/**
 * 音声の送信がこれを下回ったら「ほぼ止まっている」。本番設定 (speech + RED) は 50kbps 前後出る。
 * 2026-10-29 の障害時はマイクが 1.5〜9kbps だった
 */
export const STALLED_AUDIO_KBPS = 20;
/** 映像の送信がこれを下回ったら「ほぼ止まっている」。テスト映像は 800kbps 以上出る */
export const STALLED_VIDEO_KBPS = 100;
/** サーバーの受信報告がこれ以上途絶えたら「届いていない」。正常時は 1〜2 秒ごとに届く */
export const ACK_GAP_LIMIT_SEC = 6;

/** 送信の測定中に起きた再接続（メディア経路の張り直し）の回数 */
export function reconnectsWhileMeasuring(r: UploadResult): number {
  if (r.measureStartSec == null) return 0;
  const start = r.measureStartSec;
  return r.reconnectAtSec.filter((s) => s > 0 && s >= start).length;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** 動きのある映像を作る。単色だとエンコーダが帯域を使わず、送信量の検査にならない */
function createTestVideo(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas が使えません');
  let frame = 0;
  // タブが裏に回ると requestAnimationFrame が止まるため setInterval で描く
  const timer = window.setInterval(() => {
    frame++;
    ctx.fillStyle = `hsl(${(frame * 3) % 360}, 70%, 45%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `hsl(${Math.random() * 360}, 80%, ${30 + Math.random() * 40}%)`;
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 60, 60);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px sans-serif';
    ctx.fillText(`接続テスト ${frame}`, 40, 80);
  }, 50);
  const track = canvas.captureStream(20).getVideoTracks()[0];
  return { track, stop: () => { window.clearInterval(timer); track.stop(); } };
}

/** 発話の代わりに、音量が揺れる音を作る（無音だと Opus がほとんど送らない） */
function createTestAudio(): { track: MediaStreamTrack; stop: () => void } {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  osc.frequency.value = 330;
  lfo.frequency.value = 3;
  lfoGain.gain.value = 0.15;
  gain.gain.value = 0.2;
  lfo.connect(lfoGain).connect(gain.gain);
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  const track = dest.stream.getAudioTracks()[0];
  return { track, stop: () => { track.stop(); void ctx.close(); } };
}

export interface StatsTotals {
  audioBytes: number;
  videoBytes: number;
  rttMs: number | null;
  availableKbps: number | null;
  limitation: string | null;
  path: string | null;
  /** サーバーから届いた受信報告の累計（音声＋映像） */
  acks: number;
  remoteRttMs: number | null;
}

/**
 * 送信側 RTCPeerConnection の統計から、送信バイト累計・受信報告・選ばれた経路を読む。
 * 通話中の送信停止の見張り (lib/uplink-watchdog.ts) でも使う
 */
export function readUplinkStats(reports: RTCStatsReport[]): StatsTotals {
  let audioBytes = 0;
  let videoBytes = 0;
  let acks = 0;
  let remoteRttMs: number | null = null;
  let limitation: string | null = null;
  let pair: RTCIceCandidatePairStats | undefined;
  const byId = new Map<string, RTCStats>();
  for (const report of reports) {
    report.forEach((s) => byId.set(s.id, s));
  }
  for (const s of byId.values()) {
    if (s.type === 'outbound-rtp') {
      const o = s as RTCOutboundRtpStreamStats & { kind?: string; qualityLimitationReason?: string };
      if (o.kind === 'audio') audioBytes += o.bytesSent ?? 0;
      else videoBytes += o.bytesSent ?? 0;
      if (o.kind === 'video' && o.qualityLimitationReason && o.qualityLimitationReason !== 'none') {
        limitation = o.qualityLimitationReason;
      }
    }
    if (s.type === 'remote-inbound-rtp') {
      const ri = s as RTCStats & { kind?: string; roundTripTime?: number; roundTripTimeMeasurements?: number };
      acks += ri.roundTripTimeMeasurements ?? 0;
      if (ri.kind === 'audio' && ri.roundTripTime != null) remoteRttMs = Math.round(ri.roundTripTime * 1000);
    }
    if (s.type === 'transport') {
      const id = (s as RTCTransportStats).selectedCandidatePairId;
      const p = id ? byId.get(id) : undefined;
      if (p) pair = p as RTCIceCandidatePairStats;
    }
  }
  if (!pair) {
    for (const s of byId.values()) {
      const p = s as RTCIceCandidatePairStats & { selected?: boolean };
      if (s.type === 'candidate-pair' && (p.selected || (p.nominated && p.state === 'succeeded'))) pair = p;
    }
  }
  let path: string | null = null;
  if (pair) {
    const local = byId.get(pair.localCandidateId) as
      | (RTCStats & { candidateType?: string; protocol?: string; relayProtocol?: string })
      | undefined;
    if (local) {
      path = [local.candidateType, local.protocol, local.relayProtocol && `中継 ${local.relayProtocol}`]
        .filter(Boolean)
        .join(' / ');
    }
  }
  return {
    audioBytes,
    videoBytes,
    rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
    availableKbps:
      pair?.availableOutgoingBitrate != null ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
    limitation,
    path,
    acks,
    remoteRttMs,
  };
}

/**
 * TURN/TLS へ切り替える。SDK の ConnectionCheck (switchProtocol) と同じく
 * サーバーに候補の切り替えを頼み、再接続が終わるのを待つ。
 * `force-tls` は SDK の試験用の機能。通話中の自動切り替え (lib/uplink-watchdog.ts) でも使うため、
 * livekit-client を更新したら /connection-test の「中継・TLS」で切り替わることを確かめる
 */
export async function switchToTls(room: Room, timeoutMs = 15000): Promise<void> {
  let reconnecting = false;
  let reconnected = false;
  const onReconnecting = () => { reconnecting = true; };
  const onReconnected = () => { reconnected = true; };
  room.on(RoomEvent.Reconnecting, onReconnecting);
  room.on(RoomEvent.Reconnected, onReconnected);
  try {
    await room.simulateScenario('force-tls');
    await new Promise((r) => setTimeout(r, 1000));
    if (!reconnecting) return;
    const deadline = performance.now() + timeoutMs;
    while (!reconnected && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!reconnected) {
      throw new Error(`TLS への切り替えが ${Math.round(timeoutMs / 1000)} 秒以内に終わりませんでした`);
    }
  } finally {
    room.off(RoomEvent.Reconnecting, onReconnecting);
    room.off(RoomEvent.Reconnected, onReconnected);
  }
}

export async function runUploadTest(
  url: string,
  token: string,
  mode: UploadMode,
  seconds: number,
  onSample: (sample: UploadSample) => void
): Promise<UploadResult> {
  // テスト用の部屋には受信者がいないため、dynacast のままだと SFU が 10 秒ほどで
  // 映像の送信を止めさせる（音声だけの 51kbps に落ちる）。送信量を測るために切る
  const room = new Room({ ...createCallRoomOptions(), dynacast: false });
  const result: UploadResult = {
    mode,
    path: '不明',
    samples: [],
    medianKbps: 0,
    minKbps: 0,
    medianAudioKbps: 0,
    medianVideoKbps: null,
    medianRttMs: null,
    maxRttMs: null,
    maxAckGapSec: 0,
    neverAcked: false,
    reconnects: 0,
    reconnectAtSec: [],
    measureStartSec: null,
    disconnected: false,
  };
  // 測定後に自分で切断したときの Disconnected は数えない
  let measuring = true;
  const connectStartedAt = performance.now();
  room.on(RoomEvent.Reconnecting, () => {
    if (!measuring) return;
    result.reconnects++;
    result.reconnectAtSec.push(Math.round((performance.now() - connectStartedAt) / 100) / 10);
  });
  room.on(RoomEvent.SignalReconnecting, () => {
    if (measuring) result.reconnectAtSec.push(-Math.round((performance.now() - connectStartedAt) / 100) / 10);
  });
  room.on(RoomEvent.Disconnected, () => { if (measuring) result.disconnected = true; });

  let hiddenInInterval = document.hidden;
  const onVisibility = () => { if (document.hidden) hiddenInInterval = true; };
  document.addEventListener('visibilitychange', onVisibility);

  let video: ReturnType<typeof createTestVideo> | null = null;
  let audio: ReturnType<typeof createTestAudio> | null = null;
  try {
    await room.connect(url, token, mode === 'auto' ? {} : { rtcConfig: { iceTransportPolicy: 'relay' } });
    if (mode === 'tls') await switchToTls(room);
    video = createTestVideo();
    audio = createTestAudio();
    const vPub = await room.localParticipant.publishTrack(video.track, {
      source: Track.Source.Camera,
      name: 'conntest-video',
    });
    const aPub = await room.localParticipant.publishTrack(audio.track, {
      source: Track.Source.Microphone,
      name: 'conntest-audio',
    });

    const read = async () => {
      const reports = await Promise.all(
        [vPub.track, aPub.track].map((t) => t?.getRTCStatsReport() ?? Promise.resolve(undefined))
      );
      return readUplinkStats(reports.filter((r): r is RTCStatsReport => !!r));
    };

    let prev = await read();
    let prevAt = performance.now();
    const startedAt = prevAt;
    let lastAckAt = startedAt;
    const firstAcks = prev.acks;
    result.measureStartSec = Math.round((startedAt - connectStartedAt) / 100) / 10;
    hiddenInInterval = document.hidden;
    while (performance.now() - startedAt < seconds * 1000) {
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
      if (result.disconnected) break;
      const cur = await read();
      const now = performance.now();
      const kbpsOf = (bytes: number) => Math.max(0, Math.round((bytes * 8) / (now - prevAt)));
      const audioKbps = kbpsOf(cur.audioBytes - prev.audioBytes);
      const videoKbps = kbpsOf(cur.videoBytes - prev.videoBytes);
      if (cur.acks > prev.acks) lastAckAt = now;
      const sample: UploadSample = {
        t: Math.round((now - startedAt) / 1000),
        kbps: audioKbps + videoKbps,
        audioKbps,
        videoKbps,
        hidden: hiddenInInterval,
        rttMs: cur.rttMs,
        availableKbps: cur.availableKbps,
        limitation: cur.limitation,
        ackGapSec: Math.round((now - lastAckAt) / 1000),
        remoteRttMs: cur.remoteRttMs,
      };
      result.neverAcked = cur.acks === firstAcks;
      if (cur.path) result.path = cur.path;
      result.samples.push(sample);
      onSample(sample);
      prev = cur;
      prevAt = now;
      hiddenInInterval = document.hidden;
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    measuring = false;
    document.removeEventListener('visibilitychange', onVisibility);
    video?.stop();
    audio?.stop();
    await room.disconnect().catch(() => {});
  }

  // 最初の区間は接続直後の立ち上がりを含むので、判定からは外す
  const steady = result.samples.length > 2 ? result.samples.slice(1) : result.samples;
  const kbps = steady.map((s) => s.kbps);
  const rtts = steady.map((s) => s.rttMs).filter((v): v is number => v != null);
  result.medianKbps = median(kbps) ?? 0;
  result.minKbps = kbps.length ? Math.min(...kbps) : 0;
  result.medianAudioKbps = median(steady.map((s) => s.audioKbps)) ?? 0;
  result.medianVideoKbps = median(steady.filter((s) => !s.hidden).map((s) => s.videoKbps));
  result.medianRttMs = median(rtts);
  result.maxRttMs = rtts.length ? Math.max(...rtts) : null;
  result.maxAckGapSec = result.samples.length ? Math.max(...result.samples.map((s) => s.ackGapSec)) : 0;
  return result;
}
