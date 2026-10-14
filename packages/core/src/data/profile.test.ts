import { describe, expect, it } from "vitest";
import type { Row } from "../spec.js";
import { profileDataset, rankMeasures, suggestCharts } from "./profile.js";
import { inferFields } from "./resolve.js";
import type { ResolvedDataset } from "./types.js";

const ds = (rows: Row[], id = "d"): ResolvedDataset => ({ id, rows, fields: inferFields(rows) });

const regions = ["North", "South", "East", "West"];
const sales = Array.from({ length: 24 }, (_, i) => ({
  order_id: `o${i}`,
  month: `2026-${String((i % 6) + 1).padStart(2, "0")}-01`,
  region: regions[i % 4]!,
  revenue: 100 + i * 10,
  margin_rate: 0.1 + (i % 5) / 100,
  units: i + 1,
}));

describe("profileDataset", () => {
  const p = profileDataset(ds(sales));
  const role = (name: string) => p.fields.find((f) => f.name === name)!;

  it("assigns semantic roles", () => {
    expect(role("order_id").role).toBe("identifier");
    expect(role("month").role).toBe("time");
    expect(role("region").role).toBe("dimension");
    expect(role("revenue").role).toBe("measure");
    expect(role("units").role).toBe("measure");
  });

  it("treats numeric year-like names as time and unique strings in big tables as identifiers", () => {
    const fields = profileDataset(ds(Array.from({ length: 20 }, (_, i) => ({ year: 2000 + i, name: `n${i}`, customerId: i, v: i })))).fields;
    expect(fields.map((f) => f.role)).toEqual(["time", "identifier", "identifier", "measure"]);
    // Small aggregated tables keep unique labels as dimensions.
    expect(profileDataset(ds([{ name: "a", v: 1 }, { name: "b", v: 2 }])).fields[0]!.role).toBe("dimension");
  });

  it("computes stats, top values and suggested formats", () => {
    expect(role("revenue")).toMatchObject({ count: 24, nulls: 0, distinct: 24, min: 100, max: 330, suggestedFormat: "currency" });
    expect(role("margin_rate").suggestedFormat).toBe("percent");
    expect(role("units").suggestedFormat).toBeUndefined();
    expect(role("region").top).toHaveLength(4);
    expect(role("region").top![0]).toEqual({ value: "North", count: 6 });
    expect(role("month")).toMatchObject({ min: "2026-01-01", max: "2026-06-01" });
    // Ratio-like name but values outside [-1.5, 1.5] → no percent.
    expect(profileDataset(ds([{ growth: 12.5 }, { growth: 3 }])).fields[0]!.suggestedFormat).toBeUndefined();
    expect(profileDataset(ds([{ 매출액: 10 }])).fields[0]!.suggestedFormat).toBe("currency");
  });
});

describe("rankMeasures", () => {
  it("puts amounts first, then plain numbers, per-unit values, ratios and flattened counts", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ "items.count": i, units: i, unit_price: 2.5 + i, conversion_rate: 0.1 + i / 100, total: 100 * i }));
    expect(rankMeasures(profileDataset(ds(rows)).fields).map((f) => f.name)).toEqual(["total", "units", "unit_price", "conversion_rate", "items.count"]);
  });
});

describe("suggestCharts", () => {
  it("ranks a time trend first and covers bar, donut, scatter with reasons", () => {
    const s = suggestCharts(ds(sales));
    expect(s[0]!.chart).toMatchObject({ kind: "line", x: "month", data: "d" });
    const kinds = s.map((x) => x.chart.kind);
    expect(kinds).toContain("bar");
    expect(kinds).toContain("donut");
    expect(kinds).toContain("scatter");
    expect(s.every((x) => x.reason.endsWith(".") && x.reason.length > 10)).toBe(true);
    expect([...s].sort((a, b) => b.score - a.score)).toEqual(s);
    expect(s.find((x) => x.chart.kind === "bar" && !x.chart.series)!.chart).toMatchObject({ x: "region", y: "revenue", sort: "-y" });
  });

  it("uses horizontal bars for long labels and limits many categories", () => {
    const long = ds(Array.from({ length: 5 }, (_, i) => ({ product: `A very long product name ${i}`, sales: i })));
    expect(suggestCharts(long).find((x) => x.chart.kind === "bar")!.chart.horizontal).toBe(true);
    const many = ds(Array.from({ length: 40 }, (_, i) => ({ city: `c${i % 20}`, v: i })));
    expect(suggestCharts(many).find((x) => x.chart.kind === "bar")!.chart).toMatchObject({ limit: 10, others: true });
  });

  it("suggests heatmap and stacked bars for two dimensions", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ region: regions[i % 4]!, channel: i % 2 ? "web" : "store", v: i }));
    const kinds = suggestCharts(ds(rows)).map((x) => `${x.chart.kind}${x.chart.stack ? "-stack" : ""}`);
    expect(kinds).toContain("heatmap");
    expect(kinds).toContain("bar-stack");
  });

  it("never puts measures of different magnitude on one line axis", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${i + 1}`, "items.count": 30 + i, total: 4000 + i * 100, net: 3500 + i }));
    const line = suggestCharts(ds(rows)).find((x) => x.chart.kind === "line")!;
    expect(line.chart.y).toEqual(["total", "net"]);
  });

  it("returns nothing without a measure", () => {
    expect(suggestCharts(ds([{ a: "x" }, { a: "y" }]))).toEqual([]);
  });
});
