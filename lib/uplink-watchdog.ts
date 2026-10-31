import { ConnectionQuality, ConnectionState, Track, type LocalVideoTrack, type Room } from 'livekit-client';
import { readUplinkStats, switchToTls, type StatsTotals } from '@/lib/connection-test';

/**
 * 通話中に自分の接続が劣化したことを見張り、Zoom がしているように経路を変えて音声を守る。
 *
 * LiveKit は WebRTC の接続が `failed` になるか ping が時間切れになるまで経路を変えない。
 * 2026-10-29 朝は、接続を保ったまま上りが細く届き続け（カメラ 3〜12 kbps・マイク 1.5〜9 kbps）、
 * サーバーが判定した自分の接続品質が Poor〜Lost に落ちたまま、最後まで UDP だった
 * (docs/reviews/2026-10-30-zoom-vs-livekit.md)。
 *
 * 「劣化」は次のどれか:
 * - サーバーが判定した自分の接続品質が Poor / Lost（ダッシュボードの品質スコアで 2.06 以下。
 *   10/21・10/26 の 1.61、10/29 の 1.25 が該当し、ほかの参加者の最悪値 3.2 は該当しない）
 * - 往復遅延が RTT_LIMIT_MS 以上
 * - 送り出しているのに、サーバーの受信報告 (remote-inbound-rtp) が戻らない
 *
 * 劣化が続いたら、次の順に手を打つ:
 * 1. PAUSE_VIDEO_SEC 秒: 自分のカメラ映像を一時的に止め、音声に帯域を譲る（収録中は止めない）
 * 2. SWITCH_SEC 秒（受信報告が戻らないときは STALL_SEC 秒）: 1 回だけ TURN/TLS (TCP 443) へその場で切り替える。
 *    録画・チャット・画面の状態は保たれる
 * 3. 品質が Good 以上に戻って RESUME_SEC 秒たったら、止めた映像を戻す。戻した後にまた劣化したら、待つ時間を倍にする
 *
 * 判定には品質・往復遅延・送信量・受信報告だけを使い、映像・音声の中身や IP アドレスは扱わない。
 */

export type DegradeReason = 'quality' | 'rtt' | 'no-ack';

export type UplinkEvent =
  | {
      type: 'stalled';
      reason: DegradeReason;
      stalledSec: number;
      quality: string;
      path: string;
      rttMs: number | null;
      willSwitch: boolean;
    }
  | { type: 'switched'; ok: boolean; quality: string; path: string; rttMs: number | null; error?: string }
  | { type: 'recovered'; stalledSec: number; path: string }
  | { type: 'video-paused'; reason: DegradeReason; quality: string; path: string; rttMs: number | null }
  | { type: 'video-resumed'; pausedSec: number; path: string; error?: string };

export interface UplinkWatchdogOptions {
  onEvent: (event: UplinkEvent) => void;
  /** 映像を止めてよいか。収録中は false（講師の映像が収録から消えるため） */
  canPauseVideo?: () => boolean;
  /** 開発用: 品質 Poor・受信報告なしとして扱い、止める→切り替える→戻すの流れを試す */
  simulateStall?: boolean;
}

const SAMPLE_MS = 2000;
const STATS_TIMEOUT_MS = 1500;
/** 往復遅延がこれ以上なら劣化。10/29 14:48 の中継 UDP の詰まりは 7,114 ms、正常時は 15〜60 ms */
export const RTT_LIMIT_MS = 1000;
const PAUSE_VIDEO_SEC = 6;
const SWITCH_SEC = 10;
const STALL_SEC = 8;
const VERIFY_SEC = 15;
const RESUME_SEC = 20;
const RESUME_SEC_MAX = 160;

function isPoor(q: ConnectionQuality): boolean {
  return q === ConnectionQuality.Poor || q === ConnectionQuality.Lost;
}

function isGood(q: ConnectionQuality): boolean {
  return q === ConnectionQuality.Good || q === ConnectionQuality.Excellent;
}

export class UplinkWatchdog {
  constructor(private readonly room: Room, private readonly opts: UplinkWatchdogOptions) {}

