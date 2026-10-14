import type { DataContext } from "../data/types.js";
import type { Block, BlockOf, LayoutPattern, Section } from "../spec.js";
import { cellBox } from "./geometry.js";
import { METRICS } from "./metrics.js";

export interface SpanCell {
  blockId: string;
  span: number;
}

interface Slot extends SpanCell {
  /** Explicit `block.span`: never bumped, shrunk or redistributed (only stretched to close a row). */
  fixed: boolean;
  min: number;
}

const COLUMNS = METRICS.grid.columns;
const PATTERNS: Record<Exclude<LayoutPattern, "auto">, readonly number[]> = {
  stack: [12],
  "main-side": [8, 4],
  "side-main": [4, 8],
  split: [6, 6],
  thirds: [4, 4, 4],
  quarters: [3, 3, 3, 3],
};
/** Narrative blocks (text, callout, list) shorter than this pair next to a chart or sit in a 4/4/4 trio. */
const SHORT_NARRATIVE_CHARS = 500;
const SHORT_LIST_ITEMS = 6;

/**
 * Split a section's blocks into grid rows of 12 columns.
 *
 * Precedence: explicit `block.span` > section layout pattern (cyclic) > `auto` heuristics.
 * Non-explicit spans are bumped until the cell reaches its minimum pixel width at `contentWidth`,
 * which is why print (narrow) and web (wide) layouts differ. Every returned row sums to exactly 12.
 */
export function assignRows(section: Section, ctx: DataContext, contentWidth: number, gap: number): SpanCell[][] {
  const minSpan = (block: Block): number => {
    const px = minWidth(block);
    for (let s = 1; s <= COLUMNS; s++) if (cellBox(1, s, contentWidth, gap).width >= px) return s;
    return COLUMNS;
  };
  const slot = (block: Block, preferred: number): Slot => {
    if (block.span !== undefined) return { blockId: block.id, span: block.span, fixed: true, min: block.span };
    const min = minSpan(block);
    return { blockId: block.id, span: Math.min(COLUMNS, Math.max(preferred, min)), fixed: false, min };
  };

  /** Units are kept on one row when they fit; rows break between units otherwise. */
  const units: Slot[][] = [];
  const blocks = section.blocks;
  const pattern = section.layout ?? "auto";
  if (pattern !== "auto") {
    const spans = PATTERNS[pattern];
    blocks.forEach((b, i) => units.push([slot(b, spans[i % spans.length] ?? COLUMNS)]));
  } else {
    let i = 0;
    while (i < blocks.length) {
      const group = autoGroup(blocks, i, ctx);
      units.push(fitGroup(group.map(([b, span]) => slot(b, span))));
      i += group.length;
    }
  }
  return pack(units);
}

/** Next auto unit starting at `i`: a 4/4/4 trio, an 8/4 or 6/6 pair, or a single block with its own span. */
function autoGroup(blocks: readonly Block[], i: number, ctx: DataContext): Array<[Block, number]> {
  const [a, b, c] = [blocks[i], blocks[i + 1], blocks[i + 2]].map((x) => (x && x.span === undefined ? x : undefined));
  const first = blocks[i]!;
  if (a && b && c && isCompact(a) && isCompact(b) && isCompact(c)) return [[a, 4], [b, 4], [c, 4]];
  if (a?.type === "chart" && !isWideChart(a, ctx) && b) {
    if (b.type === "chart" && !isWideChart(b, ctx)) return [[a, 6], [b, 6]];
    if (isShortNarrative(b)) return isRound(a) ? [[a, 6], [b, 6]] : [[a, 8], [b, 4]];
  }
  // Two small non-chart blocks (comparison, short list/callout/text) read well side by side.
  if (a && b && a.type !== "chart" && b.type !== "chart" && (isCompact(a) || isShortNarrative(a)) && (isCompact(b) || isShortNarrative(b))) {
    return [[a, 6], [b, 6]];
  }
  return [[first, singleSpan(first, ctx)]];
}

function singleSpan(block: Block, ctx: DataContext): number {
  if (block.type === "chart") return isRound(block) && !isWideChart(block, ctx) ? 6 : 12;
  if (block.type === "table") {
    const ds = ctx.datasets.get(block.data);
    const columns = block.columns?.length ?? ds?.fields.length;
    const total = ds?.rows.length;
    const rows = total === undefined ? block.maxRows : Math.min(total, block.maxRows ?? total);
    return columns !== undefined && columns <= 3 && rows !== undefined && rows <= 8 ? 6 : 12;
  }
  return 12;
}

