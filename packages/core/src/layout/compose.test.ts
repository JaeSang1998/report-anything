import { describe, expect, it } from "vitest";
import type { DataContext, ResolvedDataset } from "../data/types.js";
import { Section } from "../spec.js";
import type { Block, LayoutPattern, Row } from "../spec.js";
import { composeSection } from "./compose.js";
import type { ComposeEnv } from "./compose.js";
import { LEVEL_TOLERANCE } from "./cost.js";
import { pageGeometry } from "./geometry.js";
import { METRICS } from "./metrics.js";
import type { Band, Composition } from "./types.js";

const WEB = 1040;
const PAGE = pageGeometry();
const PRINT = PAGE.contentWidth;
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
    ["wide", dataset("wide", Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Order ${i}`, region: "EU", owner: "Ann", value: i })))],
  ]),
};

const env = (width: number, measured?: Record<string, number>): ComposeEnv => ({
  ctx,
  contentWidth: width,
  gap: GAP,
  density: "comfortable",
  measured,
  pageHeight: width === PRINT ? PAGE.contentHeight : undefined,
});

const compose = (blocks: unknown[], width = WEB, layout?: LayoutPattern, measured?: Record<string, number>): { section: Section; bands: Band[] } => {
  const section = Section.parse({ id: "s", ...(layout ? { layout } : {}), blocks });
  return { section, bands: composeSection(section, env(width, measured)) };
};
const kinds = (bands: readonly Band[]): Composition[] => bands.map((b) => b.composition);

const words = (n: number) => "Renewals concentrated in the fourth quarter. ".repeat(n).trim();
const text = (id: string, content = "Revenue grew 12% on enterprise renewals while churn held flat.", extra: object = {}) => ({ id, type: "text", content, ...extra });
const callout = (id: string) => ({ id, type: "callout", content: "Renewals concentrate in Q4; plan capacity early." });
const list = (id: string) => ({ id, type: "list", items: [{ text: "Hire two AEs" }, { text: "Cut churn" }, { text: "Expand APAC" }] });
const chart = (id: string, kind = "line", extra: object = {}) => ({ id, type: "chart", title: "Revenue", chart: { kind, data: "monthly", x: "month", y: "revenue" }, ...extra });
const kpi = (id: string, n = 4) => ({ id, type: "kpi", items: Array.from({ length: n }, (_, i) => ({ label: `K${i}`, value: i })) });
const stat = (id: string) => ({ id, type: "stat", label: "ARR", value: 12, compareTo: 10, description: "Up on enterprise renewals." });
const smallTable = (id: string) => ({ id, type: "table", data: "small", columns: [{ field: "name" }, { field: "a" }] });
const wideTable = (id: string) => ({ id, type: "table", data: "wide" });
const comparison = (id: string) => ({ id, type: "comparison", entities: ["Q1", "Q2"], metrics: [{ label: "Revenue", values: [1, 2] }] });

/** A mixed bag covering every block type. */
const MIXED = [
  kpi("k"),
  chart("c1"),
  callout("co"),
  chart("c2", "bar"),
  list("l"),
  smallTable("t"),
  stat("st"),
  text("x", words(12)),
  chart("p", "pie"),
  comparison("cmp"),
  { id: "d", type: "diagram", source: "graph TD; A-->B" },
  wideTable("w"),
  text("y"),
];
const LAYOUTS: readonly LayoutPattern[] = ["auto", "stack", "main-side", "side-main", "split", "thirds", "quarters", "feature", "sidebar", "grid"];

function minWidth(block: Block): number {
  switch (block.type) {
    case "chart":
      return METRICS.minWidth.chart;
    case "diagram":
      return METRICS.minWidth.diagram;
    case "table":
      return METRICS.minWidth.table;
    case "stat":
      return METRICS.minWidth.stat;
    case "kpi":
      return block.items.length * METRICS.kpi.minItemWidth + (block.items.length - 1) * METRICS.kpi.columnGap;
    case "comparison":
      return METRICS.comparison.labelColumn + (block.entities.length + 1) * METRICS.comparison.entityColumn;
    default:
      return METRICS.minWidth.text;
  }
}

describe("composeSection — invariants", () => {
  const cases = LAYOUTS.flatMap((layout) => [WEB, PRINT, 480, 1400].map((width) => ({ layout, width })));

  it.each(cases)("placements tile 12 columns per row track without overlap ($layout @ $width)", ({ layout, width }) => {
    for (const band of compose(MIXED, width, layout).bands) {
      const grid = Array.from({ length: band.rows }, () => Array<number>(12).fill(0));
      for (const p of band.placements) {
        for (let r = p.row; r < p.row + p.rowSpan; r++) for (let c = p.col; c < p.col + p.span; c++) grid[r - 1]![c - 1]!++;
      }
      for (const track of grid) expect(track).toEqual(Array(12).fill(1));
    }
  });

  it.each(cases)("preserves reading order and respects min widths ($layout @ $width)", ({ layout, width }) => {
    const { section, bands } = compose(MIXED, width, layout);
    expect(bands.flatMap((b) => b.placements.map((p) => p.blockId))).toEqual(section.blocks.map((b) => b.id));
    const byId = new Map(section.blocks.map((b) => [b.id, b]));
    for (const p of bands.flatMap((b) => b.placements)) {
      if (p.span < 12) expect(p.width).toBeGreaterThanOrEqual(minWidth(byId.get(p.blockId)!));
    }
  });

  it("is deterministic", () => {
    for (const width of [WEB, PRINT]) expect(compose(MIXED, width).bands).toEqual(compose(MIXED, width).bands);
  });

  it("band height covers every column and plotHeight is set exactly for elastic blocks", () => {
    for (const band of compose(MIXED).bands) {
      for (const p of band.placements) {
        expect(p.height).toBeLessThanOrEqual(band.height + 0.5);
        const type = MIXED.find((b) => b.id === p.blockId)!.type;
        expect(p.plotHeight !== undefined).toBe(type === "chart" || type === "diagram");
      }
    }
  });
});

describe("composeSection — compositions", () => {
  it("a chart followed by two short narratives becomes a feature", () => {
    const { bands } = compose([chart("c"), text("a"), callout("b")]);
    expect(kinds(bands)).toHaveLength(1);
    expect(kinds(bands)[0]).toMatch(/^feature-/);
    const lead = bands[0]!.placements[0]!;
    expect(lead).toMatchObject({ span: 8, rowSpan: 2 });
  });

  it("a long narrative followed by three charts becomes a sidebar", () => {
    const { bands } = compose([text("n", words(30)), chart("a"), chart("b", "bar"), chart("c", "area")]);
    expect(kinds(bands)).toEqual([expect.stringMatching(/^sidebar-/)]);
    const [aside, ...main] = bands[0]!.placements;
    expect(aside).toMatchObject({ blockId: "n", span: 4, rowSpan: 3 });
    for (const p of main) expect(p.span).toBe(8);
  });

  it("a realistic mixed section uses at least three different compositions", () => {
    const { bands } = compose([kpi("k"), chart("c1"), callout("co"), chart("c2", "bar"), list("l"), smallTable("t")]);
    expect(new Set(kinds(bands)).size).toBeGreaterThanOrEqual(3);
  });

  it("KPI blocks and wide tables always take the full width", () => {
    for (const layout of LAYOUTS) {
      for (const width of [WEB, 1400]) {
        const { bands } = compose([kpi("k", 2), text("a"), wideTable("w"), text("b")], width, layout);
        for (const id of ["k", "w"]) {
          const band = bands.find((b) => b.placements.some((p) => p.blockId === id))!;
          expect(band.placements).toHaveLength(1);
          expect(band.placements[0]!.span).toBe(12);
        }
      }
    }
  });

  it("a stat alone becomes a hero; a lead chart may, a normal chart may not", () => {
    expect(kinds(compose([stat("s")]).bands)).toEqual(["hero"]);
    expect(kinds(compose([chart("c", "line", { importance: "lead" })]).bands)).toEqual(["hero"]);
    expect(kinds(compose([chart("c")]).bands)).toEqual(["full"]);
  });

  it("print and web choose different compositions for the same section", () => {
    const blocks = [chart("c"), text("a"), callout("b"), chart("p", "pie"), list("l"), comparison("x")];
    expect(kinds(compose(blocks, WEB).bands)).not.toEqual(kinds(compose(blocks, PRINT).bands));
    // Feature stacks need 4 columns ≥ the text minimum: true at 1040px, false at the 698px A4 width.
    expect(kinds(compose([chart("c"), text("a"), callout("b")], PRINT).bands).some((k) => k.startsWith("feature"))).toBe(false);
  });
});

describe("composeSection — section layout restricts candidates", () => {
  const blocks = [chart("c1"), callout("co"), chart("c2", "bar"), list("l"), text("t"), chart("p", "pie")];
  const ALLOWED: Record<Exclude<LayoutPattern, "auto">, { primary: readonly Composition[]; other: readonly Composition[] }> = {
    stack: { primary: ["stack"], other: [] },
    "main-side": { primary: ["pair"], other: ["full"] },
    "side-main": { primary: ["pair"], other: ["full"] },
    split: { primary: ["pair"], other: ["full"] },
    thirds: { primary: ["trio"], other: ["pair", "full"] },
    quarters: { primary: ["quad"], other: ["trio", "pair", "full"] },
    feature: { primary: ["feature-left", "feature-right"], other: ["full"] },
    sidebar: { primary: ["sidebar-left", "sidebar-right"], other: ["full"] },
    grid: { primary: ["grid", "pair", "trio", "quad"], other: ["full"] },
  };
  const SPLIT: Partial<Record<LayoutPattern, readonly number[]>> = { "main-side": [8, 4], "side-main": [4, 8], split: [6, 6] };

  it.each(Object.keys(ALLOWED) as Array<keyof typeof ALLOWED>)("%s", (layout) => {
    const { primary, other } = ALLOWED[layout];
    const { bands } = compose(blocks, WEB, layout);
    for (const k of kinds(bands)) expect([...primary, ...other]).toContain(k);
    // Quarters cannot fit these charts at 3 columns; the fallback test covers it.
    if (layout !== "quarters") expect(kinds(bands).some((k) => primary.includes(k))).toBe(true);
    const split = SPLIT[layout];
    if (split) for (const b of bands.filter((x) => x.composition === "pair")) expect(b.placements.map((p) => p.span)).toEqual(split);
    if (layout === "grid") for (const b of bands) expect(new Set(b.placements.map((p) => p.span)).size).toBe(1);
  });

  it("falls back only when the layout's own compositions are infeasible", () => {
    // 3 columns at 1040px are 233px: too narrow for charts, so quarters falls back to trios.
    expect(kinds(compose(blocks, WEB, "quarters").bands)).not.toContain("quad");
    expect(kinds(compose(["a", "b", "c", "d"].map((id) => text(id)), WEB, "quarters").bands)).toEqual(["quad"]);
    // An odd block count leaves one block for a fallback.
    expect(kinds(compose(["a", "b", "c"].map((id) => text(id)), WEB, "split").bands).sort()).toEqual(["full", "pair"]);
  });
});

describe("composeSection — explicit spans", () => {
  const spans = (blocks: unknown[], layout?: LayoutPattern) => compose(blocks, WEB, layout).bands.map((b) => b.placements.map((p) => p.span));

  it("honours explicit spans over layouts and min widths", () => {
    expect(spans(["a", "b", "c"].map((id) => text(id, "x", { span: 4 })), "stack")).toEqual([[4, 4, 4]]);
    // Explicit 3 on a chart is kept although 3 columns are below the chart minimum; the neighbour takes the rest.
    expect(spans([{ ...chart("a"), span: 3 }, chart("b", "pie")])).toEqual([[3, 9]]);
    expect(spans([text("a", "x", { span: 9 }), { ...chart("b"), span: 3 }])).toEqual([[9, 3]]);
    expect(spans([{ ...kpi("k"), span: 6 }, text("t", "x", { span: 6 })])).toEqual([[6, 6]]);
  });

  it("stretches a lone explicit span that nothing can honour", () => {
    expect(spans([text("a", "x", { span: 5 })])).toEqual([[12]]);
  });
});

describe("composeSection — levelling", () => {
  /** Lead column height minus the stack column height (stack includes the row gap). */
  const imbalance = (band: Band): number => {
    const lead = band.placements.find((p) => p.rowSpan === 2)!;
    const stack = band.placements.filter((p) => p !== lead);
    return Math.abs(lead.height - (stack.reduce((n, p) => n + p.height, 0) + GAP));
  };

  it("levels a feature's lead against its stack when the elastic range allows", () => {
    // Stack ≈ 2 × 6 lines + gap: inside the chart's [200, 420] body range.
    const { bands } = compose([chart("c"), text("a", words(5)), text("b", words(5))]);
    expect(bands[0]!.composition).toMatch(/^feature-/);
    expect(imbalance(bands[0]!)).toBeLessThanOrEqual(LEVEL_TOLERANCE);
    const lead = bands[0]!.placements[0]!;
    expect(lead.plotHeight).not.toBe(METRICS.chart.plot.md);
  });

  it("stops at the elastic range when the other column is out of reach", () => {
    const { bands } = compose([chart("c"), text("a"), callout("b")]);
    const lead = bands[0]!.placements[0]!;
    expect(lead.plotHeight).toBe(METRICS.chart.plot.sm);
    expect(bands[0]!.height).toBe(lead.height);
  });

  it("stretches a chart to a taller fixed neighbour within range", () => {
    const { bands } = compose([chart("c"), text("a", words(20))], WEB, "split");
    const [c, a] = bands[0]!.placements;
    expect(Math.abs(c!.height - a!.height)).toBeLessThanOrEqual(LEVEL_TOLERANCE);
    expect(c!.plotHeight).toBeGreaterThan(METRICS.chart.plot.md);
  });

  it("measured elastic heights are chrome only: the body stays solved", () => {
    const { bands } = compose([chart("c")], WEB, undefined, { c: 40 });
    expect(bands[0]!.placements[0]).toMatchObject({ height: 40 + METRICS.chart.plot.md, plotHeight: METRICS.chart.plot.md });
  });
});