  /** 送信中（ミュートでない）トラックの統計をまとめて読む。送っていなければ null */
  private async read(): Promise<StatsTotals | null> {
    const tracks = [...this.room.localParticipant.trackPublications.values()]
      .filter((p) => p.track && !p.isMuted)
      .map((p) => p.track!);
    if (!tracks.length) return null;
    const reports = await Promise.all(
      tracks.map((t) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        // 統計の取得が固まっても見張り全体を止めない
        return Promise.race([
          t.getRTCStatsReport(),
          new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), STATS_TIMEOUT_MS); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
      })
    );
    const ok = reports.filter((r): r is RTCStatsReport => !!r);
    return ok.length ? readUplinkStats(ok) : null;
  }

  private camera(): LocalVideoTrack | undefined {
    return this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
  }

  start(): () => void {
    let stopped = false;
    let busy = false;
    let switched = false;
    let prev: StatsTotals | null = null;
    let lastAckAt = performance.now();
    let degradedSince: number | null = null;
    let goodSince: number | null = null;
    let reportedAt: number | null = null;
    let pausedAt: number | null = null;
    let resumeSec = RESUME_SEC;
    // 開発用の擬似劣化は、入室 10 秒後から切り替えまでの間だけ
    let simulateFrom = this.opts.simulateStall ? performance.now() + 10_000 : Infinity;

    const reset = () => {
      prev = null;
      lastAckAt = performance.now();
      degradedSince = null;
      goodSince = null;
    };

    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        if (this.room.state !== ConnectionState.Connected) return reset();
        const cur = await this.read();
        if (stopped) return;
        const now = performance.now();
        const simulating = now >= simulateFrom;
        const quality = simulating ? ConnectionQuality.Poor : this.room.localParticipant.connectionQuality;

        // 受信報告: 送り出しているのに増えなければ「届いていない」
        const sending = !!cur && prev != null && cur.audioBytes + cur.videoBytes > prev.audioBytes + prev.videoBytes;
        const acked = !!cur && prev != null && cur.acks > prev.acks && !simulating;
        if (!cur || prev == null || acked || !sending) lastAckAt = now;
        prev = cur;
        const ackGapSec = (now - lastAckAt) / 1000;
        const rttMs = cur ? Math.max(cur.remoteRttMs ?? 0, cur.rttMs ?? 0) || null : null;
        const path = cur?.path ?? '不明';

        const reason: DegradeReason | null =
          ackGapSec >= STALL_SEC ? 'no-ack' : isPoor(quality) ? 'quality' : rttMs != null && rttMs >= RTT_LIMIT_MS ? 'rtt' : null;
        if (reason) {
          degradedSince ??= now;
          goodSince = null;
        } else {
          degradedSince = null;
          if (isGood(quality)) goodSince ??= now;
        }
        const degradedSec = degradedSince == null ? 0 : (now - degradedSince) / 1000;

        // 1. 映像を止めて音声に譲る
        const cam = this.camera();
        if (reason && pausedAt == null && degradedSec >= PAUSE_VIDEO_SEC && cam && !cam.isMuted
            && (this.opts.canPauseVideo?.() ?? true)) {
          await cam.mute().catch(() => {});
          if (cam.isMuted) {
            pausedAt = now;
            this.opts.onEvent({ type: 'video-paused', reason, quality, path, rttMs });
          }
        }

        // 2. 経路を TLS へ切り替える（1 回だけ）
        if (reason && (reason === 'no-ack' ? ackGapSec >= STALL_SEC : degradedSec >= SWITCH_SEC) && reportedAt == null) {
          reportedAt = now;
          const willSwitch = !switched && !/tls/.test(path);
          this.opts.onEvent({
            type: 'stalled',
            reason,
            stalledSec: Math.round(Math.max(degradedSec, ackGapSec)),
            quality,
            path,
            rttMs,
            willSwitch,
          });
          if (willSwitch) {
            switched = true;
            simulateFrom = Infinity;
            await this.switchAndVerify();
            reportedAt = null;
            reset();
            return;
          }
        } else if (reportedAt != null && !reason && goodSince != null) {
          this.opts.onEvent({ type: 'recovered', stalledSec: Math.round((now - reportedAt) / 1000), path });
          reportedAt = null;
        }

        // 3. 品質が戻ったら映像を戻す
        if (pausedAt != null) {
          if (!cam || !cam.isMuted) {
            // 本人がカメラを操作した。以後は本人に任せる
            pausedAt = null;
          } else if (goodSince != null && (now - goodSince) / 1000 >= resumeSec) {
            const pausedSec = Math.round((now - pausedAt) / 1000);
            pausedAt = null;
            resumeSec = Math.min(resumeSec * 2, RESUME_SEC_MAX);
            try {
              await cam.unmute();
              this.opts.onEvent({ type: 'video-resumed', pausedSec, path });
            } catch (e) {
              this.opts.onEvent({
                type: 'video-resumed',
                pausedSec,
                path,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
      } finally {
        busy = false;
      }
    };

    const interval = setInterval(() => { void tick(); }, SAMPLE_MS);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }

  /** TLS へ切り替え、しばらく見て、受信報告が戻り品質が Poor でなくなったかを確かめる */
  private async switchAndVerify(): Promise<void> {
    try {
      await switchToTls(this.room, 20_000);
    } catch (e) {
      const after = await this.read().catch(() => null);
      this.opts.onEvent({
        type: 'switched',
        ok: false,
        quality: this.room.localParticipant.connectionQuality,
        path: after?.path ?? '不明',
        rttMs: after?.rttMs ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const before = await this.read();
    await new Promise((r) => setTimeout(r, VERIFY_SEC * 1000));
    const after = await this.read();
    const quality = this.room.localParticipant.connectionQuality;
    const rttMs = after ? Math.max(after.remoteRttMs ?? 0, after.rttMs ?? 0) || null : null;
    const acked = !before || !after || after.acks > before.acks;
    const ok = acked && !isPoor(quality) && (rttMs == null || rttMs < RTT_LIMIT_MS);
    this.opts.onEvent({ type: 'switched', ok, quality, path: after?.path ?? '不明', rttMs });
  }
}
