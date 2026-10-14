import type { ChartSpec, Scalar } from "../spec.js";
import type { FormatContext } from "../data/types.js";
import type { Category, Prepared } from "./prepare.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { Axis, ColorRef, GridLine, LegendItem, Mark } from "./types.js";
import { scaleBand } from "d3-scale";
import { formatCompact, formatDelta, formatValue } from "../data/format.js";
import { compareScalars } from "../data/values.js";
import { uiStrings } from "../i18n.js";
import { LEGEND_BAND, PAD, TICK_GAP, maxTextWidth, niceScale, planBottomLabels, ticksOf, toTicks, valueExtent, verticalTickCount } from "./axes.js";
import { MAX_LABEL_CHARS, describe, fitText, truncate } from "./text.js";
import { estimateTextWidth } from "../text.js";

/** Funnel rows never grow taller than this; extra height becomes vertical centering. */
const MAX_FUNNEL_ROW = 56;

function sign(v: number): string {
  return v > 0 ? "+" : v < 0 ? "−" : "";
}

/** Share as a percent; small shares keep one decimal so 0.4% does not read as 0%. */
function percent(ratio: number, ctx: FormatContext): string {
  return formatValue(ratio, Math.abs(ratio) < 0.1 ? "percent:1" : "percent:0", ctx);
}

interface Step {
  key: string;
  label: string;
  x: Scalar;
  /** Row value: the signed change for deltas, the level for start/total bars. */
  v: number;
  lo: number;
  hi: number;
  /** Running level after this bar. */
  end: number;
  total: boolean;
}

