import { describe, expect, it } from "vitest";
import type { ChartSpec, Row } from "../spec.js";
import type { DataContext, FieldInfo } from "../data/types.js";
import type { ChartModel, Mark } from "./types.js";
import { buildChart } from "./build.js";

const SIZE = { width: 640, height: 320 };

function ctxOf(datasets: Record<string, { rows: Row[]; fields?: FieldInfo[] }>): DataContext {
  return {
    locale: "en-US",
    currency: "USD",
    datasets: new Map(
      Object.entries(datasets).map(([id, d]) => [
        id,
        { id, rows: d.rows, fields: d.fields ?? Object.keys(d.rows[0] ?? {}).map((name) => ({ name, type: typeof d.rows[0]![name] === "number" ? "number" : "string", label: name })) },
      ]),
    ) as DataContext["datasets"],
  };
}

const rects = (m: ChartModel) => m.marks.filter((k): k is Extract<Mark, { type: "rect" }> => k.type === "rect");
const arcs = (m: ChartModel) => m.marks.filter((k): k is Extract<Mark, { type: "arc" }> => k.type === "arc");
const close = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

/** Absolute coordinate pairs of an SVG path (M/L/C/Q pairs, A end points). */
function pathPoints(d: string): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const [, cmd, args] of d.matchAll(/([MLCQAZ])([^MLCQAZ]*)/g)) {
    const nums = args!.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
    if (cmd === "A") for (let i = 0; i + 6 < nums.length; i += 7) pts.push([nums[i + 5]!, nums[i + 6]!]);
    else for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!]);
  }
  return pts;
}

function expectInside(m: ChartModel) {
  const inX = (x: number, r = 0) => x - r >= -0.01 && x + r <= m.width + 0.01;
  const inY = (y: number, r = 0) => y - r >= -0.01 && y + r <= m.height + 0.01;
  for (const k of m.marks) {
    const ok = (() => {
      switch (k.type) {
        case "rect":
          return inX(k.x) && inX(k.x + k.width) && inY(k.y) && inY(k.y + k.height) && k.width >= 0 && k.height >= 0;
        case "circle":
          return inX(k.cx, k.r) && inY(k.cy, k.r);
        case "text":
          return inX(k.x) && inY(k.y);
        case "line":
          return inX(k.x1) && inX(k.x2) && inY(k.y1) && inY(k.y2);
        case "path":
        case "arc":
          return pathPoints(k.d).every(([x, y]) => inX(x) && inY(y));
      }
    })();
    expect(ok, `${k.type} ${k.key} outside ${m.width}x${m.height}: ${JSON.stringify(k)}`).toBe(true);
  }
}

const months = ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"];
const sales = months.flatMap((month, i) =>
  ["North", "South", "East"].map((region, j) => ({ month, region, revenue: 1000 + i * 200 * (j + 1), cost: 400 + i * 50, growth: 0.05 * (i - 2) })),
);
const salesFields: FieldInfo[] = [
  { name: "month", type: "date", label: "Month" },
  { name: "region", type: "string", label: "Region" },
  { name: "revenue", type: "number", label: "Revenue", format: "currency" },
  { name: "cost", type: "number", label: "Cost", format: "currency" },
  { name: "growth", type: "number", label: "Growth", format: "percent" },
];
const ctx = ctxOf({ sales: { rows: sales, fields: salesFields } });

