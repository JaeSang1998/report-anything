import { describe, expect, it } from "vitest";
import type { DataContext } from "../data/types.js";
import { Block } from "../spec.js";
import { blockBox, chartPlotHeight, estimateBlockHeight, facetGrid, estimateReportHeader, estimateSectionHeader, markdownHeight, wrapLines } from "./estimate.js";
import { cellBox, pageGeometry } from "./geometry.js";
import { METRICS } from "./metrics.js";

const rows = Array.from({ length: 50 }, (_, i) => ({ name: `R${i}`, value: i }));
const ctx: DataContext = {
  locale: "en-US",
  currency: "USD",
  datasets: new Map([
    [
      "t",
      {
        id: "t",
        rows,
        fields: [
          { name: "name", type: "string", label: "Name" },
          { name: "value", type: "number", label: "Value" },
        ],
      },
    ],
  ]),
};
const block = (input: unknown): Block => Block.parse(input);

describe("pageGeometry", () => {
  it("returns A4 portrait by default and swaps for landscape", () => {
    expect(pageGeometry()).toEqual({ size: "A4", orientation: "portrait", width: 794, height: 1123, margin: 48, contentWidth: 698, contentHeight: 1027 });
    const letter = pageGeometry({ size: "Letter", orientation: "landscape" });
    expect([letter.width, letter.height, letter.contentWidth, letter.contentHeight]).toEqual([1056, 816, 960, 720]);
  });
});

describe("cellBox", () => {
  it("integer widths + gaps tile the content width exactly", () => {
    for (const width of [1040, 698, 777, 333]) {
      for (const spans of [[12], [8, 4], [7, 5], [4, 4, 4], [3, 3, 3, 3], [1, 2, 3, 6], Array.from({ length: 12 }, () => 1)]) {
        let start = 1;
        let x = 0;
        for (const span of spans) {
          const box = cellBox(start, span, width, 16);
          expect(Number.isInteger(box.width)).toBe(true);
          expect(box.x).toBe(x);
          x += box.width + 16;
          start += span;
        }
        expect(x - 16).toBe(width);
      }
    }
  });
});

describe("wrapLines / markdownHeight", () => {
  it("wraps more lines at narrower widths and counts empty text as 0", () => {
    const s = "The quick brown fox jumps over the lazy dog. ".repeat(8);
    expect(wrapLines("", 300, 14)).toBe(0);
    expect(wrapLines("Hello", 300, 14)).toBe(1);
    expect(wrapLines(s, 200, 14)).toBeGreaterThan(wrapLines(s, 600, 14));
  });

  it("measures CJK glyphs at 1em and breaks between them", () => {
    // 20 Hangul glyphs × 14px = 280px; 20 latin glyphs × 0.55 × 14 = 154px.
    expect(wrapLines("가".repeat(20), 200, 14)).toBe(2);
    expect(wrapLines("a".repeat(20), 200, 14)).toBe(1);
    // Same glyph count: Hangul words wrap to more lines than latin words.
    expect(wrapLines("가나다라 ".repeat(20), 200, 14)).toBeGreaterThan(wrapLines("abcd ".repeat(20), 200, 14));
  });

  it("counts a template placeholder as ~8 digit glyphs", () => {
    const width = 8 * METRICS.glyph.digit * 14;
    expect(wrapLines("{{ sum(sales.revenue) | currency:KRW }}", width, 14)).toBe(1);
    expect(wrapLines("{{ sum(sales.revenue) | currency:KRW }}", width - 1, 14)).toBe(2);
  });

  it("adds item gaps for bullets and paragraph gaps between paragraphs", () => {
    const L = METRICS.text.line;
    expect(markdownHeight("One line.", 400)).toBe(L);
    expect(markdownHeight("First para\ncontinues here.\n\nSecond.", 400)).toBe(2 * L + METRICS.text.paragraphGap);
    expect(markdownHeight("Intro\n- a\n- b\n- c", 400)).toBe(4 * L + METRICS.text.paragraphGap + 2 * METRICS.text.itemGap);
  });
});

