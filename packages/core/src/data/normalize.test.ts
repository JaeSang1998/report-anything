import { describe, expect, it } from "vitest";
import { normalizeJson } from "./normalize.js";
import { DataError } from "./errors.js";

const api = {
  meta: { page: 1, total: 2 },
  data: [
    { id: 1, customer: { name: "Ann", address: { city: "Seoul", geo: { lat: 1 } } }, tags: ["a", "b"], items: [{ sku: "X", qty: 2 }, { sku: "Y", qty: 1 }] },
    { id: 2, customer: { name: "Bob", address: { city: "Busan", geo: { lat: 2 } } }, tags: [], items: [] },
  ],
};

describe("normalizeJson", () => {
  it("auto-detects the lone record array and flattens nested objects into dotted keys", () => {
    const rows = normalizeJson(api);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 1,
      "customer.name": "Ann",
      "customer.address.city": "Seoul",
      "customer.address.geo": '{"lat":1}',
      tags: "a, b",
      "items.count": 2,
    });
    // Empty object arrays count 0 when other rows count; empty scalar arrays are null.
    expect(rows[1]).toMatchObject({ tags: null, "items.count": 0 });
  });

  it("respects maxDepth", () => {
    const rows = normalizeJson(api, { maxDepth: 1 });
    expect(rows[0]!.customer).toBe(JSON.stringify(api.data[0]!.customer));
  });

  it("follows an explicit path and reports missing segments with available keys", () => {
    expect(normalizeJson({ a: { b: [{ x: 1 }] } }, { path: "a.b" })).toEqual([{ x: 1 }]);
    try {
      normalizeJson({ a: { c: [] } }, { path: "a.b" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DataError);
      expect((e as DataError).hint).toContain("c");
    }
  });

  it("unnests a child array: one row per child with parent scalars copied", () => {
    const rows = normalizeJson(api, { unnest: "items" });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 1, "customer.name": "Ann", "items.sku": "X", "items.qty": 2 });
    expect(rows[1]).toMatchObject({ id: 1, "items.sku": "Y" });
    expect(rows[0]).not.toHaveProperty("items.count");
    // Parent without children is kept once.
    expect(rows[2]).toMatchObject({ id: 2, "customer.name": "Bob" });
    expect(rows[2]).not.toHaveProperty("items.sku");
  });

  it("turns keyed maps into rows with a key field", () => {
    expect(normalizeJson({ kr: { sales: 10 }, us: { sales: 20 } })).toEqual([
      { key: "kr", sales: 10 },
      { key: "us", sales: 20 },
    ]);
  });

  it("handles scalar arrays, single objects and wrapper objects", () => {
    expect(normalizeJson([1, 2])).toEqual([{ value: 1 }, { value: 2 }]);
    expect(normalizeJson({ a: 1, b: { c: 2 } })).toEqual([{ a: 1, "b.c": 2 }]);
    expect(normalizeJson({ response: { results: [{ v: 1 }] } })).toEqual([{ v: 1 }]);
    expect(normalizeJson([])).toEqual([]);
  });
});
