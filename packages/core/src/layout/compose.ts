import type { DataContext } from "../data/types.js";
import type { Block, LayoutPattern, Section } from "../spec.js";
import { bandCost, chartCategories, idealWidth, importanceRank, isShortNarrative, rhythmCost, WEIGHTS } from "./cost.js";
import type { BandFacts, CellFacts, Fit } from "./cost.js";
import { blockBox, tableMetrics } from "./estimate.js";
import type { BlockBox, Density } from "./estimate.js";
import { cellBox } from "./geometry.js";
import { METRICS } from "./metrics.js";
import type { Band, Composition, Placement } from "./types.js";

export interface ComposeEnv {
  ctx: DataContext;
  contentWidth: number;
  gap: number;
  density: Density;
  measured: Readonly<Record<string, number>> | undefined;
  /** Print page content height; undefined on the web. */
  pageHeight: number | undefined;
}

interface Slot {
  col: number;
  span: number;
  row: number;
  rowSpan: number;
}

interface Template {
  composition: Composition;
  /** One slot per block, in block (reading) order. */
  slots: readonly Slot[];
  /** Row groups levelled independently, top to bottom; each is a list of columns of slot indices stacked top to bottom. */
  groups: readonly (readonly (readonly number[])[])[];
  /** Hero / feature lead slot. */
  lead?: number;
  /** Sidebar aside slot. */
  aside?: number;
  /** Feature lead on the side that contradicts reading order. */
  reversed?: boolean;
  /** Explicit spans fixed this template: it bypasses the section layout's candidate set. */
  explicit?: boolean;
  /** A lone explicit span that nothing honours, stretched to full width. */
  brokenSpan?: boolean;
}

interface Item {
  block: Block;
  /** Hard minimum cell width (px) for a non-explicit placement narrower than the full width. */
  min: number;
  /** KPI blocks, wide tables and wide charts only take the full width. */
  full: boolean;
  compact: boolean;
  fit: Fit;
  boxes: Map<number, BlockBox>;
}

interface Candidate {
  band: Band;
  cost: number;
  size: number;
}

const COLUMNS = METRICS.grid.columns;
const EPS = 1e-6;
/** Left span of every pair split the solver tries. */
const PAIR_SPLITS = [6, 7, 5, 8, 4] as const;

const row = (composition: Composition, spans: readonly number[], extra: Partial<Template> = {}): Template => {
  let col = 1;
  const slots = spans.map((span) => {
    const slot = { col, span, row: 1, rowSpan: 1 };
    col += span;
    return slot;
  });
  return { composition, slots, groups: [slots.map((_, i) => [i])], ...extra };
};

const sidebar = (side: "left" | "right", n: number): Template => {
  const left = side === "left";
  const slots: Slot[] = [{ col: left ? 1 : 9, span: 4, row: 1, rowSpan: n - 1 }];
  for (let k = 1; k < n; k++) slots.push({ col: left ? 5 : 1, span: 8, row: k, rowSpan: 1 });
  return { composition: `sidebar-${side}`, slots, groups: [[[0], slots.slice(1).map((_, k) => k + 1)]], aside: 0 };
};

