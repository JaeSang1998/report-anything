import { describe, expect, it } from "vitest";
import type { Row, Transform } from "../spec.js";
import { DataError } from "./errors.js";
import { applyTransforms } from "./transform.js";
import type { ResolvedDataset } from "./types.js";

const none = () => undefined;
const run = (rows: Row[], ...t: Transform[]) => applyTransforms(rows, t, none);

const sales: Row[] = [
  { region: "North", month: "2026-01-15", revenue: 100, units: 1 },
  { region: "South", month: "2026-01-20", revenue: 50, units: 2 },
  { region: "North", month: "2026-02-03", revenue: 150, units: 3 },
  { region: "South", month: "2026-02-10", revenue: null, units: 4 },
];

function errorOf(fn: () => unknown): DataError {
  try {
    fn();
  } catch (e) {
    if (e instanceof DataError) return e;
    throw e;
  }
  throw new Error("expected DataError");
}

describe("filter / derive", () => {
  it("filters on truthy expressions and derives fields", () => {
    expect(run(sales, { op: "filter", expr: "revenue >= 100" }).map((r) => r.revenue)).toEqual([100, 150]);
    expect(run(sales, { op: "derive", as: "avg", expr: "revenue / units" }).map((r) => r.avg)).toEqual([100, 25, 50, null]);
  });

  it("rejects unknown fields with a did-you-mean hint and bad expressions", () => {
    const e = errorOf(() => run(sales, { op: "filter", expr: "revenu > 1" }));
    expect(e.code).toBe("unknown_field");
    expect(e.hint).toBe("did you mean 'revenue'?");
    expect(errorOf(() => run(sales, { op: "derive", as: "x", expr: "revenue +" })).code).toBe("bad_expression");
  });

  it("passes empty input through", () => {
    expect(run([], { op: "filter", expr: "anything > 1" })).toEqual([]);
  });
});

describe("aggregate", () => {
  it("groups in first-seen order", () => {
    const out = run(sales, {
      op: "aggregate",
      groupBy: ["region"],
      measures: [
        { field: "revenue", agg: "sum", as: "revenue" },
        { agg: "count", as: "n" },
        { field: "units", agg: "max", as: "maxUnits" },
      ],
    });
    expect(out).toEqual([
      { region: "North", revenue: 250, n: 2, maxUnits: 3 },
      { region: "South", revenue: 50, n: 2, maxUnits: 4 },
    ]);
  });

  it("yields one total row for empty input without groupBy", () => {
    expect(run([], { op: "aggregate", groupBy: [], measures: [{ agg: "count", as: "n" }] })).toEqual([{ n: 0 }]);
    expect(run([], { op: "aggregate", groupBy: ["g"], measures: [{ agg: "count", as: "n" }] })).toEqual([]);
  });

  it("requires a field for non-count aggs", () => {
    expect(errorOf(() => run(sales, { op: "aggregate", groupBy: [], measures: [{ agg: "sum", as: "s" }] })).code).toBe("unknown_field");
  });
});

describe("sort / limit / top", () => {
  it("sorts descending with nulls last and limits with offset", () => {
    expect(run(sales, { op: "sort", by: "-revenue" }).map((r) => r.revenue)).toEqual([150, 100, 50, null]);
    expect(run(sales, { op: "sort", by: ["region", "-units"] }).map((r) => r.units)).toEqual([3, 1, 4, 2]);
    expect(run(sales, { op: "limit", count: 2, offset: 1 }).map((r) => r.units)).toEqual([2, 3]);
    expect(errorOf(() => run(sales, { op: "sort", by: "-units2" })).hint).toBe("did you mean 'units'?");
  });

  it("keeps the top n and buckets the rest into an others row", () => {
    const rows: Row[] = [
      { name: "a", v: 5, w: 1 },
      { name: "b", v: 9, w: 1 },
      { name: "c", v: 1, w: 1 },
      { name: "d", v: 3, w: 2 },
    ];
    expect(run(rows, { op: "top", n: 2, by: "v" }).map((r) => r.name)).toEqual(["b", "a"]);
    const out = run(rows, { op: "top", n: 2, by: "v", field: "name", othersLabel: "Other" });
    expect(out).toEqual([
      { name: "b", v: 9, w: 1 },
      { name: "a", v: 5, w: 1 },
      { name: "Other", v: 4, w: 3 },
    ]);
    // Nothing left over → no others row.
    expect(run(rows, { op: "top", n: 10, by: "v", othersLabel: "Other" })).toHaveLength(4);
  });
});

