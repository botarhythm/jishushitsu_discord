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
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      simulcast: true,
      degradationPreference: 'balanced',
    },
  };
}