/** Every template that does not depend on explicit spans, in tie-break order. */
const TEMPLATES: readonly Template[] = [
  row("full", [12]),
  row("hero", [12], { lead: 0 }),
  row("stack", [12]),
  ...PAIR_SPLITS.map((a) => row("pair", [a, COLUMNS - a])),
  row("trio", [4, 4, 4]),
  row("quad", [3, 3, 3, 3]),
  {
    composition: "grid",
    slots: [0, 1, 2, 3].map((k) => ({ col: (k % 2) * 6 + 1, span: 6, row: Math.floor(k / 2) + 1, rowSpan: 1 })),
    groups: [[[0], [1]], [[2], [3]]],
  },
  {
    composition: "grid",
    slots: [0, 1, 2, 3, 4, 5].map((k) => ({ col: (k % 3) * 4 + 1, span: 4, row: Math.floor(k / 3) + 1, rowSpan: 1 })),
    groups: [[[0], [1], [2]], [[3], [4], [5]]],
  },
  {
    composition: "feature-right",
    slots: [{ col: 1, span: 8, row: 1, rowSpan: 2 }, { col: 9, span: 4, row: 1, rowSpan: 1 }, { col: 9, span: 4, row: 2, rowSpan: 1 }],
    groups: [[[0], [1, 2]]],
    lead: 0,
  },
  {
    composition: "feature-left",
    slots: [{ col: 1, span: 4, row: 1, rowSpan: 1 }, { col: 1, span: 4, row: 2, rowSpan: 1 }, { col: 5, span: 8, row: 1, rowSpan: 2 }],
    groups: [[[0, 1], [2]]],
    lead: 2,
  },
  {
    composition: "feature-left",
    slots: [{ col: 5, span: 8, row: 1, rowSpan: 2 }, { col: 1, span: 4, row: 1, rowSpan: 1 }, { col: 1, span: 4, row: 2, rowSpan: 1 }],
    groups: [[[1, 2], [0]]],
    lead: 0,
    reversed: true,
  },
  {
    composition: "feature-right",
    slots: [{ col: 9, span: 4, row: 1, rowSpan: 1 }, { col: 9, span: 4, row: 2, rowSpan: 1 }, { col: 1, span: 8, row: 1, rowSpan: 2 }],
    groups: [[[2], [0, 1]]],
    lead: 2,
    reversed: true,
  },
  ...[3, 4, 5].flatMap((n) => [sidebar("left", n), sidebar("right", n)]),
];

type CompositionSet = Partial<Record<Composition, true>>;

/**
 * Candidate set per section layout. `fallback` compositions are used only when nothing in `primary` is feasible
 * (odd block counts, min widths at print width). `pairs` restricts pair splits (left span).
 */
const LAYOUT_RULES: Record<LayoutPattern, { primary: CompositionSet; fallback: CompositionSet; pairs?: readonly number[] }> = {
  auto: {
    primary: { full: true, hero: true, pair: true, trio: true, quad: true, grid: true, "feature-left": true, "feature-right": true, "sidebar-left": true, "sidebar-right": true },
    fallback: {},
  },
  stack: { primary: { stack: true }, fallback: {} },
  "main-side": { primary: { pair: true }, fallback: { full: true }, pairs: [8] },
  "side-main": { primary: { pair: true }, fallback: { full: true }, pairs: [4] },
  split: { primary: { pair: true }, fallback: { full: true }, pairs: [6] },
  thirds: { primary: { trio: true }, fallback: { pair: true, full: true }, pairs: [6] },
  quarters: { primary: { quad: true }, fallback: { trio: true, pair: true, full: true }, pairs: [6] },
  feature: { primary: { "feature-left": true, "feature-right": true }, fallback: { full: true } },
  sidebar: { primary: { "sidebar-left": true, "sidebar-right": true }, fallback: { full: true } },
  grid: { primary: { grid: true, pair: true, trio: true, quad: true }, fallback: { full: true }, pairs: [6] },
};

const FULL_WIDTH: CompositionSet = { full: true, stack: true };

/**
 * Solve a section's bands: dynamic programming over the block sequence (reading order preserved). Each step
 * consumes the next blocks with one feasible template; the plan minimises Σ band cost + rhythm, ties broken toward
 * fewer bands, then template order. Deterministic.
 */