describe("estimateBlockHeight", () => {
  it("chart: plot preset + legend + title + caption, no padding", () => {
    const sm = block({ id: "c", type: "chart", height: "sm", chart: { kind: "line", data: "t", x: "name", y: "value" } });
    expect(chartPlotHeight(sm as Extract<Block, { type: "chart" }>)).toBe(200);
    expect(estimateBlockHeight(sm, 500, ctx)).toBe(200);
    const lg = block({ id: "c", type: "chart", height: "lg", title: "Revenue", caption: "Source: ERP", chart: { kind: "bar", data: "t", x: "name", y: ["value", "value2"] } });
    expect(estimateBlockHeight(lg, 500, ctx)).toBe(
      METRICS.blockTitle.line + METRICS.blockTitle.marginBottom + 360 + METRICS.chart.legendBand + METRICS.caption.marginTop + METRICS.caption.line,
    );
  });

  it("kpi: items per row = floor((width + columnGap) / (minItemWidth + columnGap))", () => {
    const K = METRICS.kpi;
    const item = K.label.line + K.value.line + K.delta.line;
    const kpi = block({ id: "k", type: "kpi", items: ["a", "b", "c", "d"].map((label) => ({ label, value: 1 })) });
    expect(estimateBlockHeight(kpi, 1040, ctx)).toBe(item);
    // 4 items on one row need 4×minItemWidth + 3×columnGap; 2 per row below that; 1 per row below 2×min + gap.
    const oneRow = 4 * K.minItemWidth + 3 * K.columnGap;
    expect(estimateBlockHeight(kpi, oneRow, ctx)).toBe(item);
    expect(estimateBlockHeight(kpi, oneRow - 1, ctx)).toBe(2 * item + K.rowGap);
    expect(estimateBlockHeight(kpi, 2 * K.minItemWidth + K.columnGap - 1, ctx)).toBe(4 * item + 3 * K.rowGap);
    const extras = block({
      id: "k",
      type: "kpi",
      title: "Headline",
      items: [{ label: "a", value: 1, description: "d", sparkline: { data: "t", x: "name", y: "value" } }, { label: "b", value: 2 }],
    });
    expect(estimateBlockHeight(extras, 600, ctx)).toBe(METRICS.blockTitle.line + METRICS.blockTitle.marginBottom + item + K.description.line + K.sparkline);
  });

  it("table: title + header + min(rows, maxRows) × row + totals + truncation note", () => {
    const T = METRICS.table;
    expect(estimateBlockHeight(block({ id: "x", type: "table", data: "t" }), 600, ctx)).toBe(T.header + 50 * T.row);
    expect(estimateBlockHeight(block({ id: "x", type: "table", data: "t", maxRows: 10, totals: true, title: "Orders" }), 600, ctx)).toBe(
      METRICS.blockTitle.line + METRICS.blockTitle.marginBottom + T.header + 10 * T.row + T.totals + T.truncationNote,
    );
    expect(estimateBlockHeight(block({ id: "x", type: "table", data: "t", maxRows: 10, density: "compact" }), 600, ctx)).toBe(
      T.header + 10 * T.rowCompact + T.truncationNote,
    );
    // compact report density only shrinks table rows
    expect(estimateBlockHeight(block({ id: "x", type: "table", data: "t", maxRows: 5 }), 600, ctx, "compact")).toBe(T.header + 5 * T.rowCompact + T.truncationNote);
    const text = block({ id: "a", type: "text", content: "Short." });
    expect(estimateBlockHeight(text, 400, ctx, "compact")).toBe(estimateBlockHeight(text, 400, ctx));
  });

  it("paged (interactive web) table: one page of rows + pager; no pager when everything fits", () => {
    const T = METRICS.table;
    const est = (input: unknown) => estimateBlockHeight(block(input), 600, ctx, "comfortable", true);
    expect(est({ id: "x", type: "table", data: "t" })).toBe(T.header + 10 * T.row + T.pager);
    expect(est({ id: "x", type: "table", data: "t", maxRows: 20, totals: true })).toBe(T.header + 20 * T.row + T.totals + T.pager);
    // pageSize wins over maxRows (maxRows still caps the printed table)
    expect(est({ id: "x", type: "table", data: "t", maxRows: 20, pageSize: 5 })).toBe(T.header + 5 * T.row + T.pager);
    expect(estimateBlockHeight(block({ id: "x", type: "table", data: "t", maxRows: 20, pageSize: 5 }), 600, ctx)).toBe(T.header + 20 * T.row + T.truncationNote);
    expect(est({ id: "x", type: "table", data: "t", pageSize: 50 })).toBe(T.header + 50 * T.row);
  });

  it("text grows with content", () => {
    const short = estimateBlockHeight(block({ id: "a", type: "text", content: "Short." }), 400, ctx);
    const long = estimateBlockHeight(block({ id: "a", type: "text", content: "Longer sentence here. ".repeat(40) }), 400, ctx);
    expect(short).toBe(METRICS.text.line);
    expect(long).toBeGreaterThan(short);
  });

  it("callout: 16/26 body; a variant adds a label title line", () => {
    const C = METRICS.callout;
    const titleLine = METRICS.blockTitle.line + METRICS.blockTitle.marginBottom;
    expect(estimateBlockHeight(block({ id: "c", type: "callout", content: "Watch churn." }), 400, ctx)).toBe(C.line);
    expect(estimateBlockHeight(block({ id: "c", type: "callout", variant: "risk", content: "Watch churn." }), 400, ctx)).toBe(titleLine + C.line);
    // 30-char title fits one line alone but wraps once "Recommendation: " is prefixed
    const title = "Renewals concentrate in Q4 now";
    const width = 250;
    expect(estimateBlockHeight(block({ id: "c", type: "callout", title, content: "x" }), width, ctx)).toBe(titleLine + C.line);
    expect(estimateBlockHeight(block({ id: "c", type: "callout", title, variant: "recommendation", content: "x" }), width, ctx)).toBe(
      titleLine + METRICS.blockTitle.line + C.line,
    );
  });

  it("list: lines + detail lines + item gaps; a plain-text tag narrows the item text", () => {
    const L = METRICS.list;
    const list = block({ id: "l", type: "list", items: [{ text: "One" }, { text: "Two", detail: "More detail" }] });
    expect(estimateBlockHeight(list, 400, ctx)).toBe(2 * L.line + L.detailLine + L.itemGap);
    // "abcdefghij" (77px) fits 120px alone; the tag (71.5px + 8px gap) pushes it to two lines.
    const width = 120 + L.marker;
    expect(estimateBlockHeight(block({ id: "l", type: "list", items: [{ text: "abcdefghij" }] }), width, ctx)).toBe(L.line);
    expect(estimateBlockHeight(block({ id: "l", type: "list", items: [{ text: "abcdefghij", tag: "Owner: Kim" }] }), width, ctx)).toBe(2 * L.line);
  });

  it("comparison: header + one row per metric", () => {
    const cmp = block({ id: "m", type: "comparison", entities: ["A", "B"], metrics: [{ label: "x", values: [1, 2] }, { label: "y", values: [1, 2] }] });
    expect(estimateBlockHeight(cmp, 400, ctx)).toBe(METRICS.comparison.header + 2 * METRICS.comparison.row);
  });
});

