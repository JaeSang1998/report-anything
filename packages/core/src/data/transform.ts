import type { Agg, Row, Scalar, Transform } from "../spec.js";
import { aggregate, groupRows } from "./aggregate.js";
import { compileExpr, ExprError, isTruthy } from "./expr.js";
import type { CompiledExpr } from "./expr.js";
import { DataError } from "./errors.js";
import type { ResolvedDataset } from "./types.js";
import { closest, groupKey, isoDay, parseDate, sortComparator, toNumber } from "./values.js";

type Op<K extends Transform["op"]> = Extract<Transform, { op: K }>;
type Lookup = (id: string) => ResolvedDataset | undefined;

const DAY = 86_400_000;

/** Union of row keys in first-seen order. */
function fieldsOf(rows: readonly Row[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  return [...seen];
}

/**
 * Throw `unknown_field` for names missing from `available`.
 * Skipped when `available` is empty (no rows → nothing to validate against).
 */
function requireFields(names: readonly string[], available: readonly string[], where: string): void {
  if (available.length === 0) return;
  for (const name of names) {
    if (available.includes(name)) continue;
    const guess = closest(name, available);
    throw new DataError(
      "unknown_field",
      `${where}: unknown field '${name}'`,
      guess ? `did you mean '${guess}'?` : `available fields: ${available.slice(0, 20).join(", ")}`,
    );
  }
}

function compile(src: string, available: readonly string[], where: string): CompiledExpr {
  let expr: CompiledExpr;
  try {
    expr = compileExpr(src);
  } catch (e) {
    if (e instanceof ExprError) throw new DataError("bad_expression", `${where}: ${e.message} in '${src}'`, "check operators, quotes and parentheses");
    throw e;
  }
  requireFields(expr.fields, available, where);
  return expr;
}

function aggregateOp(rows: readonly Row[], t: Op<"aggregate">, available: readonly string[]): Row[] {
  const groupBy = t.groupBy ?? [];
  requireFields(groupBy, available, "aggregate.groupBy");
  for (const m of t.measures) {
    if (m.field === undefined) {
      if (m.agg !== "count") throw new DataError("unknown_field", `aggregate: measure '${m.as}' needs a field for agg '${m.agg}'`, "only 'count' may omit field");
    } else requireFields([m.field], available, "aggregate.measures");
  }
  const groups = rows.length === 0 && groupBy.length === 0 ? new Map([["", [] as Row[]]]) : groupRows(rows, groupBy);
  return [...groups.values()].map((group) => {
    const out: Row = {};
    for (const g of groupBy) out[g] = group[0]?.[g] ?? null;
    for (const m of t.measures) {
      const field = m.field;
      out[m.as] = field === undefined ? group.length : aggregate(group.map((r) => r[field] ?? null), m.agg);
    }
    return out;
  });
}

function topOp(rows: readonly Row[], t: Op<"top">, available: readonly string[]): Row[] {
  requireFields(t.field === undefined ? [t.by] : [t.by, t.field], available, "top");
  const ranked = [...rows].sort((a, b) => {
    const x = toNumber(a[t.by]);
    const y = toNumber(b[t.by]);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return y - x;
  });
  const kept = ranked.slice(0, t.n);
  const rest = ranked.slice(t.n);
  if (t.othersLabel === undefined || rest.length === 0) return kept;
  const restFields = fieldsOf(rest);
  const label = t.field ?? restFields.find((f) => rest.some((r) => typeof r[f] === "string"));
  const other: Row = {};
  for (const f of restFields) {
    const values = rest.map((r) => r[f] ?? null);
    other[f] = values.every((v) => v === null || typeof v === "number") ? (aggregate(values, "sum") as number) : null;
  }
  if (label !== undefined) other[label] = t.othersLabel;
  return [...kept, other];
}

function foldOp(rows: readonly Row[], t: Op<"fold">, available: readonly string[]): Row[] {
  requireFields(t.fields, available, "fold");
  const [keyField, valueField] = t.as ?? ["key", "value"];
  return rows.flatMap((row) => {
    const rest: Row = {};
    for (const [k, v] of Object.entries(row)) if (!t.fields.includes(k)) rest[k] = v;
    return t.fields.map((f) => ({ ...rest, [keyField]: f, [valueField]: row[f] ?? null }));
  });
}

function pivotOp(rows: readonly Row[], t: Op<"pivot">, available: readonly string[]): Row[] {
  requireFields([...t.index, t.columns, t.values], available, "pivot");
  const agg: Agg = t.agg ?? "sum";
  const columns: string[] = [];
  for (const row of rows) {
    const c = String(row[t.columns] ?? "null");
    if (!columns.includes(c)) columns.push(c);
  }
  return [...groupRows(rows, t.index).values()].map((group) => {
    const out: Row = {};
    for (const f of t.index) out[f] = group[0]![f] ?? null;
    const cells = new Map<string, Scalar[]>();
    for (const row of group) {
      const c = String(row[t.columns] ?? "null");
      let values = cells.get(c);
      if (!values) cells.set(c, (values = []));
      values.push(row[t.values] ?? null);
    }
    for (const c of columns) {
      const values = cells.get(c);
      out[c] = values ? aggregate(values, agg) : null;
    }
    return out;
  });
}

/** Start of the period containing `t` (epoch ms UTC). Weeks start on ISO Monday. */
function periodStart(t: number, unit: Op<"timeUnit">["unit"]): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (unit) {
    case "year":
      return Date.UTC(y, 0, 1);
    case "quarter":
      return Date.UTC(y, m - (m % 3), 1);
    case "month":
      return Date.UTC(y, m, 1);
    case "week": {
      const day = Date.UTC(y, m, d.getUTCDate());
      return day - ((d.getUTCDay() + 6) % 7) * DAY;
    }
    default:
      return Date.UTC(y, m, d.getUTCDate());
  }
}

