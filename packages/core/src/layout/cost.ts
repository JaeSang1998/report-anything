import type { DataContext } from "../data/types.js";
import type { Block, BlockOf } from "../spec.js";
import { estimateTextWidth } from "../text.js";
import { FACET_KINDS } from "../chart/facet.js";
import { facetGrid } from "./estimate.js";
import { METRICS } from "./metrics.js";
import type { Composition } from "./types.js";

/**
 * Every soft-cost weight of the composition solver, in one place. Costs are px² of page area, so terms compare
 * directly: whitespace, mis-sized cells and the gap a band adds are all area; rewards and penalties are area-equivalents.
 */
export const WEIGHTS = {
  /** Per px² of whitespace beside shorter columns after levelling, and of the gap each extra band adds. The main term. */
  ragged: 1,
  /** Per px² of cell area wider than the block's content needs (a 3-item list at 8 columns). */
  fill: 0.5,
  /** Per px² of cell area narrower than the block's content needs, above its hard minimum width. */
  cramp: 1,
  /** Per px² by which a less important block's area exceeds a more important one's in the same band. */
  importance: 0.5,
  /** Reward: a lead block in a hero or feature lead slot. */
  leadSlot: 40_000,
  /** Reward: a chart/diagram beside a short narrative in a feature, sidebar or uneven pair. */
  pairing: 40_000,
  /** Penalty: two narratives side by side when one of them is long. */
  longNarratives: 60_000,
  /** Penalty: the same composition as the previous band (full, hero and stack exempt). */
  repeat: 20_000,
  /** Reward: feature/sidebar mirrored relative to the previous band (z-pattern). */
  zigzag: 25_000,
  /** Penalty: a feature whose lead sits on the side that contradicts reading order. */
  reversed: 10_000,
  /** Penalty: a section of two or more bands that are all full width. */
  allFull: 60_000,
  /** Print: per px² of a multi-block band taller than `printTallRatio` of the page. */
  printTall: 2,
  printTallRatio: 0.7,
  /** A composition outside the section layout's own set, used only when nothing in it is feasible. */
  fallback: 1e7,
  /** An explicit `span` that no feasible composition honours (the block falls back to full width). */
  brokenSpan: 1e8,
} as const;

/** Levelled columns of a band end within this many px of each other when the elastic ranges allow it. */
export const LEVEL_TOLERANCE = 1;

/** Comfortable line length for reading text; wider cells are wasted. */
const MEASURE = 640;
/** Narrowest comfortable text column (≈ 40 characters). */
const PROSE_MIN = 320;
/** Text, callout and list blocks longer than this read badly in narrow columns or beside another long text. */
const SHORT_NARRATIVE_CHARS = 500;
const SHORT_LIST_ITEMS = 6;

/** 2 lead, 1 normal, 0 supporting. */
export type Rank = 0 | 1 | 2;
const RANK: Record<"lead" | "normal" | "supporting", Rank> = { lead: 2, normal: 1, supporting: 0 };

/**
 * Importance: the spec's, else inferred from the type. Stat and KPI blocks lead only when they own the band
 * (hero/full); beside other blocks they are normal. Text, callouts and lists support.
 */
export function importanceRank(block: Block, alone: boolean): Rank {
  if (block.importance) return RANK[block.importance];
  switch (block.type) {
    case "stat":
    case "kpi":
      return alone ? 2 : 1;
    case "text":
    case "callout":
    case "list":
      return 0;
    default:
      return 1;
  }
}

/** Character count of a narrative block (text, callout, list); undefined for everything else. */
function narrativeChars(block: Block): number | undefined {
  if (block.type === "text" || block.type === "callout") return block.content.length;
  if (block.type === "list") return block.items.reduce((n, item) => n + item.text.length + (item.detail?.length ?? 0) + (item.tag?.length ?? 0), 0);
  return undefined;
}

export function isShortNarrative(block: Block): boolean {
  const chars = narrativeChars(block);
  if (chars === undefined) return false;
  return chars < SHORT_NARRATIVE_CHARS && (block.type !== "list" || block.items.length <= SHORT_LIST_ITEMS);
}

/** Distinct x categories a chart draws (after `limit`/`others`); undefined when its dataset is missing. */
export function chartCategories(chart: BlockOf<"chart">["chart"], ctx: DataContext): number | undefined {
  const rows = ctx.datasets.get(chart.data)?.rows;
  if (!rows) return undefined;
  const n = new Set(rows.map((r) => r[chart.x] ?? null)).size;
  return chart.limit === undefined ? n : Math.min(n, chart.limit + (chart.others ? 1 : 0));
}

/** Comfortable cell width range (px) of a block: narrower cells cramp it, wider ones waste area. */
export interface Fit {
  lo: number;
  hi: number;
}

