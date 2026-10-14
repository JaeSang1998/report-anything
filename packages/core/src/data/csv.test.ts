import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded commas and newlines", () => {
    const rows = parseCsv('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nLee,plain\r\n');
    expect(rows).toEqual([
      { name: "Smith, J", note: 'said "hi"\nthen left' },
      { name: "Lee", note: "plain" },
    ]);
  });

  it("coerces numbers, booleans and empties but keeps dates as strings", () => {
    const rows = parseCsv("month,revenue,active,note\n2026-01,\"1,200\",true,\n2026-02,-3.5e2,false,x");
    expect(rows).toEqual([
      { month: "2026-01", revenue: 1200, active: true, note: null },
      { month: "2026-02", revenue: -350, active: false, note: "x" },
    ]);
  });

  it("pads short records with null and ignores blank lines", () => {
    expect(parseCsv("a,b,c\n1\n\n2,3,4\n")).toEqual([
      { a: 1, b: null, c: null },
      { a: 2, b: 3, c: 4 },
    ]);
  });

  it("returns no rows for empty input or header only", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("a,b\n")).toEqual([]);
  });

  it("strips a BOM from the header", () => {
    expect(Object.keys(parseCsv("\uFEFFid,v\n1,2")[0]!)).toEqual(["id", "v"]);
  });
});
