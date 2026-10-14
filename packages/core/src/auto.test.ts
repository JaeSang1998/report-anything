import { describe, expect, it } from "vitest";
import { autoReport } from "./auto.js";
import { evaluateMeasure } from "./data/measure.js";
import { createDataContext } from "./data/resolve.js";
import { renderTemplate } from "./data/template.js";
import type { DataContext } from "./data/types.js";
import { toNumber } from "./data/values.js";
import { ReportSpec } from "./spec.js";
import type { Block, ChartSpec, Measure } from "./spec.js";

const maxAbs = (ctx: DataContext, data: string, field: string) =>
  Math.max(0, ...ctx.datasets.get(data)!.rows.map((r) => Math.abs(toNumber(r[field]) ?? 0)));

/** Parse, resolve and render every template, and enforce the draft's reading-order invariants. */
function check(input: unknown, opts?: Parameters<typeof autoReport>[1]) {
  const draft = autoReport(input, opts);
  // Must be JSON-serializable as an agent would send it.
  const spec = ReportSpec.parse(JSON.parse(JSON.stringify(draft)));
  const { context, issues } = createDataContext(spec);
  expect(issues).toEqual([]);
  const blocks = spec.sections.flatMap((s) => s.blocks);
  const texts = [spec.summary ?? "", ...blocks.flatMap((b) => (b.type === "text" ? [b.content] : []))];
  for (const t of texts) {
    expect(t).toMatch(/\{\{/);
    expect(renderTemplate(t, context).issues).toEqual([]);
  }
  const ids = [...spec.sections.map((s) => s.id), ...blocks.map((b) => b.id), ...Object.keys(spec.datasets)];
  for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(new Set(ids).size).toBe(ids.length);

  const charts: ChartSpec[] = blocks.flatMap((b) => (b.type === "chart" ? [b.chart] : []));
  expect(charts.length).toBeLessThanOrEqual(3);
  // One chart per dimension: no two charts share an x field.
  expect(new Set(charts.map((c) => c.x)).size).toBe(charts.length);
  for (const c of charts) {
    // Measures sharing an axis stay within 10× of each other.
    if (Array.isArray(c.y)) {
      const scales = c.y.map((y) => maxAbs(context, c.data, y));
      expect(Math.max(...scales)).toBeLessThanOrEqual(10 * Math.min(...scales));
    }
    if (c.kind === "donut" || c.kind === "pie") expect(new Set(context.datasets.get(c.data)!.rows.map((r) => r[c.x])).size).toBeLessThanOrEqual(6);
  }
  // Every chart is followed by a text block that adds data, not a restated title.
  blocks.forEach((b, i) => {
    if (b.type !== "chart") return;
    const next = blocks[i + 1];
    expect(next?.type).toBe("text");
    if (next?.type === "text") expect(next.content).not.toContain(b.title ?? "\u0000");
  });
  const kpiItems = blocks.flatMap((b) => (b.type === "kpi" ? b.items : []));
  expect(kpiItems.length).toBeLessThanOrEqual(3);
  for (const k of kpiItems) {
    expect(k.sparkline).toBeUndefined();
    expect(isMeasure(k.value)).toBe(true);
    if (k.compareTo !== undefined) expect(isMeasure(k.compareTo)).toBe(true);
  }
  const table = blocks.find((b): b is Extract<Block, { type: "table" }> => b.type === "table")!;
  expect(table.maxRows).toBe(20);
  for (const col of table.columns ?? []) expect(col.emphasis).toBeUndefined();
  return { spec, context, blocks, charts, table, kpis: kpiItems };
}

const isMeasure = (v: unknown): v is Measure => typeof v === "object" && v !== null && "data" in v;
const textOf = (blocks: Block[], ctx: DataContext) =>
  blocks.flatMap((b) => (b.type === "text" ? [renderTemplate(b.content, ctx).text] : [])).join("\n");

describe("autoReport", () => {
  const monthly = ["2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03"].map((month, i) => ({
    month,
    revenue: 1000 + i * 100,
    orders: 50 + i,
    conversion_rate: 0.02 + i / 1000,
  }));

  it("(a) monthly sales array → headline KPI latest vs previous period, one trend with the rate on a secondary axis", () => {
    const { spec, context, charts, table, kpis } = check(monthly, { title: "Sales", locale: "ko-KR", currency: "krw" });
    expect(spec.title).toBe("Sales");
    expect(spec.meta).toEqual({ locale: "ko-KR", currency: "KRW" });
    expect(kpis.map((k) => k.label)).toEqual(["Revenue", "Records", "Orders"]);
    const revenue = kpis[0]!;
    expect(evaluateMeasure(revenue.value as Measure, context)).toBe(1500);
    expect(evaluateMeasure(revenue.compareTo as Measure, context)).toBe(1400);
    expect((revenue.compareTo as Measure).where).toBe("`month` == '2026-02-01'");
    expect(revenue.format).toBe("currency");
    // One row per month: a per-month record count would always be 1, so no comparison.
    expect(kpis[1]!.compareTo).toBeUndefined();
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ kind: "line", y: "revenue", secondary: { y: "conversion_rate", format: "percent" } });
    expect(table).toMatchObject({ data: "data", sortBy: "-month" });
    expect(textOf(spec.sections.flatMap((s) => s.blocks), context)).toMatch(/vs the previous month/);
  });

  it("aggregates daily raw rows into a monthly trend dataset", () => {
    const rows = Array.from({ length: 90 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      region: ["N", "S", "E"][i % 3]!,
      sales: 10 + (i % 7),
    }));
    const { spec, context, charts, kpis } = check({ sales: rows });
    const trend = Object.entries(spec.datasets).find(([id]) => id.endsWith("_trend"))!;
    expect(trend[1].transform![0]).toEqual({ op: "timeUnit", field: "date", unit: "month" });
    expect(context.datasets.get(trend[0])!.rows.map((r) => r.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    const sales = kpis.find((k) => k.label === "Sales")!;
    expect((sales.value as Measure).where).toBe("`date` == '2026-03-01'");
    expect(sales.deltaLabel).toMatch(/^vs /);
    // Record count for the latest month.
    expect(evaluateMeasure(kpis[1]!.value as Measure, context)).toBe(31);
    // Average per record compares raw rows within each period.
    const avg = kpis[2]!;
    expect(avg.label).toBe("Avg sales per record");
    expect((avg.compareTo as Measure).where).toBe("`date` >= '2026-02-01' and `date` < '2026-03-01'");
    expect(charts.map((c) => c.x)).toEqual(["date", "region"]);
  });

  it("orders API payload: no mixed-magnitude trend, no 2-category charts, splits stated in text", () => {
    const statuses = ["paid", "paid", "refunded"];
    const tiers = ["gold", "silver", "bronze", "platinum"];
    const countries = ["KR", "US", "JP", "DE", "FR"];
    const orders = Array.from({ length: 120 }, (_, i) => ({
      id: i + 1,
      created_at: new Date(Date.UTC(2026, 0, 1) + i * 0.75 * 86_400_000).toISOString(),
      status: statuses[i % 3]!,
      customer: { name: `Customer ${i % 40}`, tier: tiers[(i * 3) % 4]!, country: countries[(i * 7) % 5]! },
      items: Array.from({ length: 1 + (i % 3) }, (_, j) => ({ sku: `SKU-${(i + j) % 8}`, qty: 1 + j, price: 10 + ((i * j) % 30) })),
      total: 50 + ((i * 37) % 200),
    }));
    const { spec, context, blocks, charts, table, kpis } = check({ meta: { page: 1, total: 120 }, data: { orders } });
    // Headline is the amount, not the flattened `items.count`.
    expect(kpis.map((k) => (k.value as Measure).field)).toEqual(["total", "records", "total"]);
    expect(kpis[2]!.label).toBe("Avg total per record");
    expect(charts[0]).toMatchObject({ kind: "line", y: "total" });
    for (const c of charts) {
      expect([c.y].flat()).not.toContain("items.count");
      expect(c.x).not.toBe("status");
      expect(c.x).not.toBe("customer.name");
    }
    // The two-category status split is stated, with shares.
    expect(textOf(blocks, context)).toMatch(/\*\*Status:\*\* paid accounts for \d+(\.\d)?% of total/);
    expect(table.columns!.slice(0, 2).map((c) => c.field)).toEqual(["created_at", "id"]);
    expect(Object.keys(spec.datasets)).toContain("orders_items");
  });

  it("(b) nested JSON with orders/items → exploded items charted on their own amount", () => {
    const orders = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      placed_at: `2026-0${(i % 4) + 1}-1${i % 9}`,
      customer: { name: ["Ann", "Bob", "Cy"][i % 3], tier: i % 2 ? "gold" : "silver" },
      total: 100 + i * 7,
      items: [
        { sku: `S${i % 3}`, qty: 1 + (i % 2), price: 20 + i },
        { sku: "S9", qty: 1, price: 5 },
      ],
    }));
    const { spec, context, charts, kpis } = check({ meta: { page: 1 }, orders });
    expect(Object.keys(spec.datasets)).toEqual(expect.arrayContaining(["orders", "orders_items"]));
    expect(context.datasets.get("orders")!.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["customer.name", "items.count"]));
    expect(context.datasets.get("orders_items")!.rows).toHaveLength(16);
    // price × qty becomes the item amount.
    expect(spec.datasets.orders_items!.transform).toEqual([{ op: "derive", as: "items.amount", expr: "`items.price` * `items.qty`" }]);
    // The order-level dataset drives KPIs; exploded rows would double-count order totals.
    expect(kpis.every((k) => !(k.value as Measure).data.startsWith("orders_items"))).toBe(true);
    const itemCharts = charts.filter((c) => c.data.startsWith("orders_items"));
    expect(itemCharts).toHaveLength(1);
    expect(itemCharts[0]).toMatchObject({ x: "items.sku", y: "items.amount" });
  });

  it("(c) CSV string → derived amount headline and one chart per dimension", () => {
    const csv = ["product,category,price,units", "Widget,Tools,9.5,120", "Gadget,Tools,12,80", "Doohickey,Toys,3.25,300", "Gizmo,Toys,20,15", "Thing,Home,7,60"].join("\n");
    const { spec, context, charts, kpis } = check(csv);
    expect(spec.title).toBe("Data report");
    expect(spec.meta).toBeUndefined();
    expect(kpis.map((k) => k.label)).toEqual(["Amount", "Records", "Units"]);
    expect(evaluateMeasure(kpis[0]!.value as Measure, context)).toBe(3795);
    expect(kpis[1]!.value).toEqual({ data: "data", agg: "count" });
    expect(charts.map((c) => c.x).sort()).toEqual(["category", "product"]);
  });

  it("charts many-category dimensions as top 10 with the rest grouped", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ city: `City ${i % 30}`, revenue: 100 + (i % 30) * 10 }));
    const { charts } = check(rows);
    expect(charts).toEqual([expect.objectContaining({ kind: "bar", x: "city", limit: 10, others: true, horizontal: true })]);
  });

  it("handles an object of named CSV strings and arrays", () => {
    const { spec } = check({ targets: "team,goal\nA,10\nB,20", actuals: [{ team: "A", done: 7 }, { team: "B", done: 25 }] });
    expect(Object.keys(spec.datasets)).toEqual(expect.arrayContaining(["targets", "actuals"]));
  });
});
