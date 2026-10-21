/**
 * 収録中の話者ごとの発話区間を記録する（speakers.json の生成元）。
 *
 * 録画ミキサーは参加者ごとの音声を別々のトラックとして受け取ってから1本に混ぜる。
 * 混ぜる前のトラックごとの音量を見れば「いつ・誰が話していたか」が推測なしで分かる。
 * これを録画ファイルの先頭を 0 とする時計（session-clock）で記録し、
 * 文字起こし側（DegiHara-ChatBot の podcast パイプライン等）で各字幕行に
 * 話者を割り当てられるようにする。
 *
 * 判定は単純な音量しきい値 + ヒステリシス:
 *   - しきい値を MIN_SPEECH_MS 続けて超えたら発話開始（開始時刻は超え始めた時点）
 *   - しきい値を HANGOVER_MS 続けて下回ったら発話終了（終了時刻は最後に超えた時点）
 * 各自のマイクは別トラックなので声質の識別は要らない。相手の声の回り込みは
 * ブラウザのエコーキャンセルに依存する。
 */
import { recordSessionEvent, sessionTime } from '@/lib/session-clock';

export type SpeakerKind = 'human' | 'ai' | 'screen' | 'other';

export interface SpeakerInfo {
  /** 話者の識別子。人間は LiveKit identity、画面共有音声は `<identity>#screen` */
  id: string;
  /** 収録時点の表示名（Discord 名） */
  name: string;
  kind: SpeakerKind;
}

export interface SpeechSegment {
  speaker: string;
  /** 録画ファイル先頭からの秒 */
  start: number;
  end: number;
}

export interface VadParams {
  frameMs: number;
  thresholdDb: number;
  minSpeechMs: number;
  hangoverMs: number;
}

export const DEFAULT_VAD_PARAMS: VadParams = {
  frameMs: 50,
  // 会話音声は RMS で概ね -35〜-20 dBFS。ノイズ抑制後の無音は -60 dBFS 前後
  thresholdDb: -45,
  // 咳・クリック音を発話にしない最短長
  minSpeechMs: 150,
  // 文中の息継ぎで区間を割らない余韻
  hangoverMs: 500,
};

/** 1トラック分の判定状態 */
export interface VadState {
  speaking: boolean;
  /** しきい値を超え始めた時刻 (未発話時の候補) */
  candidateSince: number | null;
  /** 発話中に最後にしきい値を超えた時刻 */
  lastVoiceAt: number;
  segmentStart: number;
}

export function initialVadState(): VadState {
  return { speaking: false, candidateSince: null, lastVoiceAt: 0, segmentStart: 0 };
}

/**
 * 1フレーム分の判定を進める（純関数）。
 * @returns 区間が確定したらその [start, end] (ms)、発話開始なら 'started'、それ以外は null
 */
export function stepVad(
  state: VadState,
  db: number,
  t: number,
  params: VadParams = DEFAULT_VAD_PARAMS
): { state: VadState; started?: boolean; segment?: [number, number] } {
  const voiced = db >= params.thresholdDb;
  if (!state.speaking) {
    if (!voiced) return { state: { ...state, candidateSince: null } };
    const since = state.candidateSince ?? t;
    if (t - since >= params.minSpeechMs) {
      return {
        state: { speaking: true, candidateSince: null, lastVoiceAt: t, segmentStart: since },
        started: true,
      };
    }
    return { state: { ...state, candidateSince: since } };
  }
  if (voiced) return { state: { ...state, lastVoiceAt: t } };
  if (t - state.lastVoiceAt >= params.hangoverMs) {
    return {
      state: initialVadState(),
      segment: [state.segmentStart, state.lastVoiceAt + params.frameMs],
    };
  }
  return { state };
}

/** 話者ごとの音量の分布 (しきい値が各自のマイクに合っているかを使う側で確かめるため) */
export interface LevelStats {
  speaker: string;
  /** 測ったフレーム数 (frameMs ごと) */
  frames: number;
  /** 下位10% / 中央値 / 上位10% の dBFS (1 dB 刻み)。無音は FLOOR_DB に丸める */
  p10: number;
  median: number;
  p90: number;
  /** しきい値以上だったフレームの割合 (0〜1) */
  voicedRatio: number;
}