describe("headers", () => {
  it("section header is 0 without title/description", () => {
    expect(estimateSectionHeader({}, 698)).toBe(0);
    expect(estimateSectionHeader({ title: "Revenue" }, 698)).toBe(METRICS.section.title + METRICS.section.marginBottom);
  });

  it("report header stacks title, subtitle, meta and summary", () => {
    const R = METRICS.reportHeader;
    expect(estimateReportHeader({ title: "Q3" }, 698)).toBe(R.titleLine + R.marginBottom);
    expect(estimateReportHeader({ title: "Q3", subtitle: "Board pack", summary: "Strong quarter.", meta: { author: "Ops" } }, 698)).toBe(
      R.titleLine + R.subtitleGap + R.subtitleLine + R.metaGap + R.metaLine + R.summaryGap + R.summaryLine + R.marginBottom,
    );
  });
});

describe("stat block", () => {
  const S = METRICS.stat;
  it("label + value, plus delta when there is a baseline, plus gap + description", () => {
    expect(estimateBlockHeight(block({ id: "s", type: "stat", label: "ARR", value: 1 }), 400, ctx)).toBe(S.label.line + S.value.line);
    expect(estimateBlockHeight(block({ id: "s", type: "stat", label: "ARR", value: 1, compareTo: 2 }), 400, ctx)).toBe(S.label.line + S.value.line + S.delta.line);
    expect(estimateBlockHeight(block({ id: "s", type: "stat", label: "ARR", value: 1, delta: 0.1, description: "Up." }), 400, ctx)).toBe(
      S.label.line + S.value.line + S.delta.line + S.gap + S.description.line,
    );
    // The description wraps at the cell width.
    const long = block({ id: "s", type: "stat", label: "ARR", value: 1, description: "Enterprise renewals carried the quarter. ".repeat(6) });
    expect(estimateBlockHeight(long, 300, ctx)).toBeGreaterThan(estimateBlockHeight(long, 900, ctx));
    expect(blockBox(long, 300, ctx)).toMatchObject({ body: 0, min: 0, max: 0 });
  });
});