function timeUnitOp(rows: readonly Row[], t: Op<"timeUnit">, available: readonly string[]): Row[] {
  requireFields([t.field], available, "timeUnit");
  const as = t.as ?? t.field;
  return rows.map((row) => {
    const v = row[t.field];
    // Bare numeric years (2024) are accepted as dates.
    const ts = typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 9999 ? Date.UTC(v, 0, 1) : parseDate(v ?? null, true);
    return { ...row, [as]: ts === null ? null : isoDay(periodStart(ts, t.unit)) };
  });
}

/** Nearest 1/2/5 × 10^k step to `raw` (geometric midpoints, as d3 ticks). */
function niceStep(raw: number): number {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r >= Math.sqrt(50) ? 10 : r >= Math.sqrt(10) ? 5 : r >= Math.SQRT2 ? 2 : 1) * mag;
}

function binOp(rows: readonly Row[], t: Op<"bin">, available: readonly string[]): Row[] {
  requireFields([t.field], available, "bin");
  const as = t.as ?? `${t.field}_bin`;
  const nums = rows.map((r) => toNumber(r[t.field])).filter((n): n is number => n !== null);
  let step = t.step;
  if (step === undefined) {
    const lo = nums.length ? Math.min(...nums) : 0;
    const hi = nums.length ? Math.max(...nums) : 0;
    step = hi > lo ? niceStep((hi - lo) / (t.bins ?? 10)) : 1;
  }
  // Round away float noise (0.30000000000000004) to the step's precision.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  const fix = (n: number) => Number(n.toFixed(decimals));
  return rows.map((row) => {
    const n = toNumber(row[t.field]);
    if (n === null) return { ...row, [as]: null, [`${as}_end`]: null };
    // Snap n/step before flooring so 0.3/0.1 (2.9999…) lands in bin 3.
    const start = fix(Math.floor(Number((n / step).toFixed(9))) * step);
    return { ...row, [as]: start, [`${as}_end`]: fix(start + step) };
  });
}

function windowOp(rows: readonly Row[], t: Op<"window">, available: readonly string[]): Row[] {
  const field = t.field;
  if (field === undefined && t.fn !== "rowNumber") {
    throw new DataError("unknown_field", `window: fn '${t.fn}' needs a field`, `set "field" to the numeric field to ${t.fn}`);
  }
  const sortField = t.sortBy?.replace(/^-/, "");
  requireFields([...(field === undefined ? [] : [field]), ...(t.groupBy ?? []), ...(sortField ? [sortField] : [])], available, "window");
  const out: Row[] = rows.map((r) => ({ ...r }));
  const indexed = rows.map((row, i) => ({ row, i }));
  const groups = new Map<string, Array<{ row: Row; i: number }>>();
  for (const item of indexed) {
    const k = groupKey(item.row, t.groupBy ?? []);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(item);
  }
  const cmp = t.sortBy ? sortComparator([t.sortBy]) : undefined;
  for (const group of groups.values()) {
    if (cmp) group.sort((a, b) => cmp(a.row, b.row) || a.i - b.i);
    const values = group.map(({ row }) => (field === undefined ? null : toNumber(row[field])));
    const results = windowValues(t, values);
    group.forEach(({ i }, j) => {
      out[i]![t.as] = results[j]!;
    });
  }
  return out;
}

