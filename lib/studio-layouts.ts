/**
 * 収録レイアウトのレジストリ（データ駆動）。
 *
 * 従来 StudioStage.tsx に JSX でハードコードされていた4レイアウトを
 * CSS Grid の幾何データとして表現し、任意スロット数のレイアウトを
 * 追加できるようにする（要件§11: 固定2分割UIの禁止）。
 *
 * 既存4レイアウト（split / screen-main / solo / speaker）は改修前と
 * 同一の見た目になる値で移植している（AC-007）。変更時はスクショ比較で回帰確認すること。
 */

export type StudioLayout = 'split' | 'screen-main' | 'solo' | 'speaker' | 'trio' | 'triple';

export interface SlotGeometry {
  /** grid-column の値 (例 '1 / 3') 。省略時は自動配置 */
  column?: string;
  /** grid-row の値 */
  row?: string;
  /** true: object-cover でスロットを埋める / false: object-contain */
  cover?: boolean;
  /** 小窓向けの控えめ表示（ネームプレート縮小等） */
  compact?: boolean;
  /** StudioBar の割当 select に出すラベル。省略時は「出演者N」 */
  roleLabel?: string;
}

export interface StudioLayoutSpec {
  id: StudioLayout;
  label: string;
  /**
   * 描画方式:
   *  - 'grid': gridTemplate* に従って slots を敷き詰める
   *  - 'screen-main': 背景に画面共有、右下に slots を小窓で縦積み（専用描画）
   */
  kind: 'grid' | 'screen-main';
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  slots: SlotGeometry[];
}

export const STUDIO_LAYOUTS: Record<StudioLayout, StudioLayoutSpec> = {
  // 従来: grid grid-cols-2 gap-px / object-contain
  split: {
    id: 'split',
    label: '横並び2分割',
    kind: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    slots: [{}, {}],
  },
  // 従来: 画面共有メイン + 右下小窓2 (compact + cover)
  'screen-main': {
    id: 'screen-main',
    label: '画面共有メイン+小窓',
    kind: 'screen-main',
    slots: [
      { cover: true, compact: true },
      { cover: true, compact: true },
    ],
  },
  // 従来: 1名フル (cover)
  solo: {
    id: 'solo',
    label: 'ソロ1名',
    kind: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    slots: [{ cover: true }],
  },
  // 従来: 主役 flex-1 + 右列 w-[28%] min-w-10rem max-w-22rem に2名縦積み (全て cover)
  speaker: {
    id: 'speaker',
    label: '主役+サブ2名',
    kind: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) clamp(10rem, 28%, 22rem)',
    gridTemplateRows: 'minmax(0, 1fr) minmax(0, 1fr)',
    slots: [
      { column: '1', row: '1 / 3', cover: true, roleLabel: '主役(ゲスト)' },
      { column: '2', row: '1', cover: true, roleLabel: 'サブ1' },
      { column: '2', row: '2', cover: true, roleLabel: 'サブ2' },
    ],
  },
  // 新規: 上段2名 + 下段1名(AI想定・横長) — 要件§11 の初期レイアウト
  trio: {
    id: 'trio',
    label: '上2名+下1名(AI)',
    kind: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1.2fr) minmax(0, 1fr)',
    slots: [
      { column: '1', row: '1', cover: true, roleLabel: '上段左' },
      { column: '2', row: '1', cover: true, roleLabel: '上段右' },
      { column: '1 / 3', row: '2', cover: true, roleLabel: '下段(AI)' },
    ],
  },
  // 新規: 3等分横並び
  triple: {
    id: 'triple',
    label: '3等分横並び',
    kind: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
    gridTemplateRows: 'minmax(0, 1fr)',
    slots: [{ cover: true }, { cover: true }, { cover: true }],
  },
};

export const STUDIO_LAYOUT_LABELS: Record<StudioLayout, string> = Object.fromEntries(
  Object.values(STUDIO_LAYOUTS).map((s) => [s.id, s.label])
) as Record<StudioLayout, string>;

/** レイアウトごとに必要な出演者スロット数（レジストリから導出） */
export const STUDIO_LAYOUT_SLOTS: Record<StudioLayout, number> = Object.fromEntries(
  Object.values(STUDIO_LAYOUTS).map((s) => [s.id, s.slots.length])
) as Record<StudioLayout, number>;

/** 全レイアウト中の最大スロット数（studioSlots 配列の長さに使う） */
export const MAX_STUDIO_SLOTS = Math.max(
  ...Object.values(STUDIO_LAYOUTS).map((s) => s.slots.length)
);

/**
 * 未知のレイアウトIDを安全に解決する（旧クライアント/不正metadata対策）。
 * 未知の場合は split にフォールバックし、決して空ステージにしない。
 */
export function resolveLayout(layout: string | null | undefined): StudioLayoutSpec {
  if (layout && Object.prototype.hasOwnProperty.call(STUDIO_LAYOUTS, layout)) {
    return STUDIO_LAYOUTS[layout as StudioLayout];
  }
  return STUDIO_LAYOUTS.split;
}
