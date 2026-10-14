import type { ChartSpec, Scalar } from "../spec.js";
import type { FormatContext } from "../data/types.js";
import type { Category, ChartSource, RawCategory } from "./prepare.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { Mark } from "./types.js";
import { scaleBand } from "d3-scale";
import { formatCompact, formatValue } from "../data/format.js";
import { PAD, TICK_GAP, maxTextWidth, planBottomLabels, toTicks } from "./axes.js";
import { aggregateCell, categoryOf, detectXType, labelCategories, sortByPosition, yFields } from "./prepare.js";
import { MAX_LABEL_CHARS, describe, fitText, truncate } from "./text.js";
import { estimateTextWidth } from "../text.js";

/** Cells darker than this intensity get light label text. */
const DARK_CELL = 0.55;

interface Cell {
  xi: number;
  yi: number;
  v: number;
}

export interface HeatmapData {
  xCats: Category[];
  yCats: Category[];
  cells: Cell[];
  xLabel: string;
  yLabel: string;
  measure: string;
  format?: string;
}

/** Group by (x, y) categories and aggregate `value` (count of rows when no value field). */
export function prepareHeatmap(spec: ChartSpec, source: ChartSource, ctx: FormatContext): HeatmapData {
  const { ds } = source;
  const yField = yFields(spec.y)[0]!;
  const xInfo = source.field(spec.x);
  const yInfo = source.field(yField);
  const xType = detectXType(ds.rows, xInfo);
  const yType = detectXType(ds.rows, yInfo);
  const agg = spec.aggregate ?? (spec.value ? "sum" : "count");
  const valueField = spec.value ?? spec.x;

  const xIndex = new Map<string, number>();
  const yIndex = new Map<string, number>();
  const xRaw: RawCategory[] = [];
  const yRaw: RawCategory[] = [];
  const raw = new Map<string, { xi: number; yi: number; values: Scalar[] }>();
  for (const row of ds.rows) {
    const cx = categoryOf(row[spec.x], xType);
    const cy = categoryOf(row[yField], yType);
    if (!cx || !cy) continue;
    let xi = xIndex.get(cx.key);
    if (xi === undefined) {
      xIndex.set(cx.key, (xi = xRaw.length));
      xRaw.push(cx);
    }
    let yi = yIndex.get(cy.key);
    if (yi === undefined) {
      yIndex.set(cy.key, (yi = yRaw.length));
      yRaw.push(cy);
    }
    const k = `${xi}|${yi}`;
    let cell = raw.get(k);
    if (!cell) raw.set(k, (cell = { xi, yi, values: [] }));
    cell.values.push(row[valueField] ?? null);
  }
  const xOrder = sortByPosition(
    xRaw.map((c, i) => ({ ...c, i })),
    spec.sort === "none" ? "category" : xType,
  );
  const yOrder = sortByPosition(
    yRaw.map((c, i) => ({ ...c, i })),
    yType,
  );
  if (spec.sort === "-x") xOrder.reverse();
  const xRank = new Map(xOrder.map((c, r) => [c.i, r]));
  const yRank = new Map(yOrder.map((c, r) => [c.i, r]));
  const cells: Cell[] = [];
  for (const c of raw.values()) {
    const v = aggregateCell(c.values, agg);
    if (v !== null) cells.push({ xi: xRank.get(c.xi)!, yi: yRank.get(c.yi)!, v });
  }
  return {
    xCats: labelCategories(xOrder, xType, spec.xFormat ?? xInfo.format, ctx),
    yCats: labelCategories(yOrder, yType, undefined, ctx),
    cells,
    xLabel: spec.xLabel ?? xInfo.label,
    yLabel: spec.yLabel ?? yInfo.label,
    measure: spec.value ? source.field(spec.value).label : "Count",
    format: spec.yFormat ?? (spec.value ? source.field(spec.value).format : undefined),
  };
}

