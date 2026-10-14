import type { ChartKind, ChartSpec, Row, Scalar } from "../spec.js";
import type { DataContext } from "../data/types.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { ChartSource, FacetSplit } from "./prepare.js";
import type { ChartModel, LegendItem } from "./types.js";
import { EMPTY_VALUE } from "../data/format.js";
import { toNumber } from "../data/values.js";
import { METRICS } from "../layout/metrics.js";
import { PAD, TICK_GAP, niceScale, verticalTickCount } from "./axes.js";
import { buildCartesian, valueSpans } from "./cartesian.js";
import { loadSource, prepareCategorical, yFields } from "./prepare.js";
import { buildScatter, prepareScatter } from "./scatter.js";
import { DEFAULT_FONT_SIZE } from "./text.js";

/** Chart kinds that support `facet` (small multiples). Other kinds ignore it and render one chart. */
export const FACET_KINDS: Record<ChartKind, boolean> = {
  bar: true,
  line: true,
  area: true,
  scatter: true,
  pie: false,
  donut: false,
  heatmap: false,
  waterfall: false,
  funnel: false,
  dumbbell: false,
};

const DEFAULT_FACET_LIMIT = 12;

export interface FacetPanel {
  key: string;
  /** Panel title: the facet value. */
  label: string;
  model: ChartModel;
}

export interface FacetCharts {
  /** Row-major, largest totals first. Panel models carry no legend; `legend` is shared by every panel. */
  panels: FacetPanel[];
  legend: LegendItem[];
  warnings: string[];
}

export interface FacetOptions {
  /** Width of the whole panel grid (columns + gaps of METRICS.chart.facetGap). */
  width: number;
  /** One grid cell's height: METRICS.chart.facetLabel line + panel SVG. */
  panelHeight: number;
  columns: number;
  fontSize?: number;
}

type Margins = NonNullable<SceneOptions["margins"]>;

/**
 * Small multiples for bar/line/area/scatter charts with `facet`: one panel per facet value (largest totals first,
 * at most `facetLimit`). Panels share categories, value domain and bubble scale so they compare directly; only
 * left-column panels label the value axis and only panels with nothing below them label the x axis. Plot areas are
 * identical: edge panels are wider/taller by exactly their axis labels, and the grid fills `width` ×
 * (rows × panelHeight + gaps).
 */
