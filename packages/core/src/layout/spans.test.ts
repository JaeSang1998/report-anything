import { describe, expect, it } from "vitest";
import type { DataContext, ResolvedDataset } from "../data/types.js";
import { Section } from "../spec.js";
import type { Row } from "../spec.js";
import { pageGeometry } from "./geometry.js";
import { METRICS } from "./metrics.js";
import { assignRows } from "./spans.js";

const WEB = 1040;
const WIDE = 1200;
const PRINT = pageGeometry().contentWidth;
const GAP = METRICS.grid.gap;

function dataset(id: string, rows: Row[]): ResolvedDataset {
  const names = Object.keys(rows[0] ?? {});
  return { id, rows, fields: names.map((name) => ({ name, type: typeof rows[0]?.[name] === "number" ? "number" : "string", label: name })) };
}

const ctx: DataContext = {
  locale: "en-US",
  currency: "USD",
  datasets: new Map([
    ["monthly", dataset("monthly", Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, revenue: i * 10 })))],
    ["many", dataset("many", Array.from({ length: 20 }, (_, i) => ({ name: `Product ${i}`, revenue: i })))],
    ["small", dataset("small", Array.from({ length: 5 }, (_, i) => ({ name: `R${i}`, a: i, b: i })))],
  ]),
};

const spans = (input: unknown, width = WEB): number[][] =>
  assignRows(Section.parse(input), ctx, width, GAP).map((row) => row.map((c) => c.span));

const text = (id: string, content = "Short note.", extra: object = {}) => ({ id, type: "text", content, ...extra });
const callout = (id: string, content = "Revenue grew 12% on enterprise renewals.") => ({ id, type: "callout", content });
const list = (id: string) => ({ id, type: "list", items: [{ text: "Hire two AEs" }, { text: "Cut churn" }] });
const chart = (id: string, kind: string, data = "monthly", x = "month", extra: object = {}) => ({
  id,
  type: "chart",
  chart: { kind, data, x, y: "revenue", ...extra },
});