export function buildHeatmap(spec: ChartSpec, data: HeatmapData, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const { xCats, yCats, cells } = data;
  const titleBand = fs + 6;
  const top = PAD;
  const yLabels = yCats.map((c) => fitText(truncate(c.label, MAX_LABEL_CHARS), W * 0.3, fs));
  const left = PAD + (spec.yLabel ? titleBand : 0) + maxTextWidth(yLabels, fs) + TICK_GAP;
  let plotW = Math.max(1, W - left - PAD);
  const plan = planBottomLabels(
    xCats.map((c) => c.label),
    plotW / Math.max(1, xCats.length),
    false,
    fs,
    H * 0.35,
  );
  const step = plotW / Math.max(1, xCats.length);
  const right = Math.max(PAD, PAD + plan.overhangRight - step / 2);
  plotW = Math.max(1, W - left - right);
  const bottom = plan.height + (spec.xLabel ? titleBand : 0) + PAD;
  const plotH = Math.max(1, H - top - bottom);
  const plot = { x: left, y: top, width: plotW, height: plotH };
  const xb = scaleBand<number>()
    .domain(xCats.map((_, i) => i))
    .range([left, left + plotW])
    .padding(0.04);
  const yb = scaleBand<number>()
    .domain(yCats.map((_, i) => i))
    .range([top, top + plotH])
    .padding(0.04);

  const axes: Scene["axes"] = [
    {
      position: "bottom",
      ticks: toTicks(
        plan,
        xCats.map((c) => c.value),
        xCats.map((_, i) => (xb(i) ?? 0) + xb.bandwidth() / 2),
      ),
      line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
      ...(plan.angle !== undefined ? { labelAngle: plan.angle } : {}),
      ...(spec.xLabel ? { title: spec.xLabel } : {}),
    },
    {
      position: "left",
      ticks: yCats.map((c, i) => ({ value: c.value, label: yLabels[i] ?? "", offset: (yb(i) ?? 0) + yb.bandwidth() / 2 })),
      line: { x1: left, y1: top, x2: left, y2: top + plotH },
      ...(spec.yLabel ? { title: spec.yLabel } : {}),
    },
  ];

  const vs = cells.map((c) => c.v);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const marks: Mark[] = [];
  const labels: Mark[] = [];
  for (const c of cells) {
    const t = max === min ? 1 : (c.v - min) / (max - min);
    const xc = xCats[c.xi]!;
    const yc = yCats[c.yi]!;
    const x = xb(c.xi) ?? 0;
    const y = yb(c.yi) ?? 0;
    const w = xb.bandwidth();
    const h = yb.bandwidth();
    marks.push({
      type: "rect",
      key: `cell:${xc.key}:${yc.key}`,
      series: data.measure,
      x,
      y,
      width: w,
      height: h,
      fill: { scale: t },
      rx: 2,
      datum: { x: xc.value, y: yc.value, label: `${xc.label} · ${yc.label}: ${formatValue(c.v, data.format, ctx)}` },
    });
    const text = formatCompact(c.v, data.format, ctx);
    if (spec.labels !== false && w >= estimateTextWidth(text, fs) + 6 && h >= fs + 4) {
      labels.push({ type: "text", key: `label:${xc.key}:${yc.key}`, x: x + w / 2, y: y + h / 2, text, anchor: "middle", baseline: "middle", role: "value-label", fill: t > DARK_CELL ? "surface" : "fg" });
    }
  }
  marks.push(...labels);
  const peak = cells.find((c) => c.v === max);
  return {
    plot,
    axes,
    grid: [],
    marks,
    legend: [],
    warnings: [],
    description: describe({
      kind: "heatmap",
      measure: data.measure,
      by: `${data.xLabel} and ${data.yLabel}`,
      points: cells.length,
      series: 1,
      min: formatCompact(min, data.format, ctx),
      max: formatCompact(max, data.format, ctx),
      ...(peak ? { peak: `${xCats[peak.xi]!.label} · ${yCats[peak.yi]!.label} (${formatCompact(peak.v, data.format, ctx)})` } : {}),
    }),
  };
}
