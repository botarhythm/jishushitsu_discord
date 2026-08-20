/**
 * アプリ内の独自 AudioContext（RMS発話検出・ChatGPT入力ミキサー・AIモニタ等）の一元管理。
 *
 * ブラウザの autoplay ポリシーで AudioContext は suspended のまま始まることがあり、
 * LiveKit の room.startAudio()（StartAudioBanner）だけでは独自 context は resume されない。
 * ここに登録された context をユーザー操作時にまとめて resume する。
 */

const contexts = new Set<AudioContext>();
let shared: AudioContext | null = null;

/**
 * アプリ全体で共有する唯一の AudioContext。
 *
 * AudioContext は1つにつき専用のオーディオレンダースレッドを持つ。発話検出・
 * 録画ミキサー・ChatGPT入力ミキサー・レベルメータがそれぞれ context を作ると
 * 同時に5〜6本のスレッドが走り、収録で CPU が詰まっている場面では取りこぼし
 * （音の途切れ）を起こす。グラフは1つの context の中で並列に組めるので、
 * context 自体は共有して1本に抑える。
 *
 * - close() してはならない。利用側は自分のノードを disconnect するだけにする。
 * - サンプルレートは 48kHz に固定する。WebRTC・VB-CABLE・MediaRecorder が
 *   いずれも 48kHz 前提であり、途中で変換が挟まると音質と負荷の両方で損をする。
 * - latencyHint は 'playback'。バッファを厚く取り、負荷変動でのアンダーラン
 *   （プチプチ・途切れ）を避ける。数十 ms の遅延と引き換えだが、収録用途では
 *   途切れないことのほうが重要。
 */
export function getSharedAudioContext(): AudioContext {
  if (shared && shared.state !== 'closed') return shared;
  try {
    shared = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  } catch {
    // sampleRate 指定を受け付けない環境ではブラウザ既定にフォールバックする
    shared = new AudioContext();
  }
  registerAudioContext(shared);
  return shared;
}
const stateListeners = new Set<() => void>();

export function registerAudioContext(ctx: AudioContext): () => void {
  contexts.add(ctx);
  const notify = () => notifyStateChange();
  ctx.addEventListener('statechange', notify);
  notifyStateChange();
  return () => {
    ctx.removeEventListener('statechange', notify);
    contexts.delete(ctx);
    notifyStateChange();
  };
}

/** ユーザー操作（クリック等）のハンドラ内から呼ぶこと */
export async function resumeAllAudioContexts(): Promise<void> {
  await Promise.all(
    Array.from(contexts, (ctx) =>
      ctx.state !== 'running' ? ctx.resume().catch(() => {}) : Promise.resolve()
    )
  );
}

/** suspended のままの独自 context があるか（UI 表示用） */
export function hasSuspendedAudioContext(): boolean {
  for (const ctx of contexts) {
    if (ctx.state === 'suspended') return true;
  }
  return false;
}

export function subscribeAudioRuntimeState(cb: () => void): () => void {
  stateListeners.add(cb);
  return () => {
    stateListeners.delete(cb);
  };
}

function notifyStateChange(): void {
  for (const cb of stateListeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}
