import type { Scalar } from "../spec.js";
import { Agg, FORMAT_PATTERN } from "../spec.js";
import { formatValue, EMPTY_VALUE } from "./format.js";
import { evaluateMeasure } from "./measure.js";
import { DataError } from "./errors.js";
import type { DataContext } from "./types.js";
import { closest } from "./values.js";

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const CALL = /^\s*([A-Za-z]+)\s*\(\s*([^()]*?)\s*\)\s*(?:\|\s*(.*?)\s*)?$/;
/** Aggregations whose result is in the field's own unit, so the field's display format applies. */
const KEEPS_UNIT: Record<string, true> = { sum: true, avg: true, min: true, max: true, median: true, first: true, last: true };

/**
 * Replace `{{ agg(dataset.field) | format }}` placeholders with computed, formatted values.
 * Dataset id = text before the first '.', field = the rest (omit for `count(dataset)`).
 * Unresolvable placeholders render as "—" and produce an issue.
 */
export function renderTemplate(text: string, ctx: DataContext): { text: string; issues: Array<{ code: string; message: string }> } {
  const issues: Array<{ code: string; message: string }> = [];
  const out = text.replace(PLACEHOLDER, (whole, inner: string) => {
    const m = CALL.exec(inner);
    if (!m) {
      issues.push({ code: "bad_template", message: `${whole}: expected {{agg(dataset.field) | format}}` });
      return EMPTY_VALUE;
    }
    const aggName = m[1]!;
    const ref = m[2]!;
    const format = m[3];
    const agg = Agg.safeParse(aggName);
    if (!agg.success) {
      const guess = closest(aggName, Agg.options);
      issues.push({ code: "unknown_agg", message: `${whole}: unknown aggregation '${aggName}'${guess ? ` (did you mean '${guess}'?)` : ""}` });
      return EMPTY_VALUE;
    }
    const dot = ref.indexOf(".");
    const data = dot < 0 ? ref : ref.slice(0, dot);
    const field = dot < 0 ? undefined : ref.slice(dot + 1).replace(/^`(.*)`$/, "$1");
    if (data === "") {
      issues.push({ code: "bad_template", message: `${whole}: missing dataset id` });
      return EMPTY_VALUE;
    }
    let value: Scalar;
    try {
      value = evaluateMeasure({ data, agg: agg.data, ...(field ? { field } : {}) }, ctx);
    } catch (e) {
      if (!(e instanceof DataError)) throw e;
      issues.push({ code: e.code, message: `${whole}: ${e.message}${e.hint ? ` (${e.hint})` : ""}` });
      return EMPTY_VALUE;
    }
    if (format !== undefined && format !== "") {
      if (FORMAT_PATTERN.test(format)) return formatValue(value, format, ctx);
      issues.push({ code: "bad_format", message: `${whole}: unknown format '${format}'; using the default` });
    }
    const fieldFormat = field && KEEPS_UNIT[agg.data] ? ctx.datasets.get(data)?.fields.find((f) => f.name === field)?.format : undefined;
    return formatValue(value, fieldFormat, ctx);
  });
  return { text: out, issues };
}
