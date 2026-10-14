import type { Agg, Row, Scalar } from "../spec.js";
import { groupKey, toNumber } from "./values.js";

/** Aggregate raw values. Numeric aggs ignore non-numeric values and return null when nothing remains. */
export function aggregate(values: readonly Scalar[], agg: Agg): Scalar {
  switch (agg) {
    case "count":
      return values.filter((v) => v !== null && v !== undefined).length;
    case "countDistinct":
      return new Set(values.filter((v) => v !== null && v !== undefined).map((v) => JSON.stringify(v))).size;
    case "first":
      return values.find((v) => v !== null && v !== undefined) ?? null;
    case "last": {
      for (let i = values.length - 1; i >= 0; i--) {
        const v = values[i];
        if (v !== null && v !== undefined) return v;
      }
      return null;
    }
    default: {
      const nums: number[] = [];
      for (const v of values) {
        const n = toNumber(v);
        if (n !== null) nums.push(n);
      }
      if (nums.length === 0) return agg === "sum" ? 0 : null;
      switch (agg) {
        case "sum":
          return nums.reduce((a, b) => a + b, 0);
        case "avg":
          return nums.reduce((a, b) => a + b, 0) / nums.length;
        case "min":
          return Math.min(...nums);
        case "max":
          return Math.max(...nums);
        case "median": {
          const s = [...nums].sort((a, b) => a - b);
          const mid = s.length >> 1;
          return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
        }
      }
    }
  }
}

/** Group rows by fields, preserving first-seen group order. */
export function groupRows(rows: readonly Row[], fields: readonly string[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = groupKey(row, fields);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(row);
  }
  return groups;
}
