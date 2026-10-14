import { describe, expect, it } from "vitest";
import type { DataContext, ResolvedDataset } from "../data/types.js";
import { ReportSpec } from "../spec.js";
import { layoutReport } from "./engine.js";
import { tableMetrics } from "./estimate.js";
import { METRICS } from "./metrics.js";
import type { LayoutOptions, LayoutPlan, PageItem } from "./types.js";

const H = 1027; // A4 portrait content height

function table(id: string, n: number): ResolvedDataset {
  return {
    id,
    rows: Array.from({ length: n }, (_, i) => ({ name: `Row ${i}`, value: i })),
    fields: [
      { name: "name", type: "string", label: "Name" },
      { name: "value", type: "number", label: "Value" },
    ],
  };
}

function context(...datasets: ResolvedDataset[]): DataContext {
  return { locale: "en-US", currency: "USD", datasets: new Map(datasets.map((d) => [d.id, d])) };
}

const spec = (input: unknown): ReportSpec => ReportSpec.parse(input);
const text = (id: string, content = "Short note.") => ({ id, type: "text", content });

function itemHeight(plan: LayoutPlan, item: PageItem, s: ReportSpec, ctx: DataContext): number {
  if (item.kind === "report-header") return plan.reportHeaderHeight;
  const section = plan.sections.find((x) => x.id === item.sectionId)!;
  if (item.kind === "section-header") return section.headerHeight;
  const row = section.rows[item.row]!;
  if (item.kind === "row") return row.height;
  const block = s.sections.find((x) => x.id === item.sectionId)!.blocks.find((b) => b.id === item.blockId)!;
  if (block.type !== "table") throw new Error("slice of non-table");
  const t = tableMetrics(block, row.cells[0]!.width, ctx, s.theme?.density);
  return t.top + t.header + (item.to - item.from) * t.row + (item.to === t.rows ? t.footer : 0);
}

/** Invariants every plan must satisfy. */
function check(plan: LayoutPlan, s: ReportSpec, ctx: DataContext): void {
  expect(plan.pages.length).toBeGreaterThan(0);
  plan.pages.forEach((p, i) => {
    expect(p.index).toBe(i);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items[0]!.spacingBefore).toBe(0);
    const sum = p.items.reduce((n, item) => n + item.spacingBefore + itemHeight(plan, item, s, ctx), 0);
    expect(sum).toBeCloseTo(p.usedHeight, 6);
  });
  expect(plan.pages[0]!.items[0]!.kind).toBe("report-header");
  for (const section of plan.sections) {
    for (const row of section.rows) {
      expect(row.cells.reduce((n, c) => n + c.span, 0)).toBe(12);
      expect(row.cells.reduce((n, c) => n + c.width, 0) + (row.cells.length - 1) * plan.gap).toBe(plan.contentWidth);
      expect(row.height).toBe(Math.max(...row.cells.map((c) => c.height)));
    }
  }
}

function layout(s: ReportSpec, ctx: DataContext, opts: LayoutOptions): LayoutPlan {
  const plan = layoutReport(s, ctx, opts);
  check(plan, s, ctx);
  return plan;
}

const kinds = (items: PageItem[]): string[] => items.map((i) => (i.kind === "report-header" ? i.kind : `${i.kind}:${i.sectionId}`));