export function composeSection(section: Section, env: ComposeEnv): Band[] {
  const items = section.blocks.map((block) => describe(block, env));
  const rules = LAYOUT_RULES[section.layout ?? "auto"];
  const n = items.length;

  interface State {
    cost: number;
    bands: number;
    allFull: boolean;
    last?: Composition;
    prev?: State;
    band?: Band;
  }
  const better = (a: State, b: State | undefined): boolean => !b || a.cost < b.cost - EPS || (Math.abs(a.cost - b.cost) <= EPS && a.bands < b.bands);

  const states: Array<Map<string, State>> = Array.from({ length: n + 1 }, () => new Map());
  states[0]!.set("", { cost: 0, bands: 0, allFull: true });
  for (let i = 0; i < n; i++) {
    if (states[i]!.size === 0) continue;
    const candidates = candidatesAt(items, i, rules, env);
    for (const state of states[i]!.values()) {
      for (const c of candidates) {
        const composition = c.band.composition;
        const next: State = {
          cost: state.cost + c.cost + rhythmCost(state.last, composition),
          bands: state.bands + 1,
          allFull: state.allFull && FULL_WIDTH[composition] === true,
          last: composition,
          prev: state,
          band: c.band,
        };
        const key = `${composition}|${next.allFull}`;
        const bucket = states[i + c.size]!;
        if (better(next, bucket.get(key))) bucket.set(key, next);
      }
    }
  }

  let best: State | undefined;
  for (const s of states[n]!.values()) {
    const final = s.allFull && s.bands >= 2 ? { ...s, cost: s.cost + WEIGHTS.allFull } : s;
    if (better(final, best)) best = final;
  }
  const bands: Band[] = [];
  for (let s = best; s?.band; s = s.prev) bands.push(s.band);
  return bands.reverse();
}

function describe(block: Block, env: ComposeEnv): Item {
  const { ctx } = env;
  const fit = idealWidth(block, ctx, env.contentWidth);
  let min: number = METRICS.minWidth.text;
  let full = false;
  let compact = false;
  switch (block.type) {
    case "kpi":
      // All items on one row.
      min = block.items.length * METRICS.kpi.minItemWidth + (block.items.length - 1) * METRICS.kpi.columnGap;
      full = true;
      break;
    case "stat":
      min = METRICS.minWidth.stat;
      compact = true;
      break;
    case "comparison":
      // Entity columns plus the change column (shown unless showDelta is false).
      min = METRICS.comparison.labelColumn + (block.entities.length + (block.showDelta === false ? 0 : 1)) * METRICS.comparison.entityColumn;
      compact = block.metrics.length <= 4;
      break;
    case "diagram":
      min = METRICS.minWidth.diagram;
      break;
    case "table":
      min = METRICS.minWidth.table;
      // Wide tables (columns beyond two thirds of the width) and long ones (which may split across pages) own the band.
      full = tableMetrics(block, env.contentWidth, ctx).rows > 8 || fit.lo > cellBox(1, 8, env.contentWidth, env.gap).width;
      break;
    case "chart": {
      min = METRICS.minWidth.chart;
      const c = block.chart;
      const round = c.kind === "pie" || c.kind === "donut";
      compact = round;
      // Bars with many categories need the full width (vertical > 24; one row per category > 12).
      const categories = round ? undefined : chartCategories(c, ctx);
      const rowsPerCategory = c.kind === "funnel" || c.kind === "dumbbell" || (c.kind === "bar" && c.horizontal === true);
      const barLike = c.kind === "bar" || c.kind === "waterfall" || c.kind === "funnel" || c.kind === "dumbbell";
      full = barLike && categories !== undefined && categories > (rowsPerCategory ? 12 : 24);
      break;
    }
    default:
      compact = isShortNarrative(block);
  }
  return { block, min, full, compact, fit, boxes: new Map() };
}

function boxAt(item: Item, width: number, env: ComposeEnv): BlockBox {
  let box = item.boxes.get(width);
  if (!box) {
    box = blockBox(item.block, width, env.ctx, env.density);
    const measured = env.measured?.[item.block.id];
    // Measured elastic blocks report their chrome only; their body stays solvable.
    if (measured !== undefined) box = { ...box, chrome: measured };
    item.boxes.set(width, box);
  }
  return box;
}