const FLOOR_DB = -100;

/** dBFS を 1 dB 刻みで数えるヒストグラム（純粋。長時間でもメモリは一定） */
export class LevelHistogram {
  private bins = new Array<number>(-FLOOR_DB + 1).fill(0);
  private total = 0;
  private voiced = 0;

  add(db: number, thresholdDb: number): void {
    const v = Number.isFinite(db) ? Math.min(0, Math.max(FLOOR_DB, Math.round(db))) : FLOOR_DB;
    this.bins[v - FLOOR_DB]++;
    this.total++;
    if (db >= thresholdDb) this.voiced++;
  }

  stats(speaker: string): LevelStats | null {
    if (this.total === 0) return null;
    return {
      speaker,
      frames: this.total,
      p10: this.quantile(0.1),
      median: this.quantile(0.5),
      p90: this.quantile(0.9),
      voicedRatio: round3(this.voiced / this.total),
    };
  }

  private quantile(q: number): number {
    const target = q * this.total;
    let acc = 0;
    for (let i = 0; i < this.bins.length; i++) {
      acc += this.bins[i];
      if (acc >= target) return i + FLOOR_DB;
    }
    return 0;
  }
}

/** 参加者の在室区間。途中参加・途中退出・再入室を区間の列で持つ */
export interface PresenceInfo {
  id: string;
  name: string;
  kind: SpeakerKind;
  intervals: { start: number; end: number }[];
}

/** 入退室の記録（純粋。時刻は録画相対の ms を受け取る） */
export class PresenceLog {
  private people = new Map<string, { name: string; kind: SpeakerKind; open: number | null; done: [number, number][] }>();

  join(id: string, name: string, kind: SpeakerKind, t: number): void {
    const p = this.people.get(id);
    if (!p) {
      this.people.set(id, { name, kind, open: t, done: [] });
      return;
    }
    p.name = name;
    if (p.open == null) p.open = t;
  }

  leave(id: string, t: number): void {
    const p = this.people.get(id);
    if (!p || p.open == null) return;
    p.done.push([p.open, t]);
    p.open = null;
  }

  /** 録画終了時点 (t) で在室中の人の区間を閉じて返す */
  close(t: number): PresenceInfo[] {
    return [...this.people].map(([id, p]) => ({
      id,
      name: p.name,
      kind: p.kind,
      intervals: [...p.done, ...(p.open == null ? [] : [[p.open, t] as [number, number]])].map(([s, e]) => ({
        start: round3(s / 1000),
        end: round3(e / 1000),
      })),
    }));
  }
}

interface TrackEntry {
  info: SpeakerInfo;
  analyser: AnalyserNode;
  source: AudioNode;
  state: VadState;
}

export interface SpeakerLog {
  speakers: SpeakerInfo[];
  segments: SpeechSegment[];
  /** 録画中の在室区間 (録画開始時点の参加者は start=0) */
  presence: PresenceInfo[];
  /** 話者ごとの音量の分布 */
  levels: LevelStats[];
  /** 記録を止めた時点の録画相対秒 */
  durationSec: number;
  detector: VadParams;
}