describe("layoutReport — web", () => {
  it("puts everything on a single page and never splits tables", () => {
    const ctx = context(table("big", 200));
    const s = spec({
      title: "Q3 review",
      page: { targetPages: 1 },
      sections: [
        { id: "a", title: "Overview", blocks: [text("t1"), { id: "c", type: "chart", chart: { kind: "line", data: "big", x: "name", y: "value" } }] },
        { id: "b", title: "Detail", breakBefore: true, blocks: [{ id: "tbl", type: "table", data: "big" }] },
      ],
    });
    const plan = layout(s, ctx, { mode: "web" });
    expect(plan.contentWidth).toBe(1040);
    expect(plan.page).toBeUndefined();
    expect(plan.pages).toHaveLength(1);
    expect(kinds(plan.pages[0]!.items)).toEqual(["report-header", "section-header:a", "row:a", "row:a", "section-header:b", "row:b"]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("honours a custom web content width and gap", () => {
    const s = spec({ title: "T", sections: [{ id: "a", layout: "thirds", blocks: [text("x"), text("y"), text("z")] }] });
    const plan = layout(s, context(), { mode: "web", contentWidth: 1203, gap: 24 });
    expect(plan.sections[0]!.rows[0]!.cells.map((c) => c.start)).toEqual([1, 5, 9]);
  });
});

describe("layoutReport — print", () => {
  it("uses page geometry and gives print different spans than web", () => {
    const s = spec({
      title: "T",
      sections: [{ id: "a", blocks: [{ id: "p", type: "chart", chart: { kind: "pie", data: "d", x: "name", y: "value" } }, { id: "c", type: "callout", content: "Hi" }, { id: "l", type: "list", items: [{ text: "x" }] }] }],
    });
    const ctx = context(table("d", 4));
    const web = layout(s, ctx, { mode: "web" });
    const print = layout(s, ctx, { mode: "print" });
    expect(print.page?.contentWidth).toBe(698);
    expect(print.contentWidth).toBe(698);
    expect(web.sections[0]!.rows.map((r) => r.cells.map((c) => c.span))).toEqual([[4, 4, 4]]);
    expect(print.sections[0]!.rows.map((r) => r.cells.map((c) => c.span))).toEqual([[6, 6], [12]]);
  });

  it("measured heights override estimates and change pagination", () => {
    const s = spec({ title: "T", sections: [{ id: "a", blocks: [text("x")] }, { id: "b", blocks: [text("y")] }] });
    const estimated = layout(s, context(), { mode: "print" });
    expect(estimated.pages).toHaveLength(1);
    const measured = layout(s, context(), { mode: "print", measured: { x: 700, y: 400 }, measuredReportHeader: 50 });
    expect(measured.reportHeaderHeight).toBe(50);
    expect(measured.sections[0]!.rows[0]!.cells[0]!.height).toBe(700);
    expect(measured.sections[0]!.rows[0]!.height).toBe(700);
    expect(measured.pages.map((p) => kinds(p.items))).toEqual([["report-header", "row:a"], ["row:b"]]);
    expect(measured.pages[0]!.usedHeight).toBe(750);
  });

  it("row height is the tallest cell", () => {
    const s = spec({ title: "T", sections: [{ id: "a", layout: "split", blocks: [text("x"), text("y")] }] });
    const plan = layout(s, context(), { mode: "print", measured: { x: 120, y: 300 } });
    expect(plan.sections[0]!.rows[0]!.height).toBe(300);
  });

  it("keeps a section header with its first row", () => {
    const s = spec({
      title: "T",
      sections: [
        { id: "a", title: "A", blocks: [text("x")] },
        { id: "b", title: "B", blocks: [text("y")] },
      ],
    });
    // Page 1: 100 + 40 + 700 = 840. Header B alone would fit (840 + 48 + 40 = 928) but not with its row (+200).
    const plan = layout(s, context(), { mode: "print", measuredReportHeader: 100, measuredHeaders: { a: 40, b: 40 }, measured: { x: 700, y: 200 } });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([
      ["report-header", "section-header:a", "row:a"],
      ["section-header:b", "row:b"],
    ]);
    expect(plan.pages[1]!.usedHeight).toBe(240);
  });

  it("spacingBefore follows gap/sectionGap rules and sums to usedHeight", () => {
    const ctx = context(table("big", 90));
    const s = spec({
      title: "Quarterly",
      subtitle: "Board pack",
      sections: [
        { id: "a", title: "Summary", blocks: [text("x"), text("y", "word ".repeat(130)), text("z")] },
        { id: "b", title: "Detail", description: "Every row.", blocks: [{ id: "tbl", type: "table", data: "big", title: "Orders", totals: true }] },
        { id: "c", title: "Notes", blocks: [text("n")] },
      ],
    });
    const plan = layout(s, ctx, { mode: "print" });
    const all = plan.pages.flatMap((p) => p.items.map((item, i) => ({ item, first: i === 0, prev: p.items[i - 1] })));
    for (const { item, first, prev } of all) {
      if (first || !prev || prev.kind === "report-header" || prev.kind === "section-header") expect(item.spacingBefore).toBe(0);
      else if (item.kind !== "section-header" && "sectionId" in prev && prev.sectionId === item.sectionId) expect(item.spacingBefore).toBe(METRICS.grid.gap);
      else expect(item.spacingBefore).toBe(METRICS.section.gap);
    }
    expect(all.some(({ item }) => item.spacingBefore === METRICS.section.gap)).toBe(true);
    expect(all.some(({ item }) => item.spacingBefore === METRICS.grid.gap)).toBe(true);
  });

  it("breakBefore starts a new page unless the page is empty", () => {
    const s = spec({
      title: "T",
      sections: [
        { id: "a", blocks: [text("x")] },
        { id: "b", breakBefore: true, blocks: [text("y")] },
        { id: "c", breakBefore: true, blocks: [] },
      ],
    });
    const plan = layout(s, context(), { mode: "print" });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "row:a"], ["row:b"]]);
  });

  it("splits a too-tall full-width table into slices covering [0, n) with repeated headers", () => {
    const ctx = context(table("big", 100));
    const s = spec({
      title: "T",
      sections: [
        { id: "a", blocks: [text("intro")] },
        { id: "b", title: "All orders", blocks: [{ id: "tbl", type: "table", data: "big", title: "Orders", totals: true }] },
      ],
    });
    const plan = layout(s, ctx, { mode: "print" });
    const slices = plan.pages.flatMap((p) => p.items.filter((i) => i.kind === "table-slice"));
    expect(slices.length).toBeGreaterThan(1);
    let next = 0;
    slices.forEach((sl, i) => {
      expect(sl.from).toBe(next);
      expect(sl.to - sl.from).toBeGreaterThanOrEqual(3);
      expect(sl.continued).toBe(i > 0);
      next = sl.to;
    });
    expect(next).toBe(100);
    // one slice per page, header stays with the first slice, nothing overflows
    for (const p of plan.pages) {
      expect(p.items.filter((i) => i.kind === "table-slice").length).toBeLessThanOrEqual(1);
      expect(p.usedHeight).toBeLessThanOrEqual(H);
    }
    const headerPage = plan.pages.find((p) => p.items.some((i) => i.kind === "section-header" && i.sectionId === "b"))!;
    expect(headerPage.items.at(-1)).toMatchObject({ kind: "table-slice", from: 0 });
    expect(plan.diagnostics).toEqual([]);
  });

  it("slice invariants hold across table sizes and starting offsets", () => {
    for (let n = 30; n <= 95; n += 1) {
      const ctx = context(table("big", n));
      const s = spec({ title: "T", sections: [{ id: "a", blocks: [{ id: "tbl", type: "table", data: "big", totals: true }] }] });
      for (const reportHeader of [80, 400, 900]) {
        const plan = layout(s, ctx, { mode: "print", measuredReportHeader: reportHeader });
        const slices = plan.pages.flatMap((p) => p.items.filter((i) => i.kind === "table-slice"));
        if (slices.length === 0) continue; // fits on one page
        let next = 0;
        for (const sl of slices) {
          expect(sl.from).toBe(next);
          expect(sl.to - sl.from).toBeGreaterThanOrEqual(3);
          next = sl.to;
        }
        expect(next).toBe(n);
        for (const p of plan.pages) expect(p.usedHeight).toBeLessThanOrEqual(H);
      }
    }
  });

  it("does not split tables with paginate: false or narrower than full width", () => {
    const ctx = context(table("big", 100));
    const s = spec({ title: "T", sections: [{ id: "a", blocks: [text("x"), { id: "tbl", type: "table", data: "big", paginate: false }, text("y")] }] });
    const plan = layout(s, ctx, { mode: "print" });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "row:a"], ["row:a"], ["row:a"]]);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: "block_too_tall", path: "sections[0].blocks[1]", severity: "warning" })]);
    expect(plan.diagnostics[0]!.hint).toMatch(/paginate/);
  });

  it("puts a too-tall non-table block alone on its own page with a warning", () => {
    // Long trailing text (> 500 chars) keeps the chart from pairing, so the chart is a row of its own.
    const blocks = [text("x"), { id: "c", type: "chart", height: "lg", chart: { kind: "line", data: "d", x: "a", y: "b" } }, text("z", "word ".repeat(120))];
    const s = spec({ title: "T", sections: [{ id: "a", title: "A", blocks }] });
    const plan = layout(s, context(), { mode: "print", measured: { c: 1500 } });
    const tallPage = plan.pages.find((p) => p.items.some((i) => i.kind === "row" && i.row === 1))!;
    expect(tallPage.items).toHaveLength(1);
    expect(tallPage.usedHeight).toBe(1500);
    expect(plan.pages).toHaveLength(3);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: "block_too_tall", path: "sections[0].blocks[1]" })]);
    expect(plan.diagnostics[0]!.hint).toMatch(/'sm'/);
  });

  it("a too-tall first block stays with its section header", () => {
    const s = spec({ title: "T", sections: [{ id: "a", blocks: [text("x")] }, { id: "b", title: "B", blocks: [text("y")] }] });
    const plan = layout(s, context(), { mode: "print", measured: { y: 1200 } });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "row:a"], ["section-header:b", "row:b"]]);
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["block_too_tall"]);
  });

  it("warns when targetPages is exceeded, naming the two tallest sections", () => {
    const s = spec({
      title: "T",
      page: { targetPages: 1 },
      sections: [
        { id: "a", title: "Revenue", blocks: [text("x")] },
        { id: "b", title: "Costs", blocks: [text("y")] },
        { id: "c", title: "Hiring", blocks: [text("z")] },
      ],
    });
    const plan = layout(s, context(), { mode: "print", measured: { x: 600, y: 900, z: 100 } });
    expect(plan.pages.length).toBeGreaterThan(1);
    const warning = plan.diagnostics.find((d) => d.code === "page_target_exceeded")!;
    expect(warning).toMatchObject({ severity: "warning", path: "page.targetPages" });
    expect(warning.hint).toContain('"Costs"');
    expect(warning.hint).toContain('"Revenue"');
    expect(warning.hint).not.toContain("Hiring");
    expect(warning.hint!.indexOf("Costs")).toBeLessThan(warning.hint!.indexOf("Revenue"));

    const ok = layout({ ...s, page: { ...s.page!, targetPages: 3 } }, context(), { mode: "print", measured: { x: 600, y: 900, z: 100 } });
    expect(ok.diagnostics).toEqual([]);
  });

  it("landscape Letter changes geometry", () => {
    const s = spec({ title: "T", page: { size: "Letter", orientation: "landscape" }, sections: [{ id: "a", blocks: [text("x")] }] });
    const plan = layout(s, context(), { mode: "print" });
    expect(plan.page).toMatchObject({ width: 1056, height: 816, contentWidth: 960, contentHeight: 720 });
    expect(plan.contentWidth).toBe(960);
  });
});
