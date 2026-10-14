import { describe, expect, it } from "vitest";
import type { ChartSpec, Row } from "../spec.js";
import type { DataContext } from "../data/types.js";
import type { ChartModel } from "./types.js";
import { buildFacetCharts } from "./facet.js";
import { METRICS } from "../layout/metrics.js";

function ctxOf(rows: Row[]): DataContext {
  const fields = Object.keys(rows[0] ?? {}).map((name) => ({ name, type: typeof rows[0]![name] === "number" ? ("number" as const) : ("string" as const), label: name }));
  return { locale: "en-US", currency: "USD", datasets: new Map([["sales", { id: "sales", rows, fields }]]) };
}

const months = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"];
/** Region totals: West > East > North > South; South misses March. */
const scale: Record<string, number> = { North: 2, South: 1, East: 3, West: 5 };
const sales: Row[] = months.flatMap((month, i) =>
  ["North", "South", "East", "West"]
    .filter((region) => !(region === "South" && i === 2))
    .flatMap((region) => ["Online", "Retail"].map((channel) => ({ month, region, channel, revenue: scale[region]! * (100 + i * 20) + (channel === "Online" ? 30 : 0), units: i + scale[region]! }))),
);
const ctx = ctxOf(sales);
const opts = { width: 760, panelHeight: METRICS.chart.facetPlot, columns: 3 };
const spec = (s: Partial<ChartSpec>): ChartSpec => ({ kind: "line", data: "sales", x: "month", y: "revenue", facet: "region", ...s });

const leftAxis = (m: ChartModel) => m.axes.find((a) => a.position === "left")!;
const bottomAxis = (m: ChartModel) => m.axes.find((a) => a.position === "bottom")!;

