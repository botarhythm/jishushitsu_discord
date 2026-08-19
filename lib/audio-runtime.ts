/**
 * アプリ内の独自 AudioContext（RMS発話検出・ChatGPT入力ミキサー・AIモニタ等）の一元管理。
 *
 * ブラウザの autoplay ポリシーで AudioContext は suspended のまま始まることがあり、
 * LiveKit の room.startAudio()（StartAudioBanner）だけでは独自 context は resume されない。
 * ここに登録された context をユーザー操作時にまとめて resume する。
 */

const contexts = new Set<AudioContext>();
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