/** Every feasible band starting at block `i`, costed independently of its neighbours. */
function candidatesAt(items: readonly Item[], i: number, rules: (typeof LAYOUT_RULES)[LayoutPattern], env: ComposeEnv): Candidate[] {
  const out: Candidate[] = [];
  const add = (t: Template, group: readonly Item[], fallback: boolean) => {
    const c = evaluate(t, group, fallback, env);
    if (c.cost < Infinity) out.push(c);
  };
  for (let size = 1; size <= 6 && i + size <= items.length; size++) {
    const group = items.slice(i, i + size);
    if (group.some((it) => it.block.span !== undefined)) {
      const t = explicitTemplate(group);
      if (t && fits(t, group, env)) add(t, group, false);
      continue;
    }
    for (const t of TEMPLATES) {
      if (t.slots.length !== size) continue;
      const primary = rules.primary[t.composition] === true;
      if (!primary && !rules.fallback[t.composition]) continue;
      if (t.composition === "pair" && rules.pairs && !rules.pairs.includes(t.slots[0]!.span)) continue;
      if (fits(t, group, env)) add(t, group, !primary);
    }
  }
  return out;
}

/**
 * Row template honouring explicit spans (full/pair/trio/quad). Blocks without a span share the remaining columns
 * evenly (earlier blocks take the remainder). A lone block whose span nothing honours falls back to full width.
 */
function explicitTemplate(group: readonly Item[]): Template | undefined {
  if (group.length > 4) return undefined;
  const fixed = group.reduce((n, it) => n + (it.block.span ?? 0), 0);
  const free = group.filter((it) => it.block.span === undefined).length;
  const rest = COLUMNS - fixed;
  if (free === 0 ? rest !== 0 : rest < free) {
    return group.length === 1 ? row("full", [COLUMNS], { explicit: true, brokenSpan: true }) : undefined;
  }
  let k = 0;
  const spans = group.map((it) => it.block.span ?? Math.floor(rest / free) + (k++ < rest % free ? 1 : 0));
  const composition = (["full", "pair", "trio", "quad"] as const)[group.length - 1]!;
  return row(composition, spans, { explicit: true });
}

const LEAD_TYPES: Partial<Record<Block["type"], true>> = { chart: true, diagram: true, table: true, comparison: true, stat: true };
const ASIDE_TYPES: Partial<Record<Block["type"], true>> = { text: true, callout: true, list: true, stat: true };

/** Hard constraints: min widths, full-width-only blocks, and per-composition slot eligibility. */
function fits(t: Template, group: readonly Item[], env: ComposeEnv): boolean {
  const ok = group.every((it, k) => {
    const slot = t.slots[k]!;
    if (slot.span === COLUMNS || it.block.span !== undefined) return true;
    return !it.full && cellBox(slot.col, slot.span, env.contentWidth, env.gap).width >= it.min;
  });
  if (!ok) return false;
  switch (t.composition) {
    case "hero": {
      const b = group[0]!.block;
      return b.type === "stat" || (b.type === "chart" && b.importance === "lead");
    }
    case "grid":
      return group.every((it) => it.compact);
    case "feature-left":
    case "feature-right":
      return LEAD_TYPES[group[t.lead!]!.block.type] === true;
    case "sidebar-left":
    case "sidebar-right":
      return ASIDE_TYPES[group[t.aside!]!.block.type] === true;
    default:
      return true;
  }
}

