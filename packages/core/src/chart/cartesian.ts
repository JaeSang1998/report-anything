import type { ScaleLinear } from "d3-scale";
import type { ChartSpec } from "../spec.js";
import type { FormatContext } from "../data/types.js";
import type { Category, Prepared, SeriesData } from "./prepare.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { Axis, GridLine, LegendItem, Mark, Tick } from "./types.js";
import { scaleBand, scaleLinear } from "d3-scale";
import { area, curveLinear, curveMonotoneX, curveStep, line } from "d3-shape";
import { formatCompact, formatValue } from "../data/format.js";
import { LEGEND_BAND, PAD, TICK_GAP, maxTextWidth, niceScale, planBottomLabels, ticksOf, toTicks, valueExtent, verticalTickCount } from "./axes.js";
import { MAX_LABEL_CHARS, describe, fitText, truncate } from "./text.js";
import { estimateTextWidth } from "../text.js";

/** Lines get point markers up to this many points per series. */
const MAX_MARKED_POINTS = 24;

const CURVES = { linear: curveLinear, monotone: curveMonotoneX, step: curveStep } as const;

interface Span {
  lo: number;
  hi: number;
  /** Raw (un-normalized) value. */
  v: number;
}

/** Per-series value spans; stacked series pile positives up and negatives down, percent divides by Σ|v|. */
function computeSpans(series: readonly SeriesData[], n: number, stack: ChartSpec["stack"], zeroFill: boolean): (Span | null)[][] {
  if (!stack) {
    return series.map((s) => s.values.map((v) => (v === null ? null : { lo: Math.min(0, v), hi: Math.max(0, v), v })));
  }
  const spans = series.map(() => new Array<Span | null>(n).fill(null));
  for (let i = 0; i < n; i++) {
    let denom = 1;
    if (stack === "percent") {
      denom = 0;
      for (const s of series) denom += Math.abs(s.values[i] ?? 0);
    }
    let pos = 0;
    let neg = 0;
    series.forEach((s, j) => {
      const raw = s.values[i] ?? null;
      if (raw === null && !zeroFill) return;
      const v = raw ?? 0;
      const nv = denom === 0 ? 0 : v / denom;
      if (nv >= 0) {
        spans[j]![i] = { lo: pos, hi: pos + nv, v };
        pos += nv;
      } else {
        spans[j]![i] = { lo: neg + nv, hi: neg, v };
        neg += nv;
      }
    });
  }
  return spans;
}

