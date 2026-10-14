import { describe, expect, it } from "vitest";
import { compileExpr, ExprError } from "./expr.js";

const ev = (src: string, row: Record<string, string | number | boolean | null> = {}) => compileExpr(src)(row);

describe("compileExpr", () => {
  it("follows arithmetic and logical precedence", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("-2 * 3 + 10 % 4")).toBe(-4);
    expect(ev("1 < 2 and 3 > 4 or 5 == 5")).toBe(true);
    expect(ev("not 1 == 2")).toBe(true);
    expect(ev("!(1 == 1) || false")).toBe(false);
    expect(ev("2 - 3 - 4")).toBe(-5);
    expect(ev("8 / 2 / 2")).toBe(2);
  });

  it("propagates null and returns null on division by zero", () => {
    expect(ev("a + 1", { a: null })).toBeNull();
    expect(ev("missing * 2")).toBeNull();
    expect(ev("1 / 0")).toBeNull();
    expect(ev("5 % 0")).toBeNull();
    expect(ev("a > 1", { a: null })).toBeNull();
  });

  it("compares loosely across numbers and numeric strings", () => {
    expect(ev("a == 5", { a: "5" })).toBe(true);
    expect(ev("a != '5.0'", { a: 5 })).toBe(false);
    expect(ev("a == null", { a: null })).toBe(true);
    expect(ev("m == '2026-02-01'", { m: "2026-02-01" })).toBe(true);
    expect(ev("d >= '2026-01-15'", { d: "2026-02-01" })).toBe(true);
  });

  it("resolves bare dotted and backticked field names", () => {
    const row = { "customer.name": "Ann", "unit price": 3, qty: 2 };
    expect(ev("customer.name == 'Ann'", row)).toBe(true);
    expect(ev("`unit price` * qty", row)).toBe(6);
    expect(compileExpr("`unit price` * qty + qty").fields).toEqual(["unit price", "qty"]);
  });

  it("implements the function library", () => {
    expect(ev("round(3.14159, 2)")).toBe(3.14);
    expect(ev("abs(-2) + floor(1.7) + ceil(1.2)")).toBe(5);
    expect(ev("min(3, null, 1)")).toBe(1);
    expect(ev("max(3, 9, 1)")).toBe(9);
    expect(ev("sqrt(-1)")).toBeNull();
    expect(ev("log(100, 10)")).toBeCloseTo(2);
    expect(ev("pow(2, 10)")).toBe(1024);
    expect(ev("coalesce(a, b, 7)", { a: null, b: null })).toBe(7);
    expect(ev("if(x > 0, 'pos', 'neg')", { x: -1 })).toBe("neg");
    expect(ev("if(true, 1, 1 / 0)")).toBe(1);
    expect(ev("year(d) * 100 + month(d)", { d: "2026-03-15" })).toBe(202603);
    expect(ev("quarter(d)", { d: "2026-08-01" })).toBe(3);
    expect(ev("day(d)", { d: "2026-08-09" })).toBe(9);
    expect(ev("year('2025')")).toBe(2025);
    expect(ev("year(d)", { d: "nope" })).toBeNull();
    expect(ev("upper(lower('AbC'))")).toBe("ABC");
    expect(ev("concat('a', null, 1)")).toBe("a1");
    expect(ev("len(s)", { s: "héllo" })).toBe(5);
    expect(ev("contains(s, 'ell')", { s: "hello" })).toBe(true);
  });

  it("accepts symbolic and word operators plus quoted strings with escapes", () => {
    expect(ev("a && b", { a: 1, b: 0 })).toBe(false);
    expect(ev("a AND b", { a: 1, b: 2 })).toBe(true);
    expect(ev("'it\\'s' == \"it's\"")).toBe(true);
    expect(ev("s + '!'", { s: "hi" })).toBe("hi!");
  });

  it("reports errors with character positions", () => {
    const pos = (src: string) => {
      try {
        compileExpr(src);
      } catch (e) {
        expect(e).toBeInstanceOf(ExprError);
        return (e as ExprError).position;
      }
      throw new Error(`expected '${src}' to fail`);
    };
    expect(pos("1 + ")).toBe(4);
    expect(pos("a + (b * 2")).toBe(10);
    expect(pos("a # b")).toBe(2);
    expect(pos("x == 'open")).toBe(5);
    expect(pos("1 2")).toBe(2);
    expect(pos("summ(a)")).toBe(0);
    expect(pos("abs(1, 2)")).toBe(0);
    expect(() => compileExpr("rond(a)")).toThrow(/did you mean 'round'/);
  });
});
