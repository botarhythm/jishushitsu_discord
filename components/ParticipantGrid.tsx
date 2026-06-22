'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  VideoTrack,
  useTracks,
  useParticipants,
  isTrackReference,
} from '@livekit/components-react';
import type { TrackReference } from '@livekit/components-react';
import { Track, Participant } from 'livekit-client';
import { ParticipantMetadata, RoomName } from '@/lib/types';

export interface InstructorActionContext {
  currentRoom: RoomName;
  selfIdentity: string;
}

interface ParticipantGridProps {
  focused: string | null;
  onFocus: (id: string | null) => void;
  instructorContext?: InstructorActionContext;
}

interface TileItem {
  participant: Participant;
  trackRef: TrackReference | null;
  /** screen-share タイルかどうか。1人が camera と screen 両方持ってると2タイル出す */
  source: 'camera' | 'screen' | 'none';
}

/** タイルのアスペクト比 (幅:高 = 4:3)。PC/スマホ・人数に関わらず固定。 */
const TILE_ASPECT = 4 / 3;
/** タイル間ギャップ(px)。Tailwind gap-2 = 0.5rem = 8px と一致させる。 */
const TILE_GAP = 8;

export function ParticipantGrid({ focused, onFocus, instructorContext }: ParticipantGridProps) {
  const tracks = useTracks(
    [Track.Source.ScreenShare, Track.Source.Camera],
    { onlySubscribed: false }
  );
  const participants = useParticipants();

  const tiles = useMemo<TileItem[]>(() => {
    const list: TileItem[] = [];
    const seen = new Set<string>();
    for (const t of tracks) {
      if (!isTrackReference(t)) continue;
      const src = t.source === Track.Source.ScreenShare ? 'screen' : 'camera';
      list.push({ participant: t.participant, trackRef: t, source: src });
      seen.add(`${t.participant.identity}:${src}`);
    }
    for (const p of participants) {
      const hasCam = seen.has(`${p.identity}:camera`);
      const hasScreen = seen.has(`${p.identity}:screen`);
      if (!hasCam && !hasScreen) {
        list.push({ participant: p, trackRef: null, source: 'none' });
      }
    }
    return list;
  }, [tracks, participants]);

  if (tiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-stone-500 text-sm">
        参加者がいません
      </div>
    );
  }

  // スポットライト決定 (Zoom 模倣):
  //   1. ユーザが明示的にピン留めしたタイル (focused)
  //   2. なければ画面共有を自動スポットライト
  //   3. どちらも無ければ均等グリッド (4:3 固定 + ページ送り)
  const pinnedTile = focused ? tiles.find((t) => tileKey(t) === focused) ?? null : null;
  const screenTile = tiles.find((t) => t.source === 'screen') ?? null;
  const spotlight = pinnedTile ?? screenTile;

  if (spotlight) {
    const others = tiles.filter((t) => tileKey(t) !== tileKey(spotlight));
    return (
      <div className="h-full flex flex-col gap-2">
        <Tile
          item={spotlight}
          large
          onClick={() => onFocus(null)}
          instructorContext={instructorContext}
          extraTopRight={
            pinnedTile ? (
              <button
                onClick={() => onFocus(null)}
                className="bg-black/50 text-white text-xs px-2 py-1 rounded hover:bg-black/70"
              >
                {screenTile ? '共有画面に戻る' : 'グリッドに戻る'}
              </button>
            ) : undefined
          }
        />
        {others.length > 0 && (
          <ThumbnailRow tiles={others} focusedKey={focused} onFocus={onFocus} />
        )}
      </div>
    );
  }

  // 均等グリッド: 各タイルを 4:3 固定サイズにし、画面に入るだけ並べて残りはページ送り。
  return (
    <PaginatedGrid
      tiles={tiles}
      onFocus={onFocus}
      instructorContext={instructorContext}
    />
  );
}

/**
 * 4:3 固定タイルのページ送りグリッド。
 *
 * - タイルのアスペクト比は常に 4:3 (PC/スマホ・人数に関わらず固定)
 * - 表示領域の実寸を測り、「読みやすい最小サイズ」を保ったまま入るだけ並べる
 * - 入りきらない人数は次ページへ送る (◀ 1/2 ▶)
 */
