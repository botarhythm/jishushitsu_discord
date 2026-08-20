/**
 * 録画ミキサー向けの汎用「追加音声トラック」レジストリ。
 *
 * Recorder (useLocalRecording) はこのレジストリ経由でしか追加音声を知らない。
 * 「AI」「ChatGPT」等のドメイン概念をここに持ち込まないこと（要件§13:
 * Recorder は AudioTrack しか認識しない）。トラックの stop 権限は登録側
 * （Provider 等のオーナー）にあり、レジストリは参照を保持するだけ。
 */

export interface AudioTrackRegistryEvent {
  type: 'add' | 'remove';
  id: string;
  track?: MediaStreamTrack;
}

export class AudioTrackRegistry {
  private tracks = new Map<string, MediaStreamTrack>();
  private listeners = new Set<(ev: AudioTrackRegistryEvent) => void>();

  /** 同じ id への再登録はトラック差し替え（remove → add）として通知する */
  add(id: string, track: MediaStreamTrack): void {
    const existing = this.tracks.get(id);
    if (existing === track) return;
    if (existing) {
      this.tracks.delete(id);
      this.emit({ type: 'remove', id });
    }
    this.tracks.set(id, track);
    this.emit({ type: 'add', id, track });
  }

  remove(id: string): void {
    if (!this.tracks.has(id)) return;
    this.tracks.delete(id);
    this.emit({ type: 'remove', id });
  }

  list(): { id: string; track: MediaStreamTrack }[] {
    return Array.from(this.tracks, ([id, track]) => ({ id, track }));
  }

  subscribe(cb: (ev: AudioTrackRegistryEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(ev: AudioTrackRegistryEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch (e) {
        console.warn('[AudioTrackRegistry] listener error', e);
      }
    }
  }
}