describe("assignRows", () => {
  it("explicit spans win over patterns and auto heuristics", () => {
    expect(spans({ id: "s", layout: "stack", blocks: [text("a", "x", { span: 4 }), text("b", "x", { span: 4 }), text("c", "x", { span: 4 })] })).toEqual([[4, 4, 4]]);
    // Explicit 3 on a chart is not bumped to the chart minimum width; the flexible neighbour fills the row.
    expect(spans({ id: "s", blocks: [{ ...chart("a", "line"), span: 3 }, chart("b", "pie")] })).toEqual([[3, 9]]);
    expect(spans({ id: "s", blocks: [text("a", "x", { span: 9 }), { ...chart("b", "line"), span: 3 }] })).toEqual([[9, 3]]);
  });

  it.each([
    ["stack", [[12], [12], [12], [12]]],
    ["main-side", [[8, 4], [8, 4]]],
    ["side-main", [[4, 8], [4, 8]]],
    ["split", [[6, 6], [6, 6]]],
    ["thirds", [[4, 4, 4], [12]]],
    ["quarters", [[3, 3, 3, 3]]],
  ] as const)("pattern %s assigns spans cyclically", (layout, expected) => {
    // At 1200px a 3-column cell (276px) clears the 240px text minimum.
    expect(spans({ id: "s", layout, blocks: ["a", "b", "c", "d"].map((id) => text(id)) }, WIDE)).toEqual(expected);
  });

  it("distributes a short trailing row of equal cells evenly", () => {
    expect(spans({ id: "s", layout: "thirds", blocks: ["a", "b", "c", "d", "e"].map((id) => text(id)) })).toEqual([[4, 4, 4], [6, 6]]);
  });

  it("pairs a chart with a short narrative 8/4", () => {
    expect(spans({ id: "s", blocks: [chart("c", "line"), callout("n")] })).toEqual([[8, 4]]);
    expect(spans({ id: "s", blocks: [chart("c", "bar"), text("n")] })).toEqual([[8, 4]]);
  });

  it("pairs pie/donut with a narrative 6/6", () => {
    expect(spans({ id: "s", blocks: [chart("c", "donut"), text("n")] })).toEqual([[6, 6]]);
  });

  it("pairs two consecutive charts 6/6", () => {
    expect(spans({ id: "s", blocks: [chart("a", "line"), chart("b", "area")] })).toEqual([[6, 6]]);
  });

  it("puts three compact blocks on one 4/4/4 row", () => {
    expect(spans({ id: "s", blocks: [chart("p", "pie"), callout("c"), list("l")] })).toEqual([[4, 4, 4]]);
  });

  it("gives long text, KPIs, lone charts and wide bars the full width", () => {
    expect(spans({ id: "s", blocks: [text("t", "word ".repeat(140))] })).toEqual([[12]]);
    expect(spans({ id: "s", blocks: [{ id: "k", type: "kpi", items: [{ label: "A", value: 1 }] }] })).toEqual([[12]]);
    expect(spans({ id: "s", blocks: [chart("c", "line")] })).toEqual([[12]]);
    // Vertical bars stay pairable up to 24 categories; horizontal bars go full width past 12 rows.
    expect(spans({ id: "s", blocks: [chart("c", "bar", "many", "name"), text("n")] })).toEqual([[8, 4]]);
    expect(spans({ id: "s", blocks: [chart("c", "bar", "many", "name", { horizontal: true }), text("n")] })).toEqual([[12], [12]]);
    expect(spans({ id: "s", blocks: [chart("c", "bar", "many", "name", { limit: 10, horizontal: true }), text("n")] })).toEqual([[8, 4]]);
  });

  it("text over 500 chars does not pair with a chart", () => {
    expect(spans({ id: "s", blocks: [chart("c", "line"), text("n", "word ".repeat(110))] })).toEqual([[12], [12]]);
  });

  it("halves small tables and keeps large ones full width", () => {
    const small = { id: "t", type: "table", data: "small", columns: [{ field: "name" }, { field: "a" }] };
    const large = { id: "u", type: "table", data: "many" };
    expect(spans({ id: "s", blocks: [small, { ...small, id: "t2" }] })).toEqual([[6, 6]]);
    expect(spans({ id: "s", blocks: [large] })).toEqual([[12]]);
  });

  it("tolerates missing datasets", () => {
    expect(spans({ id: "s", blocks: [chart("a", "bar", "nope", "x"), chart("b", "line", "nope", "x")] })).toEqual([[6, 6]]);
    expect(spans({ id: "s", blocks: [{ id: "t", type: "table", data: "nope" }] })).toEqual([[12]]);
  });

  it("bumps spans to minimum pixel widths, so print rows differ from web rows", () => {
    const trio = { id: "s", blocks: [chart("p", "pie"), callout("c"), list("l")] };
    expect(spans(trio, WEB)).toEqual([[4, 4, 4]]);
    expect(spans(trio, PRINT)).toEqual([[6, 6], [12]]);
    // chart+note keeps one row in print by shrinking the chart toward its minimum
    expect(spans({ id: "s", blocks: [chart("c", "line"), callout("n")] }, PRINT)).toEqual([[7, 5]]);
    const quarters = { id: "s", layout: "quarters" as const, blocks: ["a", "b", "c", "d"].map((id) => text(id)) };
    expect(spans(quarters, WIDE)).toEqual([[3, 3, 3, 3]]);
    // 3 cols at 1040px are 236px ≥ 220px text minimum
    expect(spans(quarters, WEB)).toEqual([[3, 3, 3, 3]]);
    expect(spans(quarters, PRINT)).toEqual([[6, 6], [6, 6]]);
    // KPI items on one row need 3×160 + 2×24 = 528px: 8 web columns (683px) but 10 print columns.
    const kpi = { id: "k", type: "kpi", items: ["a", "b", "c"].map((label) => ({ label, value: 1 })) };
    const mainSide = { id: "s", layout: "main-side" as const, blocks: [kpi, text("t")] };
    expect(spans(mainSide, WEB)).toEqual([[8, 4]]);
    expect(spans(mainSide, PRINT)).toEqual([[12], [12]]);
  });

  it("every row sums to exactly 12", () => {
    const blocks = [
      chart("a", "pie"),
      text("b"),
      { id: "c", type: "comparison", entities: ["Q1", "Q2"], metrics: [{ label: "Rev", values: [1, 2] }] },
      chart("d", "line"),
      { id: "e", type: "kpi", items: [{ label: "A", value: 1 }], span: 5 },
      callout("f"),
      list("g"),
      { id: "h", type: "table", data: "small" },
      text("i", "x", { span: 7 }),
    ];
    for (const layout of ["auto", "stack", "main-side", "side-main", "split", "thirds", "quarters"] as const) {
      for (const width of [WEB, PRINT, 480, 1400]) {
        const rows = spans({ id: "s", layout, blocks }, width);
        expect(rows.flat()).toHaveLength(blocks.length);
        for (const row of rows) expect(row.reduce((a, b) => a + b, 0)).toBe(12);
      }
    }
  });
});
