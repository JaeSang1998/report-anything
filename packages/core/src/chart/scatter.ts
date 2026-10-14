import type { ChartSpec, Scalar } from "../spec.js";
import type { FormatContext } from "../data/types.js";
import type { ChartSource, RawCategory, XType } from "./prepare.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { ColorRef, LegendItem, Mark, Tick } from "./types.js";
import { scaleLinear, scaleSqrt, scaleUtc } from "d3-scale";
import { formatCompact, formatDate, formatValue } from "../data/format.js";
import { toNumber } from "../data/values.js";
import { LEGEND_BAND, PAD, TICK_GAP, maxTextWidth, niceScale, planBottomLabels, ticksOf, toTicks, valueExtent, verticalTickCount } from "./axes.js";
import { OTHER_LABEL, categoryOf, detectXType, inferDateUnit, labelCategories, seriesBuckets, yFields } from "./prepare.js";
import { describe } from "./text.js";
import { estimateTextWidth } from "../text.js";

const R_DEFAULT = 4;
const R_MIN = 3;
const R_MAX = 18;

interface Point {
  x: Scalar;
  /** Position: epoch ms / number, or category index. */
  px: number;
  y: number;
  size: number | null;
  series: number;
  xLabel: string;
}

export interface ScatterData {
  xType: XType;
  points: Point[];
  series: Array<{ key: string; label: string; color: ColorRef }>;
  /** Category labels when xType is "category" (point px indexes into it). */
  categories: string[];
  xLabel: string;
  measure: string;
  yFormat?: string;
  sizeLabel?: string;
  sizeFormat?: string;
}

/** Scatter never aggregates: one point per row with numeric y (one series per y field and/or `series` value). */
export function prepareScatter(spec: ChartSpec, source: ChartSource, ctx: FormatContext): ScatterData {
  const { ds } = source;
  const xInfo = source.field(spec.x);
  const xType = detectXType(ds.rows, xInfo);
  const ys = yFields(spec.y);
  const xFormat = spec.xFormat ?? xInfo.format;
  const buckets = spec.series ? seriesBuckets(ds.rows, spec.series, ys) : undefined;
  const groups = buckets ? buckets.order : [""];
  const series = groups.flatMap((g, gi) =>
    ys.map((y, j) => {
      const label = buckets ? (ys.length > 1 ? `${g} · ${source.field(y).label}` : g) : source.field(y).label;
      const color: ColorRef = g === OTHER_LABEL ? "muted" : gi * ys.length + j;
      return { key: label, label, color };
    }),
  );

  const catIndex = new Map<string, number>();
  const cats: RawCategory[] = [];
  const points: Point[] = [];
  for (const row of ds.rows) {
    const c = categoryOf(row[spec.x], xType);
    if (!c) continue;
    let px = c.pos;
    if (xType === "category") {
      let i = catIndex.get(c.key);
      if (i === undefined) {
        i = cats.length;
        catIndex.set(c.key, i);
        cats.push(c);
      }
      px = i;
    }
    const g = buckets ? groups.indexOf(buckets.bucketOf(row)) : 0;
    ys.forEach((yField, j) => {
      const y = toNumber(row[yField]);
      if (y === null || px === null) return;
      points.push({ x: c.value, px, y, size: spec.value ? toNumber(row[spec.value]) : null, series: g * ys.length + j, xLabel: "" });
    });
  }
  const labeled = labelCategories(cats, "category", xFormat, ctx);
  const unit = xType === "date" ? inferDateUnit(points.map((p) => p.px)) : "day";
  for (const p of points) {
    if (xType === "category") p.xLabel = labeled[p.px]?.label ?? String(p.x);
    else if (xType === "date") p.xLabel = xFormat ? formatValue(p.px, xFormat, ctx) : formatDate(p.px, unit, ctx.locale);
    else p.xLabel = formatValue(p.px, xFormat, ctx);
  }
  return {
    xType,
    points,
    series: series.map(({ key, label, color }) => ({ key, label, color })),
    categories: labeled.map((c) => c.label),
    xLabel: spec.xLabel ?? xInfo.label,
    measure: spec.yLabel ?? ys.map((y) => source.field(y).label).join(", "),
    yFormat: spec.yFormat ?? source.field(ys[0]!).format,
    ...(spec.value ? { sizeLabel: source.field(spec.value).label, sizeFormat: source.field(spec.value).format } : {}),
  };
}