export class SpeakerActivityTracker {
  private entries = new Map<string, TrackEntry>();
  /** 一度でも登場した話者 (途中退出しても speakers に残す) */
  private speakers = new Map<string, SpeakerInfo>();
  private segments: SpeechSegment[] = [];
  private presence = new PresenceLog();
  private histograms = new Map<string, LevelHistogram>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: Float32Array<ArrayBuffer> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: AudioContext,
    private readonly params: VadParams = DEFAULT_VAD_PARAMS
  ) {}

  /**
   * トラックを監視対象にする。同じ key の再登録は差し替え（デバイス切替・再publish）。
   * source は録画ミキサーへ繋いだのと同じノードを渡す（分岐させるだけで音は変わらない）。
   */
  add(key: string, info: SpeakerInfo, source: AudioNode): void {
    if (this.stopped) return;
    this.remove(key);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    try {
      source.connect(analyser);
    } catch (e) {
      console.warn('[SpeakerActivityTracker] 監視の接続に失敗', e);
      return;
    }
    this.entries.set(key, { info, analyser, source, state: initialVadState() });
    this.speakers.set(info.id, info);
  }

  /** 監視をやめる。発話中なら今の時点で区間を閉じる */
  remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.closeOpen(entry, sessionTime());
    try {
      entry.source.disconnect(entry.analyser);
    } catch {
      // ソース側が先に切断済み
    }
    this.entries.delete(key);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.params.frameMs);
  }

  /** 参加者が部屋にいる（録画開始時点の参加者・途中参加）。録画開始前の呼び出しは捨てる */
  markPresent(id: string, name: string, kind: SpeakerKind): void {
    const t = sessionTime();
    if (t == null || this.stopped) return;
    this.presence.join(id, name, kind, t);
  }

  markAbsent(id: string): void {
    const t = sessionTime();
    if (t == null || this.stopped) return;
    this.presence.leave(id, t);
  }

  /** 記録を確定して返す。2回目以降は null（冪等） */
  stop(): SpeakerLog | null {
    if (this.stopped) return null;
    const now = sessionTime();
    for (const key of [...this.entries.keys()]) this.remove(key);
    this.dispose();
    this.stopped = true;
    return {
      speakers: [...this.speakers.values()],
      segments: [...this.segments].sort((a, b) => a.start - b.start),
      presence: this.presence.close(now ?? 0),
      levels: [...this.histograms]
        .map(([id, h]) => h.stats(id))
        .filter((s): s is LevelStats => s !== null),
      durationSec: round3((now ?? 0) / 1000),
      detector: this.params,
    };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const t = sessionTime();
    if (t == null) return;
    for (const entry of this.entries.values()) {
      const db = this.levelDb(entry.analyser);
      let hist = this.histograms.get(entry.info.id);
      if (!hist) this.histograms.set(entry.info.id, (hist = new LevelHistogram()));
      hist.add(db, this.params.thresholdDb);
      const r = stepVad(entry.state, db, t, this.params);
      entry.state = r.state;
      if (r.started) {
        recordSessionEvent({ type: 'speaking_started', participantId: entry.info.id });
      }
      if (r.segment) this.pushSegment(entry.info.id, r.segment);
    }
  }

  private closeOpen(entry: TrackEntry, t: number | null): void {
    if (!entry.state.speaking || t == null) return;
    this.pushSegment(entry.info.id, [entry.state.segmentStart, Math.max(entry.state.lastVoiceAt, t)]);
    entry.state = initialVadState();
  }

  private pushSegment(speaker: string, [startMs, endMs]: [number, number]): void {
    recordSessionEvent({ type: 'speaking_stopped', participantId: speaker });
    this.segments.push({ speaker, start: round3(startMs / 1000), end: round3(endMs / 1000) });
  }

  private levelDb(analyser: AnalyserNode): number {
    if (!this.buffer || this.buffer.length !== analyser.fftSize) {
      this.buffer = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
    const rms = Math.sqrt(sum / this.buffer.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** speakers.json の中身 */
export function buildSpeakersJson(
  log: SpeakerLog,
  meta: { recordingFile: string; startedAt: Date }
): string {
  return JSON.stringify(
    {
      format: 'jishushitsu-speakers',
      version: 1,
      recording: {
        file: meta.recordingFile,
        startedAt: meta.startedAt.toISOString(),
        durationSec: log.durationSec,
      },
      timeBase: '録画ファイルの先頭を 0 とする秒',
      detector: log.detector,
      speakers: log.speakers,
      segments: log.segments,
      // 以下は version 1 のまま後から足した項目 (読む側は無くても動くこと)
      presence: log.presence,
      levels: log.levels,
    },
    null,
    2
  );
}