describe("fold / pivot", () => {
  it("folds wide to long with default and custom names", () => {
    const rows: Row[] = [{ m: "Jan", a: 1, b: 2 }];
    expect(run(rows, { op: "fold", fields: ["a", "b"] })).toEqual([
      { m: "Jan", key: "a", value: 1 },
      { m: "Jan", key: "b", value: 2 },
    ]);
    expect(run(rows, { op: "fold", fields: ["a"], as: ["metric", "amount"] })).toEqual([{ m: "Jan", b: 2, metric: "a", amount: 1 }]);
  });

  it("pivots long to wide with first-seen columns, sum default and null gaps", () => {
    const rows: Row[] = [
      { m: "Jan", k: "x", v: 1 },
      { m: "Jan", k: "x", v: 2 },
      { m: "Jan", k: "y", v: 5 },
      { m: "Feb", k: "y", v: 7 },
    ];
    expect(run(rows, { op: "pivot", index: ["m"], columns: "k", values: "v" })).toEqual([
      { m: "Jan", x: 3, y: 5 },
      { m: "Feb", x: null, y: 7 },
    ]);
    expect(run(rows, { op: "pivot", index: ["m"], columns: "k", values: "v", agg: "avg" })[0]).toEqual({ m: "Jan", x: 1.5, y: 5 });
  });
});

describe("timeUnit / bin", () => {
  it("truncates to ISO period starts (week = Monday)", () => {
    const rows: Row[] = [{ d: "2026-05-14" }, { d: "2026-05-17T23:00:00Z" }, { d: "bad" }, { d: 2024 }];
    const unit = (u: "year" | "quarter" | "month" | "week" | "day") => run(rows, { op: "timeUnit", field: "d", unit: u, as: "p" }).map((r) => r.p);
    expect(unit("week")).toEqual(["2026-05-11", "2026-05-11", null, "2024-01-01"]);
    expect(unit("month")).toEqual(["2026-05-01", "2026-05-01", null, "2024-01-01"]);
    expect(unit("quarter")).toEqual(["2026-04-01", "2026-04-01", null, "2024-01-01"]);
    expect(unit("year")[0]).toBe("2026-01-01");
    expect(unit("day")[1]).toBe("2026-05-17");
    // Default `as` overwrites the field.
    expect(run([{ d: "2026-05-14" }], { op: "timeUnit", field: "d", unit: "month" })).toEqual([{ d: "2026-05-01" }]);
  });

  it("bins with a nice step by default or an explicit step", () => {
    const rows: Row[] = [{ v: 0 }, { v: 37 }, { v: 100 }, { v: null }];
    expect(run(rows, { op: "bin", field: "v" }).map((r) => [r.v_bin, r.v_bin_end])).toEqual([
      [0, 10],
      [30, 40],
      [100, 110],
      [null, null],
    ]);
    expect(run(rows, { op: "bin", field: "v", bins: 4 }).map((r) => r.v_bin)).toEqual([0, 20, 100, null]);
    expect(run([{ v: 0.3 }], { op: "bin", field: "v", step: 0.1, as: "b" })).toEqual([{ v: 0.3, b: 0.3, b_end: 0.4 }]);
    expect(run([{ v: 5 }, { v: 5 }], { op: "bin", field: "v" })[0]).toMatchObject({ v_bin: 5, v_bin_end: 6 });
  });
});