export function buildScatter(spec: ChartSpec, data: ScatterData, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const { points, xType } = data;
  const showLegend = spec.legend ?? data.series.length >= 2;
  const legend: LegendItem[] = showLegend ? data.series.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: "circle" })) : [];
  const sizes = points.flatMap((p) => (p.size === null ? [] : [Math.max(0, p.size)]));
  const rScale = sizes.length > 0 ? scaleSqrt().domain([0, Math.max(...sizes) || 1]).range([R_MIN, R_MAX]).clamp(true) : undefined;
  const rMax = rScale ? R_MAX : R_DEFAULT;

  const refs = spec.reference ?? [];
  const [lo, hi] = valueExtent([...points.map((p) => p.y), ...refs.filter((r) => r.axis === "y").map((r) => r.value)], false);
  const top = (o.legendBand && legend.length > 0 ? LEGEND_BAND : 0) + PAD + (spec.labels ? fs + 4 : 0);
  const titleBand = fs + 6;
  const flatLabels = fs + TICK_GAP + 2;
  const bottom = flatLabels + (spec.xLabel ? titleBand : 0) + PAD;
  const count = verticalTickCount(H - top - bottom);
  const ys = niceScale(lo, hi, count);
  const yTicks = ticksOf(ys, count, data.yFormat, ctx);
  const left = PAD + (spec.yLabel ? titleBand : 0) + maxTextWidth(yTicks.map((t) => t.label), fs) + TICK_GAP;
  const pxs = points.map((p) => p.px);
  const xs0 = Math.min(...pxs);
  const xs1 = Math.max(...pxs);

  // x ticks
  let bottomTicks: Array<{ value: Scalar; label: string; pos: number }>;
  let labelAngle: number | undefined;
  let labelHeight = flatLabels;
  let plotW = Math.max(1, W - left - PAD);
  let xDomain: [number, number];
  if (xType === "category") {
    xDomain = [-0.5, data.categories.length - 0.5];
    const plan = planBottomLabels(data.categories, plotW / Math.max(1, data.categories.length), false, fs, H * 0.35);
    labelAngle = plan.angle;
    labelHeight = plan.height;
    bottomTicks = toTicks(
      plan,
      data.categories,
      data.categories.map((_, i) => i),
    ).map((t) => ({ value: t.value, label: t.label, pos: t.offset }));
  } else if (xType === "date") {
    const utc = scaleUtc().domain([new Date(xs0), new Date(xs1 === xs0 ? xs0 + 86_400_000 : xs1)]);
    const ticks = utc.ticks(Math.max(2, Math.min(8, Math.floor(plotW / 80))));
    const unit = inferDateUnit(ticks.map((d) => d.getTime()));
    xDomain = [utc.domain()[0]!.getTime(), utc.domain()[1]!.getTime()];
    bottomTicks = ticks.map((d) => ({ value: d.getTime(), label: formatDate(d.getTime(), unit, ctx.locale), pos: d.getTime() }));
  } else {
    const lin = niceScale(xs0, xs1, 6);
    const sample = lin.ticks(6).map((v) => formatValue(v, spec.xFormat, ctx));
    const xCount = Math.max(2, Math.min(8, Math.floor(plotW / (maxTextWidth(sample, fs) + 20))));
    xDomain = lin.domain() as [number, number];
    bottomTicks = lin.ticks(xCount).map((v) => ({ value: v, label: formatValue(v, spec.xFormat, ctx), pos: v }));
  }
  const right = Math.max(PAD, PAD + estimateTextWidth(bottomTicks[bottomTicks.length - 1]?.label ?? "", fs) / 2 - rMax);
  plotW = Math.max(1, W - left - right);
  const plotH = Math.max(1, H - top - (bottom - flatLabels + labelHeight));
  const plot = { x: left, y: top, width: plotW, height: plotH };
  const inset = Math.min(rMax, plotW / 4, plotH / 4);
  const xs = scaleLinear().domain(xDomain).range([left + inset, left + plotW - inset]);
  ys.range([top + plotH - inset, top + inset]);

  const xTicks: Tick[] = bottomTicks.map((t) => ({ value: t.value, label: t.label, offset: xs(t.pos) }));
  const axes: Scene["axes"] = [
    {
      position: "bottom",
      ticks: xTicks,
      line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
      ...(labelAngle !== undefined ? { labelAngle } : {}),
      ...(spec.xLabel ? { title: spec.xLabel } : {}),
    },
    {
      position: "left",
      ticks: yTicks.map((t) => ({ value: t.value, label: t.label, offset: ys(t.value) })),
      line: { x1: left, y1: top, x2: left, y2: top + plotH },
      ...(spec.yLabel ? { title: spec.yLabel } : {}),
    },
  ];
  const grid = yTicks.map((t) => ({ x1: left, y1: ys(t.value), x2: left + plotW, y2: ys(t.value) }));

  const marks: Mark[] = [];
  const labels: Mark[] = [];
  const ordered = points.map((p, i) => ({ p, i, r: rScale && p.size !== null ? rScale(Math.max(0, p.size)) : R_DEFAULT })).sort((a, b) => b.r - a.r);
  for (const { p, i, r } of ordered) {
    const s = data.series[p.series]!;
    const size = p.size !== null && data.sizeLabel ? ` · ${data.sizeLabel}: ${formatValue(p.size, data.sizeFormat, ctx)}` : "";
    marks.push({
      type: "circle",
      key: `point:${i}`,
      series: s.key,
      cx: xs(p.px),
      cy: ys(p.y),
      r: Math.min(r, Math.max(inset, 1)),
      fill: s.color,
      opacity: 0.75,
      datum: { x: p.x, y: p.y, series: s.key, label: `${p.xLabel} · ${s.label}: ${formatValue(p.y, data.yFormat, ctx)}${size}` },
    });
    if (spec.labels) {
      labels.push({ type: "text", key: `label:${i}`, x: xs(p.px), y: Math.max(fs, ys(p.y) - r - 3), text: formatCompact(p.y, data.yFormat, ctx), anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
    }
  }
  const warnings: string[] = [];
  for (const [k, r] of refs.entries()) {
    const label = r.label ? { label: r.label } : {};
    if (r.axis === "y") {
      const y = ys(r.value);
      marks.push({ type: "line", key: `ref:${k}`, x1: left, y1: y, x2: left + plotW, y2: y, role: "reference", stroke: "muted", dash: true, ...label });
    } else if (xType !== "category") {
      const pos = xType === "date" && Math.abs(r.value) < 10_000 ? Date.UTC(r.value, 0, 1) : r.value;
      const x = Math.max(left, Math.min(left + plotW, xs(pos)));
      marks.push({ type: "line", key: `ref:${k}`, x1: x, y1: top, x2: x, y2: top + plotH, role: "reference", stroke: "muted", dash: true, ...label });
    } else {
      warnings.push("x reference lines need a numeric or time x axis; ignored.");
    }
  }
  marks.push(...labels);

  const yVals = points.map((p) => p.y);
  const maxP = points.reduce((a, b) => (b.y > a.y ? b : a), points[0]!);
  return {
    plot,
    axes,
    grid,
    marks,
    legend,
    warnings,
    description: describe({
      kind: "scatter",
      measure: data.measure,
      by: data.xLabel,
      points: points.length,
      series: data.series.length,
      min: formatCompact(Math.min(...yVals), data.yFormat, ctx),
      max: formatCompact(Math.max(...yVals), data.yFormat, ctx),
      peak: `${maxP.xLabel} (${formatCompact(maxP.y, data.yFormat, ctx)})`,
    }),
  };
}