export function buildFacetCharts(spec: ChartSpec, ctx: DataContext, opts: FacetOptions): FacetCharts {
  const field = spec.facet;
  const { source, warnings } = loadSource(spec, ctx);
  if (!source || field === undefined || !FACET_KINDS[spec.kind]) {
    if (source) warnings.push(field === undefined ? "Chart has no facet field." : `${spec.kind} charts do not support facet.`);
    return { panels: [], legend: [], warnings };
  }

  // Facet values by total measure (row count for count aggregates); ties keep first-seen order.
  const ys = yFields(spec.y);
  const counting = spec.aggregate === "count" || spec.aggregate === "countDistinct";
  const totals = new Map<Scalar, number>();
  for (const row of source.ds.rows) {
    const v = row[field] ?? null;
    let t = totals.get(v) ?? 0;
    if (counting) t += 1;
    else for (const y of ys) t += Math.abs(toNumber(row[y]) ?? 0);
    totals.set(v, t);
  }
  const limit = spec.facetLimit ?? DEFAULT_FACET_LIMIT;
  const values = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
  if (values.length > limit) {
    warnings.push(`Facet "${field}" has ${values.length} values; only the ${limit} largest panels are drawn (${values.length - limit} dropped). Raise facetLimit (max 24) or filter the data.`);
  }
  const kept = values.slice(0, limit);
  const n = kept.length;
  if (n === 0) return { panels: [], legend: [], warnings: [...warnings, `No plottable rows in dataset "${spec.data}" for this chart.`] };
  const panelOf = new Map<Scalar, number>(kept.map((v, i) => [v, i]));
  const split: FacetSplit = { count: n, of: (row: Row) => panelOf.get(row[field] ?? null)! };
  const rows = source.ds.rows.filter((r) => panelOf.has(r[field] ?? null));
  const panelSource: ChartSource = { ds: { ...source.ds, rows }, field: source.field };
  let s = spec;
  if (spec.secondary) {
    warnings.push("Faceted charts do not draw a secondary axis; secondary measures were omitted.");
    s = { ...spec, secondary: undefined };
  }

  const fs = opts.fontSize ?? DEFAULT_FONT_SIZE;
  const columns = Math.max(1, Math.min(Math.floor(opts.columns), n));
  const gridRows = Math.ceil(n / columns);
  const G = METRICS.chart.facetGap;
  const svgH = Math.max(1, opts.panelHeight - METRICS.chart.facetLabel);
  const guessW = Math.max(1, (opts.width - (columns - 1) * G) / columns);

  let scene: (panel: number, o: SceneOptions) => Scene;
  if (s.kind === "scatter") {
    const data = prepareScatter(s, panelSource, ctx, split);
    scene = (panel, o) => buildScatter(s, { ...data, panel }, o, ctx);
  } else {
    const prep = prepareCategorical(s, panelSource, ctx, split);
    const panels = prep.panels!.map((p) => ({ ...prep, ...p }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of panels) {
      const [a, b] = valueSpans(s, p).extent;
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    // Same tick density the panels will use: horizontal bars start from 5 ticks, vertical from the plot height.
    const count = s.kind === "bar" && s.horizontal ? 5 : verticalTickCount(svgH - 2 * PAD - fs - TICK_GAP - 2);
    const domain = niceScale(lo, hi, count).domain() as [number, number];
    scene = (panel, o) => buildCartesian(s, panels[panel]!, { ...o, domain }, ctx);
  }

  // Probe natural margins with and without axis labels at the guessed panel size, then fix one plot size for all.
  const base: SceneOptions = { width: guessW, height: svgH, fontSize: fs, legendBand: false };
  const margins = (left: boolean, bottom: boolean): Margins => {
    const { plot } = scene(0, { ...base, tickLabels: { left, bottom } });
    return { left: plot.x, right: guessW - plot.x - plot.width, top: plot.y, bottom: svgH - plot.y - plot.height };
  };
  const full = margins(true, true);
  const inner = margins(false, false);
  const bottomOnly = margins(false, true);
  const right = Math.max(full.right, inner.right, bottomOnly.right);
  const top = Math.max(full.top, inner.top);
  const innerLeft = Math.max(inner.left, bottomOnly.left);
  const plotW = Math.max(1, (opts.width - (columns - 1) * G - full.left - (columns - 1) * innerLeft - columns * right) / columns);
  const labelsBelow = (i: number) => i + columns >= n;
  let bottoms = 0;
  for (let r = 0; r < gridRows; r++) bottoms += labelsBelow(Math.min(n - 1, r * columns + columns - 1)) ? full.bottom : inner.bottom;
  const plotH = Math.max(1, svgH - top - bottoms / gridRows);

  let legend: LegendItem[] = [];
  const seen = new Set(warnings);
  const panels = kept.map((v, i): FacetPanel => {
    const left = i % columns === 0;
    const below = labelsBelow(i);
    const m: Margins = { left: left ? full.left : innerLeft, right, top, bottom: below ? full.bottom : inner.bottom };
    const width = m.left + plotW + m.right;
    const height = m.top + plotH + m.bottom;
    const sc = scene(i, { width, height, fontSize: fs, legendBand: false, tickLabels: { left, bottom: below }, margins: m });
    if (i === 0) legend = sc.legend;
    for (const w of sc.warnings) seen.add(w);
    const label = v === null || v === "" ? EMPTY_VALUE : String(v);
    const empty = !sc.marks.some((mk) => mk.type === "rect" || mk.type === "circle" || mk.type === "path");
    return {
      key: v === null ? "\u0000null" : String(v),
      label,
      model: { kind: s.kind, width, height, ...sc, legend: [], description: `${label}: ${sc.description}`, empty, warnings: [] },
    };
  });
  return { panels, legend, warnings: [...seen] };
}
