import { describe, expect, it } from "vitest";
import type { DataContext } from "../data/types.js";
import { Block } from "../spec.js";
import type { BlockOf } from "../spec.js";
import { buildTableModel, pagerItems } from "./models.js";
import type { TableModel } from "./models.js";

/** 25 rows: id 0..24, score cycles 3,1,2 with a null every 5th row, team alternates. */
const rows = Array.from({ length: 25 }, (_, i) => ({ id: i, score: i % 5 === 4 ? null : [3, 1, 2][i % 3]!, team: i % 2 ? "b" : "a" }));
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
          { name: "id", type: "number" },
          { name: "score", type: "number" },
          { name: "team", type: "string" },
        ],
      },
    ],
  ]),
};
const table = (extra: Record<string, unknown> = {}): BlockOf<"table"> => {
  const b = Block.parse({ id: "x", type: "table", data: "t", ...extra });
  if (b.type !== "table") throw new Error("not a table");
  return b;
};
const ids = (m: TableModel) => m.rows.map((r) => r.cells[0]!.value);

describe("buildTableModel — paging", () => {
  it("pages through every row: first, middle, partial last page, clamped out-of-range pages", () => {
    const first = buildTableModel(table(), ctx, { page: 1 });
    expect(first.page).toEqual({ page: 1, pages: 3, from: 0, to: 10 });
    expect(ids(first)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first.hiddenRows).toBe(0);
    expect(ids(buildTableModel(table(), ctx, { page: 2 }))).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const last = buildTableModel(table(), ctx, { page: 3 });
    expect(last.page).toEqual({ page: 3, pages: 3, from: 20, to: 25 });
    expect(ids(last)).toEqual([20, 21, 22, 23, 24]);
    expect(buildTableModel(table(), ctx, { page: 99 }).page).toEqual(last.page);
    expect(buildTableModel(table(), ctx, { page: 0 }).page).toEqual(first.page);
  });

  it("page size is pageSize, else maxRows, else 10; an explicit option wins", () => {
    expect(buildTableModel(table({ maxRows: 20 }), ctx, { page: 2 }).page).toEqual({ page: 2, pages: 2, from: 20, to: 25 });
    expect(buildTableModel(table({ maxRows: 20, pageSize: 5 }), ctx, { page: 5 }).page).toEqual({ page: 5, pages: 5, from: 20, to: 25 });
    expect(buildTableModel(table(), ctx, { pageSize: 25 }).page).toEqual({ page: 1, pages: 1, from: 0, to: 25 });
  });

  it("an empty dataset is one empty page", () => {
    const empty: DataContext = { ...ctx, datasets: new Map([["t", { id: "t", rows: [], fields: [{ name: "id", type: "number" }] }]]) };
    expect(buildTableModel(table(), empty, { page: 3 }).page).toEqual({ page: 1, pages: 1, from: 0, to: 0 });
  });

  it("totals sum every row, not the page or the print cap", () => {
    const sum = rows.reduce((s, r) => s + (r.score ?? 0), 0);
    const totals = (m: TableModel) => m.totals?.find((c) => c.field === "score")?.value;
    expect(totals(buildTableModel(table({ totals: true }), ctx, { page: 3 }))).toBe(sum);
    expect(totals(buildTableModel(table({ totals: true, maxRows: 4 }), ctx))).toBe(sum);
  });

  it("row keys stay the dataset index across sorts and pages", () => {
    const m = buildTableModel(table(), ctx, { page: 1, sort: { field: "id", dir: "desc" } });
    expect(m.rows.map((r) => r.key)).toEqual(ids(m).map(String));
  });
});

describe("buildTableModel — sort", () => {
  const all = { pageSize: 25 };
  const scores = (m: TableModel) => m.rows.map((r) => r.cells[1]!.value);

  it("asc/desc keep nulls last and ties in dataset order (stable)", () => {
    const asc = buildTableModel(table(), ctx, { ...all, sort: { field: "score", dir: "asc" } });
    expect(scores(asc)).toEqual([...Array(6).fill(1), ...Array(7).fill(2), ...Array(7).fill(3), ...Array(5).fill(null)]);
    expect(ids(asc).slice(0, 6)).toEqual([1, 7, 10, 13, 16, 22]);
    const desc = buildTableModel(table(), ctx, { ...all, sort: { field: "score", dir: "desc" } });
    expect(scores(desc).slice(0, 7)).toEqual(Array(7).fill(3));
    expect(ids(desc).slice(0, 7)).toEqual([0, 3, 6, 12, 15, 18, 21]);
    expect(scores(desc).slice(-5)).toEqual(Array(5).fill(null));
    expect(ids(desc).slice(-5)).toEqual([4, 9, 14, 19, 24]);
  });

  it("no reader sort falls back to the spec's sortBy, which also breaks reader-sort ties", () => {
    expect(ids(buildTableModel(table({ sortBy: "-id" }), ctx, { page: 1 }))).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);
    const byTeam = buildTableModel(table({ sortBy: "-id" }), ctx, { ...all, sort: { field: "team", dir: "asc" } });
    expect(ids(byTeam).slice(0, 4)).toEqual([24, 22, 20, 18]);
    expect(ids(byTeam).slice(13, 16)).toEqual([23, 21, 19]);
  });

  it("print (no options) is unchanged: spec sort, maxRows cap, hidden count, no page", () => {
    const m = buildTableModel(table({ sortBy: "-id", maxRows: 4 }), ctx);
    expect(ids(m)).toEqual([24, 23, 22, 21]);
    expect(m.hiddenRows).toBe(21);
    expect(m.totalRows).toBe(25);
    expect(m.page).toBeUndefined();
  });
});

describe("pagerItems", () => {
  it("lists every page up to 7", () => {
    expect(pagerItems(1, 1)).toEqual([1]);
    expect(pagerItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("always 7 items around the current page, gaps hiding at least two pages", () => {
    expect(pagerItems(1, 14)).toEqual([1, 2, 3, 4, 5, null, 14]);
    expect(pagerItems(4, 14)).toEqual([1, 2, 3, 4, 5, null, 14]);
    expect(pagerItems(5, 14)).toEqual([1, null, 4, 5, 6, null, 14]);
    expect(pagerItems(11, 14)).toEqual([1, null, 10, 11, 12, 13, 14]);
    expect(pagerItems(14, 14)).toEqual([1, null, 10, 11, 12, 13, 14]);
    for (let pages = 8; pages <= 30; pages++) {
      for (let page = 1; page <= pages; page++) {
        const items = pagerItems(page, pages);
        expect(items).toHaveLength(7);
        expect(items).toContain(page);
        items.forEach((p, i) => {
          if (p !== null) return;
          expect((items[i + 1] as number) - (items[i - 1] as number)).toBeGreaterThanOrEqual(3);
        });
      }
    }
  });
});
