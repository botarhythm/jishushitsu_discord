import { Room, Track, type LocalVideoTrack } from 'livekit-client';

/**
 * カメラを ON にする。カメラが応答しないときは、取り直し → 別のカメラの順に立て直す。
 *
 * 2026-11-20 夜、講師のカメラが通話の途中で止まり、その後 1 時間、ON にするたびに
 * `AbortError: Timeout starting video source` で失敗し続けた (Vercel の device-log に 12 回)。
 * LiveKit の ON は、止まった publication を同じカメラ・同じ条件で取り直すだけなので、
 * カメラ側が応答しない間は何度押しても同じ失敗を繰り返していた。
 *
 * ここでは「カメラが起動しない」種類の失敗に限って、次の順に試す:
 * 1. いつもどおり ON にする
 * 2. 止まった publication を外して捨て、少し待ってから同じカメラで作り直す
 * 3. ほかの実機カメラ (仮想カメラは除く) を順に試す
 * 権限の拒否やカメラが無いときは、試しても直らないのでそのまま失敗を返す。
 */

export type CameraRecovery = 'fresh' | 'other-device';

export interface CameraEnableResult {
  /** 1 で戻らず、2 か 3 で戻ったとき */
  recovered?: CameraRecovery;
  /** 使っているカメラの名前 */
  label?: string;
}

/** ブラウザがカメラを起動できなかった（応答しない・他のアプリが使用中）ときの失敗か */
export function isCameraStartFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    ['AbortError', 'NotReadableError', 'TrackStartError', 'SourceUnavailableError'].includes(e.name) ||
    /timeout starting|could not start/i.test(e.message)
  );
}

/** 何も映さないことがあるため、別のカメラを自動で選ぶときは使わない（設定から選ぶことはできる） */
const VIRTUAL_CAMERA = /virtual|obs|logi capture|snap camera|manycam|xsplit|broadcast|droidcam|iriun|epoccam|camo/i;
const OTHER_DEVICES_MAX = 2;
const FRESH_RETRY_DELAY_MS = 1000;

const inFlight = new WeakMap<Room, Promise<CameraEnableResult>>();

function cameraTrack(room: Room): LocalVideoTrack | undefined {
  return room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack;
}

function labelOf(room: Room): string | undefined {
  return cameraTrack(room)?.mediaStreamTrack?.label || undefined;
}

/** OS に止められたまま publication だけ残っているトラックを取り直す */
async function reviveEnded(room: Room): Promise<void> {
  const track = cameraTrack(room);
  if (track && track.mediaStreamTrack?.readyState === 'ended') {
    console.warn('[camera] トラックが終了していたため取り直します');
    await track.restartTrack();
  }
}

async function tryEnable(room: Room, deviceId?: string): Promise<void> {
  await room.localParticipant.setCameraEnabled(true, deviceId ? { deviceId: { exact: deviceId } } : undefined);
  await reviveEnded(room);
  if (!room.localParticipant.isCameraEnabled) throw new Error('camera did not turn on');
}

async function enable(room: Room, onProgress?: (message: string) => void): Promise<CameraEnableResult> {
  const lp = room.localParticipant;
  let firstError: unknown;
  try {
    await tryEnable(room);
    return { label: labelOf(room) };
  } catch (e) {
    if (!isCameraStartFailure(e)) throw e;
    firstError = e;
  }

  // 2. 止まった publication を捨てて、同じカメラで作り直す
  onProgress?.('カメラが応答しないため、カメラを起動し直しています…');
  const stale = cameraTrack(room);
  const currentId =
    stale?.mediaStreamTrack?.getSettings().deviceId || room.getActiveDevice('videoinput') || undefined;
  const currentLabel = stale?.mediaStreamTrack?.label;
  if (stale) await lp.unpublishTrack(stale, true).catch(() => {});
  await new Promise((r) => setTimeout(r, FRESH_RETRY_DELAY_MS));
  try {
    await tryEnable(room, currentId && currentId !== 'default' ? currentId : undefined);
    return { recovered: 'fresh', label: labelOf(room) };
  } catch (e) {
    if (!isCameraStartFailure(e)) throw e;
  }

  // 3. ほかの実機カメラを試す
  const devices = await Room.getLocalDevices('videoinput', false).catch(() => [] as MediaDeviceInfo[]);
  const others = devices
    .filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== currentId)
    .filter((d) => d.label !== currentLabel && !VIRTUAL_CAMERA.test(d.label))
    .slice(0, OTHER_DEVICES_MAX);
  for (const d of others) {
    onProgress?.(`カメラが応答しないため、「${d.label || '別のカメラ'}」に切り替えています…`);
    try {
      await tryEnable(room, d.deviceId);
      // 設定画面のカメラ選択にも反映する
      await room.switchActiveDevice('videoinput', d.deviceId).catch(() => {});
      return { recovered: 'other-device', label: labelOf(room) ?? d.label };
    } catch (e) {
      if (!isCameraStartFailure(e)) throw e;
      // 失敗した試行で publication が残っていれば外して次へ
      const leftover = cameraTrack(room);
      if (leftover) await lp.unpublishTrack(leftover, true).catch(() => {});
    }
  }
  throw firstError;
}

/** 同時に何度押されても、立て直しは 1 本だけ走らせる */
export function enableCameraWithRecovery(
  room: Room,
  onProgress?: (message: string) => void
): Promise<CameraEnableResult> {
  const running = inFlight.get(room);
  if (running) return running;
  const p = enable(room, onProgress).finally(() => inFlight.delete(room));
  inFlight.set(room, p);
  return p;
}

/** 立て直しても起動しなかったときに本人へ出す案内 */
export const CAMERA_STUCK_MESSAGE =
  'カメラが応答せず、起動できませんでした。\n' +
  'カメラを使う他のアプリ（カメラの付属ソフト・OBS・Zoom など）を閉じるか、カメラの USB を挿し直してから、もう一度 ON にしてください。' +
  '直らないときは、設定（歯車）から別のカメラを選ぶか、ページを再読み込みしてください。';
