import { describe, expect, it } from "vitest";
import { Dataset, ReportSpec } from "../spec.js";
import { createDataContext, inferFields, resolveDatasets } from "./resolve.js";

const parse = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Dataset.parse(v)]));

describe("inferFields", () => {
  it("unions keys in first-seen order and infers types by majority", () => {
    const fields = inferFields([
      { month: "2026-01", revenue: 10, ok: true, note: "a" },
      { month: "2026-02", revenue: "1,200", extra: 1, ok: false, note: "2026-01-01" },
      { month: null, revenue: "n/a", ok: null, note: "b" },
    ]);
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ["month", "date"],
      ["revenue", "number"],
      ["ok", "boolean"],
      ["note", "string"],
      ["extra", "number"],
    ]);
  });

  it("applies overrides for type, label and format; humanizes otherwise", () => {
    const [a, b] = inferFields([{ total_revenue: 1, year: 2024 }], [{ name: "year", type: "date", label: "Fiscal year", format: "date:year" }]);
    expect(a).toEqual({ name: "total_revenue", type: "number", label: "Total revenue" });
    expect(b).toEqual({ name: "year", type: "date", label: "Fiscal year", format: "date:year" });
  });
});

describe("resolveDatasets", () => {
  it("resolves in dependency order regardless of declaration order", () => {
    const { datasets, issues } = resolveDatasets(
      parse({
        enriched: { from: "base", transform: [{ op: "lookup", from: "managers", on: "region" }] },
        base: { csv: "region,revenue\nN,10\nS,20\nN,5", transform: [{ op: "aggregate", groupBy: ["region"], measures: [{ field: "revenue", agg: "sum", as: "revenue" }] }] },
        managers: { json: { data: [{ region: "N", manager: "Kim" }] } },
      }),
    );
    expect(issues).toEqual([]);
    expect(datasets.get("enriched")!.rows).toEqual([
      { region: "N", revenue: 15, manager: "Kim" },
      { region: "S", revenue: 20, manager: null },
    ]);
    expect(datasets.get("enriched")!.fields.map((f) => f.name)).toEqual(["region", "revenue", "manager"]);
  });

  it("loads json with path and unnest", () => {
    const { datasets } = resolveDatasets(parse({ items: { json: { res: { orders: [{ id: 1, items: [{ q: 1 }, { q: 2 }] }] } }, path: "res.orders", unnest: "items" } }));
    expect(datasets.get("items")!.rows).toEqual([
      { id: 1, "items.q": 1 },
      { id: 1, "items.q": 2 },
    ]);
  });

  it("reports cycles on every member and omits them", () => {
    const { datasets, issues } = resolveDatasets(
      parse({ a: { from: "b" }, b: { from: "a" }, ok: { rows: [{ x: 1 }] }, self: { from: "self" } }),
    );
    expect([...datasets.keys()]).toEqual(["ok"]);
    expect(issues.filter((i) => i.code === "dataset_cycle").map((i) => i.path).sort()).toEqual(["datasets.a", "datasets.b", "datasets.self"]);
    expect(issues.every((i) => i.code === "dataset_cycle")).toBe(true);
  });

  it("reports unknown datasets and dependants of failures", () => {
    const { datasets, issues } = resolveDatasets(parse({ sales: { rows: [{ x: 1 }] }, broken: { from: "sale" }, after: { from: "broken" } }));
    expect([...datasets.keys()]).toEqual(["sales"]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "unknown_dataset", path: "datasets.broken.from", hint: "did you mean 'sales'?" }));
    expect(issues).toContainEqual(expect.objectContaining({ code: "dataset_unavailable", path: "datasets.after.from" }));
  });

  it("points transform failures at the transform index with a hint", () => {
    const { datasets, issues } = resolveDatasets(
      parse({
        sales: {
          rows: [{ revenue: 1 }],
          transform: [{ op: "derive", as: "x", expr: "revenue * 2" }, { op: "filter", expr: "revenu > 0" }],
        },
        bad: { rows: [{ a: 1 }], transform: [{ op: "filter", expr: "a >" }] },
      }),
    );
    expect(datasets.size).toBe(0);
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", code: "unknown_field", path: "datasets.sales.transform[1]", hint: "did you mean 'revenue'?" }),
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: "bad_expression", path: "datasets.bad.transform[0]" }));
  });

  it("warns about field overrides that match nothing", () => {
    const { datasets, issues } = resolveDatasets(parse({ s: { rows: [{ revenue: 1 }], fields: [{ name: "revenu", format: "currency" }] } }));
    expect(datasets.has("s")).toBe(true);
    expect(issues).toEqual([expect.objectContaining({ severity: "warning", code: "unknown_field", hint: "did you mean 'revenue'?" })]);
  });
});

describe("createDataContext", () => {
  it("defaults locale and currency and honours spec.meta", () => {
    const spec = ReportSpec.parse({ title: "t", sections: [], datasets: { a: { rows: [{ x: 1 }] } } });
    expect(createDataContext(spec).context).toMatchObject({ locale: "en-US", currency: "USD" });
    const ko = ReportSpec.parse({ title: "t", sections: [], meta: { locale: "ko-KR", currency: "KRW" } });
    expect(createDataContext(ko).context).toMatchObject({ locale: "ko-KR", currency: "KRW" });
  });
});
