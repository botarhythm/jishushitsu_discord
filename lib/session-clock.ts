/**
 * 収録セッションの単調増加クロックとイベント記録（要件 FR-008 / NFR-005）。
 *
 * 音声・映像・イベントのタイムラインが同一の時計を共有するようにする。
 * 基準は **MediaRecorder.start() の直前**に確定した performance.now()。
 * 収録ファイルの先頭が 0 になるので、後からイベントを収録内容へ突き合わせられる。
 *
 * Phase 1 ではメモリ内に保持するだけ（要件どおり speaking-events.json 等の
 * ファイル出力は Phase 2）。ただし内部モデルと時計は先に入れておく。
 */

export type SessionEvent =
  | { type: 'recording_started'; t: number }
  | { type: 'recording_stopped'; t: number; reason: string }
  | { type: 'speaking_started'; t: number; participantId: string }
  | { type: 'speaking_stopped'; t: number; participantId: string }
  | { type: 'track_replaced'; t: number; participantId: string }
  | { type: 'participant_error'; t: number; participantId: string };

/** 記録時に渡す形（時刻はこのモジュールが付ける） */
export type SessionEventInput =
  | { type: 'recording_started' }
  | { type: 'recording_stopped'; reason: string }
  | { type: 'speaking_started'; participantId: string }
  | { type: 'speaking_stopped'; participantId: string }
  | { type: 'track_replaced'; participantId: string }
  | { type: 'participant_error'; participantId: string };

let originPerf: number | null = null;
let originWallClock: number | null = null;
const events: SessionEvent[] = [];

/** MediaRecorder.start() の直前に呼ぶ。以降のイベントはここからの相対時刻になる */
export function startSessionClock(): void {
  originPerf = performance.now();
  // 外部表示用の補助。時刻の基準そのものは performance.now() 側を使う
  originWallClock = Date.now();
  events.length = 0;
}

export function stopSessionClock(): void {
  originPerf = null;
  originWallClock = null;
}

/** セッション相対のミリ秒。収録していなければ null */
export function sessionTime(): number | null {
  return originPerf == null ? null : performance.now() - originPerf;
}

/** 収録の開始時刻（壁時計）。ファイル名や表示用の補助 */
export function sessionStartedAtWallClock(): number | null {
  return originWallClock;
}

/**
 * イベントを記録する。収録していない間は捨てる
 * （収録ファイルに対応づかないイベントを持っても意味がないため）。
 */
export function recordSessionEvent(ev: SessionEventInput): void {
  const t = sessionTime();
  if (t == null) return;
  events.push({ ...ev, t } as SessionEvent);
}

export function getSessionEvents(): SessionEvent[] {
  return [...events];
}

/** 収録終了時のサマリ（Phase 2 の JSON 出力までの繋ぎとして console に出す） */
export function summarizeSessionEvents(): string {
  const speaking = events.filter((e) => e.type === 'speaking_started').length;
  const errors = events.filter((e) => e.type === 'participant_error').length;
  const replaced = events.filter((e) => e.type === 'track_replaced').length;
  return `events=${events.length} speaking=${speaking} trackReplaced=${replaced} errors=${errors}`;
}
