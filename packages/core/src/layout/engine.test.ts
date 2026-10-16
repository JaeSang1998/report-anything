import { describe, expect, it } from "vitest";
import type { DataContext, ResolvedDataset } from "../data/types.js";
import { ReportSpec } from "../spec.js";
import { paneGroups } from "./compose.js";
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
  const band = section.bands[item.band]!;
  if (item.kind === "band") return band.height;
  const block = s.sections.find((x) => x.id === item.sectionId)!.blocks.find((b) => b.id === item.blockId)!;
  if (block.type !== "table") throw new Error("slice of non-table");
  const t = tableMetrics(block, band.placements[0]!.width, ctx, s.theme?.density);
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
    for (const band of section.bands) {
      // Cells of the first row track span the content width exactly.
      const top = band.placements.filter((p) => p.row === 1);
      expect(top.reduce((n, p) => n + p.span, 0)).toBe(12);
      expect(top.reduce((n, p) => n + p.width, 0) + (top.length - 1) * plan.gap).toBe(plan.contentWidth);
      for (const p of band.placements) expect(p.height).toBeLessThanOrEqual(band.height + 0.5);
      if (band.rows === 1) expect(band.height).toBe(Math.max(...band.placements.map((p) => p.height)));
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
    // The short note sits beside the chart: one band.
    expect(kinds(plan.pages[0]!.items)).toEqual(["report-header", "section-header:a", "band:a", "section-header:b", "band:b"]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("honours a custom web content width and gap", () => {
    const s = spec({ title: "T", sections: [{ id: "a", layout: "thirds", blocks: [text("x"), text("y"), text("z")] }] });
    const plan = layout(s, context(), { mode: "web", contentWidth: 1203, gap: 24 });
    expect(plan.sections[0]!.bands[0]!.placements.map((p) => p.col)).toEqual([1, 5, 9]);
  });
});

