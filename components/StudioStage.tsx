'use client';

import { useMemo } from 'react';
import {
  VideoTrack,
  useTracks,
  useParticipants,
  isTrackReference,
} from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { Track, Participant } from 'livekit-client';

/** 収録レイアウトのプリセット */
export type StudioLayout = 'split' | 'screen-main' | 'solo';

export const STUDIO_LAYOUT_LABELS: Record<StudioLayout, string> = {
  split: '横並び2分割',
  'screen-main': '画面共有メイン+小窓',
  solo: 'ソロ1名',
};

/** レイアウトごとに必要な出演者スロット数 */
export const STUDIO_LAYOUT_SLOTS: Record<StudioLayout, number> = {
  split: 2,
  'screen-main': 2,
  solo: 1,
};

interface StudioStageProps {
  layout: StudioLayout;
  /** スロット順に並べた出演者 identity。null は空きスロット */
  slotIdentities: (string | null)[];
  /** ネームプレート(lower-third)を表示するか */
  showNameplates: boolean;
  /** 16:9 ステージ要素への ref。Region Capture で録画をこの矩形にクロップするために使用 */
  stageRef?: React.Ref<HTMLDivElement>;
}

/**
 * 収録モードのステージ。
 *
 * - 画面中央に 16:9 ステージをレターボックス配置（周囲は黒）。
 *   ビューポート比が 16:9 でなくても、録画フレームは YouTube 最適比率に収まる。
 * - 録画はホストの自タブをキャプチャするため、このステージはホストの画面だけ切り替えればよい。
 */
export function StudioStage({ layout, slotIdentities, showNameplates, stageRef }: StudioStageProps) {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: false,
  });
  const participants = useParticipants();

  const byIdentity = useMemo(() => {
    const map = new Map<string, Participant>();
    for (const p of participants) map.set(p.identity, p);
    return map;
  }, [participants]);

  const camRef = (identity: string | null): TrackReference | null => {
    if (!identity) return null;
    const t = tracks.find(
      (tr) =>
        isTrackReference(tr) &&
        tr.participant.identity === identity &&
        tr.source === Track.Source.Camera
    );
    return t && isTrackReference(t) ? t : null;
  };

  const screenRef = useMemo<TrackReference | null>(() => {
    const t = tracks.find(
      (tr) => isTrackReference(tr) && tr.source === Track.Source.ScreenShare
    );
    return t && isTrackReference(t) ? t : null;
  }, [tracks]);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black">
      {/* 16:9 レターボックスステージ。max-width を vh 基準にして縦がはみ出さないよう調整。
          stageRef は Region Capture のクロップ対象 (この矩形=16:9 が録画範囲になる)。 */}
      <div
        ref={stageRef}
        className="relative aspect-video w-full"
        style={{ maxWidth: 'calc(100dvh * 16 / 9)', maxHeight: '100%' }}
      >
        {layout === 'split' && (
          <div className="absolute inset-0 grid grid-cols-2 gap-px bg-stone-950">
            {[0, 1].map((i) => (
              <Slot
                key={i}
                participant={byIdentity.get(slotIdentities[i] ?? '') ?? null}
                trackRef={camRef(slotIdentities[i] ?? null)}
                showNameplate={showNameplates}
              />
            ))}
          </div>
        )}

        {layout === 'solo' && (
          <div className="absolute inset-0 bg-stone-950">
            <Slot
              participant={byIdentity.get(slotIdentities[0] ?? '') ?? null}
              trackRef={camRef(slotIdentities[0] ?? null)}
              showNameplate={showNameplates}
              cover
            />
          </div>
        )}

        {layout === 'screen-main' && (
          <div className="absolute inset-0 bg-stone-950">
            {/* メイン: 画面共有 (object-contain で全体を表示) */}
            <div className="absolute inset-0 flex items-center justify-center bg-black">
              {screenRef ? (
                <VideoTrack trackRef={screenRef} className="h-full w-full object-contain" />
              ) : (
                <div className="text-sm text-stone-500">画面共有を待機中…</div>
              )}
            </div>
            {/* 小窓: 出演者を右下に縦積み */}
            <div className="absolute bottom-3 right-3 flex flex-col gap-2">
              {slotIdentities.slice(0, 2).map((id, i) => (
                <div
                  key={i}
                  className="aspect-video w-40 overflow-hidden rounded-md border border-stone-700/80 bg-stone-900 shadow-lg"
                >
                  <Slot
                    participant={byIdentity.get(id ?? '') ?? null}
                    trackRef={camRef(id ?? null)}
                    showNameplate={showNameplates}
                    compact
                    cover
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Slot({
  participant,
  trackRef,
  showNameplate,
  cover = false,
  compact = false,
}: {
  participant: Participant | null;
  trackRef: TrackReference | null;
  showNameplate: boolean;
  /** true: object-cover でスロットを埋める / false: object-contain */
  cover?: boolean;
  /** 小窓向けの控えめ表示 */
  compact?: boolean;
}) {
  if (!participant) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-stone-900 text-xs text-stone-600">
        出演者未割当
      </div>
    );
  }

  const name = participant.name?.trim() || participant.identity;
  const fit = cover ? 'object-cover' : 'object-contain';

  return (
    <div className="relative h-full w-full bg-stone-900">
      {trackRef ? (
        <VideoTrack trackRef={trackRef} className={`h-full w-full ${fit}`} />
      ) : (
        <AvatarPlate name={name} compact={compact} />
      )}

      {showNameplate && (
        <div
          className={`absolute left-0 bottom-0 ${
            compact ? 'px-1.5 py-0.5' : 'px-4 py-2'
          }`}
        >
          <span
            className={`inline-block rounded-md bg-black/55 font-medium text-white backdrop-blur-sm ${
              compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-3 py-1 text-base'
            }`}
          >
            {name}
          </span>
        </div>
      )}
    </div>
  );
}

function AvatarPlate({ name, compact }: { name: string; compact: boolean }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-b from-stone-800 to-stone-900 text-stone-300">
      <div
        className={`flex items-center justify-center rounded-full bg-stone-700 font-semibold text-stone-100 ${
          compact ? 'h-8 w-8 text-sm' : 'h-24 w-24 text-4xl'
        }`}
      >
        {initial}
      </div>
      {!compact && <span className="text-lg font-medium text-stone-300">{name}</span>}
    </div>
  );
}