function windowValues(t: Op<"window">, values: Array<number | null>): Array<number | null> {
  switch (t.fn) {
    case "rowNumber":
      return values.map((_, j) => j + 1);
    case "cumsum": {
      let acc = 0;
      return values.map((v) => (acc += v ?? 0));
    }
    case "diff":
    case "pctChange":
      return values.map((v, j) => {
        const prev = j > 0 ? values[j - 1]! : null;
        if (v === null || prev === null) return null;
        if (t.fn === "diff") return v - prev;
        return prev === 0 ? null : (v - prev) / Math.abs(prev);
      });
    case "share": {
      const total = values.reduce<number>((a, v) => a + (v ?? 0), 0);
      return values.map((v) => (v === null || total === 0 ? null : v / total));
    }
    case "rank": {
      // Competition ranking: ties share the rank of their first position in descending order.
      const sorted = values.filter((v): v is number => v !== null).sort((a, b) => b - a);
      const rankOf = new Map<number, number>();
      sorted.forEach((v, j) => {
        if (!rankOf.has(v)) rankOf.set(v, j + 1);
      });
      return values.map((v) => (v === null ? null : rankOf.get(v)!));
    }
    case "movingAvg": {
      const size = t.size ?? 3;
      return values.map((_, j) => {
        const win = values.slice(Math.max(0, j - size + 1), j + 1).filter((v): v is number => v !== null);
        return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
      });
    }
  }
}

/** Normalized join key so 1 and "1" match; null never matches. */
function joinKey(v: Scalar | undefined): string | null {
  if (v === null || v === undefined) return null;
  const n = toNumber(v);
  return n === null ? `s:${String(v)}` : `n:${n}`;
}

function lookupOp(rows: readonly Row[], t: Op<"lookup">, available: readonly string[], lookup: Lookup): Row[] {
  const other = lookup(t.from);
  if (!other) throw new DataError("unknown_dataset", `lookup: unknown dataset '${t.from}'`, `define datasets.${t.from} or fix "from"`);
  const [leftKey, rightKey] = typeof t.on === "string" ? [t.on, t.on] : t.on;
  requireFields([leftKey], available, "lookup.on");
  const otherFields = other.fields.length ? other.fields.map((f) => f.name) : fieldsOf(other.rows);
  requireFields([rightKey], otherFields, `lookup.on (dataset '${t.from}')`);
  const copy = t.fields ?? otherFields.filter((f) => f !== rightKey);
  requireFields(copy, otherFields, `lookup.fields (dataset '${t.from}')`);
  const index = new Map<string, Row>();
  for (const r of other.rows) {
    const k = joinKey(r[rightKey]);
    if (k !== null && !index.has(k)) index.set(k, r);
  }
  return rows.map((row) => {
    const k = joinKey(row[leftKey]);
    const match = k === null ? undefined : index.get(k);
    const out: Row = { ...row };
    for (const f of copy) out[f] = match?.[f] ?? null;
    return out;
  });
}

function applyOne(rows: readonly Row[], t: Transform, lookup: Lookup): Row[] {
  const available = fieldsOf(rows);
  switch (t.op) {
    case "filter": {
      const expr = compile(t.expr, available, "filter");
      return rows.filter((r) => isTruthy(expr(r)));
    }
    case "derive": {
      const expr = compile(t.expr, available, `derive '${t.as}'`);
      return rows.map((r) => ({ ...r, [t.as]: expr(r) }));
    }
    case "aggregate":
      return aggregateOp(rows, t, available);
    case "sort": {
      const keys = typeof t.by === "string" ? [t.by] : t.by;
      requireFields(
        keys.map((k) => k.replace(/^-/, "")),
        available,
        "sort",
      );
      return [...rows].sort(sortComparator(keys));
    }
    case "limit": {
      const offset = t.offset ?? 0;
      return rows.slice(offset, offset + t.count);
    }
    case "top":
      return topOp(rows, t, available);
    case "fold":
      return foldOp(rows, t, available);
    case "pivot":
      return pivotOp(rows, t, available);
    case "timeUnit":
      return timeUnitOp(rows, t, available);
    case "bin":
      return binOp(rows, t, available);
    case "window":
      return windowOp(rows, t, available);
    case "lookup":
      return lookupOp(rows, t, available, lookup);
    case "select":
      requireFields(t.fields, available, "select");
      return rows.map((r) => Object.fromEntries(t.fields.map((f) => [f, r[f] ?? null])));
    case "rename": {
      requireFields(Object.keys(t.fields), available, "rename");
      return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [t.fields[k] ?? k, v])));
    }
  }
}

/** Run a transform pipeline. Throws DataError (unknown_field with a did-you-mean hint, unknown_dataset, bad_expression). */
export function applyTransforms(rows: readonly Row[], transforms: readonly Transform[], lookup: Lookup): Row[] {
  let current: Row[] = [...rows];
  for (const t of transforms) current = applyOne(current, t, lookup);
  return current;
}
