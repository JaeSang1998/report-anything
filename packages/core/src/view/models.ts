import type { BlockOf, Scalar, TableColumn } from "../spec.js";
import type { DataContext, FieldInfo } from "../data/types.js";
import { aggregate, groupRows } from "../data/aggregate.js";
import { formatCompact, formatDelta, formatValue } from "../data/format.js";
import { resolveValue } from "../data/measure.js";
import { renderTemplate } from "../data/template.js";
import { compareScalars, sortComparator, toNumber } from "../data/values.js";
import { uiStrings } from "../i18n.js";

export type Sentiment = "positive" | "negative" | "neutral";

// ─── Table ─────────────────────────────────────────────────────────────────────

export type CellEmphasis = { kind: "bar"; ratio: number; negative: boolean } | { kind: "heat"; t: number } | { kind: "delta"; sentiment: Sentiment };

export interface TableCell {
  field: string;
  value: Scalar;
  text: string;
  emphasis?: CellEmphasis;
}

export interface TableColumnModel {
  field: string;
  label: string;
  align: "left" | "right" | "center";
  format?: string;
}

export interface TableModel {
  columns: TableColumnModel[];
  /** Visible body rows after sort + maxRows. */
  rows: Array<{ key: string; cells: TableCell[] }>;
  totals?: TableCell[];
  /** Rows in the dataset. */
  totalRows: number;
  /** Rows hidden by maxRows. */
  hiddenRows: number;
}

/** Resolve a table block into display-ready cells. Missing dataset → empty model. */
export function buildTableModel(block: BlockOf<"table">, ctx: DataContext): TableModel {
  const ds = ctx.datasets.get(block.data);
  if (!ds) return { columns: [], rows: [], totalRows: 0, hiddenRows: 0 };
  const byName = new Map<string, FieldInfo>(ds.fields.map((f) => [f.name, f]));
  const specs: TableColumn[] = block.columns ?? ds.fields.map((f) => ({ field: f.name }));

  const columns: TableColumnModel[] = specs.map((c) => {
    const info = byName.get(c.field);
    // Raw ISO timestamps are unreadable in a table; date fields default to a localized date.
    const format = c.format ?? info?.format ?? (info?.type === "date" ? "date" : undefined);
    return {
      field: c.field,
      label: c.label ?? info?.label ?? c.field,
      align: c.align ?? (info?.type === "number" ? "right" : "left"),
      ...(format ? { format } : {}),
    };
  });

  let rows = ds.rows;
  if (block.sortBy !== undefined) rows = [...rows].sort(sortComparator(Array.isArray(block.sortBy) ? block.sortBy : [block.sortBy]));
  const visible = block.maxRows !== undefined ? rows.slice(0, block.maxRows) : rows;

  // Per-column numeric extents for emphasis (computed on visible rows so bars are comparable on screen).
  const extents = new Map<string, { min: number; max: number; absMax: number }>();
  for (const c of specs) {
    if (!c.emphasis || c.emphasis === "delta") continue;
    const nums = visible.map((r) => toNumber(r[c.field])).filter((n): n is number => n !== null);
    if (nums.length) extents.set(c.field, { min: Math.min(...nums), max: Math.max(...nums), absMax: Math.max(...nums.map(Math.abs)) });
  }

  const cell = (spec: TableColumn, col: TableColumnModel, value: Scalar): TableCell => {
    const text = formatValue(value, col.format, ctx);
    const n = toNumber(value);
    if (!spec.emphasis || n === null) return { field: col.field, value, text };
    if (spec.emphasis === "delta") {
      // Sign is part of the meaning; color only reinforces it.
      const signed = n > 0 && !text.startsWith("+") ? `+${text}` : text;
      return { field: col.field, value, text: signed, emphasis: { kind: "delta", sentiment: n > 0 ? "positive" : n < 0 ? "negative" : "neutral" } };
    }
    const ext = extents.get(col.field);
    if (!ext) return { field: col.field, value, text };
    if (spec.emphasis === "bar") {
      return { field: col.field, value, text, emphasis: { kind: "bar", ratio: ext.absMax === 0 ? 0 : Math.abs(n) / ext.absMax, negative: n < 0 } };
    }
    const span = ext.max - ext.min;
    return { field: col.field, value, text, emphasis: { kind: "heat", t: span === 0 ? 0.5 : (n - ext.min) / span } };
  };

  const model: TableModel = {
    columns,
    rows: visible.map((r, i) => ({ key: String(i), cells: specs.map((s, j) => cell(s, columns[j]!, r[s.field] ?? null)) })),
    totalRows: rows.length,
    hiddenRows: rows.length - visible.length,
  };

  if (block.totals) {
    const fields = new Set(
      Array.isArray(block.totals) ? block.totals : specs.filter((c) => byName.get(c.field)?.type === "number").map((c) => c.field),
    );
    model.totals = specs.map((s, j) => {
      const col = columns[j]!;
      if (fields.has(s.field)) {
        const v = aggregate(rows.map((r) => r[s.field] ?? null), "sum");
        return { field: s.field, value: v, text: formatValue(v, col.format, ctx) };
      }
      return { field: s.field, value: null, text: j === 0 ? uiStrings(ctx.locale).total : "" };
    });
  }
  return model;
}