describe("buildChart data preparation", () => {
  it("aggregates duplicate x values (sum by default, avg on request)", () => {
    const c = ctxOf({ d: { rows: [{ c: "A", v: 1 }, { c: "B", v: 5 }, { c: "A", v: 2 }] } });
    const sum = buildChart({ kind: "bar", data: "d", x: "c", y: "v" }, c, SIZE);
    expect(rects(sum).map((r) => [r.datum.x, r.datum.y])).toEqual([
      ["A", 3],
      ["B", 5],
    ]);
    const avg = buildChart({ kind: "bar", data: "d", x: "c", y: "v", aggregate: "avg" }, c, SIZE);
    expect(rects(avg)[0]!.datum.y).toBe(1.5);
  });

  it("never aggregates scatter points", () => {
    const c = ctxOf({ d: { rows: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 3 }] } });
    const m = buildChart({ kind: "scatter", data: "d", x: "x", y: "y" }, c, SIZE);
    expect(m.marks.filter((k) => k.type === "circle")).toHaveLength(3);
  });

  it("splits series by field and buckets beyond 8 into Other (top 7 by total)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ x: "a", s: `S${i}`, v: 10 - i }));
    const m = buildChart({ kind: "bar", data: "d", x: "x", y: "v", series: "s" }, ctxOf({ d: { rows } }), SIZE);
    expect(m.legend.map((l) => l.label)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5", "S6", "Other"]);
    expect(m.legend.at(-1)!.color).toBe("muted");
    const other = rects(m).find((r) => r.series === "Other")!;
    expect(other.datum.y).toBe(3 + 2 + 1);
  });

  it("one series per y field, labelled by FieldInfo.label", () => {
    const m = buildChart({ kind: "line", data: "sales", x: "month", y: ["revenue", "cost"] }, ctx, SIZE);
    expect(m.legend.map((l) => l.label)).toEqual(["Revenue", "Cost"]);
    expect(m.marks.filter((k) => k.type === "path")).toHaveLength(2);
  });

  it("sorts time x ascending and labels ticks by granularity", () => {
    const rows = [
      { m: "2025-03", v: 3 },
      { m: "2025-01", v: 1 },
      { m: "2025-02", v: 2 },
    ];
    const m = buildChart({ kind: "bar", data: "d", x: "m", y: "v" }, ctxOf({ d: { rows } }), SIZE);
    expect(rects(m).map((r) => r.datum.y)).toEqual([1, 2, 3]);
    expect(m.axes.find((a) => a.position === "bottom")!.ticks.map((t) => t.label)).toEqual(["Jan 2025", "Feb 2025", "Mar 2025"]);
    expect(rects(m)[0]!.datum.label).toBe("Jan 2025 · v: 1");

    const q = buildChart({ kind: "line", data: "d", x: "q", y: "v" }, ctxOf({ d: { rows: [{ q: "2025-Q2", v: 1 }, { q: "2025-Q1", v: 2 }] } }), SIZE);
    expect(q.axes.find((a) => a.position === "bottom")!.ticks.map((t) => t.label)).toEqual(["2025 Q1", "2025 Q2"]);
  });

  it("sort '-y' orders categories by total descending", () => {
    const rows = [
      { c: "A", v: 1 },
      { c: "B", v: 9 },
      { c: "C", v: 5 },
    ];
    const m = buildChart({ kind: "bar", data: "d", x: "c", y: "v", sort: "-y" }, ctxOf({ d: { rows } }), SIZE);
    expect(rects(m).map((r) => r.datum.x)).toEqual(["B", "C", "A"]);
  });

  it("limit keeps the top N by total; others merges the remainder", () => {
    const rows = [
      { c: "A", v: 5 },
      { c: "B", v: 50 },
      { c: "C", v: 20 },
      { c: "D", v: 1 },
      { c: "E", v: 30 },
    ];
    const c = ctxOf({ d: { rows } });
    const top = buildChart({ kind: "bar", data: "d", x: "c", y: "v", limit: 2 }, c, SIZE);
    expect(rects(top).map((r) => r.datum.x)).toEqual(["B", "E"]);
    const others = buildChart({ kind: "bar", data: "d", x: "c", y: "v", limit: 2, others: true }, c, SIZE);
    expect(rects(others).map((r) => [r.datum.x, r.datum.y])).toEqual([
      ["B", 50],
      ["E", 30],
      ["Other", 26],
    ]);
  });

  it("missing dataset or field → empty model with an actionable warning, never throws", () => {
    const f = buildChart({ kind: "bar", data: "sales", x: "month", y: "revnue" }, ctx, SIZE);
    expect(f.empty).toBe(true);
    expect(f.marks).toEqual([]);
    expect(f.warnings[0]).toContain('"revnue"');
    expect(f.warnings[0]).toContain('did you mean "revenue"');
    const d = buildChart({ kind: "bar", data: "salez", x: "month", y: "revenue" }, ctx, SIZE);
    expect(d.empty).toBe(true);
    expect(d.warnings[0]).toContain('did you mean "sales"');
  });

  it("no plottable rows → empty with a warning", () => {
    const m = buildChart({ kind: "line", data: "d", x: "x", y: "y" }, ctxOf({ d: { rows: [{ x: null, y: 1 }], fields: [{ name: "x", type: "string", label: "x" }, { name: "y", type: "number", label: "y" }] } }), SIZE);
    expect(m.empty).toBe(true);
    expect(m.warnings).toHaveLength(1);
  });
});

