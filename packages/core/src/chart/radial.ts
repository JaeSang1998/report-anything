import type { PieArcDatum } from "d3-shape";
import type { ChartSpec, Scalar } from "../spec.js";
import type { FormatContext } from "../data/types.js";
import type { Prepared } from "./prepare.js";
import type { Scene, SceneOptions } from "./axes.js";
import type { ColorRef, LegendItem, Mark } from "./types.js";
import { arc, pie } from "d3-shape";
import { formatCompact, formatValue } from "../data/format.js";
import { LEGEND_BAND, PAD } from "./axes.js";
import { OTHER_LABEL } from "./prepare.js";
import { describe, fitText } from "./text.js";
import { uiStrings } from "../i18n.js";

/** Slices below this share of the total are merged into 'Other' (when there are at least two of them). */
const SMALL_SHARE = 0.02;
const DONUT_HOLE = 0.6;
/** Share labels are printed only on slices at least this large. */
const LABEL_SHARE = 0.05;

interface Slice {
  key: string;
  value: Scalar;
  label: string;
  v: number;
  color: ColorRef;
}

/** Shift absolute SVG path coordinates (M/L/C/Q pairs, A end points) by (dx, dy). d3 arcs are centered on the origin. */
export function translatePath(d: string, dx: number, dy: number): string {
  const round = (n: number) => String(Math.round(n * 1000) / 1000);
  return d.replace(/([MLCQAZ])([^MLCQAZ]*)/g, (_, cmd: string, args: string) => {
    const nums = args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    const out = nums.map((n, i) => {
      if (cmd === "A") {
        const k = i % 7;
        return round(k === 5 ? n + dx : k === 6 ? n + dy : n);
      }
      return round(i % 2 === 0 ? n + dx : n + dy);
    });
    return cmd + out.join(",");
  });
}

/** Pie / donut from the first measure: sorted descending, tiny slices merged, shares in labels. */
export function buildRadial(spec: ChartSpec, prep: Prepared, o: SceneOptions, ctx: FormatContext): Scene {
  const { width: W, height: H, fontSize: fs } = o;
  const warnings: string[] = [];
  const values = prep.series[0]?.values ?? [];
  let slices: Slice[] = [];
  let other: Slice | undefined;
  let dropped = 0;
  prep.categories.forEach((c, i) => {
    const v = values[i];
    if (v === null || v === undefined || v === 0) return;
    if (v < 0) {
      dropped++;
      return;
    }
    const s = { key: c.key, value: c.value, label: c.label, v, color: 0 as ColorRef };
    if (c.pos === null && c.label === OTHER_LABEL) other = s;
    else slices.push(s);
  });
  if (dropped > 0) warnings.push(`${dropped} negative value(s) cannot be shown as pie slices and were omitted.`);
  const total = slices.reduce((a, s) => a + s.v, 0) + (other?.v ?? 0);
  slices.sort((a, b) => b.v - a.v);
  const small = slices.filter((s) => s.v / total < SMALL_SHARE);
  if (small.length >= 2) {
    const merged = small.reduce((a, s) => a + s.v, 0) + (other?.v ?? 0);
    other = { key: other?.key ?? "\u0000other", value: OTHER_LABEL, label: OTHER_LABEL, v: merged, color: "muted" };
    slices = slices.slice(0, slices.length - small.length);
  }
  slices.forEach((s, i) => (s.color = i));
  if (other) slices.push({ ...other, color: "muted" });

  const legend: LegendItem[] = spec.legend === false ? [] : slices.map((s) => ({ key: s.key, label: s.label, color: s.color, shape: "square" }));
  const top = (o.legendBand && legend.length > 0 ? LEGEND_BAND : 0) + PAD;
  const plot = { x: PAD, y: top, width: Math.max(1, W - 2 * PAD), height: Math.max(1, H - top - PAD) };
  const R = Math.max(1, Math.min(plot.width, plot.height) / 2);
  const cx = plot.x + plot.width / 2;
  const cy = plot.y + plot.height / 2;
  const donut = spec.kind === "donut";
  const inner = donut ? R * DONUT_HOLE : 0;
  const arcs = pie<Slice>()
    .value((s) => s.v)
    .sort(null)(slices);
  const arcGen = arc<PieArcDatum<Slice>>().innerRadius(inner).outerRadius(R);

  const marks: Mark[] = [];
  const labels: Mark[] = [];
  for (const a of arcs) {
    const s = a.data;
    const share = s.v / total;
    const [mx, my] = arcGen.centroid(a);
    const centroid: [number, number] = [cx + mx, cy + my];
    marks.push({
      type: "arc",
      key: `slice:${s.key}`,
      series: s.key,
      d: translatePath(arcGen(a) ?? "", cx, cy),
      fill: s.color,
      centroid,
      datum: { x: s.value, y: s.v, label: `${s.label}: ${formatValue(s.v, prep.yFormat, ctx)} (${formatValue(share, "percent:1", ctx)})` },
    });
    // Shares are the point of a pie: print them unless explicitly disabled (hover-only meaning is not enough).
    if (spec.labels !== false && share >= LABEL_SHARE) {
      labels.push({ type: "text", key: `label:${s.key}`, x: centroid[0], y: centroid[1], text: formatValue(share, "percent:0", ctx), anchor: "middle", baseline: "middle", role: "value-label", fill: "surface" });
    }
  }
  marks.push(...labels);
  if (donut) {
    const room = inner * 1.6;
    marks.push(
      { type: "text", key: "center-label", x: cx, y: cy - fs * 0.4, text: fitText(uiStrings(ctx.locale).total, room, fs), anchor: "middle", baseline: "auto", role: "center-label", fill: "muted" },
      { type: "text", key: "center-value", x: cx, y: cy + fs * 0.4, text: formatCompact(total, prep.yFormat, ctx), anchor: "middle", baseline: "hanging", role: "center-value", fill: "fg" },
    );
  }
  const top1 = slices[0];
  return {
    plot,
    axes: [],
    grid: [],
    marks,
    legend,
    warnings,
    description: describe({
      kind: spec.kind,
      measure: prep.measure,
      by: prep.xLabel,
      points: slices.length,
      series: 1,
      ...(top1 ? { peak: `${top1.label} (${formatValue(top1.v / total, "percent:1", ctx)} of ${formatCompact(total, prep.yFormat, ctx)})` } : {}),
    }),
  };
}
