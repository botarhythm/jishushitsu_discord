import { ConnectionState, type Room } from 'livekit-client';
import { readUplinkStats, switchToTls, type StatsTotals } from '@/lib/connection-test';

/**
 * 通話中に「自分の映像・音声がサーバーに届いていない」ことを見張り、TURN/TLS へ逃がす。
 *
 * 2026-10-29 の障害は、接続は保ったまま上り（UDP）の送信だけが止まり、
 * 双方が「固まった」と感じるだけで、どちらの送信が止まったのか分からなかった
 * (docs/reviews/2026-10-29-livekit-session-analysis.md)。
 * 送り出しているのにサーバーの受信報告 (remote-inbound-rtp) が一定時間戻らなければ「止まった」とみなし、
 * 1 回だけ TURN/TLS (TCP 443) へその場で切り替える。録画・チャット・画面の状態は保たれる。
 *
 * 判定には送り出している量と受信報告だけを使い、映像・音声の中身や IP アドレスは扱わない。
 */

export type UplinkEvent =
  | { type: 'stalled'; stalledSec: number; path: string; rttMs: number | null; willSwitch: boolean }
  | { type: 'switched'; ok: boolean; path: string; rttMs: number | null; error?: string }
  | { type: 'recovered'; stalledSec: number; path: string };

export interface UplinkWatchdogOptions {
  onEvent: (event: UplinkEvent) => void;
  /** 受信報告がこの秒数戻らなければ「止まった」 */
  stallSec?: number;
  /** 切り替え後、届くようになったかをこの秒数見てから判定する */
  verifySec?: number;
  /** 開発用: 受信報告が戻っていないものとして扱い、切り替えの流れを試す */
  simulateStall?: boolean;
}

const SAMPLE_MS = 2000;
const STATS_TIMEOUT_MS = 1500;

export class UplinkWatchdog {
  private readonly stallSec: number;
  private readonly verifySec: number;

  constructor(private readonly room: Room, private readonly opts: UplinkWatchdogOptions) {
    this.stallSec = opts.stallSec ?? 8;
    this.verifySec = opts.verifySec ?? 12;
  }

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

  start(): () => void {
    let stopped = false;
    let busy = false;
    let switched = false;
    let prev: StatsTotals | null = null;
    let lastAckAt = performance.now();
    let stalledAt: number | null = null;
    // 開発用の擬似停止は、入室 10 秒後から切り替えまでの間だけ
    let simulateFrom = this.opts.simulateStall ? performance.now() + 10_000 : Infinity;

    const reset = () => {
      prev = null;
      lastAckAt = performance.now();
    };

    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        if (this.room.state !== ConnectionState.Connected) return reset();
        const cur = await this.read();
        if (stopped) return;
        // 何も送っていない（マイクもカメラも OFF）なら判定しない
        if (!cur) return reset();
        const now = performance.now();
        const sending = prev != null && cur.audioBytes + cur.videoBytes > prev.audioBytes + prev.videoBytes;
        const acked = prev != null && cur.acks > prev.acks && now < simulateFrom;
        if (prev == null || acked || !sending) lastAckAt = now;
        prev = cur;

        const gapSec = Math.round((now - lastAckAt) / 1000);
        const path = cur.path ?? '不明';
        if (stalledAt == null && gapSec >= this.stallSec) {
          stalledAt = lastAckAt;
          const willSwitch = !switched && !/tls/.test(path);
          this.opts.onEvent({ type: 'stalled', stalledSec: gapSec, path, rttMs: cur.rttMs, willSwitch });
          if (willSwitch) {
            switched = true;
            simulateFrom = Infinity;
            await this.switchAndVerify();
            reset();
            stalledAt = null;
          }
        } else if (stalledAt != null && gapSec === 0) {
          this.opts.onEvent({ type: 'recovered', stalledSec: Math.round((now - stalledAt) / 1000), path });
          stalledAt = null;
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

  /** TLS へ切り替え、しばらく見て受信報告が戻るようになったかを確かめる */
  private async switchAndVerify(): Promise<void> {
    try {
      await switchToTls(this.room, 20_000);
    } catch (e) {
      const after = await this.read().catch(() => null);
      this.opts.onEvent({
        type: 'switched',
        ok: false,
        path: after?.path ?? '不明',
        rttMs: after?.rttMs ?? null,
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const before = await this.read();
    await new Promise((r) => setTimeout(r, this.verifySec * 1000));
    const after = await this.read();
    const acked = !!before && !!after && after.acks > before.acks;
    const path = after?.path ?? '不明';
    this.opts.onEvent({
      type: 'switched',
      ok: acked,
      path,
      rttMs: after?.rttMs ?? null,
      ...(after ? {} : { error: '切り替え後に送信中のトラックがありません' }),
    });
  }
}
