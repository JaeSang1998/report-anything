import { describe, expect, it } from "vitest";
import { autoReport } from "./auto.js";
import type { Archetype, AutoReportOptions } from "./auto.js";
import { buildChart } from "./chart/build.js";
import { buildFacetCharts } from "./chart/facet.js";
import { chartToSvg } from "./chart/svg.js";
import { evaluateMeasure } from "./data/measure.js";
import { isStockMeasure } from "./data/profile.js";
import { createDataContext } from "./data/resolve.js";
import { renderTemplate } from "./data/template.js";
import type { DataContext } from "./data/types.js";
import { toNumber } from "./data/values.js";
import { inspectReport } from "./inspect.js";
import { METRICS } from "./layout/metrics.js";
import { ReportSpec } from "./spec.js";
import type { Block, ChartSpec, Measure, Row } from "./spec.js";
import { validateReport } from "./validate.js";
import { ordersPayload, saasRows, salesRows, ticketRows, trafficCsv } from "../../../examples/playground/src/samples.js";

const maxAbs = (ctx: DataContext, data: string, field: string) =>
  Math.max(0, ...ctx.datasets.get(data)!.rows.map((r) => Math.abs(toNumber(r[field]) ?? 0)));

/** Invariants of every archetype: valid spec, resolvable data, bound numbers, unique ids, no level metric summed across periods. */
function checkDraft(input: unknown, opts?: AutoReportOptions) {
  const draft = autoReport(input, opts);
  // Must be JSON-serializable as an agent would send it.
  const spec = ReportSpec.parse(JSON.parse(JSON.stringify(draft)));
  const { context, issues } = createDataContext(spec);
  expect(issues).toEqual([]);
  expect(validateReport(spec).issues.filter((i) => i.severity === "error")).toEqual([]);
  const blocks = spec.sections.flatMap((s) => s.blocks);
  const texts = [spec.summary ?? "", ...blocks.flatMap((b) => (b.type === "text" || b.type === "callout" ? [b.content] : []))];
  for (const t of texts) {
    expect(t).toMatch(/\{\{/);
    expect(renderTemplate(t, context).issues).toEqual([]);
  }
  const ids = [...spec.sections.map((s) => s.id), ...blocks.map((b) => b.id), ...Object.keys(spec.datasets)];
  for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  expect(new Set(ids).size).toBe(ids.length);
  const values = blocks.flatMap((b) =>
    b.type === "kpi"
      ? b.items.flatMap((k) => [k.value, ...(k.compareTo === undefined ? [] : [k.compareTo])])
      : b.type === "stat"
        ? [b.value, ...(b.compareTo === undefined ? [] : [b.compareTo])]
        : b.type === "comparison"
          ? b.metrics.flatMap((m) => m.values)
          : [],
  );
  for (const v of values) expect(isMeasure(v)).toBe(true);
  // Aggregation sanity: rates are never summed; level metrics are never summed across periods.
  for (const [id, ds] of Object.entries(spec.datasets)) {
    const source = ds.from === undefined ? undefined : context.datasets.get(ds.from);
    if (!source) continue;
    const times = source.fields.filter((f) => f.type === "date" || /month|week|year/.test(f.name)).map((f) => f.name);
    (ds.transform ?? []).forEach((t, i) => {
      if (t.op !== "aggregate") return;
      for (const m of t.measures) {
        const f = source.fields.find((x) => x.name === m.field);
        if (f?.format === "percent" || /rate|ratio/.test(m.field ?? "")) expect(m.agg, `${id}: ${m.field}`).not.toBe("sum");
        if (m.agg !== "sum" || !m.field || !isStockMeasure(m.field) || t.groupBy.some((g) => times.includes(g))) continue;
        const pinned = (ds.transform ?? []).slice(0, i).some((p) => p.op === "filter" && times.some((tf) => p.expr.startsWith(`\`${tf}\` ==`)));
        expect(pinned, `${id} sums level metric ${m.field} across periods`).toBe(true);
      }
    });
  }
  const charts: ChartSpec[] = blocks.flatMap((b) => (b.type === "chart" ? [b.chart] : []));
  // Every chart renders with data and without engine complaints (wrong encodings, ignored options).
  for (const c of charts) {
    if (c.facet !== undefined) {
      const facets = buildFacetCharts(c, context, { width: 640, panelHeight: METRICS.chart.facetPlot, columns: 3 });
      expect(facets.panels.length, `facet ${c.data}`).toBeGreaterThan(1);
      expect(facets.warnings, `facet ${c.data}`).toEqual([]);
      continue;
    }
    const model = buildChart(c, context, { width: 640, height: 320 });
    expect(model.empty, `${c.kind} ${c.data}`).toBe(false);
    expect(model.warnings, `${c.kind} ${c.data}`).toEqual([]);
    expect(chartToSvg(model)).toMatch(/^<svg/);
  }
  return { spec, context, blocks, charts };
}

/** checkDraft plus the overview's reading-order invariants. */
function check(input: unknown, opts?: AutoReportOptions) {
  const { spec, context, blocks, charts } = checkDraft(input, opts);
  expect(charts.length).toBeLessThanOrEqual(3);
  // One chart per dimension: no two charts share an x field (small multiples count for their facet dimension).
  expect(new Set(charts.map((c) => c.facet ?? c.x)).size).toBe(charts.length);
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
  // The headline stat (when present) and the KPI strip are one set of figures, headline first.
  const kpiItems = blocks.flatMap((b) => (b.type === "stat" ? [b] : b.type === "kpi" ? b.items : []));
  expect(kpiItems.length).toBeLessThanOrEqual(3);
  for (const k of kpiItems) expect("sparkline" in k ? k.sparkline : undefined).toBeUndefined();
  const table = blocks.find((b): b is Extract<Block, { type: "table" }> => b.type === "table" && b.id === "detail_table")!;
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
    // One row per month is a pre-aggregated table: no record-count KPI.
    expect(kpis.map((k) => k.label)).toEqual(["Revenue", "Orders", "Avg conversion rate"]);
    const revenue = kpis[0]!;
    expect(evaluateMeasure(revenue.value as Measure, context)).toBe(1500);
    expect(evaluateMeasure(revenue.compareTo as Measure, context)).toBe(1400);
    expect((revenue.compareTo as Measure).where).toBe("`month` == '2026-02-01'");
    expect(revenue.format).toBe("currency:0");
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
    expect(kpis.map((k) => k.label)).toEqual(["Amount", "Units"]);
    expect(evaluateMeasure(kpis[0]!.value as Measure, context)).toBe(3795);
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
  describe("playground samples", () => {
    const kpiFields = (kpis: Array<{ value: unknown }>) => kpis.map((k) => (k.value as Measure).field ?? "count");

    it("SaaS: MRR headline, level metrics shown as the latest snapshot, churn rate averaged", () => {
      const { spec, context, charts, kpis, blocks } = check(saasRows());
      expect(kpis.map((k) => k.label)).toEqual(["MRR", "Customers", "Avg logo churn rate"]);
      expect(kpis[0]!.format).toBe("currency:0");
      expect(kpis[2]).toMatchObject({ format: "percent", goodWhen: "down" });
      const latestMrr = evaluateMeasure(kpis[0]!.value as Measure, context) as number;
      const sep = saasRows().filter((r) => r.month === "2026-09-01");
      expect(latestMrr).toBe(sep.reduce((a, r) => a + (r.mrr as number), 0));
      expect(evaluateMeasure(kpis[1]!.value as Measure, context)).toBe(sep.reduce((a, r) => a + (r.customers as number), 0));
      // The plan breakdown shows the latest month only, so its total equals the latest MRR.
      const byPlan = charts.find((c) => c.x === "plan")!;
      expect(byPlan.y).toBe("mrr");
      expect(context.datasets.get(byPlan.data)!.rows.reduce((a, r) => a + (r.mrr as number), 0)).toBe(latestMrr);
      expect(blocks.find((b) => b.type === "chart" && b.chart.x === "plan")!.title).toMatch(/latest month$/);
      // Acronym-aware labels reach the renderer through field overrides.
      expect(context.datasets.get("data")!.fields.find((f) => f.name === "new_mrr")!.label).toBe("New MRR");
      expect(spec.datasets.data!.fields).toContainEqual({ name: "mrr", format: "currency:0", label: "MRR" });
    });

    it("sales cross-tab: no record count, revenue headline", () => {
      const { kpis, charts } = check(salesRows());
      expect(kpis.map((k) => k.label)).toEqual(["Revenue", "Orders"]);
      expect(charts[0]).toMatchObject({ kind: "line", y: "revenue" });
    });

    it("traffic CSV: weekly trend with a derived conversion rate that is computed, never summed", () => {
      const { spec, context, charts, kpis } = check(trafficCsv());
      expect(kpis.map((k) => k.label)).toEqual(["Sessions", "Signups", "Conversion rate"]);
      const trendId = charts[0]!.data;
      expect(charts[0]).toMatchObject({ kind: "line", x: "week", y: "sessions", secondary: { y: "conversion_rate", format: "percent" } });
      expect(spec.datasets[trendId]!.transform).toContainEqual({ op: "derive", as: "conversion_rate", expr: "`signups` / `sessions`" });
      const last = context.datasets.get(trendId)!.rows.at(-1)!;
      expect(last.conversion_rate).toBeCloseTo((last.signups as number) / (last.sessions as number), 12);
      expect(evaluateMeasure(kpis[2]!.value as Measure, context)).toBeCloseTo(last.conversion_rate as number, 12);
      const byChannel = charts.find((c) => c.x === "channel")!;
      const email = context.datasets.get(byChannel.data)!.rows.find((r) => r.channel === "Email")!;
      expect(email.conversion_rate).toBeCloseTo((email.signups as number) / (email.sessions as number), 12);
    });

    it("tickets: count headline for events whose measures are durations and scores", () => {
      const { kpis, charts } = check(ticketRows());
      expect(kpiFields(kpis)).toEqual(["records", "first_response_minutes", "resolution_hours"]);
      expect(kpis.slice(1).every((k) => k.goodWhen === "down" && k.label.startsWith("Avg "))).toBe(true);
      expect(charts[0]).toMatchObject({ kind: "line", y: "records" });
      expect(charts.some((c) => c.x === "status")).toBe(false);
    });

    it("orders payload: identifier rows are events, so the record count is a KPI", () => {
      const { kpis } = check(ordersPayload());
      expect(kpiFields(kpis)).toEqual(["total", "records", "total"]);
    });
  });
});

describe("autoReport archetypes", () => {
  const ARCHETYPES: Archetype[] = ["overview", "brief", "trend", "compare", "breakdown", "bridge"];
  const SAMPLES: Record<string, () => unknown> = { salesRows, saasRows, trafficCsv, ticketRows, ordersPayload };
  /** Multiset of block types / chart kinds: what a reader sees, regardless of order. */
  const shape = (blocks: Block[]) =>
    blocks
      .map((b) => (b.type === "chart" ? `chart:${b.chart.kind}` : b.type))
      .sort()
      .join(",");
  const sum = (rows: Row[], field: string) => rows.reduce((a, r) => a + (toNumber(r[field]) ?? 0), 0);
  const rowsOf = (ctx: DataContext, id: string) => ctx.datasets.get(id)!.rows;
  const value = (v: unknown, ctx: DataContext) => evaluateMeasure(v as Measure, ctx);

  for (const [name, sample] of Object.entries(SAMPLES)) {
    it(`${name}: every archetype is valid, resolvable and structurally distinct`, () => {
      const drafts = ARCHETYPES.map((archetype) => checkDraft(sample(), { archetype }));
      const shapes = drafts.map((d) => shape(d.blocks));
      expect(new Set(shapes).size, shapes.join("\n")).toBe(ARCHETYPES.length);
      const titles = drafts.map((d) => d.spec.sections.map((s) => s.title).join("|"));
      expect(new Set(titles).size).toBe(ARCHETYPES.length);
      // Section titles are specific; "Analysis"/"Summary"/"Detail" stay the overview's.
      for (const d of drafts.slice(1)) expect(d.spec.sections.map((s) => s.title)).not.toContain("Analysis");
    });
  }

  it("brief: a lead headline stat, ≤ 3 figures, one chart and one bound insight callout on a single printed page", () => {
    for (const sample of Object.values(SAMPLES)) {
      const { spec, context, blocks } = checkDraft(sample(), { archetype: "brief" });
      expect(spec.page?.targetPages).toBe(1);
      // The KPI strip only appears when there are figures beyond the headline.
      expect(blocks.map((b) => b.type).filter((t) => t !== "kpi")).toEqual(["stat", "chart", "callout"]);
      expect(blocks[0]).toMatchObject({ importance: "lead" });
      expect(blocks[0]).toHaveProperty("compareTo");
      const strip = blocks.find((b): b is Extract<Block, { type: "kpi" }> => b.type === "kpi");
      expect(1 + (strip?.items.length ?? 0)).toBeLessThanOrEqual(3);
      expect(blocks.at(-1)).toMatchObject({ variant: "insight", importance: "supporting" });
      expect(inspectReport({ spec, context, issues: [] }).pages).toBe(1);
    }
  });

  it("trend: moving-average series, small multiples by the main dimension, growth bars around zero, best/worst months, latest-change callout", () => {
    const rows = saasRows();
    const { spec, context, blocks, charts } = checkDraft(rows, { archetype: "trend" });
    expect(spec.sections.map((s) => s.title)).toEqual(["Latest month", "MRR over time", "Best and worst months"]);
    expect(charts.map((c) => c.facet)).toEqual([undefined, "plan", undefined]);
    const [line, facet, growth] = charts;
    expect(line).toMatchObject({ kind: "line", x: "month" });
    const [mrr, ma] = line!.y as string[];
    const trend = rowsOf(context, line!.data);
    expect(trend.at(-1)![ma!]).toBeCloseTo(sum(trend.slice(-3), mrr!) / 3, 6);
    // One row per month × plan; MRR is a level, so each panel's latest point is that plan's latest MRR.
    expect(facet).toMatchObject({ kind: "line", x: "month", y: "mrr" });
    const panels = rowsOf(context, facet!.data);
    expect(panels).toHaveLength(rows.length);
    const sep = (r: Row) => r.month === "2026-09-01";
    expect(sum(panels.filter(sep), "mrr")).toBe(sum(rows.filter(sep), "mrr"));
    expect(growth).toMatchObject({ kind: "bar", x: "month", yFormat: "percent", reference: [{ value: 0 }] });
    // Best and worst months are separate tabs over disjoint datasets, each listed from the extreme inward.
    const extremes = spec.sections.find((s) => s.id === "extremes")!;
    expect(extremes.view).toBe("tabs");
    expect(extremes.blocks.map((b) => b.title)).toEqual(["Best 3 months", "Worst 3 months"]);
    const [best, worst] = extremes.blocks.map((b) => rowsOf(context, (b as Extract<Block, { type: "table" }>).data).map((r) => r[mrr!] as number));
    const all = trend.map((r) => r[mrr!] as number).sort((a, b) => b - a);
    expect(best).toEqual(all.slice(0, 3));
    expect(worst).toEqual(all.slice(-3).reverse());
    expect(blocks.find((b) => b.type === "callout")).toMatchObject({ variant: "insight" });
    // Narrative is supporting so the layout sets it beside the charts.
    for (const b of blocks) if (b.type === "text" || b.type === "callout") expect(b.importance).toBe("supporting");
  });

  it("compare: latest six months vs the previous six, a dumbbell per dimension as tabs, movers across region × channel", () => {
    const rows = salesRows();
    const { spec, context, blocks, charts } = checkDraft(rows, { archetype: "compare" });
    const byDimension = spec.sections.find((s) => s.id === "by_dimension")!;
    expect(byDimension.view).toBe("tabs");
    expect(byDimension.blocks.map((b) => [b.type, b.title])).toEqual([
      ["chart", "Revenue by region"],
      ["chart", "Revenue by channel"],
    ]);
    // Tabs show one block at a time, so the bound mover sentences sit with the comparison.
    expect(spec.sections[0]!.blocks.map((b) => b.type)).toEqual(["comparison", "text"]);
    expect(textOf(blocks, context)).toMatch(/By region:.*added the most[\s\S]*By channel:.*added the most/);
    const cmp = blocks.find((b): b is Extract<Block, { type: "comparison" }> => b.type === "comparison")!;
    expect(cmp.entities).toEqual(["Jul 2025–Dec 2025", "Jan 2026–Jun 2026"]);
    const between = (from: string, to: string) => sum(rows.filter((r) => (r.month as string) >= from && (r.month as string) <= to), "revenue");
    const [prev, latest] = [between("2025-07-01", "2025-12-01"), between("2026-01-01", "2026-06-01")];
    const revenue = cmp.metrics.find((m) => m.label === "Revenue")!;
    expect(revenue.values.map((v) => value(v, context))).toEqual([prev, latest]);
    const dumbbell = charts.find((c) => c.kind === "dumbbell")!;
    expect(dumbbell.x).toBe("region");
    const [from, to] = dumbbell.y as string[];
    const byRegion = rowsOf(context, dumbbell.data);
    expect(byRegion).toHaveLength(5);
    expect([sum(byRegion, from!), sum(byRegion, to!)]).toEqual([prev, latest]);
    expect(context.datasets.get(dumbbell.data)!.fields.find((f) => f.name === to)!.label).toBe("Jan 2026–Jun 2026");
    const movers = blocks.find((b): b is Extract<Block, { type: "table" }> => b.type === "table")!;
    expect(rowsOf(context, movers.data)).toHaveLength(15);
    expect(movers.columns!.slice(0, 2).map((c) => c.field)).toEqual(["region", "channel"]);
  });

  it("compare and bridge read level metrics (MRR) at each window's last snapshot", () => {
    const rows = saasRows();
    const at = (month: string) => sum(rows.filter((r) => r.month === month), "mrr");
    const c = checkDraft(rows, { archetype: "compare" });
    const cmp = c.blocks.find((b): b is Extract<Block, { type: "comparison" }> => b.type === "comparison")!;
    expect(cmp.entities).toEqual(["Oct 2025–Mar 2026", "Apr 2026–Sep 2026"]);
    expect(cmp.metrics.find((m) => m.label === "MRR")!.values.map((v) => value(v, c.context))).toEqual([at("2026-03-01"), at("2026-09-01")]);

    const b = checkDraft(rows, { archetype: "bridge" });
    expect(b.spec.sections.map((s) => s.title)).toEqual(["What changed", "Contributors", "Detail"]);
    const waterfall = b.charts.find((x) => x.kind === "waterfall")!;
    expect(waterfall).toMatchObject({ base: "first", total: "Apr 2026–Sep 2026" });
    const y = waterfall.y as string;
    const steps = rowsOf(b.context, waterfall.data);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ [waterfall.x]: "Oct 2025–Mar 2026", [y]: at("2026-03-01") });
    // Start + every plan's change = the latest total; changes run largest first.
    expect(sum(steps, y)).toBe(at("2026-09-01"));
    const changes = steps.slice(1).map((r) => r[y] as number);
    expect(changes).toEqual([...changes].sort((p, q) => q - p));
    const callout = b.blocks.find((x) => x.type === "callout")!;
    const text = renderTemplate((callout as Extract<Block, { type: "callout" }>).content, b.context).text;
    expect(text).toMatch(/\*\*(Starter|Pro|Enterprise)\*\* added the most \(\+\$/);
  });

  it("bridge: an ‘Other’ step keeps waterfalls readable for many categories and the bridge still adds up", () => {
    const rows = ["2026-08-01", "2026-09-01"].flatMap((month, m) =>
      Array.from({ length: 20 }, (_, i) => ({ month, store: `Store ${i + 1}`, sales: 1000 + i * 37 + m * (i % 3 === 0 ? -150 : 90 + i) })),
    );
    const { context, charts } = checkDraft(rows, { archetype: "bridge" });
    const waterfall = charts.find((x) => x.kind === "waterfall")!;
    const steps = rowsOf(context, waterfall.data);
    expect(steps).toHaveLength(12);
    expect(steps.map((r) => r[waterfall.x])).toContain("Other");
    expect(sum(steps, waterfall.y as string)).toBe(sum(rows.filter((r) => r.month === "2026-09-01"), "sales"));
  });

  it("breakdown: horizontal ranking, share donut, 100% channel mix, ranked table with share and rank", () => {
    const { context, blocks, charts } = checkDraft(salesRows(), { archetype: "breakdown" });
    expect(charts.map((c) => c.kind)).toEqual(["bar", "donut", "bar"]);
    expect(charts[0]).toMatchObject({ x: "region", horizontal: true, sort: "-y" });
    expect(charts[2]).toMatchObject({ x: "region", series: "channel", stack: "percent" });
    const table = blocks.find((b): b is Extract<Block, { type: "table" }> => b.type === "table")!;
    const ranked = rowsOf(context, table.data);
    expect(ranked.map((r) => r[table.sortBy as string])).toEqual([1, 2, 3, 4, 5]);
    const share = table.columns!.find((c) => c.format === "percent")!.field;
    expect(sum(ranked, share)).toBeCloseTo(1, 12);
  });

  it("without a date field: compare pits the top two categories; trend and bridge fall back with a note", () => {
    const rows = ["North", "South", "East", "West"].flatMap((region, i) =>
      ["Shoes", "Bags", "Hats"].map((product, j) => ({ region, product, revenue: (4 - i) * 1000 + j * 300 + (i === 1 && j === 2 ? 2000 : 0), units: 10 + i + j })),
    );
    const c = checkDraft(rows, { archetype: "compare" });
    const cmp = c.blocks.find((b): b is Extract<Block, { type: "comparison" }> => b.type === "comparison")!;
    expect(cmp.entities).toEqual(["North", "South"]);
    const revenue = (region: string) => sum(rows.filter((r) => r.region === region), "revenue");
    expect(cmp.metrics[0]!.values.map((v) => value(v, c.context))).toEqual([revenue("North"), revenue("South")]);
    const dumbbell = c.charts.find((x) => x.kind === "dumbbell")!;
    expect(dumbbell.x).toBe("product");
    // South beats North on hats, so the text says so.
    expect(textOf(c.blocks, c.context)).toMatch(/South is ahead in \*\*Hats\*\*/);

    const overview = checkDraft(rows);
    const trend = checkDraft(rows, { archetype: "trend" });
    expect(trend.spec.summary).toMatch(/No date field/);
    expect(shape(trend.blocks)).toBe(shape(overview.blocks));
    const bridge = checkDraft(rows, { archetype: "bridge" });
    expect(bridge.spec.summary).toMatch(/No date field/);
    expect(shape(bridge.blocks)).toBe(shape(checkDraft(rows, { archetype: "breakdown" }).blocks));
    // Brief leads with the strongest breakdown when there is no trend.
    const brief = checkDraft(rows, { archetype: "brief" });
    expect(brief.charts).toEqual([expect.objectContaining({ kind: "bar", x: "region" })]);
    expect(inspectReport({ spec: brief.spec, context: brief.context, issues: [] }).pages).toBe(1);
  });

  describe("compositions", () => {
    const bands = (input: unknown, archetype: Archetype) => {
      const { spec, context, blocks, charts } = checkDraft(input, { archetype });
      const outline = inspectReport({ spec, context, issues: [] }, { mode: "web" }).outline;
      return { spec, blocks, charts, all: outline.flatMap((s) => s.bands), bySection: Object.fromEntries(outline.map((s, i) => [spec.sections[i]!.id, s.bands])) };
    };
    const block = (blocks: Block[], id: string) => blocks.find((b) => b.id === id);

    for (const [name, sample] of Object.entries({ salesRows, saasRows })) {
      it(`${name}: overview varies its bands and leads with the headline stat`, () => {
        const { all, blocks } = bands(sample(), "overview");
        expect(new Set(all).size, all.join(",")).toBeGreaterThanOrEqual(3);
        expect(blocks[0]).toMatchObject({ type: "stat", importance: "lead" });
        for (const b of blocks) {
          if (b.type === "chart") expect(b.importance).toBe("normal");
          if (b.type === "text") expect(b.importance).toBe("supporting");
        }
      });

      it(`${name}: brief opens with a hero stat`, () => {
        expect(bands(sample(), "brief").bySection.brief![0]).toBe("hero");
      });

      it(`${name}: breakdown sets the lead ranking in a feature`, () => {
        const { all, blocks } = bands(sample(), "breakdown");
        expect(block(blocks, "ranking_chart")).toMatchObject({ importance: "lead" });
        expect(all.some((c) => c.startsWith("feature-")), all.join(",")).toBe(true);
      });

      it(`${name}: trend adds small multiples of the headline`, () => {
        const { charts } = bands(sample(), "trend");
        expect(charts.filter((c) => c.facet !== undefined)).toHaveLength(1);
      });

      it(`${name}: compare leads with the dumbbell, bridge with the waterfall`, () => {
        expect(block(bands(sample(), "compare").blocks, "dumbbell_chart")).toMatchObject({ importance: "lead" });
        expect(block(bands(sample(), "bridge").blocks, "waterfall_chart")).toMatchObject({ importance: "lead" });
      });
    }

    it("tabs only hold titled alternative views, and print composes them as flow", () => {
      const tabbed: Record<string, string[]> = {};
      for (const archetype of ["overview", "brief", "trend", "compare", "breakdown", "bridge"] as Archetype[]) {
        const { spec, context } = checkDraft(salesRows(), { archetype });
        for (const s of spec.sections) {
          expect(s.view === undefined || s.view === "tabs", `${archetype}/${s.id}`).toBe(true);
          if (s.view !== "tabs") continue;
          (tabbed[archetype] ??= []).push(s.id);
          expect(s.blocks.length).toBeGreaterThanOrEqual(2);
          for (const b of s.blocks) {
            expect(b.title, `${archetype}/${b.id}`).toBeTruthy();
            expect(b.title!.length, b.title).toBeLessThanOrEqual(40);
            expect(["chart", "table"]).toContain(b.type);
          }
        }
        const flow = { ...spec, sections: spec.sections.map(({ view: _view, ...s }) => s) };
        const web = inspectReport({ spec, context, issues: [] }, { mode: "web" });
        // Print ignores the view; interactive web gives each tab (one chart/table each) its own full-width pane.
        expect(inspectReport({ spec, context, issues: [] }, { mode: "print" }).outline).toEqual(inspectReport({ spec: flow, context, issues: [] }, { mode: "print" }).outline);
        spec.sections.forEach((s, i) => {
          if (s.view === "tabs") expect(web.outline[i]!.bands.map((c) => (c === "hero" ? "full" : c))).toEqual(s.blocks.map(() => "full"));
        });
      }
      expect(tabbed).toEqual({ overview: ["detail"], trend: ["extremes"], compare: ["by_dimension"] });
    });

    it("overview detail tabs: the leading breakdown's full ranking, then the raw records", () => {
      const { spec, context } = checkDraft(salesRows());
      const detail = spec.sections.find((s) => s.id === "detail")!;
      expect(detail.blocks.map((b) => b.id)).toEqual(["ranked_table", "detail_table"]);
      const ranked = detail.blocks[0] as Extract<Block, { type: "table" }>;
      expect(rowsOf(context, ranked.data).map((r) => r.region)).toHaveLength(5);
      // Without a dimension there is nothing to rank: one table, plain flow.
      const monthly = checkDraft([{ month: "2026-01", revenue: 1 }, { month: "2026-02", revenue: 2 }, { month: "2026-03", revenue: 3 }]).spec;
      expect(monthly.sections.at(-1)).not.toHaveProperty("view");
    });

    it("overview facets the trend by a dimension no other chart uses", () => {
      const { charts } = bands(salesRows(), "overview");
      expect(charts.map((c) => c.facet ?? c.x)).toEqual(["month", "channel", "region"]);
    });

    it("bridge runs the contributors callout as a sidebar aside when a second dimension is charted", () => {
      const sales = bands(salesRows(), "bridge");
      expect(sales.spec.sections.find((s) => s.id === "contributors")).toMatchObject({ layout: "sidebar" });
      expect(sales.bySection.contributors!.some((c) => c.startsWith("sidebar-")), sales.all.join(",")).toBe(true);
      // SaaS has one dimension (plan), so the section holds only the callout: a sidebar needs three blocks, so no hint is given.
      const saas = bands(saasRows(), "bridge");
      expect(saas.spec.sections.find((s) => s.id === "contributors")!.layout).toBeUndefined();
    });
  });
});
