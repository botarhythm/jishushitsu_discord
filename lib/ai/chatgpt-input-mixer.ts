import { Track, RoomEvent, type Room, type RemoteTrackPublication, type RemoteTrack, type RemoteParticipant } from 'livekit-client';
import { classifyAudioPublication, isLoopbackCaptureLabel } from '@/lib/studio-participants';
import { registerAudioContext } from '@/lib/audio-runtime';

/**
 * ChatGPT 入力専用ミキサー。
 *
 * 「ローカルマイク（Human A）+ リモートの人間音声（Human B 等）」だけをアプリ内でミックスし、
 * hidden <audio> + setSinkId(CABLE-B Input) で ChatGPT デスクトップの入力デバイスへ送出する。
 * OS の「このデバイスを聴く」や LiveKit 全体の audiooutput 切替は使わない
 * （ホストが他参加者を聞けなくなる・自声の遅延回りが起きるため）。
 *
 * エコー/自己ループ防止（要件§17）の実行時安全境界:
 *   - 汎用の addTrack(MediaStreamTrack) は公開しない
 *   - 入力は Room の publication を classifyAudioPublication で検証してからのみ接続する
 *   - AI 音声（ai-audio:*）・ScreenShareAudio・未分類 Unknown は構造的に接続されない
 *     → ChatGPT 自身の声が ChatGPT 入力へ戻る経路をコードレベルで遮断する
 */
export class ChatGptInputMixer {
  private ctx: AudioContext | null = null;
  private unregister: (() => void) | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private gain: GainNode | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private nodes = new Map<string, MediaStreamAudioSourceNode>();
  private localMicNode: { track: MediaStreamTrack; source: MediaStreamAudioSourceNode } | null = null;
  private detach: (() => void) | null = null;
  private started = false;
  private blockedMicLabel: string | null = null;