/** Bar, line and area charts (with optional secondary right-axis lines). */
export function buildCartesian(spec: ChartSpec, prep: Prepared, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const warnings: string[] = [];
  const kind = spec.kind;
  const isBar = kind === "bar";
  const horizontal = isBar && spec.horizontal === true;
  const stack = isBar || kind === "area" ? spec.stack : undefined;
  const percent = stack === "percent";
  const cats = prep.categories;
  const n = cats.length;
  const series = prep.series;
  const secondary = horizontal ? [] : prep.secondary;
  if (horizontal && prep.secondary.length > 0) warnings.push("Secondary axis is not supported on horizontal bars; secondary measures were omitted.");
  const axisFormat = percent ? "percent" : prep.yFormat;
  const showLegend = spec.legend ?? (series.length + secondary.length >= 2 || secondary.length > 0);
  const legendShape = isBar || kind === "area" ? "square" : "line";
  const legend: LegendItem[] = showLegend
    ? [
        ...series.map((s): LegendItem => ({ key: s.key, label: s.label, color: s.color, shape: legendShape })),
        ...secondary.map((s): LegendItem => ({ key: s.key, label: s.label, color: s.color, shape: "line" })),
      ]
    : [];

  const spans = computeSpans(series, n, stack, kind === "area");
  const extentValues: number[] = [];
  for (const row of spans) for (const sp of row) if (sp) extentValues.push(...(stack || isBar || kind === "area" ? [sp.lo, sp.hi] : [sp.v]));
  const refs = spec.reference ?? [];
  for (const r of refs) if (r.axis === "y") extentValues.push(r.value);
  const [lo, hi] = valueExtent(extentValues, isBar || kind === "area");

  const top = (o.legendBand && legend.length > 0 ? LEGEND_BAND : 0) + PAD + (spec.labels && !horizontal ? fs + 4 : 0);
  const titleBand = fs + 6;
  const catTitle = spec.xLabel;
  const valueTitle = spec.yLabel;

  const marks: Mark[] = [];
  const axes: Axis[] = [];
  const grid: GridLine[] = [];
  const labelMarks: Mark[] = [];
  const datumLabel = (cat: Category, s: SeriesData, v: number, format: string | undefined, share?: number) =>
    `${cat.label} · ${s.label}: ${formatValue(v, format, ctx)}${share !== undefined ? ` (${formatValue(share, "percent", ctx)})` : ""}`;

  if (horizontal) {
    // ── horizontal bars: categories on the left, values along the bottom ──
    const maxCatW = W * 0.4;
    const catLabels = cats.map((c) => fitText(truncate(c.label, MAX_LABEL_CHARS + 8), maxCatW, fs));
    const left = PAD + (catTitle ? titleBand : 0) + maxTextWidth(catLabels, fs) + TICK_GAP;
    const valueLabelW = spec.labels ? maxTextWidth(series.flatMap((s) => s.values.map((v) => (v === null ? "" : formatCompact(v, axisFormat, ctx)))), fs) + 6 : 0;
    let count = 5;
    let ticks = ticksOf(niceScale(lo, hi, count), count, axisFormat, ctx);
    const right0 = Math.max(PAD + maxTextWidth(ticks.slice(-1).map((t) => t.label), fs) / 2, PAD + valueLabelW);
    const plotW = Math.max(1, W - left - right0);
    count = Math.max(2, Math.min(6, Math.floor(plotW / (maxTextWidth(ticks.map((t) => t.label), fs) + 24))));
    const xs = niceScale(lo, hi, count).range([left, left + plotW]);
    ticks = ticksOf(xs, count, axisFormat, ctx);
    const bottom = fs + TICK_GAP + 2 + (valueTitle ? titleBand : 0) + PAD;
    const plotH = Math.max(1, H - top - bottom);
    const band = scaleBand<number>()
      .domain(cats.map((_, i) => i))
      .range([top, top + plotH])
      .paddingInner(0.2)
      .paddingOuter(0.1);
    const plot = { x: left, y: top, width: plotW, height: plotH };
    axes.push({
      position: "left",
      ticks: cats.map((c, i) => ({ value: c.value, label: catLabels[i] ?? "", offset: (band(i) ?? 0) + band.bandwidth() / 2 })),
      line: { x1: left, y1: top, x2: left, y2: top + plotH },
      ...(catTitle ? { title: catTitle } : {}),
    });
    axes.push({
      position: "bottom",
      ticks: ticks.map((t) => ({ value: t.value, label: t.label, offset: xs(t.value) })),
      line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
      ...(valueTitle ? { title: valueTitle } : {}),
    });
    for (const t of ticks) grid.push({ x1: xs(t.value), y1: top, x2: xs(t.value), y2: top + plotH });
    const groups = stack ? 1 : Math.max(1, series.length);
    const inner = band.bandwidth() / groups;
    const gap = groups > 1 ? Math.min(2, inner * 0.1) : 0;
    series.forEach((s, j) => {
      cats.forEach((cat, i) => {
        const sp = spans[j]![i];
        if (!sp) return;
        const y = (band(i) ?? 0) + (stack ? 0 : j * inner) + gap / 2;
        const h = Math.max(0, (stack ? band.bandwidth() : inner) - gap);
        const x0 = xs(sp.lo);
        const x1 = xs(sp.hi);
        const share = percent ? sp.hi - sp.lo : undefined;
        marks.push({
          type: "rect",
          key: `bar:${s.key}:${cat.key}`,
          series: s.key,
          x: x0,
          y,
          width: Math.max(0, x1 - x0),
          height: h,
          fill: s.color,
          rx: 2,
          datum: { x: cat.value, y: sp.v, series: s.key, label: datumLabel(cat, s, sp.v, prep.yFormat, share) },
        });
        if (!spec.labels) return;
        const text = formatCompact(percent ? (share ?? 0) : sp.v, axisFormat, ctx);
        const tw = estimateTextWidth(text, fs);
        const negative = sp.v < 0;
        const base = { type: "text" as const, key: `label:${s.key}:${cat.key}`, y: y + h / 2, text, baseline: "middle" as const, role: "value-label" as const };
        if (x1 - x0 >= tw + 8) {
          if (stack) labelMarks.push({ ...base, x: (x0 + x1) / 2, anchor: "middle", fill: "surface" });
          else labelMarks.push({ ...base, x: negative ? x0 + 4 : x1 - 4, anchor: negative ? "start" : "end", fill: "surface" });
        } else if (!stack) {
          labelMarks.push({ ...base, x: negative ? Math.max(2, x0 - 4) : Math.min(W - 2, x1 + 4), anchor: negative ? "end" : "start", fill: "fg" });
        }
      });
    });
    for (const [k, r] of refs.entries()) {
      if (r.axis !== "y") {
        warnings.push("x reference lines need a numeric or time x axis; ignored on horizontal bars.");
        continue;
      }
      const x = xs(r.value);
      marks.push({ type: "line", key: `ref:${k}`, x1: x, y1: top, x2: x, y2: top + plotH, role: "reference", stroke: "muted", dash: true, ...(r.label ? { label: r.label } : {}) });
    }
    marks.push(...labelMarks);
    return { plot, axes, grid, marks, legend, warnings, description: summarize(spec, prep, ctx) };
  }

  // ── vertical: categories / time along the bottom, values left (+ secondary right) ──
  const bottomEstimate = fs + TICK_GAP + 2 + (catTitle ? titleBand : 0) + PAD;
  const count = verticalTickCount(H - top - bottomEstimate);
  const ys = niceScale(lo, hi, count);
  const yTicks = ticksOf(ys, count, axisFormat, ctx);
  let left = PAD + (valueTitle ? titleBand : 0) + maxTextWidth(yTicks.map((t) => t.label), fs) + TICK_GAP;
  let ys2: ScaleLinear<number, number> | undefined;
  let y2Ticks: Array<{ value: number; label: string }> = [];
  let right = PAD + 4;
  if (secondary.length > 0) {
    const vals = secondary.flatMap((s) => s.values.filter((v): v is number => v !== null));
    const [lo2, hi2] = valueExtent(vals, false);
    ys2 = niceScale(lo2, hi2, count);
    y2Ticks = ticksOf(ys2, count, prep.secondaryFormat, ctx);
    right = PAD + (spec.secondary?.label ? titleBand : 0) + maxTextWidth(y2Ticks.map((t) => t.label), fs) + TICK_GAP;
  }

  const continuous = !isBar && prep.xType !== "category" && n >= 2;
  const positions = cats.map((c) => c.pos ?? 0);
  const minPos = Math.min(...positions);
  const maxPos = Math.max(...positions);
  const stepFor = (plotW: number) => (continuous ? plotW / Math.max(1, n - 1) : plotW / Math.max(1, n));
  const numericTicks = continuous && prep.xType === "number";
  let plotW = Math.max(1, W - left - right);
  const xFormat = spec.xFormat;
  let plan = planBottomLabels(
    cats.map((c) => c.label),
    stepFor(plotW),
    prep.xType !== "category",
    fs,
    H * 0.35,
  );
  if (numericTicks) {
    const sample = scaleLinear().domain([minPos, maxPos]).nice().ticks(6).map((v) => formatValue(v, xFormat, ctx));
    const xCount = Math.max(2, Math.min(8, Math.floor(plotW / (maxTextWidth(sample, fs) + 20))));
    const labels = scaleLinear().domain([minPos, maxPos]).ticks(xCount).map((v) => formatValue(v, xFormat, ctx));
    plan = { labels, shown: labels.map((_, i) => i), height: fs + TICK_GAP + 2, overhangLeft: estimateTextWidth(labels[0] ?? "", fs) / 2, overhangRight: estimateTextWidth(labels[labels.length - 1] ?? "", fs) / 2 };
  }
  const anchorInset = continuous ? 0 : stepFor(plotW) / 2;
  left = Math.max(left, PAD + plan.overhangLeft - anchorInset);
  right = Math.max(right, PAD + plan.overhangRight - anchorInset);
  plotW = Math.max(1, W - left - right);
  const bottom = plan.height + (catTitle ? titleBand : 0) + PAD;
  const plotH = Math.max(1, H - top - bottom);
  const plot = { x: left, y: top, width: plotW, height: plotH };
  ys.range([top + plotH, top]);
  ys2?.range([top + plotH, top]);

  const band = scaleBand<number>()
    .domain(cats.map((_, i) => i))
    .range([left, left + plotW])
    .paddingInner(isBar ? 0.2 : 0)
    .paddingOuter(isBar ? 0.1 : 0);
  const xScale = scaleLinear().domain(minPos === maxPos ? [minPos - 1, maxPos + 1] : [minPos, maxPos]).range([left, left + plotW]);
  const xOf = (i: number) => (continuous ? xScale(positions[i]!) : (band(i) ?? 0) + band.bandwidth() / 2);

  let bottomTicks: Tick[];
  if (numericTicks) {
    bottomTicks = xScale.ticks(plan.labels.length).map((v) => ({ value: v, label: formatValue(v, xFormat, ctx), offset: xScale(v) }));
  } else {
    bottomTicks = toTicks(
      plan,
      cats.map((c) => c.value),
      cats.map((_, i) => xOf(i)),
    );
  }
  axes.push({
    position: "bottom",
    ticks: bottomTicks,
    line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
    ...(plan.angle !== undefined ? { labelAngle: plan.angle } : {}),
    ...(catTitle ? { title: catTitle } : {}),
  });
  axes.push({
    position: "left",
    ticks: yTicks.map((t) => ({ value: t.value, label: t.label, offset: ys(t.value) })),
    line: { x1: left, y1: top, x2: left, y2: top + plotH },
    ...(valueTitle ? { title: valueTitle } : {}),
  });
  if (ys2) {
    axes.push({
      position: "right",
      ticks: y2Ticks.map((t) => ({ value: t.value, label: t.label, offset: ys2(t.value) })),
      line: { x1: left + plotW, y1: top, x2: left + plotW, y2: top + plotH },
      ...(spec.secondary?.label ? { title: spec.secondary.label } : {}),
    });
  }
  for (const t of yTicks) grid.push({ x1: left, y1: ys(t.value), x2: left + plotW, y2: ys(t.value) });

  const curve = CURVES[spec.curve ?? "monotone"];
  const lineGen = line<[number, number] | null>()
    .defined((p) => p !== null)
    .x((p) => p![0])
    .y((p) => p![1])
    .curve(curve);
  const zeroY = ys(Math.max(ys.domain()[0]!, Math.min(ys.domain()[1]!, 0)));
  const lineMarks: Mark[] = [];
  const pointMarks: Mark[] = [];

  /** Line path + point markers + value labels for one series on a given scale. */
  const drawLine = (s: SeriesData, yScale: ScaleLinear<number, number>, values: readonly (number | null)[], format: string | undefined, raw: readonly (number | null)[]) => {
    const pts = values.map((v, i): [number, number] | null => (v === null ? null : [xOf(i), yScale(v)]));
    const d = lineGen(pts);
    if (d) lineMarks.push({ type: "path", key: `line:${s.key}`, series: s.key, d, variant: "line", stroke: s.color });
    const count = pts.filter((p) => p !== null).length;
    if (count > MAX_MARKED_POINTS) return;
    pts.forEach((p, i) => {
      const v = raw[i];
      const cat = cats[i]!;
      if (!p || v === null || v === undefined) return;
      pointMarks.push({
        type: "circle",
        key: `point:${s.key}:${cat.key}`,
        series: s.key,
        cx: p[0],
        cy: p[1],
        r: 3,
        fill: s.color,
        datum: { x: cat.value, y: v, series: s.key, label: datumLabel(cat, s, v, format) },
      });
      if (spec.labels) {
        labelMarks.push({ type: "text", key: `label:${s.key}:${cat.key}`, x: p[0], y: Math.max(fs, p[1] - 6), text: formatCompact(v, format, ctx), anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
      }
    });
  };

  if (isBar) {
    const groups = stack ? 1 : Math.max(1, series.length);
    const inner = band.bandwidth() / groups;
    const gap = groups > 1 ? Math.min(2, inner * 0.1) : 0;
    series.forEach((s, j) => {
      cats.forEach((cat, i) => {
        const sp = spans[j]![i];
        if (!sp) return;
        const x = (band(i) ?? 0) + (stack ? 0 : j * inner) + gap / 2;
        const w = Math.max(0, (stack ? band.bandwidth() : inner) - gap);
        const yTop = ys(sp.hi);
        const yBottom = ys(sp.lo);
        const share = percent ? sp.hi - sp.lo : undefined;
        marks.push({
          type: "rect",
          key: `bar:${s.key}:${cat.key}`,
          series: s.key,
          x,
          y: yTop,
          width: w,
          height: Math.max(0, yBottom - yTop),
          fill: s.color,
          rx: 2,
          datum: { x: cat.value, y: sp.v, series: s.key, label: datumLabel(cat, s, sp.v, prep.yFormat, share) },
        });
        if (!spec.labels || w < fs) return;
        const text = formatCompact(percent ? (share ?? 0) : sp.v, axisFormat, ctx);
        const key = `label:${s.key}:${cat.key}`;
        if (stack) {
          if (yBottom - yTop >= fs + 2 && w >= estimateTextWidth(text, fs) + 4) {
            labelMarks.push({ type: "text", key, x: x + w / 2, y: (yTop + yBottom) / 2, text, anchor: "middle", baseline: "middle", role: "value-label", fill: "surface" });
          }
        } else if (sp.v >= 0) {
          labelMarks.push({ type: "text", key, x: x + w / 2, y: yTop - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
        } else if (yBottom + fs + 6 <= top + plotH) {
          labelMarks.push({ type: "text", key, x: x + w / 2, y: yBottom + 4, text, anchor: "middle", baseline: "hanging", role: "value-label", fill: "fg" });
        } else if (yBottom - yTop >= fs + 6) {
          labelMarks.push({ type: "text", key, x: x + w / 2, y: yBottom - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "surface" });
        } else {
          labelMarks.push({ type: "text", key, x: x + w / 2, y: yTop - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
        }
      });
    });
  } else if (kind === "area") {
    const areaGen = area<{ x: number; y0: number; y1: number } | null>()
      .defined((p) => p !== null)
      .x((p) => p!.x)
      .y0((p) => p!.y0)
      .y1((p) => p!.y1)
      .curve(curve);
    series.forEach((s, j) => {
      const row = spans[j]!;
      const pts = row.map((sp, i) => (sp === null ? null : { x: xOf(i), y0: stack ? ys(sp.v < 0 ? sp.hi : sp.lo) : zeroY, y1: ys(stack ? (sp.v < 0 ? sp.lo : sp.hi) : sp.v) }));
      const d = areaGen(pts);
      if (d) marks.push({ type: "path", key: `area:${s.key}`, series: s.key, d, variant: "area", fill: s.color, opacity: 0.25 });
      const tops = row.map((sp) => (sp === null ? null : stack ? (sp.v < 0 ? sp.lo : sp.hi) : sp.v));
      drawLine(
        s,
        ys,
        tops,
        prep.yFormat,
        row.map((sp) => sp?.v ?? null),
      );
    });
  } else {
    for (const s of series) drawLine(s, ys, s.values, prep.yFormat, s.values);
  }
  if (ys2) for (const s of secondary) drawLine(s, ys2, s.values, prep.secondaryFormat, s.values);
  marks.push(...lineMarks, ...pointMarks);

  for (const [k, r] of refs.entries()) {
    const label = r.label ? { label: r.label } : {};
    if (r.axis === "y") {
      const y = ys(r.value);
      marks.push({ type: "line", key: `ref:${k}`, x1: left, y1: y, x2: left + plotW, y2: y, role: "reference", stroke: "muted", dash: true, ...label });
    } else if (continuous) {
      const pos = prep.xType === "date" && Math.abs(r.value) < 10_000 ? Date.UTC(r.value, 0, 1) : r.value;
      const x = Math.max(left, Math.min(left + plotW, xScale(pos)));
      marks.push({ type: "line", key: `ref:${k}`, x1: x, y1: top, x2: x, y2: top + plotH, role: "reference", stroke: "muted", dash: true, ...label });
    } else {
      warnings.push("x reference lines need a numeric or time x axis on a line/area chart; ignored.");
    }
  }
  marks.push(...labelMarks);
  return { plot, axes, grid, marks, legend, warnings, description: summarize(spec, prep, ctx) };
}

function summarize(spec: ChartSpec, prep: Prepared, ctx: FormatContext): string {
  let min = Infinity;
  let max = -Infinity;
  let peak = "";
  for (const s of prep.series) {
    s.values.forEach((v, i) => {
      if (v === null) return;
      min = Math.min(min, v);
      if (v > max) {
        max = v;
        const cat = prep.categories[i]!;
        const value = formatCompact(v, prep.yFormat, ctx);
        peak = prep.series.length > 1 ? `${cat.label} · ${s.label} (${value})` : `${cat.label} (${value})`;
      }
    });
  }
  const has = Number.isFinite(min);
  return describe({
    kind: spec.kind,
    horizontal: spec.kind === "bar" && spec.horizontal === true,
    measure: prep.measure,
    by: prep.xLabel,
    points: prep.categories.length,
    series: prep.series.length + prep.secondary.length,
    ...(has ? { min: formatCompact(min, prep.yFormat, ctx), max: formatCompact(max, prep.yFormat, ctx), peak } : {}),
  });
}
