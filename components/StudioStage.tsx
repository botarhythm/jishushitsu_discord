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
import {
  resolveLayout,
  type StudioLayout,
  type SlotGeometry,
} from '@/lib/studio-layouts';
import { parseSlotToken, type AiTileState } from '@/lib/studio-participants';
import { AiAvatarTile } from './AiAvatarTile';
import { AiEnergyOrb } from './AiEnergyOrb';

// 後方互換 re-export（従来 StudioStage からインポートしていたモジュール向け）
export {
  STUDIO_LAYOUT_LABELS,
  STUDIO_LAYOUT_SLOTS,
  MAX_STUDIO_SLOTS,
  type StudioLayout,
} from '@/lib/studio-layouts';

interface StudioStageProps {
  layout: StudioLayout;
  /**
   * スロット順に並べた出演者トークン。null は空きスロット。
   * 人間 = LiveKit identity / AI = "ai:<id>"（lib/studio-participants.ts 参照）
   */
  slotTokens: (string | null)[];
  /** ネームプレート(lower-third)を表示するか */
  showNameplates: boolean;
  /** 16:9 ステージ要素への ref。Region Capture で録画をこの矩形にクロップするために使用 */
  stageRef?: React.Ref<HTMLDivElement>;
  /** AI 参加者タイルの状態 (aiId → state)。未指定/未解決の ai トークンはプレースホルダになる */
  aiTiles?: Record<string, AiTileState>;
  /**
   * 中央に重ねて表示する AI のエネルギー球。
   * スロットを占有しないので、人物レイアウトの縦横比を変えずに AI を登場させられる。
   */
  aiOrb?: AiTileState | null;
}

/**
 * 収録モードのステージ。
 *
 * - 画面中央に 16:9 ステージをレターボックス配置（周囲は黒）。
 *   ビューポート比が 16:9 でなくても、録画フレームは YouTube 最適比率に収まる。
 * - 録画はホストの自タブをキャプチャするため、このステージはホストの画面だけ切り替えればよい。
 * - レイアウトは lib/studio-layouts.ts のレジストリでデータ駆動（固定人数のJSX分岐を持たない）。
 *   未知のレイアウトIDは split にフォールバックし、決して空ステージにしない。
 */