describe("buildChart geometry", () => {
  it("stacked bars pile contiguously; percent stacks reach the plot top", () => {
    const stacked = buildChart({ kind: "bar", data: "sales", x: "month", y: "revenue", series: "region", stack: true }, ctx, SIZE);
    const byCat = Map.groupBy(rects(stacked), (r) => String(r.datum.x));
    for (const group of byCat.values()) {
      const sorted = [...group].sort((a, b) => a.y - b.y);
      for (let i = 1; i < sorted.length; i++) expect(close(sorted[i - 1]!.y + sorted[i - 1]!.height, sorted[i]!.y)).toBe(true);
    }
    const pct = buildChart({ kind: "bar", data: "sales", x: "month", y: "revenue", series: "region", stack: "percent" }, ctx, SIZE);
    const { plot } = pct;
    for (const group of Map.groupBy(rects(pct), (r) => String(r.datum.x)).values()) {
      expect(close(Math.min(...group.map((r) => r.y)), plot.y)).toBe(true);
      expect(close(Math.max(...group.map((r) => r.y + r.height)), plot.y + plot.height)).toBe(true);
    }
    expect(pct.axes.find((a) => a.position === "left")!.ticks.at(-1)!.label).toBe("100%");
    expect(rects(pct)[0]!.datum.label).toMatch(/\(\d+(\.\d)?%\)$/);
  });

  it("horizontal bars stay within the plot and put categories on the left", () => {
    const rows = [
      { p: "A very long product name that needs truncation", v: 100 },
      { p: "B", v: 40 },
      { p: "C", v: 70 },
    ];
    const m = buildChart({ kind: "bar", data: "d", x: "p", y: "v", horizontal: true, labels: true }, ctxOf({ d: { rows } }), SIZE);
    const { plot } = m;
    for (const r of rects(m)) {
      expect(r.x).toBeGreaterThanOrEqual(plot.x - 0.01);
      expect(r.x + r.width).toBeLessThanOrEqual(plot.x + plot.width + 0.01);
      expect(r.y).toBeGreaterThanOrEqual(plot.y - 0.01);
      expect(r.y + r.height).toBeLessThanOrEqual(plot.y + plot.height + 0.01);
    }
    const left = m.axes.find((a) => a.position === "left")!;
    expect(left.ticks[0]!.label.endsWith("…")).toBe(true);
    expect(rects(m)[0]!.width).toBeGreaterThan(rects(m)[1]!.width);
  });

  it("negative bars extend below the zero baseline", () => {
    const rows = [
      { c: "A", v: 10 },
      { c: "B", v: -5 },
    ];
    const m = buildChart({ kind: "bar", data: "d", x: "c", y: "v" }, ctxOf({ d: { rows } }), SIZE);
    const zero = m.axes.find((a) => a.position === "left")!.ticks.find((t) => t.value === 0)!.offset;
    const [pos, neg] = rects(m);
    expect(close(pos!.y + pos!.height, zero)).toBe(true);
    expect(close(neg!.y, zero)).toBe(true);
    expect(neg!.y + neg!.height).toBeGreaterThan(zero);
  });

  it("rotates crowded categorical bottom labels and truncates long ones", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ c: `Category number ${i} with a long name`, v: i + 1 }));
    const m = buildChart({ kind: "bar", data: "d", x: "c", y: "v" }, ctxOf({ d: { rows } }), SIZE);
    const bottom = m.axes.find((a) => a.position === "bottom")!;
    expect(bottom.labelAngle).toBe(-35);
    expect(bottom.ticks.every((t) => [...t.label].length <= 16)).toBe(true);
  });

  it("thins time labels instead of rotating", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ d: new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7), v: i }));
    const m = buildChart({ kind: "line", data: "d", x: "d", y: "v" }, ctxOf({ d: { rows } }), SIZE);
    const bottom = m.axes.find((a) => a.position === "bottom")!;
    expect(bottom.labelAngle).toBeUndefined();
    expect(bottom.ticks.length).toBeLessThan(60);
    expect(bottom.ticks[0]!.label).toBe("Jan 2020");
    expect(m.marks.some((k) => k.type === "circle")).toBe(false);
  });

  it("null y breaks the line", () => {
    const rows = [
      { x: 1, y: 1 },
      { x: 2, y: null },
      { x: 3, y: 3 },
      { x: 4, y: 2 },
    ];
    const fields: FieldInfo[] = [
      { name: "x", type: "number", label: "x" },
      { name: "y", type: "number", label: "y" },
    ];
    const m = buildChart({ kind: "line", data: "d", x: "x", y: "y", curve: "linear" }, ctxOf({ d: { rows, fields } }), SIZE);
    const path = m.marks.find((k) => k.type === "path")!;
    expect(path.type === "path" && path.d.match(/M/g)?.length).toBe(2);
    expect(m.marks.filter((k) => k.type === "circle")).toHaveLength(3);
  });

  it("draws secondary measures on a right axis with a legend", () => {
    const m = buildChart({ kind: "bar", data: "sales", x: "month", y: "revenue", secondary: { y: "growth", format: "percent", label: "Growth" } }, ctx, SIZE);
    const right = m.axes.find((a) => a.position === "right");
    expect(right).toBeDefined();
    expect(right!.title).toBe("Growth");
    expect(right!.ticks.some((t) => t.label.endsWith("%"))).toBe(true);
    expect(m.marks.some((k) => k.type === "path" && k.series === "secondary:growth")).toBe(true);
    expect(m.legend.map((l) => l.shape)).toEqual(["square", "line"]);
  });

  it("reference lines span the plot at the value", () => {
    const m = buildChart({ kind: "bar", data: "sales", x: "month", y: "revenue", reference: [{ value: 5000, label: "Target", axis: "y" }] }, ctx, SIZE);
    const ref = m.marks.find((k) => k.type === "line");
    expect(ref).toMatchObject({ role: "reference", dash: true, label: "Target", x1: m.plot.x, x2: m.plot.x + m.plot.width });
  });

  it("pie slices tile the full circle and merge slices under 2% into Other", () => {
    const rows = [
      { c: "A", v: 50 },
      { c: "B", v: 30 },
      { c: "C", v: 18 },
      { c: "D", v: 1 },
      { c: "E", v: 0.5 },
      { c: "F", v: 0.5 },
    ];
    const m = buildChart({ kind: "pie", data: "d", x: "c", y: "v" }, ctxOf({ d: { rows } }), SIZE);
    const slices = arcs(m);
    expect(slices.map((s) => s.datum.x)).toEqual(["A", "B", "C", "Other"]);
    expect(slices.at(-1)!.fill).toBe("muted");
    expect(slices.at(-1)!.datum.label).toContain("(2.0%)");
    const ends = slices.map((s) => {
      const pts = pathPoints(s.d);
      return { start: pts[0]!, end: pts[1]! };
    });
    const cx = m.plot.x + m.plot.width / 2;
    const top = m.plot.y + m.plot.height / 2 - Math.min(m.plot.width, m.plot.height) / 2;
    expect(close(ends[0]!.start[0], cx) && close(ends[0]!.start[1], top)).toBe(true);
    for (let i = 1; i < ends.length; i++) {
      expect(close(ends[i - 1]!.end[0], ends[i]!.start[0], 0.01) && close(ends[i - 1]!.end[1], ends[i]!.start[1], 0.01)).toBe(true);
    }
    expect(close(ends.at(-1)!.end[0], cx) && close(ends.at(-1)!.end[1], top)).toBe(true);
    expect(m.legend).toHaveLength(4);
  });

  it("donut adds center label and formatted total", () => {
    const m = buildChart({ kind: "donut", data: "sales", x: "region", y: "revenue" }, ctx, SIZE);
    const center = m.marks.filter((k) => k.type === "text" && (k.role === "center-label" || k.role === "center-value"));
    expect(center).toHaveLength(2);
    expect(center[1]!.type === "text" && center[1]!.text).toMatch(/^\$/);
  });

  it("heatmap intensity is normalized to [0, 1]", () => {
    const rows = ["Mon", "Tue", "Wed"].flatMap((d, i) => ["AM", "PM"].map((s, j) => ({ d, s, n: 10 + i * 7 + j * 3 })));
    const m = buildChart({ kind: "heatmap", data: "d", x: "d", y: "s", value: "n" }, ctxOf({ d: { rows } }), SIZE);
    const ts = rects(m).map((r) => (typeof r.fill === "object" ? r.fill.scale : NaN));
    expect(ts).toHaveLength(6);
    expect(Math.min(...ts)).toBe(0);
    expect(Math.max(...ts)).toBe(1);
    expect(ts.every((t) => t >= 0 && t <= 1)).toBe(true);
    expect(m.marks.some((k) => k.type === "text" && k.role === "value-label")).toBe(true);
  });

  it("external legend reserves no top band but keeps legend items", () => {
    const spec: ChartSpec = { kind: "line", data: "sales", x: "month", y: "revenue", series: "region" };
    const top = buildChart(spec, ctx, SIZE);
    const external = buildChart(spec, ctx, { ...SIZE, legend: "external" });
    expect(top.plot.y - external.plot.y).toBe(28);
    expect(external.legend).toEqual(top.legend);
    expect(external.legend).toHaveLength(3);
  });

  it("describes the chart in one sentence", () => {
    const m = buildChart({ kind: "bar", data: "sales", x: "month", y: "revenue", series: "region" }, ctx, SIZE);
    expect(m.description).toMatch(/^Bar chart of Revenue by Month with 6 points across 3 series, ranging from .+; highest: Jun 2025 · East .+\.$/);
  });

  const specs: ChartSpec[] = [
    { kind: "bar", data: "sales", x: "month", y: "revenue", series: "region", labels: true },
    { kind: "bar", data: "sales", x: "month", y: "revenue", series: "region", stack: true, labels: true, reference: [{ value: 3000, label: "T", axis: "y" }] },
    { kind: "bar", data: "sales", x: "region", y: "growth", horizontal: true, labels: true, aggregate: "avg" },
    { kind: "bar", data: "sales", x: "month", y: "growth", labels: true, secondary: { y: "cost" } },
    { kind: "line", data: "sales", x: "month", y: ["revenue", "cost"], labels: true, curve: "monotone", reference: [{ value: 2025, axis: "x" }] },
    { kind: "line", data: "sales", x: "month", y: "growth", curve: "step" },
    { kind: "area", data: "sales", x: "month", y: "revenue", series: "region", stack: true, labels: true },
    { kind: "area", data: "sales", x: "month", y: "growth" },
    { kind: "scatter", data: "sales", x: "cost", y: "revenue", value: "growth", series: "region", labels: true },
    { kind: "scatter", data: "sales", x: "month", y: "revenue" },
    { kind: "pie", data: "sales", x: "region", y: "revenue", labels: true },
    { kind: "donut", data: "sales", x: "region", y: "revenue" },
    { kind: "heatmap", data: "sales", x: "month", y: "region", value: "revenue" },
  ];
  it.each([
    [640, 320],
    [300, 180],
  ])("every mark stays inside the %ix%i canvas", (width, height) => {
    for (const spec of specs) {
      const m = buildChart(spec, ctx, { width, height });
      expect(m.empty, `${spec.kind} empty`).toBe(false);
      expect(m.marks.length).toBeGreaterThan(0);
      expectInside(m);
    }
  });
});