  /**
   * @param room   接続済みの LiveKit Room
   * @param sinkId ChatGPT の入力デバイスへ渡す audiooutput deviceId（CABLE-B Input 等）
   */
  async start(room: Room, sinkId: string): Promise<void> {
    if (this.started) return;
    this.started = true;

    const ctx = new AudioContext();
    this.ctx = ctx;
    this.unregister = registerAudioContext(ctx);
    this.dest = ctx.createMediaStreamDestination();
    // 全ソースはこの gain を経由して destination へ送る。自己ループ検査中に
    // 送出だけ止めて「OS 側の漏れ」だけを測れるようにするため。
    this.gain = ctx.createGain();
    this.gain.connect(this.dest);
    // autoplay ポリシーで suspended のまま作られることがある。suspended だと
    // destination に音が流れず、送出先に何も届かない（無音の原因になる）。
    if (ctx.state !== "running") {
      await ctx.resume().catch(() => {});
    }

    // 送出先: hidden audio 要素を明示 sink（CABLE-B Input）へ。
    // 既定出力（ヘッドホン）には流さないので、ホストのモニタ経路とは独立。
    const el = document.createElement('audio');
    el.style.display = 'none';
    el.autoplay = true;
    el.srcObject = this.dest.stream;
    document.body.appendChild(el);
    this.audioEl = el;
    await el.setSinkId(sinkId);
    el.play().catch(() => {
      // autoplay 制限は AudioRuntime の resume と同じユーザー操作で解除される
    });

    // ── ローカルマイク（Human A）──
    const connectLocalMic = () => {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      // 実行時ガード: マイク publication 以外（AI publish 等）はここに来ない
      if (!pub || classifyAudioPublication(pub) !== 'human') return;
      const mst = pub.track?.mediaStreamTrack;
      if (!mst || !this.ctx || !this.gain) return;
      // ループバック録音デバイス(ステレオミキサー等)は再生音をそのまま拾うため、
      // AI モニタの音声が ChatGPT の耳へ戻り自己ループ(ハウリング)になる。
      // しかも本人の声は入らない。接続を拒否して UI に理由を出す。
      if (isLoopbackCaptureLabel(mst.label)) {
        this.blockedMicLabel = mst.label;
        return;
      }
      this.blockedMicLabel = null;
      if (this.localMicNode?.track === mst) return;
      if (this.localMicNode) {
        try {
          this.localMicNode.source.disconnect();
        } catch {
          // ignore
        }
        this.localMicNode = null;
      }
      try {
        const source = this.ctx.createMediaStreamSource(new MediaStream([mst]));
        source.connect(this.gain);
        this.localMicNode = { track: mst, source };
      } catch (e) {
        console.warn('[ChatGptInputMixer] ローカルマイク接続失敗', e);
      }
    };

    // ── リモートの人間音声（Human B 等）──
    const addRemote = (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return;
      // 実行時ガード: human 以外（AI音声・画面共有音声・未分類 Unknown）は接続しない。
      // これが「ChatGPT出力 → ChatGPT入力」の再帰ループを塞ぐ本体。
      if (classifyAudioPublication(pub) !== 'human') return;
      if (!this.ctx || !this.gain) return;
      const ms = track.mediaStream ?? (track.mediaStreamTrack ? new MediaStream([track.mediaStreamTrack]) : null);
      if (!ms) return;
      const key = `${participant.identity}:${track.sid ?? ''}`;
      if (this.nodes.has(key)) return;
      try {
        const source = this.ctx.createMediaStreamSource(ms);
        source.connect(this.gain);
        this.nodes.set(key, source);
      } catch (e) {
        console.warn('[ChatGptInputMixer] リモート音声接続失敗', e);
      }
    };

    const removeRemote = (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const key = `${participant.identity}:${track.sid ?? ''}`;
      const node = this.nodes.get(key);
      if (node) {
        try {
          node.disconnect();
        } catch {
          // ignore
        }
        this.nodes.delete(key);
      }
    };

    connectLocalMic();
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        const t = pub.track;
        if (t && t.kind === Track.Kind.Audio) {
          addRemote(t as RemoteTrack, pub as RemoteTrackPublication, participant);
        }
      });
    });

    const onLocalPublished = () => connectLocalMic();
    room.on(RoomEvent.TrackSubscribed, addRemote);
    room.on(RoomEvent.TrackUnsubscribed, removeRemote);
    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);
    // デバイス切替(switchActiveDevice)はトラックを差し替えるだけで
    // LocalTrackPublished が飛ばないことがある。ActiveDeviceChanged を拾い、
    // さらに取りこぼし対策として定期的にも読み直す(connectLocalMic は冪等)。
    room.on(RoomEvent.ActiveDeviceChanged, onLocalPublished);
    const micPoll = setInterval(connectLocalMic, 1000);
    this.detach = () => {
      room.off(RoomEvent.TrackSubscribed, addRemote);
      room.off(RoomEvent.TrackUnsubscribed, removeRemote);
      room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
      room.off(RoomEvent.ActiveDeviceChanged, onLocalPublished);
      clearInterval(micPoll);
    };
  }

  /** 送出の一時停止/再開（自己ループ検査中に OS 側の漏れだけを測るため） */
  setSendEnabled(on: boolean): void {
    if (!this.gain || !this.ctx) return;
    this.gain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** 送出経路が実際に成立しているかの内部状態（切り分け用） */
  getDiagnostics(): {
    contextState: string;
    localMic: { label: string; enabled: boolean; muted: boolean } | null;
    blockedMicLabel: string | null;
    remoteCount: number;
  } {
    const t = this.localMicNode?.track ?? null;
    return {
      contextState: this.ctx?.state ?? "none",
      localMic: t ? { label: t.label, enabled: t.enabled, muted: t.muted } : null,
      blockedMicLabel: this.blockedMicLabel,
      remoteCount: this.nodes.size,
    };
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
    this.nodes.forEach((n) => {
      try {
        n.disconnect();
      } catch {
        // ignore
      }
    });
    this.nodes.clear();
    if (this.localMicNode) {
      try {
        this.localMicNode.source.disconnect();
      } catch {
        // ignore
      }
      this.localMicNode = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    this.unregister?.();
    this.unregister = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.gain = null;
    this.dest = null;
    this.started = false;
  }
}
