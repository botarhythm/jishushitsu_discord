/**
 * 録画ファイルの命名とダウンロード。
 * 通常の停止と、クラッシュ復旧の両方から同じ名前規則で保存するために共有する。
 */

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  return 'webm';
}

/**
 * `自習室_20260820_143005.webm` 形式のファイル名を作る。
 * @param at 録画開始時刻。復旧時は「いつ録ったものか」が分かるよう開始時刻を渡す。
 */
export function buildRecordingFilename(
  filePrefix: string,
  mimeType: string,
  at: Date = new Date(),
  suffix = ''
): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${filePrefix}_${ts}${suffix}.${extensionFor(mimeType)}`;
}

/** Blob を指定ファイル名でダウンロードさせる。 */
export function downloadBlobAs(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 長尺ファイルはダウンロード開始までに時間がかかるため、すぐには revoke しない。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
