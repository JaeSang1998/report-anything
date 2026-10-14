import type { ScaleLinear } from "d3-scale";
import type { FormatContext } from "../data/types.js";
import type { ChartModel, Tick } from "./types.js";
import { scaleLinear } from "d3-scale";
import { formatCompact } from "../data/format.js";
import { MAX_LABEL_CHARS, truncate } from "./text.js";
import { estimateTextWidth } from "../text.js";

/** Height reserved above the plot for the legend when drawn inside the SVG. */
export const LEGEND_BAND = 28;
/** Breathing room around the plot. */
export const PAD = 8;
/** Gap between tick labels and the axis line. */
export const TICK_GAP = 6;
export const BOTTOM_LABEL_ANGLE = -35;
const SIN = Math.sin((-BOTTOM_LABEL_ANGLE * Math.PI) / 180);
const COS = Math.cos((-BOTTOM_LABEL_ANGLE * Math.PI) / 180);

/** What each chart family contributes to the model; build.ts adds kind/size/empty. */
export type Scene = Pick<ChartModel, "plot" | "axes" | "grid" | "marks" | "legend" | "description" | "warnings">;

export interface SceneOptions {
  width: number;
  height: number;
  fontSize: number;
  /** Reserve the legend band at the top of the chart (false when the adapter draws the legend outside). */
  legendBand: boolean;
}

/** Linear value scale with a nice domain; degenerate extents are widened so the scale stays invertible. */
export function niceScale(min: number, max: number, count: number): ScaleLinear<number, number> {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (lo === hi) {
    const d = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    [lo, hi] = lo >= 0 && lo !== 0 ? [0, hi] : [lo - d, hi + d];
    if (lo === hi) hi = lo + 1;
  }
  return scaleLinear().domain([lo, hi]).nice(count);
}

/**
 * Extent for a measure axis. Bars/areas always include zero; lines/scatter include it when data are one-signed and
 * the zero baseline costs less than half the axis.
 */
export function valueExtent(values: readonly number[], forceZero: boolean): [number, number] {
  if (values.length === 0) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (forceZero || (lo >= 0 && lo <= hi / 2) || (hi <= 0 && hi >= lo / 2)) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  return [lo, hi];
}

export function ticksOf(scale: ScaleLinear<number, number>, count: number, format: string | undefined, ctx: FormatContext): Array<{ value: number; label: string }> {
  const values = scale.ticks(count);
  let labels = values.map((v) => formatCompact(v, format, ctx));
  // Rounding can make neighbours read the same (2.5% and 3% → "3%"): add decimals until every tick is distinct.
  if (format?.startsWith("percent")) {
    for (let d = 1; d <= 2 && new Set(labels).size < labels.length; d++) labels = values.map((v) => formatCompact(v, `percent:${d}`, ctx));
  }
  return values.map((value, i) => ({ value, label: labels[i]! }));
}

export function maxTextWidth(labels: readonly string[], fontSize: number): number {
  let w = 0;
  for (const l of labels) w = Math.max(w, estimateTextWidth(l, fontSize));
  return w;
}

/** Tick count that keeps vertical ticks ≥ ~36px apart. */
export function verticalTickCount(plotHeight: number): number {
  return Math.max(2, Math.min(6, Math.floor(plotHeight / 36)));
}

export interface BottomPlan {
  /** Truncated label per position. */
  labels: string[];
  /** Positions that get a visible tick label. */
  shown: number[];
  angle?: number;
  /** Vertical space the labels need below the axis line. */
  height: number;
  /** Horizontal overhang of the first label to the left of its anchor. */
  overhangLeft: number;
  /** Overhang of the last label to the right of its anchor. */
  overhangRight: number;
}

/**
 * Bottom tick labels for evenly spaced positions `step` px apart. Fits horizontally when possible; otherwise ordered
 * axes (time/number) thin labels, categorical axes rotate -35° (and thin if even rotated labels collide).
 */
export function planBottomLabels(full: readonly string[], step: number, ordered: boolean, fontSize: number, maxHeight: number): BottomPlan {
  let labels = full.map((l) => truncate(l, MAX_LABEL_CHARS));
  const flatHeight = fontSize + TICK_GAP + 2;
  const every = (k: number) => labels.flatMap((_, i) => (i % k === 0 ? [i] : []));
  const widest = maxTextWidth(labels, fontSize);
  const firstW = estimateTextWidth(labels[0] ?? "", fontSize);
  if (labels.length <= 1 || widest + 6 <= step || ordered) {
    const k = labels.length <= 1 ? 1 : Math.max(1, Math.ceil((widest + 8) / Math.max(step, 1)));
    const shown = every(k);
    const lastW = estimateTextWidth(labels[shown[shown.length - 1] ?? 0] ?? "", fontSize);
    return { labels, shown, height: flatHeight, overhangLeft: firstW / 2, overhangRight: lastW / 2 };
  }
  let rotatedHeight = widest * SIN + fontSize * COS + TICK_GAP + 2;
  if (rotatedHeight > maxHeight) {
    const room = Math.max(fontSize, (maxHeight - fontSize * COS - TICK_GAP - 2) / SIN);
    labels = labels.map((l) => {
      let t = l;
      while ([...t].length > 2 && estimateTextWidth(t, fontSize) > room) t = truncate(t, [...t].length - 1);
      return t;
    });
    rotatedHeight = maxTextWidth(labels, fontSize) * SIN + fontSize * COS + TICK_GAP + 2;
  }
  const k = Math.max(1, Math.ceil((fontSize * 1.15) / Math.max(step * SIN, 0.1)));
  return {
    labels,
    shown: every(k),
    angle: BOTTOM_LABEL_ANGLE,
    height: rotatedHeight,
    overhangLeft: maxTextWidth(labels.slice(0, 1), fontSize) * COS,
    overhangRight: fontSize * SIN,
  };
}

export function toTicks(plan: BottomPlan, values: readonly Tick["value"][], offsets: readonly number[]): Tick[] {
  return plan.shown.map((i) => ({ value: values[i] ?? null, label: plan.labels[i] ?? "", offset: offsets[i] ?? 0 }));
}