/** Level the template's columns, build placements and cost the band. */
function evaluate(t: Template, group: readonly Item[], fallback: boolean, env: ComposeEnv): Candidate {
  const { gap, contentWidth } = env;
  const widths = t.slots.map((s) => cellBox(s.col, s.span, contentWidth, gap).width);
  const boxes = group.map((it, k) => boxAt(it, widths[k]!, env));
  const bodies = boxes.map((b) => b.body);
  const heights = boxes.map((b) => b.chrome + b.body);
  let whitespace = 0;
  let height = 0;
  for (const columns of t.groups) {
    const range = columns.map((col) => {
      const sum = (f: (b: BlockBox) => number) => col.reduce((n, k) => n + f(boxes[k]!), (col.length - 1) * gap);
      // Fixed blocks have body = min = max = 0, so they contribute their chrome to all three.
      return { lo: sum((b) => b.chrome + b.min), hi: sum((b) => b.chrome + b.max), natural: sum((b) => b.chrome + b.body) };
    });
    const lo = Math.max(...range.map((r) => r.lo));
    const hi = Math.min(...range.map((r) => r.hi));
    const natural = Math.max(...range.map((r) => r.natural));
    // A common height every column reaches when the ranges overlap; otherwise the least height the tallest needs.
    const target = lo <= hi ? Math.min(hi, Math.max(lo, natural)) : lo;
    const achieved = columns.map((col, c) => {
      const r = range[c]!;
      const goal = Math.min(r.hi, Math.max(r.lo, target));
      level(col, boxes, bodies, goal - r.natural);
      let h = (col.length - 1) * gap;
      for (const k of col) {
        heights[k] = boxes[k]!.chrome + bodies[k]!;
        h += heights[k];
      }
      return h;
    });
    const track = Math.max(...achieved);
    columns.forEach((col, c) => (whitespace += (track - achieved[c]!) * widths[col[0]!]!));
    height += track;
  }
  height += (t.groups.length - 1) * gap;

  const placements: Placement[] = group.map((it, k) => {
    const s = t.slots[k]!;
    const box = boxes[k]!;
    const p: Placement = { blockId: it.block.id, col: s.col, span: s.span, row: s.row, rowSpan: s.rowSpan, width: widths[k]!, height: heights[k]! };
    if (box.max > box.min) p.plotHeight = bodies[k]!;
    return p;
  });
  const rows = Math.max(...t.slots.map((s) => s.row + s.rowSpan - 1));
  const band: Band = { composition: t.composition, rows, height, placements };

  const alone = group.length === 1;
  const cells: CellFacts[] = group.map((it, k) => ({
    block: it.block,
    rank: importanceRank(it.block, alone),
    fit: it.fit,
    width: widths[k]!,
    height: heights[k]!,
    leadSlot: t.lead === k,
    aside: t.aside === k,
  }));
  const facts: BandFacts = {
    composition: t.composition,
    cells,
    whitespace,
    height,
    uneven: t.composition === "pair" && t.slots[0]!.span !== t.slots[1]!.span,
    reversed: t.reversed === true,
    fallback,
    brokenSpan: t.brokenSpan === true,
    contentWidth,
    gap,
    pageHeight: env.pageHeight,
  };
  return { band, cost: bandCost(facts), size: group.length };
}

/**
 * Move `delta` px across the elastic bodies of one column (water-filling within each body's [min, max]), then round
 * bodies to whole pixels with cumulative rounding so the column total stays within half a pixel.
 */
function level(col: readonly number[], boxes: readonly BlockBox[], bodies: number[], delta: number): void {
  const elastic = col.filter((k) => boxes[k]!.max > boxes[k]!.min);
  let rest = delta;
  while (Math.abs(rest) > EPS) {
    const active = elastic.filter((k) => (rest > 0 ? bodies[k]! < boxes[k]!.max : bodies[k]! > boxes[k]!.min));
    if (active.length === 0) break;
    const share = rest / active.length;
    for (const k of active) {
      const next = Math.min(boxes[k]!.max, Math.max(boxes[k]!.min, bodies[k]! + share));
      rest -= next - bodies[k]!;
      bodies[k] = next;
    }
  }
  let exact = 0;
  let rounded = 0;
  for (const k of elastic) {
    exact += bodies[k]!;
    const r = Math.round(exact) - rounded;
    rounded += r;
    bodies[k] = r;
  }
}