describe("window", () => {
  const rows: Row[] = [
    { g: "a", t: 2, v: 20 },
    { g: "b", t: 1, v: 5 },
    { g: "a", t: 1, v: 10 },
    { g: "a", t: 3, v: 0 },
    { g: "b", t: 2, v: 5 },
  ];
  const w = (fn: "cumsum" | "diff" | "pctChange" | "share" | "rank" | "movingAvg" | "rowNumber", extra: object = {}) =>
    run(rows, { op: "window", fn, field: "v", as: "o", groupBy: ["g"], sortBy: "t", ...extra }).map((r) => r.o);

  it("computes within groups in sortBy order while keeping original row order", () => {
    expect(w("cumsum")).toEqual([30, 5, 10, 30, 10]);
    expect(w("diff")).toEqual([10, null, null, -20, 0]);
    expect(w("pctChange")).toEqual([1, null, null, -1, 0]);
    expect(w("share")).toEqual([20 / 30, 0.5, 10 / 30, 0, 0.5]);
    expect(w("rowNumber")).toEqual([2, 1, 1, 3, 2]);
    expect(w("movingAvg", { size: 2 })).toEqual([15, 5, 10, 10, 5]);
  });

  it("ranks largest first with shared ranks for ties", () => {
    expect(w("rank")).toEqual([1, 1, 2, 3, 1]);
    expect(run([{ v: 3 }, { v: 7 }, { v: 3 }, { v: null }, { v: 1 }], { op: "window", fn: "rank", field: "v", as: "r" }).map((r) => r.r)).toEqual([2, 1, 2, null, 4]);
  });

  it("returns null pctChange on a zero base and requires a field", () => {
    expect(run([{ v: 0 }, { v: 5 }], { op: "window", fn: "pctChange", field: "v", as: "p" }).map((r) => r.p)).toEqual([null, null]);
    expect(errorOf(() => run(rows, { op: "window", fn: "cumsum", as: "x" })).code).toBe("unknown_field");
  });
});

describe("lookup / select / rename", () => {
  const regions: ResolvedDataset = {
    id: "regions",
    rows: [
      { code: 1, manager: "Kim", tier: "A" },
      { code: 1, manager: "Duplicate", tier: "Z" },
      { code: 2, manager: "Lee", tier: "B" },
    ],
    fields: [
      { name: "code", type: "number", label: "Code" },
      { name: "manager", type: "string", label: "Manager" },
      { name: "tier", type: "string", label: "Tier" },
    ],
  };
  const lookup = (id: string) => (id === "regions" ? regions : undefined);

  it("left joins on matching keys, first match wins, missing → null", () => {
    const rows: Row[] = [{ r: "1" }, { r: 3 }, { r: null }];
    expect(applyTransforms(rows, [{ op: "lookup", from: "regions", on: ["r", "code"], fields: ["manager"] }], lookup)).toEqual([
      { r: "1", manager: "Kim" },
      { r: 3, manager: null },
      { r: null, manager: null },
    ]);
    expect(applyTransforms([{ code: 2 }], [{ op: "lookup", from: "regions", on: "code" }], lookup)).toEqual([{ code: 2, manager: "Lee", tier: "B" }]);
  });

  it("validates the joined dataset and its fields", () => {
    expect(errorOf(() => applyTransforms([{ code: 1 }], [{ op: "lookup", from: "nope", on: "code" }], lookup)).code).toBe("unknown_dataset");
    const e = errorOf(() => applyTransforms([{ code: 1 }], [{ op: "lookup", from: "regions", on: "code", fields: ["manger"] }], lookup));
    expect(e.hint).toBe("did you mean 'manager'?");
  });

  it("selects and renames with validation", () => {
    expect(run(sales.slice(0, 1), { op: "select", fields: ["revenue", "region"] })).toEqual([{ revenue: 100, region: "North" }]);
    expect(Object.keys(run(sales.slice(0, 1), { op: "rename", fields: { region: "area" } })[0]!)).toEqual(["area", "month", "revenue", "units"]);
    expect(errorOf(() => run(sales, { op: "select", fields: ["regoin"] })).hint).toBe("did you mean 'region'?");
    expect(errorOf(() => run(sales, { op: "rename", fields: { nope: "x" } })).code).toBe("unknown_field");
  });
});