function isRound(block: BlockOf<"chart">): boolean {
  return block.chart.kind === "pie" || block.chart.kind === "donut";
}

/** Bars with many categories need the full width (vertical > 24 ≈ 28px per bar at 8 columns; horizontal > 12 rows). */
function isWideChart(block: BlockOf<"chart">, ctx: DataContext): boolean {
  const c = block.chart;
  if (c.kind !== "bar") return false;
  const rows = ctx.datasets.get(c.data)?.rows;
  if (!rows) return false;
  let categories = new Set(rows.map((r) => r[c.x] ?? null)).size;
  if (c.limit !== undefined) categories = Math.min(categories, c.limit + (c.others ? 1 : 0));
  return categories > (c.horizontal ? 12 : 24);
}

function isShortNarrative(block: Block): boolean {
  if (block.type === "text" || block.type === "callout") return block.content.length < SHORT_NARRATIVE_CHARS;
  if (block.type !== "list" || block.items.length > SHORT_LIST_ITEMS) return false;
  const length = block.items.reduce((n, item) => n + item.text.length + (item.detail?.length ?? 0) + (item.tag?.length ?? 0), 0);
  return length < SHORT_NARRATIVE_CHARS;
}

/** Blocks that read well at a third of the width. */
function isCompact(block: Block): boolean {
  switch (block.type) {
    case "chart":
      return isRound(block);
    case "callout":
    case "list":
      return isShortNarrative(block);
    case "comparison":
      return block.metrics.length <= 4;
    default:
      return false;
  }
}

function minWidth(block: Block): number {
  switch (block.type) {
    case "chart":
      return METRICS.minWidth.chart;
    case "table":
      return METRICS.minWidth.table;
    case "kpi":
      // All items on one row.
      return block.items.length * METRICS.kpi.minItemWidth + (block.items.length - 1) * METRICS.kpi.columnGap;
    case "comparison":
      // Entity columns plus the change column (shown unless showDelta is false).
      return METRICS.comparison.labelColumn + (block.entities.length + (block.showDelta === false ? 0 : 1)) * METRICS.comparison.entityColumn;
    default:
      return METRICS.minWidth.text;
  }
}

/** After min-width bumps, shrink the widest flexible cells back toward their minimum so the group still fits one row. */
function fitGroup(slots: Slot[]): Slot[] {
  let excess = slots.reduce((n, s) => n + s.span, 0) - COLUMNS;
  while (excess > 0) {
    let widest: Slot | undefined;
    for (const s of slots) if (!s.fixed && s.span > s.min && (!widest || s.span > widest.span)) widest = s;
    if (!widest) break;
    widest.span--;
    excess--;
  }
  return slots;
}

function pack(units: readonly Slot[][]): SpanCell[][] {
  const rows: SpanCell[][] = [];
  let row: Slot[] = [];
  let used = 0;
  const flush = (): void => {
    if (row.length === 0) return;
    rows.push(fill(row, COLUMNS - used));
    row = [];
    used = 0;
  };
  const add = (cells: readonly Slot[]): void => {
    const width = cells.reduce((n, s) => n + s.span, 0);
    if (used + width > COLUMNS) flush();
    row.push(...cells);
    used += width;
  };
  for (const unit of units) {
    if (unit.reduce((n, s) => n + s.span, 0) <= COLUMNS) add(unit);
    else for (const s of unit) add([s]);
  }
  flush();
  return rows;
}

/** Close a row: equal flexible cells split 12 evenly when possible; otherwise the last flexible cell (or last cell) stretches. */
function fill(row: readonly Slot[], deficit: number): SpanCell[] {
  const cells = row.map((s) => ({ blockId: s.blockId, span: s.span }));
  if (deficit <= 0) return cells;
  const first = row[0]!;
  if (row.every((s) => !s.fixed && s.span === first.span) && COLUMNS % row.length === 0) {
    return cells.map((c) => ({ blockId: c.blockId, span: COLUMNS / row.length }));
  }
  const flexible = row.findLastIndex((s) => !s.fixed);
  const target = cells[flexible === -1 ? cells.length - 1 : flexible]!;
  target.span += deficit;
  return cells;
}
