/**
 * 録画中の音声処理が詰まっていないかを測る計器。
 *
 * 「音が飛び飛びになる」は事後に録画を聴いて気付くしかなく、原因が
 * CPU 不足なのか配線なのかも分からないままになりがちだった。ここでは
 * 録画中に2つの指標を採り、停止時に数字で報告する。
 *
 * 1. AudioContext クロックの遅れ
 *    AudioContext.currentTime は実時間と同じ速さで進むのが正常。
 *    オーディオスレッドが CPU を取れないと進みが遅れる。これは
 *    アンダーラン（音の欠落）そのものの徴候。
 *
 * 2. MediaRecorder のチャンク間隔
 *    start(1000) なら約1秒ごとに ondataavailable が来る。間隔が大きく
 *    開いていればエンコード側が詰まっている。
 */

export interface RecordingHealthReport {
  /** 計測時間 (秒) */
  durationSec: number;
  /** AudioContext クロックの実時間に対する最大の遅れ (秒)。0.05 を超えたら黄信号 */
  maxAudioClockLagSec: number;
  /** チャンク到着間隔の最大値 (ms)。start(1000) に対して 3000 を超えたら黄信号 */
  maxChunkGapMs: number;
  /** チャンク数 */
  chunkCount: number;
  /** 上記から「音が途切れた可能性が高い」と判定されたか */
  degraded: boolean;
}

const AUDIO_LAG_WARN_SEC = 0.05;
const CHUNK_GAP_WARN_MS = 3000;

export class RecordingHealthMonitor {
  private ctxT0 = 0;
  private perfT0 = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private maxLag = 0;
  private lastChunkAt = 0;
  private maxGap = 0;
  private chunkCount = 0;

  constructor(private readonly ctx: AudioContext | null) {}

  start(): void {
    this.perfT0 = performance.now();
    this.lastChunkAt = this.perfT0;
    if (!this.ctx) return;
    this.ctxT0 = this.ctx.currentTime;
    // 2秒ごとで十分。これ自体がメインスレッドの負荷にならない程度にする。
    this.timer = setInterval(() => {
      if (!this.ctx) return;
      const wall = (performance.now() - this.perfT0) / 1000;
      const audio = this.ctx.currentTime - this.ctxT0;
      const lag = wall - audio;
      if (lag > this.maxLag) this.maxLag = lag;
    }, 2000);
  }

  /** ondataavailable から呼ぶ */
  noteChunk(): void {
    const now = performance.now();
    const gap = now - this.lastChunkAt;
    if (this.chunkCount > 0 && gap > this.maxGap) this.maxGap = gap;
    this.lastChunkAt = now;
    this.chunkCount++;
  }

  stop(): RecordingHealthReport {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const durationSec = (performance.now() - this.perfT0) / 1000;
    const report: RecordingHealthReport = {
      durationSec: Math.round(durationSec),
      maxAudioClockLagSec: Math.round(this.maxLag * 1000) / 1000,
      maxChunkGapMs: Math.round(this.maxGap),
      chunkCount: this.chunkCount,
      degraded: this.maxLag > AUDIO_LAG_WARN_SEC || this.maxGap > CHUNK_GAP_WARN_MS,
    };
    return report;
  }
}

/** 停止時にユーザーへ見せる説明文。問題なしなら null */
export function describeRecordingHealth(r: RecordingHealthReport): string | null {
  if (!r.degraded) return null;
  const parts: string[] = [];
  if (r.maxAudioClockLagSec > AUDIO_LAG_WARN_SEC) {
    parts.push(`音声処理が最大 ${Math.round(r.maxAudioClockLagSec * 1000)}ms 遅延`);
  }
  if (r.maxChunkGapMs > CHUNK_GAP_WARN_MS) {
    parts.push(`録画の書き出しが最大 ${(r.maxChunkGapMs / 1000).toFixed(1)}秒 停滞`);
  }
  return `収録中にPCの処理が追いつかない場面がありました（${parts.join('、')}）。保存したファイルの音声が途切れている可能性があります。次回は他のアプリを閉じるか、録画品質を下げてお試しください。`;
}
