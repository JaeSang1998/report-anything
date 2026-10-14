import type { ChartKind, Scalar } from "../spec.js";

/**
 * Renderer-agnostic color reference. Adapters map these to concrete colors:
 *  - number: series palette index (0-based, wraps)
 *  - { scale }: sequential intensity in [0, 1] (heatmaps, table heat)
 *  - named roles: theme tokens
 */
export type ColorRef = number | { scale: number } | "fg" | "muted" | "grid" | "positive" | "negative" | "surface";

export interface Datum {
  x: Scalar;
  y: Scalar;
  series?: string;
  /** Pre-formatted tooltip / accessible label, e.g. "Mar 2026 · Revenue: ₩1.2B". */
  label: string;
}

export type Mark =
  | { type: "rect"; key: string; series: string; x: number; y: number; width: number; height: number; fill: ColorRef; rx?: number; datum: Datum }
  | { type: "path"; key: string; series: string; d: string; variant: "line" | "area"; stroke?: ColorRef; fill?: ColorRef; opacity?: number; dash?: boolean }
  | { type: "circle"; key: string; series: string; cx: number; cy: number; r: number; fill: ColorRef; opacity?: number; datum: Datum }
  | { type: "arc"; key: string; series: string; d: string; fill: ColorRef; centroid: [number, number]; datum: Datum }
  | {
      type: "text";
      key: string;
      x: number;
      y: number;
      text: string;
      anchor: "start" | "middle" | "end";
      baseline: "auto" | "middle" | "hanging";
      role: "value-label" | "annotation" | "center-label" | "center-value";
      fill: ColorRef;
    }
  | { type: "line"; key: string; x1: number; y1: number; x2: number; y2: number; role: "reference"; stroke: ColorRef; dash: boolean; label?: string };

export interface Tick {
  value: Scalar;
  label: string;
  /** Pixel offset along the axis (x for horizontal axes, y for vertical axes), in chart coordinates. */
  offset: number;
}

export interface Axis {
  position: "bottom" | "left" | "right" | "top";
  ticks: Tick[];
  title?: string;
  /** Axis baseline segment in chart coordinates. */
  line: { x1: number; y1: number; x2: number; y2: number };
  /** Rotate bottom tick labels (degrees, e.g. -35) when crowded. */
  labelAngle?: number;
}

export interface GridLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LegendItem {
  key: string;
  label: string;
  color: ColorRef;
  shape: "square" | "line" | "circle";
}

export interface ChartModel {
  kind: ChartKind;
  width: number;
  height: number;
  /** Plot area inside the axes. */
  plot: { x: number; y: number; width: number; height: number };
  axes: Axis[];
  grid: GridLine[];
  /** Draw in array order. */
  marks: Mark[];
  legend: LegendItem[];
  /** Auto-generated accessible summary (one or two sentences). */
  description: string;
  /** True when no drawable data remains after filtering. */
  empty: boolean;
  warnings: string[];
}

export interface ChartBuildOptions {
  width: number;
  height: number;
  /** Approximate glyph width ratio used to fit labels (default 0.6 × fontSize). */
  fontSize?: number;
  /**
   * "top" (default): reserve a 28px band at the top of the SVG for the legend (chartToSvg draws it there).
   * "external": reserve nothing; the adapter draws `model.legend` itself (React renders an HTML legend below the SVG).
   */
  legend?: "top" | "external";
}
