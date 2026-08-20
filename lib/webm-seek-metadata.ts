/**
 * MediaRecorder が吐く WebM は SeekHead / Cues / Duration を欠いており、
 * 編集ソフト (Canva 等) でタイムラインを構築できない。ここではその欠損を
 * ts-ebml で補い「シーク可能な WebM」へ変換する。
 *
 * 録画停止時 (useLocalRecording) とクラッシュ復旧時 (RecordingRecoveryPrompt) の
 * 両方から使うため、フックから切り出して単独モジュールにしてある。
 */

/**
 * ts-ebml (と Buffer polyfill) をロードする。
 * ts-ebml は Node の Buffer グローバルに依存しているため、ブラウザでは事前に polyfill する。
 *
 * 注意: ts-ebml が依存する ebml パッケージはブラウザ向けエントリが壊れており、
 * next.config.ts の turbopack.resolveAlias で ESM ビルドへ張り替えないと
 * この import 自体がモジュール評価時に throw する (その場合 Duration/Cues の無い
 * 「編集ソフトで開けない WebM」が保存されてしまう)。録画開始時に preload して
 * 失敗を早期に検知する。
 */
export async function loadTsEbml() {
  if (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { Buffer?: unknown }).Buffer === 'undefined'
  ) {
    const { Buffer } = await import('buffer');
    (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
  }
  return import('ts-ebml');
}

/**
 * WebM に SeekHead / Cues / Duration を注入して、編集ソフトで開ける形にする。
 */
export async function injectWebmSeekMetadata(blob: Blob): Promise<Blob> {
  const { Decoder, tools, Reader } = await loadTsEbml();
  const decoder = new Decoder();
  const reader = new Reader();
  reader.logging = false;
  const buf = await blob.arrayBuffer();
  const elms = decoder.decode(buf);
  elms.forEach((elm) => reader.read(elm));
  reader.stop();
  const refinedMetadataBuf = tools.makeMetadataSeekable(
    reader.metadatas,
    reader.duration,
    reader.cues
  );
  // 長尺録画は数百 MB になるため、本体は ArrayBuffer.slice (即コピー) ではなく
  // Blob.slice (遅延参照) で切り出してメモリピークを倍増させない。
  const body = blob.slice(reader.metadataSize);
  return new Blob([refinedMetadataBuf, body], { type: blob.type });
}
