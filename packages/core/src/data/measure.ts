import type { Measure, Scalar, ValueOrMeasure } from "../spec.js";
import { aggregate } from "./aggregate.js";
import { compileExpr, ExprError, isTruthy } from "./expr.js";
import type { CompiledExpr } from "./expr.js";
import { DataError } from "./errors.js";
import type { DataContext } from "./types.js";
import { closest } from "./values.js";

/** agg(field) over a dataset, optionally filtered by `where`. Throws DataError(unknown_dataset | unknown_field | bad_expression). */
export function evaluateMeasure(m: Measure, ctx: DataContext): Scalar {
  const ds = ctx.datasets.get(m.data);
  if (!ds) {
    const guess = closest(m.data, ctx.datasets.keys());
    throw new DataError(
      "unknown_dataset",
      `unknown dataset '${m.data}'`,
      guess ? `did you mean '${guess}'?` : `defined datasets: ${[...ctx.datasets.keys()].join(", ") || "(none)"}`,
    );
  }
  const names = ds.fields.map((f) => f.name);
  const check = (name: string, where: string): void => {
    if (ds.rows.length === 0 || names.includes(name)) return;
    const guess = closest(name, names);
    throw new DataError(
      "unknown_field",
      `${where}: unknown field '${name}' in dataset '${ds.id}'`,
      guess ? `did you mean '${guess}'?` : `available fields: ${names.join(", ")}`,
    );
  };
  const agg = m.agg ?? "sum";
  if (m.field === undefined && agg !== "count") {
    throw new DataError("unknown_field", `measure on '${ds.id}': agg '${agg}' needs a field`, "set \"field\", or use agg 'count'");
  }
  if (m.field !== undefined) check(m.field, "measure");
  let rows = ds.rows;
  if (m.where !== undefined) {
    let expr: CompiledExpr;
    try {
      expr = compileExpr(m.where);
    } catch (e) {
      if (e instanceof ExprError) throw new DataError("bad_expression", `measure where: ${e.message} in '${m.where}'`, "check operators, quotes and parentheses");
      throw e;
    }
    for (const f of expr.fields) check(f, "measure where");
    rows = rows.filter((r) => isTruthy(expr(r)));
  }
  const field = m.field;
  if (field === undefined) return rows.length;
  return aggregate(
    rows.map((r) => r[field] ?? null),
    agg,
  );
}

/** Scalars pass through; measures are evaluated against the context. */
export function resolveValue(v: ValueOrMeasure, ctx: DataContext): Scalar {
  return v !== null && typeof v === "object" ? evaluateMeasure(v, ctx) : v;
}