function expectInside(m: ChartModel) {
  const nums = (d: string) => (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  for (const k of m.marks) {
    const xs: number[] = [];
    const ys: number[] = [];
    if (k.type === "rect") xs.push(k.x, k.x + k.width), ys.push(k.y, k.y + k.height);
    else if (k.type === "circle") xs.push(k.cx - k.r, k.cx + k.r), ys.push(k.cy - k.r, k.cy + k.r);
    else if (k.type === "line") xs.push(k.x1, k.x2), ys.push(k.y1, k.y2);
    else if (k.type === "text") xs.push(k.x), ys.push(k.y);
    else nums(k.d).forEach((v, i) => (i % 2 === 0 ? xs : ys).push(v));
    for (const x of xs) expect(x, `${k.key} x`).toBeGreaterThanOrEqual(-0.01), expect(x, `${k.key} x`).toBeLessThanOrEqual(m.width + 0.01);
    for (const y of ys) expect(y, `${k.key} y`).toBeGreaterThanOrEqual(-0.01), expect(y, `${k.key} y`).toBeLessThanOrEqual(m.height + 0.01);
  }
}

describe("buildFacetCharts", () => {
  it("draws one panel per facet value, largest totals first", () => {
    const r = buildFacetCharts(spec({}), ctx, opts);
    expect(r.panels.map((p) => p.label)).toEqual(["West", "East", "North", "South"]);
    expect(r.warnings).toEqual([]);
  });

  it("shares one value domain and one plot size across panels", () => {
    const r = buildFacetCharts(spec({ kind: "bar", series: "channel", stack: true }), ctx, opts);
    const [first, ...rest] = r.panels.map((p) => p.model);
    for (const m of rest) {
      expect(m.plot.width).toBeCloseTo(first!.plot.width, 6);
      expect(m.plot.height).toBeCloseTo(first!.plot.height, 6);
      // Same y grid lines → same value-to-pixel mapping.
      expect(m.grid.map((g) => g.y1 - m.plot.y)).toEqual(first!.grid.map((g) => g.y1 - first!.plot.y));
    }
    // The smallest region's bars are visibly shorter than the largest's on the shared scale.
    const tallest = (m: ChartModel) => Math.max(...m.marks.flatMap((k) => (k.type === "rect" ? [m.plot.y + m.plot.height - k.y] : [])));
    expect(tallest(r.panels[3]!.model)).toBeLessThan(tallest(r.panels[0]!.model) / 3);
    expect(leftAxis(first!).ticks.length).toBeGreaterThan(1);
  });

  it("shares the time axis: a gap in one panel does not shift its x positions", () => {
    const r = buildFacetCharts(spec({ kind: "line", x: "month" }), ctx, opts);
    const south = r.panels.find((p) => p.label === "South")!.model;
    const west = r.panels.find((p) => p.label === "West")!.model;
    const xs = (m: ChartModel) => m.marks.flatMap((k) => (k.type === "circle" ? [k.cx - m.plot.x] : []));
    expect(xs(south)).toHaveLength(5);
    expect(xs(west)).toHaveLength(6);
    expect(xs(west)).toEqual(expect.arrayContaining(xs(south)));
  });

  it("labels the value axis on the left column and the x axis only on panels with nothing below", () => {
    // 4 panels in 3 columns: row 0 = West, East, North; row 1 = South.
    const r = buildFacetCharts(spec({ kind: "area" }), ctx, opts);
    const labelled = r.panels.map((p) => [leftAxis(p.model).ticks.length > 0, bottomAxis(p.model).ticks.length > 0]);
    expect(labelled).toEqual([
      [true, false],
      [false, true],
      [false, true],
      [true, true],
    ]);
    for (const p of r.panels) expect(p.model.grid.length).toBeGreaterThan(1);
  });

  it("fills the grid width and height exactly", () => {
    const r = buildFacetCharts(spec({ kind: "bar" }), ctx, opts);
    const G = METRICS.chart.facetGap;
    const row0 = r.panels.slice(0, 3).map((p) => p.model.width);
    expect(row0.reduce((a, b) => a + b, 0) + 2 * G).toBeCloseTo(opts.width, 6);
    // Row tracks: row 0 is as tall as its tallest panel (East/North carry x labels), row 1 is South.
    const rowH = (ms: ChartModel[]) => Math.max(...ms.map((m) => m.height)) + METRICS.chart.facetLabel;
    const total = rowH(r.panels.slice(0, 3).map((p) => p.model)) + rowH([r.panels[3]!.model]) + G;
    expect(total).toBeCloseTo(2 * opts.panelHeight + G, 6);
  });

  it("caps panels at facetLimit and says how many were dropped", () => {
    const r = buildFacetCharts(spec({ facetLimit: 2 }), ctx, opts);
    expect(r.panels.map((p) => p.label)).toEqual(["West", "East"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("2 dropped");
  });

  it("returns the legend once and none on the panels", () => {
    const r = buildFacetCharts(spec({ series: "channel" }), ctx, opts);
    expect(r.legend.map((l) => l.label)).toEqual(["Online", "Retail"]);
    for (const p of r.panels) expect(p.model.legend).toEqual([]);
  });

  it("facets scatter charts with shared x/y scales", () => {
    const r = buildFacetCharts(spec({ kind: "scatter", x: "units", y: "revenue" }), ctx, { ...opts, columns: 2 });
    expect(r.panels).toHaveLength(4);
    const circles = r.panels.map((p) => p.model.marks.filter((k) => k.type === "circle").length);
    expect(circles).toEqual([12, 12, 12, 10]);
    const [a, b] = r.panels.map((p) => p.model);
    expect(a!.grid.map((g) => g.y1 - a!.plot.y)).toEqual(b!.grid.map((g) => g.y1 - b!.plot.y));
  });

  it.each([
    ["bar", {}],
    ["bar", { horizontal: true, x: "channel" }],
    ["line", { labels: true }],
    ["area", { series: "channel", stack: "percent" as const }],
    ["scatter", { x: "units", value: "units" }],
  ] as const)("keeps every %s mark inside its panel's plot (%j)", (kind, extra) => {
    const r = buildFacetCharts(spec({ kind, ...extra }), ctx, { width: 520, panelHeight: 140, columns: 2 });
    expect(r.panels).toHaveLength(4);
    for (const p of r.panels) {
      expect(p.model.width).toBeGreaterThan(0);
      expectInside(p.model);
    }
  });

  it("reports an unknown facet field with a suggestion", () => {
    const r = buildFacetCharts(spec({ facet: "regoin" }), ctx, opts);
    expect(r.panels).toEqual([]);
    expect(r.warnings[0]).toContain('did you mean "region"');
  });
});
