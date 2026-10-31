import { AudioPresets, VideoPresets, type RoomOptions } from 'livekit-client';

/** Conversation defaults: reserve bandwidth and encoder time for speech. */
export function createCallRoomOptions(): RoomOptions {
  return {
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { channelCount: 1 },
    videoCaptureDefaults: {
      resolution: { ...VideoPresets.h540.resolution, frameRate: 20 },
    },
    publishDefaults: {
      // Keep quiet syllables and virtual microphone input continuous.
      dtx: false,
      red: true,
      forceStereo: false,
      audioPreset: AudioPresets.speech,
      videoEncoding: { maxBitrate: 700_000, maxFramerate: 20, priority: 'low' },
      // 上りの総量を抑える。540p・360p・180p の 3 層では合計約 1.3 Mbps を常に送っており、
      // 弱い Wi-Fi で上りが詰まる一因になっていた (docs/reviews/2026-10-30-zoom-vs-livekit.md)。
      // 中間の 360p 層をやめ、540p（上限 700 kbps）と 180p（160 kbps）の 2 層にする
      videoSimulcastLayers: [VideoPresets.h180],
      simulcast: true,
      degradationPreference: 'balanced',
    },
  };
}