/** Comfortable width range of a block's content at most `contentWidth` wide. */
export function idealWidth(block: Block, ctx: DataContext, contentWidth: number): Fit {
  const exact = (w: number): Fit => ({ lo: w, hi: w });
  // Narrative reflows: anything from a ~40-character column up to the reading measure (or its own length) is fine.
  const prose = (natural: number): Fit => ({ lo: Math.max(METRICS.minWidth.text, Math.min(natural, PROSE_MIN)), hi: Math.max(METRICS.minWidth.text, Math.min(natural, MEASURE)) });
  switch (block.type) {
    case "text":
      return prose(estimateTextWidth(block.content, METRICS.text.fontSize));
    case "callout":
      return prose(estimateTextWidth(block.content, METRICS.callout.fontSize));
    case "list": {
      const L = METRICS.list;
      const widest = Math.max(
        ...block.items.map((i) =>
          Math.max(
            estimateTextWidth(i.text, METRICS.text.fontSize) + (i.tag ? estimateTextWidth(i.tag, L.tagFontSize) + L.tagGap : 0),
            i.detail ? estimateTextWidth(i.detail, L.detailFontSize) : 0,
          ),
        ),
      );
      return prose(widest + L.marker);
    }
    case "stat":
      return { lo: METRICS.minWidth.stat, hi: 400 };
    case "kpi":
      return exact(contentWidth);
    case "comparison":
      return exact(METRICS.comparison.labelColumn + (block.entities.length + (block.showDelta === false ? 0 : 1)) * 140);
    case "table": {
      const columns = block.columns?.length ?? ctx.datasets.get(block.data)?.fields.length ?? 4;
      return exact(Math.max(METRICS.minWidth.table, columns * 140));
    }
    case "diagram":
      return { lo: 420, hi: 720 };
    case "chart": {
      const c = block.chart;
      if (c.facet !== undefined && FACET_KINDS[c.kind]) {
        const G = METRICS.chart.facetGap;
        const columns = Math.min(4, Math.max(1, facetGrid(block, contentWidth, ctx).panels));
        return exact(columns * (220 + G) - G);
      }
      const k = chartCategories(c, ctx) ?? 8;
      // Charts may grow a quarter past the width their categories need before the extra is waste.
      const need = (w: number): Fit => ({ lo: w, hi: w * 1.25 });
      switch (c.kind) {
        case "pie":
        case "donut":
          return { lo: 300, hi: 420 };
        case "line":
        case "area":
          // Lines compress well: their need does not grow with the number of points.
          return { lo: 400, hi: 640 };
        case "bar":
          return need(c.horizontal ? 440 : Math.max(360, k * 28 + 80));
        case "waterfall":
          return need(Math.max(360, k * 32 + 80));
        case "heatmap":
          return need(Math.max(480, k * 40 + 140));
        default:
          return need(480);
      }
    }
  }
}

export interface CellFacts {
  block: Block;
  rank: Rank;
  fit: Fit;
  width: number;
  height: number;
  /** The cell is a hero or feature lead slot. */
  leadSlot: boolean;
  /** The cell is a sidebar aside: it runs alongside the whole main column. */
  aside: boolean;
}

export interface BandFacts {
  composition: Composition;
  cells: readonly CellFacts[];
  /** Whitespace (px²) beside columns shorter than their row track after levelling. */
  whitespace: number;
  height: number;
  /** Pair with unequal spans. */
  uneven: boolean;
  /** Feature lead on the side that contradicts reading order. */
  reversed: boolean;
  fallback: boolean;
  brokenSpan: boolean;
  contentWidth: number;
  gap: number;
  /** Print page content height; undefined on the web. */
  pageHeight: number | undefined;
}

const SIDE_BY_SIDE: Partial<Record<Composition, true>> = { pair: true, trio: true, quad: true, grid: true };
const PAIRING: Partial<Record<Composition, true>> = { "feature-left": true, "feature-right": true, "sidebar-left": true, "sidebar-right": true };

/** Soft cost of one band, independent of its neighbours. `Infinity` marks a print band that cannot fit a page. */
export function bandCost(b: BandFacts): number {
  const W = WEIGHTS;
  let cost = W.ragged * (b.whitespace + b.gap * b.contentWidth);
  const area = (c: CellFacts): number => c.width * c.height;
  for (const c of b.cells) {
    if (c.width > c.fit.hi) cost += W.fill * (c.width - c.fit.hi) * c.height;
    else if (c.width < c.fit.lo) cost += W.cramp * (c.fit.lo - c.width) * c.height;
    if (c.leadSlot && c.rank === 2) cost -= W.leadSlot;
    // An aside is measured against the main column it runs beside, not against each block in it.
    const rivals = b.cells.filter((d) => d !== c && c.rank < d.rank);
    const excess = c.aside
      ? Math.max(0, area(c) - rivals.reduce((n, d) => n + area(d), 0))
      : rivals.reduce((n, d) => n + Math.max(0, area(c) - area(d)), 0);
    cost += W.importance * excess;
  }
  const visual = b.cells.some((c) => c.block.type === "chart" || c.block.type === "diagram");
  const commentary = b.cells.some((c) => (c.aside ? narrativeChars(c.block) !== undefined : isShortNarrative(c.block)));
  if (visual && commentary && (PAIRING[b.composition] || (b.composition === "pair" && b.uneven))) cost -= W.pairing;
  const narratives = b.cells.filter((c) => narrativeChars(c.block) !== undefined);
  if (SIDE_BY_SIDE[b.composition] && narratives.length >= 2 && narratives.some((c) => !isShortNarrative(c.block))) cost += W.longNarratives;
  if (b.reversed) cost += W.reversed;
  if (b.fallback) cost += W.fallback;
  if (b.brokenSpan) cost += W.brokenSpan;
  if (b.pageHeight !== undefined && b.cells.length > 1) {
    if (b.height > b.pageHeight) return Infinity;
    const limit = W.printTallRatio * b.pageHeight;
    if (b.height > limit) cost += W.printTall * (b.height - limit) * b.contentWidth;
  }
  return cost;
}

const MIRROR: Partial<Record<Composition, Composition>> = {
  "feature-left": "feature-right",
  "feature-right": "feature-left",
  "sidebar-left": "sidebar-right",
  "sidebar-right": "sidebar-left",
};
const REPEAT_EXEMPT: Partial<Record<Composition, true>> = { full: true, hero: true, stack: true };

/** Cost of placing `next` right after `prev` in a section. */
export function rhythmCost(prev: Composition | undefined, next: Composition): number {
  if (prev === undefined) return 0;
  if (MIRROR[prev] === next) return -WEIGHTS.zigzag;
  return prev === next && !REPEAT_EXEMPT[next] ? WEIGHTS.repeat : 0;
}
