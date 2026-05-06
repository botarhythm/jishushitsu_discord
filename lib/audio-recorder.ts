/**
 * 自習室の全参加者の音声をブラウザでミックス録音するユーティリティ。
 *
 * 仕組み:
 *   - Web Audio API の AudioContext で AudioGraph を組む
 *   - 各 MediaStreamTrack を MediaStreamAudioSourceNode として接続
 *   - すべての SourceNode を 1 つの GainNode に集約
 *   - GainNode → MediaStreamAudioDestinationNode → MediaStream
 *   - MediaRecorder でその MediaStream を録音
 *
 * 参加者が増減してもトラックを動的に追加できるよう、addTrack/removeTrack を提供する。
 *
 * EchoNote へ送るのは webm/opus（軽量・Gemini が認識可能）。
 */
export class SessionAudioRecorder {
  private audioContext: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private mixer: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private trackSources = new Map<string, MediaStreamAudioSourceNode>();
  private startedAt: number | null = null;

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  get durationMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async start(): Promise<void> {
    if (this.recorder) throw new Error('既に録音中です');

    this.audioContext = new AudioContext();
    this.mixer = this.audioContext.createGain();
    this.destination = this.audioContext.createMediaStreamDestination();
    this.mixer.connect(this.destination);

    const stream = this.destination.stream;
    const mimeType = pickSupportedMimeType();
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];

    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };

    // 1秒ごとにチャンクを切る（中断しても部分回収できる余地を残す）
    this.recorder.start(1000);
    this.startedAt = Date.now();
  }

  /**
   * 参加者の音声トラックをミックスに追加する。
   * trackId にはトラック ID（重複防止用の一意キー）を渡す。
   */
  addTrack(trackId: string, track: MediaStreamTrack): void {
    if (!this.audioContext || !this.mixer) return;
    if (track.kind !== 'audio') return;
    if (this.trackSources.has(trackId)) return;

    try {
      const stream = new MediaStream([track]);
      const source = this.audioContext.createMediaStreamSource(stream);
      source.connect(this.mixer);
      this.trackSources.set(trackId, source);
    } catch (err) {
      console.warn('[recorder] addTrack failed', err);
    }
  }

  removeTrack(trackId: string): void {
    const source = this.trackSources.get(trackId);
    if (!source) return;
    try {
      source.disconnect();
    } catch {
      // ignore
    }
    this.trackSources.delete(trackId);
  }

  async stopAndFinalize(): Promise<{ blob: Blob; mimeType: string; durationMs: number }> {
    if (!this.recorder) throw new Error('録音が開始されていません');
    const recorder = this.recorder;
    const finalChunks = await new Promise<Blob[]>((resolve) => {
      recorder.onstop = () => resolve(this.chunks);
      try {
        recorder.stop();
      } catch {
        resolve(this.chunks);
      }
    });

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(finalChunks, { type: mimeType });
    const durationMs = this.durationMs;

    this.cleanup();
    return { blob, mimeType, durationMs };
  }

  private cleanup(): void {
    this.trackSources.forEach((s) => {
      try {
        s.disconnect();
      } catch {
        // ignore
      }
    });
    this.trackSources.clear();
    try {
      this.audioContext?.close();
    } catch {
      // ignore
    }
    this.audioContext = null;
    this.mixer = null;
    this.destination = null;
    this.recorder = null;
    this.startedAt = null;
  }

  abort(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // ignore
      }
    }
    this.cleanup();
  }
}

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}