/** Waterfall: start / total bars from the baseline, signed changes floating between running levels. */
export function buildWaterfall(spec: ChartSpec, prep: Prepared, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const s = prep.series[0]!;
  const fmt = prep.yFormat;
  const first = spec.base === "first";
  const steps: Step[] = [];
  let running = 0;
  prep.categories.forEach((cat, i) => {
    const v = s.values[i];
    if (v === null || v === undefined) return;
    const start = first && steps.length === 0;
    const from = start ? 0 : running;
    running = start ? v : running + v;
    steps.push({ key: cat.key, label: cat.label, x: cat.value, v, lo: Math.min(from, running), hi: Math.max(from, running), end: running, total: start });
  });
  const total = spec.total ?? first;
  if (total !== false) {
    const label = typeof total === "string" ? total : uiStrings(ctx.locale).total;
    steps.push({ key: "\u0000total", label, x: label, v: running, lo: Math.min(0, running), hi: Math.max(0, running), end: running, total: true });
  }
  const n = steps.length;

  const labels = spec.labels !== false;
  const top = PAD + (labels ? fs + 4 : 0);
  const titleBand = fs + 6;
  const count = verticalTickCount(H - top - (fs + TICK_GAP + 2 + (spec.xLabel ? titleBand : 0) + PAD));
  const [lo, hi] = valueExtent(
    steps.flatMap((st) => [st.lo, st.hi]),
    true,
  );
  const ys = niceScale(lo, hi, count);
  const yTicks = ticksOf(ys, count, fmt, ctx);
  let left = PAD + (spec.yLabel ? titleBand : 0) + maxTextWidth(
    yTicks.map((t) => t.label),
    fs,
  ) + TICK_GAP;
  let right = PAD + 4;
  const plan = planBottomLabels(
    steps.map((st) => st.label),
    Math.max(1, W - left - right) / n,
    false,
    fs,
    H * 0.35,
  );
  const inset = Math.max(1, W - left - right) / n / 2;
  left = Math.max(left, PAD + plan.overhangLeft - inset);
  right = Math.max(right, PAD + plan.overhangRight - inset);
  const plotW = Math.max(1, W - left - right);
  const plotH = Math.max(1, H - top - plan.height - (spec.xLabel ? titleBand : 0) - PAD);
  const plot = { x: left, y: top, width: plotW, height: plotH };
  ys.range([top + plotH, top]);
  const band = scaleBand<number>()
    .domain(steps.map((_, i) => i))
    .range([left, left + plotW])
    .paddingInner(0.25)
    .paddingOuter(0.1);
  const bw = band.bandwidth();

  const axes: Axis[] = [
    {
      position: "bottom",
      ticks: toTicks(
        plan,
        steps.map((st) => st.x),
        steps.map((_, i) => (band(i) ?? 0) + bw / 2),
      ),
      line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
      ...(plan.angle !== undefined ? { labelAngle: plan.angle } : {}),
      ...(spec.xLabel ? { title: spec.xLabel } : {}),
    },
    {
      position: "left",
      ticks: yTicks.map((t) => ({ value: t.value, label: t.label, offset: ys(t.value) })),
      line: { x1: left, y1: top, x2: left, y2: top + plotH },
      ...(spec.yLabel ? { title: spec.yLabel } : {}),
    },
  ];
  const grid: GridLine[] = yTicks.map((t) => ({ x1: left, y1: ys(t.value), x2: left + plotW, y2: ys(t.value) }));

  const connectors: Mark[] = [];
  const bars: Mark[] = [];
  const texts: Mark[] = [];
  steps.forEach((st, i) => {
    const x = band(i) ?? 0;
    const yTop = ys(st.hi);
    const yBottom = ys(st.lo);
    const fill: ColorRef = st.total ? 0 : st.v >= 0 ? "positive" : "negative";
    const full = (v: number) => formatValue(v, fmt, ctx);
    const datum = st.total ? `${st.label}: ${full(st.v)}` : `${st.label}: ${sign(st.v)}${full(Math.abs(st.v))} (running total ${full(st.end)})`;
    bars.push({ type: "rect", key: `bar:${st.key}`, series: s.key, x, y: yTop, width: bw, height: Math.max(1, yBottom - yTop), fill, rx: 2, datum: { x: st.x, y: st.v, series: s.key, label: datum } });
    const next = steps[i + 1];
    if (next) {
      const y = ys(st.end);
      connectors.push({ type: "line", key: `link:${st.key}`, x1: x + bw, y1: y, x2: band(i + 1) ?? x + bw, y2: y, role: "reference", stroke: "muted", dash: false });
    }
    if (!labels) return;
    // Changes are signed; levels (start/total) only carry a minus when below zero.
    const text = `${st.total ? (st.v < 0 ? "−" : "") : sign(st.v)}${formatCompact(Math.abs(st.v), fmt, ctx)}`;
    if (estimateTextWidth(text, fs) > band.step() - 2) return;
    const key = `label:${st.key}`;
    const cx = x + bw / 2;
    if (st.v >= 0) texts.push({ type: "text", key, x: cx, y: yTop - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
    else if (yBottom + fs + 6 <= top + plotH) texts.push({ type: "text", key, x: cx, y: yBottom + 4, text, anchor: "middle", baseline: "hanging", role: "value-label", fill: "fg" });
    else if (yBottom - yTop >= fs + 6) texts.push({ type: "text", key, x: cx, y: yBottom - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "surface" });
    else texts.push({ type: "text", key, x: cx, y: yTop - 4, text, anchor: "middle", baseline: "auto", role: "value-label", fill: "fg" });
  });

  const startLevel = first ? steps[0]!.v : 0;
  const change = running - startLevel;
  const summary = describe({ kind: "waterfall", measure: prep.measure, by: prep.xLabel, points: n, series: 1 });
  const net = first
    ? ` Starts at ${formatValue(startLevel, fmt, ctx)} and ends at ${formatValue(running, fmt, ctx)}${startLevel !== 0 ? ` (${formatDelta(change / Math.abs(startLevel), ctx)})` : ""}.`
    : ` Net change: ${sign(change)}${formatValue(Math.abs(change), fmt, ctx)}.`;
  return { plot, axes, grid, marks: [...connectors, ...bars, ...texts], legend: [], warnings: [], description: summary + net };
}

/** Funnel: one centered horizontal bar per stage in data order, widths proportional to the value. */
export function buildFunnel(spec: ChartSpec, prep: Prepared, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const s = prep.series[0]!;
  const fmt = prep.yFormat;
  const warnings: string[] = [];
  const stages = prep.categories.flatMap((cat, i) => {
    const v = s.values[i];
    return v === null || v === undefined ? [] : [{ cat, v }];
  });
  if (stages.some((st) => st.v < 0)) warnings.push("Funnel stages with negative values are drawn as empty bars.");
  const n = stages.length;
  const max = Math.max(...stages.map((st) => st.v), 0);
  const ofPrevious = stages.map((st, i) => {
    const prev = stages[i - 1]?.v;
    return prev === undefined || prev <= 0 ? undefined : st.v / prev;
  });
  const notes = ofPrevious.map((r) => (r === undefined ? "" : `${percent(r, ctx)} of previous`));

  const labels = stages.map((st) => fitText(truncate(st.cat.label, MAX_LABEL_CHARS + 8), W * 0.3, fs));
  const left = PAD + maxTextWidth(labels, fs) + TICK_GAP;
  const noteW = maxTextWidth(notes, fs);
  const right = PAD + (noteW > 0 ? noteW + TICK_GAP : 0);
  const plotW = Math.max(1, W - left - right);
  const avail = Math.max(1, H - 2 * PAD);
  const plotH = Math.min(avail, n * MAX_FUNNEL_ROW);
  const top = PAD + (avail - plotH) / 2;
  const plot = { x: left, y: top, width: plotW, height: plotH };
  const band = scaleBand<number>()
    .domain(stages.map((_, i) => i))
    .range([top, top + plotH])
    .paddingInner(0.15);
  const bh = band.bandwidth();
  const cx = left + plotW / 2;
  const geometry = stages.map((st, i) => {
    const w = max > 0 ? (plotW * Math.max(0, st.v)) / max : 0;
    return { x: cx - w / 2, y: band(i) ?? top, w };
  });

  const necks: Mark[] = [];
  const bars: Mark[] = [];
  const texts: Mark[] = [];
  const firstV = stages[0]!.v;
  stages.forEach((st, i) => {
    const g = geometry[i]!;
    const key = st.cat.key;
    const value = formatValue(st.v, fmt, ctx);
    const prev = ofPrevious[i];
    const ratios = i === 0 ? [] : [prev !== undefined ? `${percent(prev, ctx)} of previous` : "", firstV > 0 ? `${percent(st.v / firstV, ctx)} of first` : ""].filter(Boolean);
    bars.push({ type: "rect", key: `bar:${key}`, series: s.key, x: g.x, y: g.y, width: g.w, height: bh, fill: 0, rx: 2, datum: { x: st.cat.value, y: st.v, series: s.key, label: `${st.cat.label}: ${value}${ratios.length > 0 ? ` (${ratios.join(", ")})` : ""}` } });
    const next = geometry[i + 1];
    if (next) {
      const d = `M${g.x},${g.y + bh}L${g.x + g.w},${g.y + bh}L${next.x + next.w},${next.y}L${next.x},${next.y}Z`;
      necks.push({ type: "path", key: `neck:${key}`, series: s.key, d, variant: "area", fill: 0, opacity: 0.12 });
    }
    const cy = g.y + bh / 2;
    texts.push({ type: "text", key: `stage:${key}`, x: left - TICK_GAP, y: cy, text: labels[i] ?? "", anchor: "end", baseline: "middle", role: "annotation", fill: "fg" });
    if (spec.labels !== false) {
      const text = formatCompact(st.v, fmt, ctx);
      const inside = g.w >= estimateTextWidth(text, fs) + 8 && bh >= fs + 2;
      texts.push(
        inside
          ? { type: "text", key: `label:${key}`, x: cx, y: cy, text, anchor: "middle", baseline: "middle", role: "value-label", fill: "surface" }
          : { type: "text", key: `label:${key}`, x: g.x + g.w + 4, y: cy, text, anchor: "start", baseline: "middle", role: "value-label", fill: "fg" },
      );
    }
    const note = notes[i];
    if (note) texts.push({ type: "text", key: `note:${key}`, x: W - PAD, y: cy, text: note, anchor: "end", baseline: "middle", role: "annotation", fill: "muted" });
  });

  const last = stages[n - 1]!;
  const summary = describe({ kind: "funnel", measure: prep.measure, by: prep.xLabel, points: n, series: 1 });
  const conversion = n > 1 && firstV > 0 ? ` Overall conversion from ${stages[0]!.cat.label} to ${last.cat.label}: ${percent(last.v / firstV, ctx)}.` : "";
  return { plot, axes: [], grid: [], marks: [...necks, ...bars, ...texts], legend: [], warnings, description: summary + conversion };
}

interface Pair {
  cat: Category;
  from: number | null;
  to: number | null;
}

/** Dumbbell: one row per category with a from (muted) and to (palette 0) dot joined by a line. */
export function buildDumbbell(spec: ChartSpec, prep: Prepared, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const [fromS, toS] = [prep.series[0]!, prep.series[1]!];
  const fmt = prep.yFormat;
  let rows: Pair[] = prep.categories.flatMap((cat, i) => {
    const from = fromS.values[i] ?? null;
    const to = toS.values[i] ?? null;
    return from === null && to === null ? [] : [{ cat, from, to }];
  });
  const byTo = (a: Pair, b: Pair) => (a.to ?? -Infinity) - (b.to ?? -Infinity);
  const byX = (a: Pair, b: Pair) => (a.cat.pos !== null && b.cat.pos !== null ? a.cat.pos - b.cat.pos : compareScalars(a.cat.value, b.cat.value));
  const sort = spec.sort ?? "-y";
  if (sort === "y") rows.sort(byTo);
  else if (sort === "-y") rows.sort((a, b) => byTo(b, a));
  else if (sort === "x") rows.sort(byX);
  else if (sort === "-x") rows.sort((a, b) => byX(b, a));
  if (spec.limit !== undefined && spec.limit < rows.length) {
    const kept = new Set([...rows].sort((a, b) => byTo(b, a)).slice(0, spec.limit));
    rows = rows.filter((r) => kept.has(r));
  }
  const n = rows.length;

  const changeOf = (r: Pair): string => {
    if (r.from === null || r.to === null) return "";
    const diff = r.to - r.from;
    if (r.from > 0 && !fmt?.startsWith("percent")) return formatDelta(diff / r.from, ctx, Math.abs(diff / r.from) < 0.1 ? "percent:1" : "percent:0");
    return `${sign(diff)}${formatCompact(Math.abs(diff), fmt, ctx)}`;
  };
  const changes = rows.map(changeOf);

  const legend: LegendItem[] =
    spec.legend === false
      ? []
      : [
          { key: fromS.key, label: fromS.label, color: "muted", shape: "circle" },
          { key: toS.key, label: toS.label, color: 0, shape: "circle" },
        ];
  const top = (o.legendBand && legend.length > 0 ? LEGEND_BAND : 0) + PAD;
  const titleBand = fs + 6;
  const catLabels = rows.map((row) => fitText(truncate(row.cat.label, MAX_LABEL_CHARS + 8), W * 0.35, fs));
  const left = PAD + (spec.xLabel ? titleBand : 0) + maxTextWidth(catLabels, fs) + TICK_GAP;
  const changeW = maxTextWidth(changes, fs);
  const values = rows.flatMap((r) => [r.from, r.to].filter((v): v is number => v !== null));
  const [lo, hi] = valueExtent(values, false);
  let count = 5;
  let ticks = ticksOf(niceScale(lo, hi, count), count, fmt, ctx);
  const right = PAD + Math.max(maxTextWidth(ticks.slice(-1).map((t) => t.label), fs) / 2, changeW > 0 ? changeW + 2 * TICK_GAP : 4);
  const plotW = Math.max(1, W - left - right);
  count = Math.max(2, Math.min(6, Math.floor(plotW / (maxTextWidth(ticks.map((t) => t.label), fs) + 24))));
  const xs = niceScale(lo, hi, count).range([left, left + plotW]);
  ticks = ticksOf(xs, count, fmt, ctx);
  const bottom = fs + TICK_GAP + 2 + (spec.yLabel ? titleBand : 0) + PAD;
  const plotH = Math.max(1, H - top - bottom);
  const plot = { x: left, y: top, width: plotW, height: plotH };
  const band = scaleBand<number>()
    .domain(rows.map((_, i) => i))
    .range([top, top + plotH])
    .paddingInner(0.1)
    .paddingOuter(0.1);
  const r = Math.max(2, Math.min(6, band.bandwidth() * 0.35));

  const axes: Axis[] = [
    {
      position: "left",
      ticks: rows.map((row, i) => ({ value: row.cat.value, label: catLabels[i] ?? "", offset: (band(i) ?? 0) + band.bandwidth() / 2 })),
      line: { x1: left, y1: top, x2: left, y2: top + plotH },
      ...(spec.xLabel ? { title: spec.xLabel } : {}),
    },
    {
      position: "bottom",
      ticks: ticks.map((t) => ({ value: t.value, label: t.label, offset: xs(t.value) })),
      line: { x1: left, y1: top + plotH, x2: left + plotW, y2: top + plotH },
      ...(spec.yLabel ? { title: spec.yLabel } : {}),
    },
  ];
  const grid: GridLine[] = ticks.map((t) => ({ x1: xs(t.value), y1: top, x2: xs(t.value), y2: top + plotH }));

  const links: Mark[] = [];
  const dots: Mark[] = [];
  const texts: Mark[] = [];
  rows.forEach((row, i) => {
    const cy = (band(i) ?? 0) + band.bandwidth() / 2;
    const key = row.cat.key;
    const change = changes[i] ?? "";
    const label = `${row.cat.label}: ${formatValue(row.from, fmt, ctx)} → ${formatValue(row.to, fmt, ctx)}${change ? ` (${change})` : ""}`;
    if (row.from !== null && row.to !== null) {
      links.push({ type: "line", key: `link:${key}`, x1: xs(row.from), y1: cy, x2: xs(row.to), y2: cy, role: "reference", stroke: "muted", dash: false });
    }
    for (const [s, v, fill] of [
      [fromS, row.from, "muted"],
      [toS, row.to, 0],
    ] as const) {
      if (v === null) continue;
      dots.push({ type: "circle", key: `point:${s.key}:${key}`, series: s.key, cx: xs(v), cy, r, fill, datum: { x: row.cat.value, y: v, series: s.key, label } });
    }
    if (change && spec.labels !== false) {
      const diff = row.to! - row.from!;
      texts.push({ type: "text", key: `label:${key}`, x: W - PAD, y: cy, text: change, anchor: "end", baseline: "middle", role: "value-label", fill: diff > 0 ? "positive" : diff < 0 ? "negative" : "muted" });
    }
  });

  const paired = rows.filter((row) => row.from !== null && row.to !== null);
  const rose = paired.filter((row) => row.to! > row.from!).length;
  let biggest: Pair | undefined;
  for (const row of paired) if (!biggest || Math.abs(row.to! - row.from!) > Math.abs(biggest.to! - biggest.from!)) biggest = row;
  const summary = describe({ kind: "dumbbell", measure: `${fromS.label} vs ${toS.label}`, by: prep.xLabel, points: n, series: 1 });
  const detail = biggest ? ` ${rose} of ${paired.length} rose; largest change: ${biggest.cat.label} (${changeOf(biggest)}).` : "";
  return { plot, axes, grid, marks: [...links, ...dots, ...texts], legend, warnings: [], description: summary + detail };
}
