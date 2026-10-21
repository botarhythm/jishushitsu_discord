/**
 * マイク/カメラの失敗を、原因の切り分けに必要な情報と一緒にサーバーへ送る
 * (/api/device-log → Vercel の Runtime Logs)。
 *
 * 送るのはエラー名・権限の状態・機器の種類と件数だけで、機器のラベルは
 * 先頭だけに切り詰める (端末の識別につながる情報を必要以上に送らない)。
 * 送信の失敗は無視する (診断のために本来の操作を妨げない)。
 */
export async function reportDeviceFailure(
  device: 'mic' | 'camera',
  phase: string,
  error: unknown,
  extra: Record<string, unknown> = {}
): Promise<void> {
  try {
    const err =
      error instanceof Error
        ? { name: error.name, message: error.message, constraint: (error as { constraint?: string }).constraint }
        : { name: 'non-error', message: String(error) };

    let permission: string | null = null;
    try {
      const name = (device === 'mic' ? 'microphone' : 'camera') as PermissionName;
      permission = (await navigator.permissions.query({ name })).state;
    } catch {
      permission = 'unavailable';
    }

    let devices: { kind: string; label: string }[] | null = null;
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).map((d) => ({
        kind: d.kind,
        label: d.label.slice(0, 24),
      }));
    } catch {
      devices = null;
    }

    await fetch('/api/device-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device,
        phase,
        error: err,
        permission,
        devices,
        visibility: document.visibilityState,
        ...extra,
      }),
      keepalive: true,
    });
  } catch {
    // ignore
  }
}

/** バナーに添える技術的な詳細 (利用者がスクリーンショットで共有できるように) */
export function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 160);
  return String(error).slice(0, 160);
}
