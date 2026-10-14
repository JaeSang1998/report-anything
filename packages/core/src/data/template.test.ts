import { describe, expect, it } from "vitest";
import type { Row } from "../spec.js";
import { evaluateMeasure, resolveValue } from "./measure.js";
import { DataError } from "./errors.js";
import { inferFields } from "./resolve.js";
import { renderTemplate } from "./template.js";
import type { DataContext } from "./types.js";

const salesRows: Row[] = [
  { month: "2026-01-01", region: "N", revenue: 1000, growth: 0.1 },
  { month: "2026-02-01", region: "S", revenue: 2500, growth: 0.25 },
  { month: "2026-03-01", region: "N", revenue: null, growth: 0.125 },
];
const ctx: DataContext = {
  locale: "en-US",
  currency: "USD",
  datasets: new Map([
    ["sales", { id: "sales", rows: salesRows, fields: inferFields(salesRows, [{ name: "revenue", format: "currency" }]) }],
    ["orders", { id: "orders", rows: [{ "customer.name": "Ann" }, { "customer.name": "Bob" }, { "customer.name": "Ann" }], fields: inferFields([{ "customer.name": "Ann" }]) }],
  ]),
};

describe("evaluateMeasure / resolveValue", () => {
  it("aggregates with optional where filters", () => {
    expect(evaluateMeasure({ data: "sales", field: "revenue", agg: "sum" }, ctx)).toBe(3500);
    expect(evaluateMeasure({ data: "sales", field: "revenue", agg: "sum", where: "month == '2026-02-01'" }, ctx)).toBe(2500);
    expect(evaluateMeasure({ data: "sales", agg: "count", where: "region == 'N'" }, ctx)).toBe(2);
    expect(evaluateMeasure({ data: "orders", field: "customer.name", agg: "countDistinct" }, ctx)).toBe(2);
    expect(resolveValue(42, ctx)).toBe(42);
    expect(resolveValue(null, ctx)).toBeNull();
    expect(resolveValue({ data: "sales", field: "growth", agg: "max" }, ctx)).toBe(0.25);
  });

  it("throws coded DataErrors with hints", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(DataError);
        return [(e as DataError).code, (e as DataError).hint];
      }
      throw new Error("expected failure");
    };
    expect(code(() => evaluateMeasure({ data: "sale", field: "revenue", agg: "sum" }, ctx))).toEqual(["unknown_dataset", "did you mean 'sales'?"]);
    expect(code(() => evaluateMeasure({ data: "sales", field: "revenu", agg: "sum" }, ctx))).toEqual(["unknown_field", "did you mean 'revenue'?"]);
    expect(code(() => evaluateMeasure({ data: "sales", field: "revenue", agg: "sum", where: "regin == 'N'" }, ctx))[0]).toBe("unknown_field");
    expect(code(() => evaluateMeasure({ data: "sales", field: "revenue", agg: "sum", where: "region ==" }, ctx))[0]).toBe("bad_expression");
  });
});

describe("renderTemplate", () => {
  it("renders aggregates with field formats, explicit pipes and counts", () => {
    const out = renderTemplate(
      "Revenue {{ sum(sales.revenue) }} / {{sum(sales.revenue) | currency:KRW}}; {{count(orders)}} orders; growth {{ last(sales.growth) | percent }}; avg {{avg(sales.revenue)|number:1}}.",
      ctx,
    );
    expect(out.issues).toEqual([]);
    expect(out.text).toBe("Revenue $3,500.00 / ₩3,500; 3 orders; growth 12.5%; avg 1,750.0.");
  });

  it("does not apply a currency field format to counts", () => {
    expect(renderTemplate("{{count(sales.revenue)}}", ctx).text).toBe("2");
  });

  it("supports dotted field names after the dataset id", () => {
    expect(renderTemplate("{{countDistinct(orders.customer.name)}}", ctx).text).toBe("2");
  });

  it("renders unresolvable placeholders as — with an issue each", () => {
    const out = renderTemplate("{{sum(sale.revenue)}} {{total(sales.revenue)}} {{nonsense}} {{sum(sales.revenu)}} ok", ctx);
    expect(out.text).toBe("— — — — ok");
    expect(out.issues.map((i) => i.code)).toEqual(["unknown_dataset", "unknown_agg", "bad_template", "unknown_field"]);
    expect(out.issues[0]!.message).toContain("did you mean 'sales'?");
  });

  it("falls back to default formatting on an unknown format", () => {
    const out = renderTemplate("{{max(sales.growth) | percentage}}", ctx);
    expect(out.text).toBe("0.25");
    expect(out.issues[0]!.code).toBe("bad_format");
  });

  it("leaves text without placeholders untouched", () => {
    expect(renderTemplate("plain {text}", ctx)).toEqual({ text: "plain {text}", issues: [] });
  });
});
