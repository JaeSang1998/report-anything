import type { ChartKind } from "../spec.js";
import { estimateTextWidth } from "../text.js";

export const DEFAULT_FONT_SIZE = 11;
/** Bottom tick labels longer than this are truncated with '…'. */
export const MAX_LABEL_CHARS = 16;

/** Truncate to at most `maxChars` code points, ending with '…' when cut. */
export function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return maxChars <= 1 ? "…" : `${chars.slice(0, maxChars - 1).join("")}…`;
}

/** Truncate so the estimated width fits `width` pixels. */
export function fitText(text: string, width: number, fontSize: number): string {
  if (estimateTextWidth(text, fontSize) <= width) return text;
  const chars = [...text];
  let w = estimateTextWidth("…", fontSize);
  let n = 0;
  for (const ch of chars) {
    const cw = estimateTextWidth(ch, fontSize);
    if (w + cw > width) break;
    w += cw;
    n++;
  }
  return n === 0 ? "" : `${chars.slice(0, n).join("")}…`;
}

const KIND_NAMES: Record<ChartKind, string> = {
  bar: "Bar chart",
  line: "Line chart",
  area: "Area chart",
  scatter: "Scatter plot",
  pie: "Pie chart",
  donut: "Donut chart",
  heatmap: "Heatmap",
};

export interface Summary {
  kind: ChartKind;
  horizontal?: boolean;
  measure: string;
  by: string;
  points: number;
  series: number;
  /** Formatted value range. */
  min?: string;
  max?: string;
  /** Human label of the largest point, e.g. "Mar 2026 · Revenue: $5.6K". */
  peak?: string;
}

/** One-sentence accessible summary of a chart. */
export function describe(s: Summary): string {
  const name = s.horizontal ? "Horizontal bar chart" : KIND_NAMES[s.kind];
  const count = `${s.points} ${s.points === 1 ? "point" : "points"}${s.series > 1 ? ` across ${s.series} series` : ""}`;
  const range = s.min !== undefined && s.max !== undefined ? (s.min === s.max ? `, all at ${s.max}` : `, ranging from ${s.min} to ${s.max}`) : "";
  const peak = s.peak ? `; highest: ${s.peak}` : "";
  return `${name} of ${s.measure} by ${s.by} with ${count}${range}${peak}.`;
}