describe("facetGrid", () => {
  const G = METRICS.chart.facetGap;
  const facet = (extra: object = {}) =>
    block({ id: "c", type: "chart", chart: { kind: "bar", data: "t", x: "value", y: "value", facet: "name", ...extra } }) as Extract<Block, { type: "chart" }>;

  it("panels = distinct facet values capped by facetLimit (default 12)", () => {
    expect(facetGrid(facet(), 1040, ctx).panels).toBe(12);
    expect(facetGrid(facet({ facetLimit: 5 }), 1040, ctx).panels).toBe(5);
  });

  it("columns = floor((width + gap) / (220 + gap)) within [1, 4] and ≤ panels; rows = ceil(panels / columns)", () => {
    expect(facetGrid(facet(), 1040, ctx)).toMatchObject({ columns: 4, rows: 3, panelHeight: METRICS.chart.facetPlot });
    expect(facetGrid(facet(), 3 * 220 + 2 * G, ctx)).toMatchObject({ columns: 3, rows: 4 });
    expect(facetGrid(facet(), 3 * 220 + 2 * G - 1, ctx)).toMatchObject({ columns: 2, rows: 6 });
    expect(facetGrid(facet(), 100, ctx)).toMatchObject({ columns: 1, rows: 12 });
    expect(facetGrid(facet({ facetLimit: 2 }), 1040, ctx)).toMatchObject({ columns: 2, rows: 1 });
  });

  it("derives the panel height from an assigned plotHeight", () => {
    expect(facetGrid(facet(), 1040, ctx, 3 * 180 + 2 * G).panelHeight).toBe(180);
  });

  it("estimates facet bodies from the grid and keeps them elastic in panel height", () => {
    const box = blockBox(facet(), 1040, ctx);
    expect(box).toEqual({ chrome: 0, body: 3 * METRICS.chart.facetPlot + 2 * G, min: 3 * 120 + 2 * G, max: 3 * 200 + 2 * G });
    expect(estimateBlockHeight(facet(), 1040, ctx)).toBe(box.body);
    // Kinds without small multiples ignore facet.
    const pie = block({ id: "p", type: "chart", chart: { kind: "pie", data: "t", x: "name", y: "value", facet: "name" } });
    expect(blockBox(pie, 1040, ctx).body).toBe(METRICS.chart.plot.md);
  });
});