describe("layoutReport — print", () => {
  it("uses page geometry and gives print different compositions than web", () => {
    const s = spec({
      title: "T",
      sections: [{ id: "a", blocks: [{ id: "p", type: "chart", chart: { kind: "pie", data: "d", x: "name", y: "value" } }, { id: "c", type: "callout", content: "Hi" }, { id: "l", type: "list", items: [{ text: "x" }] }] }],
    });
    const ctx = context(table("d", 4));
    const web = layout(s, ctx, { mode: "web" });
    const print = layout(s, ctx, { mode: "print" });
    expect(print.page?.contentWidth).toBe(698);
    expect(print.contentWidth).toBe(698);
    const compositions = (plan: LayoutPlan) => plan.sections[0]!.bands.map((b) => b.composition);
    expect(compositions(web)).toHaveLength(1);
    expect(compositions(print)).not.toEqual(compositions(web));
  });

  it("measured heights override estimates and change pagination", () => {
    const s = spec({ title: "T", sections: [{ id: "a", blocks: [text("x")] }, { id: "b", blocks: [text("y")] }] });
    const estimated = layout(s, context(), { mode: "print" });
    expect(estimated.pages).toHaveLength(1);
    const measured = layout(s, context(), { mode: "print", measured: { x: 700, y: 400 }, measuredReportHeader: 50 });
    expect(measured.reportHeaderHeight).toBe(50);
    expect(measured.sections[0]!.bands[0]!.placements[0]!.height).toBe(700);
    expect(measured.sections[0]!.bands[0]!.height).toBe(700);
    expect(measured.pages.map((p) => kinds(p.items))).toEqual([["report-header", "band:a"], ["band:b"]]);
    expect(measured.pages[0]!.usedHeight).toBe(750);
  });

  it("a single-track band is as tall as its tallest block", () => {
    const s = spec({ title: "T", sections: [{ id: "a", layout: "split", blocks: [text("x"), text("y")] }] });
    const plan = layout(s, context(), { mode: "print", measured: { x: 120, y: 300 } });
    expect(plan.sections[0]!.bands[0]!.height).toBe(300);
  });

  it("keeps a section header with its first band", () => {
    const s = spec({
      title: "T",
      sections: [
        { id: "a", title: "A", blocks: [text("x")] },
        { id: "b", title: "B", blocks: [text("y")] },
      ],
    });
    // Page 1: 100 + 40 + 700 = 840. Header B alone would fit (840 + 48 + 40 = 928) but not with its band (+200).
    const plan = layout(s, context(), { mode: "print", measuredReportHeader: 100, measuredHeaders: { a: 40, b: 40 }, measured: { x: 700, y: 200 } });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([
      ["report-header", "section-header:a", "band:a"],
      ["section-header:b", "band:b"],
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
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "band:a"], ["band:b"]]);
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
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "band:a"], ["band:a"], ["band:a"]]);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: "block_too_tall", path: "sections[0].blocks[1]", severity: "warning" })]);
    expect(plan.diagnostics[0]!.hint).toMatch(/paginate/);
  });

  it("puts a too-tall non-table block alone on its own page with a warning", () => {
    // A band taller than the page cannot hold several blocks, so the chart gets a band of its own.
    const blocks = [text("x"), { id: "c", type: "chart", height: "lg", chart: { kind: "line", data: "d", x: "a", y: "b" } }, text("z", "word ".repeat(120))];
    const s = spec({ title: "T", sections: [{ id: "a", title: "A", blocks }] });
    // Measured chart chrome (title, legend, caption) of 1500px; the plot body is solved on top of it.
    const plan = layout(s, context(), { mode: "print", measured: { c: 1500 } });
    const band = plan.sections[0]!.bands.findIndex((b) => b.placements.some((p) => p.blockId === "c"));
    expect(plan.sections[0]!.bands[band]!.placements).toHaveLength(1);
    const tallPage = plan.pages.find((p) => p.items.some((i) => i.kind === "band" && i.band === band))!;
    expect(tallPage.items).toHaveLength(1);
    expect(tallPage.usedHeight).toBe(plan.sections[0]!.bands[band]!.height);
    expect(tallPage.usedHeight).toBeGreaterThan(1500);
    expect(plan.pages).toHaveLength(3);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: "block_too_tall", path: "sections[0].blocks[1]" })]);
    expect(plan.diagnostics[0]!.hint).toMatch(/'sm'/);
  });

  it("a too-tall first block stays with its section header", () => {
    const s = spec({ title: "T", sections: [{ id: "a", blocks: [text("x")] }, { id: "b", title: "B", blocks: [text("y")] }] });
    const plan = layout(s, context(), { mode: "print", measured: { y: 1200 } });
    expect(plan.pages.map((p) => kinds(p.items))).toEqual([["report-header", "band:a"], ["section-header:b", "band:b"]]);
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

describe("layoutReport — slides", () => {
  const SLIDE_H = 540 - 2 * 40;
  const chart = (id: string) => ({ id, type: "chart", chart: { kind: "line", data: "big", x: "name", y: "value" } });
  const deck = spec({
    title: "Quarterly review",
    subtitle: "Board deck",
    summary: "Revenue grew while churn held.",
    page: { targetPages: 1 },
    sections: [
      { id: "a", title: "Overview", blocks: [text("t1"), chart("c1"), text("t2", "word ".repeat(60)), chart("c2")] },
      { id: "b", title: "Detail", blocks: [{ id: "tbl", type: "table", data: "big", title: "Orders", totals: true }] },
      { id: "c", title: "Next steps", blocks: [text("t3")] },
    ],
  });
  const ctx = context(table("big", 120));

  it("uses a 16:9 canvas: title slide, every section on a new slide, nothing overflows", () => {
    const plan = layout(deck, ctx, { mode: "slides" });
    expect(plan.page).toMatchObject({ size: "slide", width: 960, height: 540, contentWidth: 960 - 80, contentHeight: SLIDE_H });
    expect(plan.contentWidth).toBe(880);
    expect(kinds(plan.pages[0]!.items)).toEqual(["report-header"]);
    for (const p of plan.pages) expect(p.usedHeight).toBeLessThanOrEqual(SLIDE_H);
    for (const id of ["a", "b", "c"]) {
      const first = plan.pages.find((p) => p.items.some((i) => i.kind !== "report-header" && i.sectionId === id))!;
      expect(first.items[0]).toMatchObject({ kind: "section-header", sectionId: id, spacingBefore: 0 });
    }
    // No slide mixes sections; targetPages is a print budget.
    for (const p of plan.pages.slice(1)) expect(new Set(p.items.map((i) => (i.kind === "report-header" ? "" : i.sectionId))).size).toBe(1);
    expect(plan.diagnostics).toEqual([]);
  });

  it("slices a long table across slides, each slice with its own header row", () => {
    const plan = layout(deck, ctx, { mode: "slides" });
    const slides = plan.pages.filter((p) => p.items.some((i) => i.kind === "table-slice"));
    expect(slides.length).toBeGreaterThan(1);
    const block = deck.sections[1]!.blocks[0]!;
    if (block.type !== "table") throw new Error("table expected");
    const t = tableMetrics(block, plan.contentWidth, ctx, "comfortable");
    let next = 0;
    slides.forEach((p, k) => {
      const slice = p.items.find((i) => i.kind === "table-slice")!;
      if (slice.kind !== "table-slice") throw new Error("slice expected");
      expect(slice).toMatchObject({ from: next, continued: k > 0 });
      const rows = slice.to - slice.from;
      // Header row accounted on every slide (the renderer repeats it); totals only on the last.
      const own = t.top + t.header + rows * t.row + (slice.to === t.rows ? t.footer : 0);
      const header = k === 0 ? plan.sections[1]!.headerHeight : 0;
      expect(p.usedHeight).toBeCloseTo(header + own, 6);
      next = slice.to;
    });
    expect(next).toBe(120);
  });

  it("warns block_too_tall in slide terms when a band cannot fit one slide", () => {
    const s = spec({ title: "T", sections: [{ id: "a", title: "A", blocks: [text("x", "word ".repeat(40))] }] });
    const plan = layout(s, context(), { mode: "slides", measured: { x: 900 } });
    expect(plan.diagnostics).toEqual([expect.objectContaining({ code: "block_too_tall", path: "sections[0].blocks[0]" })]);
    expect(plan.diagnostics[0]!.message).toMatch(/slide/);
  });

  it("is deterministic", () => {
    expect(layoutReport(deck, ctx, { mode: "slides" })).toEqual(layoutReport(deck, ctx, { mode: "slides" }));
  });
});

describe("layoutReport — section views", () => {
  const chart = (id: string, title: string) => ({ id, type: "chart", title, chart: { kind: "line", data: "big", x: "name", y: "value" } });
  const blocks = [text("t0"), chart("c1", "Trend"), text("t1"), chart("c2", "Mix")];
  const ctx = context(table("big", 6));
  const withView = (view?: "tabs" | "carousel", list: unknown[] = blocks) => spec({ title: "T", sections: [{ id: "a", title: "A", ...(view ? { view } : {}), blocks: list }] });
  const ids = (plan: LayoutPlan, from: number, to: number) => plan.sections[0]!.bands.slice(from, to).flatMap((b) => b.placements.map((p) => p.blockId));

  it("groups each non-narrative block with the narrative blocks after it; leading narrative joins the first pane", () => {
    const types = (list: unknown[]) => paneGroups(spec({ title: "T", sections: [{ id: "a", blocks: list }] }).sections[0]!.blocks).map((g) => g.map((b) => b.id));
    expect(types(blocks)).toEqual([["t0", "c1", "t1"], ["c2"]]);
    expect(types([chart("c1", "A"), text("t1"), { id: "l1", type: "list", items: [{ text: "x" }] }, { id: "k", type: "kpi", items: [{ label: "K", value: 1 }] }])).toEqual([["c1", "t1", "l1"], ["k"]]);
    expect(types([text("t0"), text("t1")])).toEqual([["t0", "t1"]]);
    expect(types([])).toEqual([]);
  });

  it("composes each pane with the flow solver and labels it by its first non-narrative block", () => {
    for (const view of ["tabs", "carousel"] as const) {
      const plan = layout(withView(view), ctx, { mode: "web" });
      const { bands, panes } = plan.sections[0]!;
      expect(panes?.map((p) => p.labelBlockId)).toEqual(["c1", "c2"]);
      expect(panes![0]!.from).toBe(0);
      expect(panes![0]!.to).toBe(panes![1]!.from);
      expect(panes![1]!.to).toBe(bands.length);
      expect(ids(plan, panes![0]!.from, panes![0]!.to)).toEqual(["t0", "c1", "t1"]);
      expect(ids(plan, panes![1]!.from, panes![1]!.to)).toEqual(["c2"]);
      expect(bands[panes![1]!.from]!.placements[0]).toMatchObject({ col: 1, span: 12, width: plan.contentWidth });
      expect(bands[panes![1]!.from]!.placements[0]!.plotHeight).toBeGreaterThan(0);
    }
    // A carousel pane (titles kept) is exactly the flow composition of its blocks.
    const carousel = layout(withView("carousel"), ctx, { mode: "web" }).sections[0]!;
    const firstPane = layout(withView(undefined, blocks.slice(0, 3)), ctx, { mode: "web" }).sections[0]!.bands;
    expect(carousel.bands.slice(0, carousel.panes![0]!.to)).toEqual(firstPane);
  });

  it("composes tabs/carousel sections as flow in print, slides and static web output", () => {
    const flowWeb = layout(withView(), ctx, { mode: "web" }).sections;
    for (const view of ["tabs", "carousel"] as const) {
      const staticWeb = layout(withView(view), ctx, { mode: "web", interactive: false }).sections;
      expect(staticWeb[0]!.panes).toBeUndefined();
      expect(staticWeb).toEqual(flowWeb);
      expect(layout(withView(view), ctx, { mode: "print" }).sections).toEqual(layout(withView(), ctx, { mode: "print" }).sections);
      expect(layout(withView(view), ctx, { mode: "slides" }).sections).toEqual(layout(withView(), ctx, { mode: "slides" }).sections);
    }
  });

  it("sizes a tab pane without its label block's title (the tab shows it); carousel slides keep it", () => {
    const last = (view: "tabs" | "carousel") => layout(withView(view), ctx, { mode: "web" }).sections[0]!.bands.at(-1)!;
    const tabs = last("tabs");
    const carousel = last("carousel");
    expect(tabs.placements[0]!.blockId).toBe("c2");
    expect(tabs.placements[0]!.plotHeight).toBe(carousel.placements[0]!.plotHeight);
    expect(carousel.height - tabs.height).toBe(METRICS.blockTitle.line + METRICS.blockTitle.marginBottom);
  });
});