export function StudioStage({ layout, slotTokens, showNameplates, stageRef, aiTiles, aiOrb }: StudioStageProps) {
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

  const spec = resolveLayout(layout);

  const renderTile = (token: string | null, geo: SlotGeometry) => {
    const ref = parseSlotToken(token);
    if (ref?.kind === 'ai') {
      const ai = aiTiles?.[ref.aiId];
      if (ai) {
        return (
          <AiTileWithNameplate
            state={ai}
            showNameplate={showNameplates}
            compact={geo.compact ?? false}
          />
        );
      }
      // descriptor 未解決 (旧metadata・状態未着) は空きスロット同等のプレースホルダ
      return <EmptySlot />;
    }
    if (ref?.kind === 'human') {
      return (
        <HumanTile
          participant={byIdentity.get(ref.identity) ?? null}
          trackRef={camRef(ref.identity)}
          showNameplate={showNameplates}
          cover={geo.cover ?? false}
          compact={geo.compact ?? false}
        />
      );
    }
    return <EmptySlot />;
  };

  return (
    <div className="flex h-full w-full items-center justify-center overflow-hidden bg-black">
      {/* 16:9 レターボックスステージ。max-width を vh 基準にして縦がはみ出さないよう調整。
          stageRef は Region Capture のクロップ対象 (この矩形=16:9 が録画範囲になる)。 */}
      <div
        ref={stageRef}
        className="relative aspect-video w-full"
        style={{ maxWidth: 'calc(100dvh * 16 / 9)', maxHeight: '100%' }}
      >
        {spec.kind === 'screen-main' ? (
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
              {spec.slots.map((geo, i) => (
                <div
                  key={i}
                  className="aspect-video w-40 overflow-hidden rounded-md border border-stone-700/80 bg-stone-900 shadow-lg"
                >
                  {renderTile(slotTokens[i] ?? null, geo)}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className="absolute inset-0 grid gap-px bg-stone-950"
            style={{
              gridTemplateColumns: spec.gridTemplateColumns,
              gridTemplateRows: spec.gridTemplateRows,
            }}
          >
            {spec.slots.map((geo, i) => (
              <div
                key={i}
                className="relative min-h-0 min-w-0 overflow-hidden"
                style={{ gridColumn: geo.column, gridRow: geo.row }}
              >
                {renderTile(slotTokens[i] ?? null, geo)}
              </div>
            ))}
          </div>
        )}

        {/* AI のエネルギー球。スロットを使わず中央に重ねるため、
            人物側のレイアウトと縦横比はそのまま保たれる。 */}
        {aiOrb && (
          <div className="pointer-events-none absolute inset-0">
            {/* キャンバスはステージ全体。球の位置と大きさは描画側の比率で決めるので、
                コロナやブルームが要素の矩形で切り取られない。 */}
            <AiEnergyOrb state={aiOrb} />
            {showNameplates && (
              <span className="absolute inset-x-0 bottom-[3%] text-center text-base font-medium text-sky-100 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
                {aiOrb.info.displayName}
              </span>
            )}
            {aiOrb.visualState === 'error' && (
              <span className="absolute inset-x-0 bottom-[9%] text-center text-xs font-medium text-red-200">
                ⚠ 音声ソース切断
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 視聴者サムネ列（収録/講演ステージの下段）。
 *
 * 出演者 (excludeTokens) 以外の参加者カメラを小さく横並び表示する。
 * ステージ (16:9, Region Capture のクロップ対象) の外に置かれるため、
 * 表示はされるが録画フレームには含まれない。
 */
export function AudienceStrip({ excludeIdentities }: { excludeIdentities: (string | null)[] }) {
  const tracks = useTracks([Track.Source.Camera], { onlySubscribed: false });
  const participants = useParticipants();
  const exclude = useMemo(() => {
    // トークン列から人間の identity のみ抽出する（ai: トークンは participant に該当しない）
    const set = new Set<string>();
    for (const token of excludeIdentities) {
      const ref = parseSlotToken(token);
      if (ref?.kind === 'human') set.add(ref.identity);
    }
    return set;
  }, [excludeIdentities]);
  const audience = participants.filter((p) => !exclude.has(p.identity));

  const camRef = (identity: string): TrackReference | null => {
    const t = tracks.find(
      (tr) =>
        isTrackReference(tr) &&
        tr.participant.identity === identity &&
        tr.source === Track.Source.Camera
    );
    return t && isTrackReference(t) ? t : null;
  };

  if (audience.length === 0) return null;

  return (
    <div className="flex h-24 shrink-0 items-center gap-2 overflow-x-auto bg-stone-950/95 px-3 py-2">
      {audience.map((p) => {
        const ref = camRef(p.identity);
        const name = p.name?.trim() || p.identity;
        return (
          <div
            key={p.identity}
            className="relative aspect-video h-full shrink-0 overflow-hidden rounded-md border border-stone-700/70 bg-stone-900"
          >
            {ref ? (
              <VideoTrack trackRef={ref} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-stone-500">
                {name}
              </div>
            )}
            <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-1 py-0.5 text-[9px] text-white">
              {name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EmptySlot() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-stone-900 text-xs text-stone-600">
      出演者未割当
    </div>
  );
}

function Nameplate({ name, compact }: { name: string; compact: boolean }) {
  return (
    <div className={`absolute left-0 bottom-0 ${compact ? 'px-1.5 py-0.5' : 'px-4 py-2'}`}>
      <span
        className={`inline-block rounded-md bg-black/55 font-medium text-white backdrop-blur-sm ${
          compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-3 py-1 text-base'
        }`}
      >
        {name}
      </span>
    </div>
  );
}

function AiTileWithNameplate({
  state,
  showNameplate,
  compact,
}: {
  state: AiTileState;
  showNameplate: boolean;
  compact: boolean;
}) {
  return (
    <div className="relative h-full w-full bg-stone-900">
      <AiAvatarTile state={state} compact={compact} />
      {showNameplate && <Nameplate name={state.info.displayName} compact={compact} />}
    </div>
  );
}

function HumanTile({
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
    return <EmptySlot />;
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

      {showNameplate && <Nameplate name={name} compact={compact} />}
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