// ─── KPI ───────────────────────────────────────────────────────────────────────

export interface KpiModel {
  label: string;
  value: Scalar;
  text: string;
  /** Same value with compact magnitude (₩586억, $1.2M); renderers use it when `text` does not fit. */
  compactText: string;
  delta?: { ratio: number; text: string; sentiment: Sentiment; label?: string };
  /** Templates resolved. */
  description?: string;
  /** Sparkline values in x order, normalized to [0, 1] (null gaps preserved). */
  sparkline?: Array<number | null>;
}

function sentimentOf(ratio: number, goodWhen: "up" | "down" = "up"): Sentiment {
  if (ratio === 0) return "neutral";
  return (ratio > 0) === (goodWhen === "up") ? "positive" : "negative";
}

/** Throws DataError for broken measures; validate first or render behind an error boundary. */
export function buildKpiModels(block: BlockOf<"kpi">, ctx: DataContext): KpiModel[] {
  return block.items.map((item) => {
    const value = resolveValue(item.value, ctx);
    const n = toNumber(value);
    const text = formatValue(value, item.format, ctx);
    const model: KpiModel = { label: item.label, value, text, compactText: n === null ? text : formatCompact(n, item.format, ctx) };
    let ratio: number | undefined;
    if (item.compareTo !== undefined) {
      const base = toNumber(resolveValue(item.compareTo, ctx));
      const cur = toNumber(value);
      if (base !== null && cur !== null && base !== 0) ratio = (cur - base) / Math.abs(base);
    } else if (item.delta !== undefined) ratio = item.delta;
    if (ratio !== undefined) {
      model.delta = {
        ratio,
        text: formatDelta(ratio, ctx),
        sentiment: sentimentOf(ratio, item.goodWhen),
        ...(item.deltaLabel ? { label: item.deltaLabel } : {}),
      };
    }
    if (item.description) model.description = item.description.includes("{{") ? renderTemplate(item.description, ctx).text : item.description;
    if (item.sparkline) {
      const ds = ctx.datasets.get(item.sparkline.data);
      if (ds) {
        const { x, y } = item.sparkline;
        const points = [...groupRows(ds.rows, [x]).values()]
          .map((g) => ({ x: g[0]![x] ?? null, y: toNumber(aggregate(g.map((r) => r[y] ?? null), "sum")) }))
          .sort((a, b) => compareScalars(a.x, b.x));
        const nums = points.map((p) => p.y).filter((n): n is number => n !== null);
        if (nums.length >= 2) {
          const min = Math.min(...nums);
          const span = Math.max(...nums) - min;
          model.sparkline = points.map((p) => (p.y === null ? null : span === 0 ? 0.5 : (p.y - min) / span));
        }
      }
    }
    return model;
  });
}

/** SVG path for normalized sparkline values in a w×h box (y=1 at top). */
export function sparklinePath(values: ReadonlyArray<number | null>, width: number, height: number, inset = 2): string {
  const step = values.length > 1 ? (width - inset * 2) / (values.length - 1) : 0;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = inset + i * step;
    const y = inset + (1 - v) * (height - inset * 2);
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

// ─── Comparison ────────────────────────────────────────────────────────────────

export interface ComparisonModel {
  entities: string[];
  rows: Array<{
    label: string;
    cells: Array<{ value: Scalar; text: string; compactText: string }>;
    delta?: { ratio: number; text: string; sentiment: Sentiment };
  }>;
}

export function buildComparisonModel(block: BlockOf<"comparison">, ctx: DataContext): ComparisonModel {
  const showDelta = block.showDelta ?? true;
  return {
    entities: block.entities,
    rows: block.metrics.map((m) => {
      const values = m.values.map((v) => resolveValue(v, ctx));
      const row: ComparisonModel["rows"][number] = {
        label: m.label,
        cells: values.map((value) => {
          const text = formatValue(value, m.format, ctx);
          const n = toNumber(value);
          return { value, text, compactText: n === null ? text : formatCompact(n, m.format, ctx) };
        }),
      };
      const first = toNumber(values[0] ?? null);
      const last = toNumber(values[values.length - 1] ?? null);
      if (showDelta && first !== null && last !== null && first !== 0) {
        const ratio = (last - first) / Math.abs(first);
        row.delta = { ratio, text: formatDelta(ratio, ctx), sentiment: sentimentOf(ratio, m.goodWhen) };
      }
      return row;
    }),
  };
}