function PaginatedGrid({
  tiles,
  onFocus,
  instructorContext,
}: {
  tiles: TileItem[];
  onFocus: (id: string) => void;
  instructorContext?: InstructorActionContext;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [page, setPage] = useState(0);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 1ページに収まる最大枚数 (容量)。読みやすさ確保のため最小タイル幅を設ける。
  const perPage = useMemo(() => {
    const { w, h } = size;
    if (w <= 0 || h <= 0) return 1;
    const minTileW = Math.min(w, w < 640 ? 132 : 200);
    const colCap = Math.max(1, Math.floor((w + TILE_GAP) / (minTileW + TILE_GAP)));
    const tW = (w - TILE_GAP * (colCap - 1)) / colCap;
    const tH = tW / TILE_ASPECT;
    const rowCap = Math.max(1, Math.floor((h + TILE_GAP) / (tH + TILE_GAP)));
    return Math.max(1, colCap * rowCap);
  }, [size]);

  const totalPages = Math.max(1, Math.ceil(tiles.length / perPage));
  // 人数が減ってページが消えても表示が破綻しないよう、描画・操作とも丸めた safePage を使う
  const safePage = Math.min(page, totalPages - 1);
  const pageTiles = tiles.slice(safePage * perPage, safePage * perPage + perPage);

  // 1ページに全員収まるなら、その人数で画面いっぱいに大きく配置。
  // 複数ページに跨る場合は満杯(perPage)基準のサイズに固定し、ページ間でタイルサイズが揺れないようにする。
  const layoutCount = tiles.length <= perPage ? tiles.length : perPage;
  const { cols, tileW, tileH } = useMemo(
    () => bestFit(layoutCount, size.w, size.h),
    [layoutCount, size]
  );

  return (
    <div className="h-full w-full flex flex-col gap-2">
      <div ref={areaRef} className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        {tileW > 0 && tileH > 0 && (
          <div
            className="grid"
            style={{
              gap: `${TILE_GAP}px`,
              gridTemplateColumns: `repeat(${cols}, ${tileW}px)`,
              gridAutoRows: `${tileH}px`,
            }}
          >
            {pageTiles.map((item) => (
              <Tile
                key={tileKey(item)}
                item={item}
                fill
                onClick={() => onFocus(tileKey(item))}
                instructorContext={instructorContext}
              />
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 flex-shrink-0 pb-1">
          <button
            onClick={() => setPage(Math.max(0, safePage - 1))}
            disabled={safePage === 0}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-700 text-stone-200 hover:bg-stone-600 disabled:opacity-30 disabled:hover:bg-stone-700"
            aria-label="前のページ"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="text-xs font-medium text-stone-300 tabular-nums">
            {safePage + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
            disabled={safePage >= totalPages - 1}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-700 text-stone-200 hover:bg-stone-600 disabled:opacity-30 disabled:hover:bg-stone-700"
            aria-label="次のページ"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * n 枚のタイルを W×H の領域に 4:3 を保ったまま最大サイズで詰める列数とタイル寸法を返す。
 */
function bestFit(
  n: number,
  W: number,
  H: number
): { cols: number; rows: number; tileW: number; tileH: number } {
  if (n <= 0 || W <= 0 || H <= 0) return { cols: 1, rows: 1, tileW: 0, tileH: 0 };
  let best = { cols: 1, rows: n, tileW: 0, tileH: 0, area: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const availW = (W - TILE_GAP * (cols - 1)) / cols;
    const availH = (H - TILE_GAP * (rows - 1)) / rows;
    if (availW <= 0 || availH <= 0) continue;
    // availW×availH の中に収まる最大の 4:3 矩形
    let tW = availW;
    let tH = tW / TILE_ASPECT;
    if (tH > availH) {
      tH = availH;
      tW = tH * TILE_ASPECT;
    }
    const area = tW * tH;
    if (area > best.area) best = { cols, rows, tileW: tW, tileH: tH, area };
  }
  return best;
}

/** タイルの一意キー (同一参加者の camera/screen を区別) */
function tileKey(t: TileItem): string {
  return `${t.participant.identity}:${t.source}`;
}

function Tile({
  item,
  large = false,
  fill = false,
  onClick,
  instructorContext,
  extraTopRight,
}: {
  item: TileItem;
  large?: boolean;
  /** 親セル(グリッド)を 4:3 で埋める表示。映像は object-cover で枠いっぱいに。 */
  fill?: boolean;
  onClick: () => void;
  instructorContext?: InstructorActionContext;
  extraTopRight?: React.ReactNode;
}) {
  const { participant, trackRef, source } = item;
  const name = participant.name?.trim() || participant.identity;

  let meta: ParticipantMetadata | null = null;
  try {
    if (participant.metadata) meta = JSON.parse(participant.metadata);
  } catch {}

  // 画面共有は内容が切れないよう contain、カメラは枠いっぱいに埋める cover。
  const videoFit = source === 'screen' ? 'object-contain' : 'object-cover';

  // ── 4:3 セルを埋めるグリッドタイル (名前はオーバーレイ) ──
  if (fill) {
    return (
      <div
        className="group relative h-full w-full overflow-hidden rounded-lg bg-stone-800 cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all"
        onClick={onClick}
      >
        {trackRef ? (
          <VideoTrack trackRef={trackRef} className={`h-full w-full ${videoFit}`} />
        ) : (
          <AvatarPlaceholder name={name} />
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-stone-900/70 px-2 py-1">
          {meta?.raisedHand && <span className="text-sm leading-none">✋</span>}
          <span className="text-xs font-medium text-stone-100 truncate" title={name}>
            {name}
          </span>
          {source === 'screen' && (
            <span className="text-[10px] uppercase tracking-wide text-amber-400">screen</span>
          )}
          <MicIndicator participant={participant} />
        </div>

        {instructorContext &&
          participant.identity !== instructorContext.selfIdentity && (
            <KickButton participant={participant} instructorContext={instructorContext} />
          )}
      </div>
    );
  }

  // ── スポットライト(large)表示 ──
  return (
    <div
      className={`group rounded-lg overflow-hidden bg-stone-800 relative ${large ? 'flex-1' : 'cursor-pointer hover:ring-2 hover:ring-amber-400 transition-all'}`}
      onClick={large ? undefined : onClick}
    >
      <div className="aspect-video w-full bg-stone-900 flex items-center justify-center">
        {trackRef ? (
          <VideoTrack trackRef={trackRef} className="w-full h-full object-contain" />
        ) : (
          <AvatarPlaceholder name={name} />
        )}
      </div>

      <div className="flex items-center justify-center gap-1.5 bg-stone-900/90 px-2 py-1 border-t border-stone-700">
        {meta?.raisedHand && <span className="text-sm leading-none">✋</span>}
        <span className="text-xs font-medium text-stone-100 truncate" title={name}>
          {name}
        </span>
        {source === 'screen' && (
          <span className="text-[10px] uppercase tracking-wide text-amber-400">screen</span>
        )}
        <MicIndicator participant={participant} />
      </div>

      {extraTopRight && <div className="absolute top-2 right-2">{extraTopRight}</div>}

      {instructorContext &&
        participant.identity !== instructorContext.selfIdentity && (
          <KickButton participant={participant} instructorContext={instructorContext} />
        )}
    </div>
  );
}

function AvatarPlaceholder({ name }: { name: string }) {
  const initial = name.charAt(0).toUpperCase();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center text-stone-400">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-stone-700 text-2xl font-semibold text-stone-200">
        {initial}
      </div>
    </div>
  );
}

function MicIndicator({ participant }: { participant: Participant }) {
  const micPub = participant.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;
  return (
    <span
      className={`text-xs leading-none ${muted ? 'text-stone-500' : 'text-emerald-400'}`}
      aria-label={muted ? 'マイクオフ' : 'マイクオン'}
      title={muted ? 'マイクオフ' : 'マイクオン'}
    >
      {muted ? '🔇' : '🎤'}
    </span>
  );
}

function ThumbnailRow({
  tiles,
  focusedKey,
  onFocus,
}: {
  tiles: TileItem[];
  focusedKey: string | null;
  onFocus: (id: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto h-24 flex-shrink-0">
      {tiles.map((item) => {
        const name = item.participant.name?.trim() || item.participant.identity;
        const key = tileKey(item);
        const isPinned = focusedKey === key;
        const videoFit = item.source === 'screen' ? 'object-contain' : 'object-cover';
        return (
          <div
            key={`thumb-${key}`}
            className={`h-full aspect-[4/3] rounded overflow-hidden bg-stone-700 relative cursor-pointer flex-shrink-0 transition-all ${
              isPinned ? 'ring-2 ring-amber-400' : 'hover:ring-2 hover:ring-amber-400/60'
            }`}
            onClick={() => onFocus(key)}
            title={name}
          >
            {item.trackRef ? (
              <VideoTrack trackRef={item.trackRef} className={`w-full h-full ${videoFit}`} />
            ) : (
              <AvatarPlaceholder name={name} />
            )}
            <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] px-1 py-0.5 truncate text-center">
              {name}
              {item.source === 'screen' && ' (画面)'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KickButton({
  participant,
  instructorContext,
}: {
  participant: Participant;
  instructorContext: InstructorActionContext;
}) {
  const [pending, setPending] = useState(false);
  const name = participant.name ?? participant.identity;

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    if (!confirm(`${name}さんを退出させますか？`)) return;
    setPending(true);
    try {
      const res = await fetch('/api/remove-participant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName: instructorContext.currentRoom,
          participantIdentity: participant.identity,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`退出処理に失敗しました: ${err.error ?? res.status}`);
      }
    } catch (err) {
      console.error('Remove participant failed:', err);
      alert('退出処理に失敗しました。もう一度お試しください。');
    } finally {
      setPending(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={pending}
      className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-red-600/90 px-2 py-1 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-500 disabled:opacity-40"
      aria-label={`${name}さんを退出させる`}
      title={`${name}さんを退出させる`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
        aria-hidden
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
      <span>退出</span>
    </button>
  );
}
