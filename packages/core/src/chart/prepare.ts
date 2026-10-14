import type { Agg, ChartSpec, Row, Scalar } from "../spec.js";
import type { DataContext, FieldInfo, FormatContext, ResolvedDataset } from "../data/types.js";
import type { DateUnit } from "../data/format.js";
import type { ColorRef } from "./types.js";
import { aggregate } from "../data/aggregate.js";
import { EMPTY_VALUE, formatDate, formatValue } from "../data/format.js";
import { closest, compareScalars, humanize, parseDate, toNumber } from "../data/values.js";

export type XType = "date" | "number" | "category";

export const OTHER_LABEL = "Other";
const OTHER_KEY = "\u0000other";
/** More distinct `series` values than this → keep the top (MAX_SERIES - 1) by total plus 'Other'. */
const MAX_SERIES = 8;

export interface ChartSource {
  ds: ResolvedDataset;
  field(name: string): FieldInfo;
}

export interface Category {
  /** Unique grouping key. */
  key: string;
  /** Representative raw x value. */
  value: Scalar;
  /** Numeric position for date (epoch ms) / number x; null for categorical or the 'Other' bucket. */
  pos: number | null;
  label: string;
}

/** A grouped x value before display labelling. */
export type RawCategory = Omit<Category, "label">;

export interface SeriesData {
  key: string;
  label: string;
  color: ColorRef;
  /** Aggregated values aligned with `Prepared.categories`; null = no data. */
  values: (number | null)[];
}

export interface Prepared {
  xType: XType;
  xLabel: string;
  categories: Category[];
  series: SeriesData[];
  secondary: SeriesData[];
  /** Label of the measured quantity (description, axis). */
  measure: string;
  /** Format of the measure values (spec.yFormat, else the first y field's format). */
  yFormat?: string;
  secondaryFormat?: string;
}

export function yFields(y: string | readonly string[]): string[] {
  return typeof y === "string" ? [y] : [...y];
}

/** Resolve the dataset and verify every referenced field; failures become agent-actionable warnings. */
export function loadSource(spec: ChartSpec, ctx: DataContext): { source?: ChartSource; warnings: string[] } {
  const ds = ctx.datasets.get(spec.data);
  if (!ds) {
    const hint = closest(spec.data, ctx.datasets.keys());
    return { warnings: [`Dataset "${spec.data}" not found${hint ? ` (did you mean "${hint}"?)` : ""}.`] };
  }
  const infos = new Map<string, FieldInfo>(ds.fields.map((f) => [f.name, f]));
  if (infos.size === 0) {
    for (const row of ds.rows) for (const k of Object.keys(row)) if (!infos.has(k)) infos.set(k, { name: k, type: "string", label: humanize(k) });
  }
  const referenced = [spec.x, ...yFields(spec.y), spec.series, spec.value, ...(spec.secondary ? yFields(spec.secondary.y) : [])];
  const warnings: string[] = [];
  for (const name of referenced) {
    if (name === undefined || infos.has(name)) continue;
    const hint = closest(name, infos.keys());
    warnings.push(`Field "${name}" not found in dataset "${ds.id}"${hint ? ` (did you mean "${hint}"?)` : ""}.`);
  }
  if (warnings.length > 0) return { warnings };
  return { source: { ds, field: (name) => infos.get(name) ?? { name, type: "string", label: humanize(name) } }, warnings };
}

/** date: FieldInfo says so or every value parses as a date; number: every value is numeric; else category. */
export function detectXType(rows: readonly Row[], info: FieldInfo): XType {
  const values = rows.map((r) => r[info.name]).filter((v): v is Exclude<Scalar, null> => v !== null && v !== undefined);
  if (values.length === 0) return "category";
  if (info.type === "date" || values.every((v) => typeof v === "string" && parseDate(v) !== null)) return "date";
  if (info.type === "number" || values.every((v) => typeof v !== "boolean" && toNumber(v) !== null)) return "number";
  return "category";
}

/** Grouping key + position for an x value; null drops the row. */
export function categoryOf(v: Scalar | undefined, xType: XType): RawCategory | null {
  if (v === null || v === undefined) return null;
  if (xType === "date") {
    const t = typeof v === "number" ? v : parseDate(v, true);
    return t === null ? null : { key: String(t), value: v, pos: t };
  }
  if (xType === "number") {
    const n = toNumber(v);
    return n === null ? null : { key: String(n), value: v, pos: n };
  }
  return { key: String(v), value: v, pos: null };
}

/** Granularity of a time axis from the smallest spacing between distinct timestamps. */
export function inferDateUnit(times: readonly number[]): DateUnit {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  const DAY = 86_400_000;
  let gap = Infinity;
  for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, sorted[i]! - sorted[i - 1]!);
  if (gap === Infinity) {
    const d = new Date(sorted[0] ?? 0);
    return d.getUTCDate() !== 1 ? "day" : d.getUTCMonth() === 0 ? "year" : "month";
  }
  if (gap >= 360 * DAY) return "year";
  if (gap >= 88 * DAY) return "quarter";
  if (gap >= 28 * DAY) return "month";
  return "day";
}

/** Attach display labels: dates by granularity (or xFormat), numbers/categories via format. */
export function labelCategories(cats: readonly RawCategory[], xType: XType, format: string | undefined, ctx: FormatContext): Category[] {
  const unit = xType === "date" && format === undefined ? inferDateUnit(cats.flatMap((c) => (c.pos === null ? [] : [c.pos]))) : undefined;
  return cats.map((c) => {
    let label: string;
    if (c.key === OTHER_KEY) label = OTHER_LABEL;
    else if (unit && c.pos !== null) label = formatDate(c.pos, unit, ctx.locale);
    else if (format !== undefined) label = formatValue(xType === "date" ? c.pos : c.value, format, ctx);
    else label = xType === "number" ? formatValue(c.pos, undefined, ctx) : String(c.value);
    return { ...c, label };
  });
}

/** Default category order: time/number ascending, else first-seen. */
export function sortByPosition<T extends { pos: number | null }>(cats: T[], xType: XType): T[] {
  return xType === "category" ? cats : [...cats].sort((a, b) => (a.pos ?? Infinity) - (b.pos ?? Infinity));
}

/** Aggregate one cell's raw values; null when no non-null input (so lines break) except for counts. */
export function aggregateCell(values: readonly Scalar[], agg: Agg): number | null {
  if (agg !== "count" && agg !== "countDistinct" && !values.some((v) => v !== null && v !== undefined)) return null;
  if (values.length === 0) return null;
  return toNumber(aggregate(values, agg));
}

interface SeriesDef {
  key: string;
  label: string;
  field: string;
  color: ColorRef;
  /** Series-field value this def matches (undefined = any row). */
  match?: (row: Row) => boolean;
}

/**
 * Distinct `series` values in first-seen order; beyond MAX_SERIES keep the top (MAX_SERIES - 1) by total and route
 * the rest into 'Other'. Returns key → bucket label mapping.
 */
export function seriesBuckets(rows: readonly Row[], seriesField: string, measures: readonly string[]): { order: string[]; bucketOf: (row: Row) => string } {
  const totals = new Map<string, number>();
  const keyOf = (row: Row) => {
    const v = row[seriesField];
    return v === null || v === undefined || v === "" ? EMPTY_VALUE : String(v);
  };
  for (const row of rows) {
    const k = keyOf(row);
    let t = totals.get(k) ?? 0;
    for (const m of measures) t += Math.abs(toNumber(row[m]) ?? 0);
    totals.set(k, t);
  }
  const order = [...totals.keys()];
  if (order.length <= MAX_SERIES) return { order, bucketOf: keyOf };
  const kept = new Set([...order].sort((a, b) => totals.get(b)! - totals.get(a)!).slice(0, MAX_SERIES - 1));
  return {
    order: [...order.filter((k) => kept.has(k)), OTHER_LABEL],
    bucketOf: (row) => {
      const k = keyOf(row);
      return kept.has(k) ? k : OTHER_LABEL;
    },
  };
}

/** Bar / line / area / pie: group by x (+series), aggregate y, sort, limit. */
export function prepareCategorical(spec: ChartSpec, source: ChartSource, ctx: FormatContext): Prepared {
  const { ds } = source;
  const xInfo = source.field(spec.x);
  const xType = detectXType(ds.rows, xInfo);
  const agg = spec.aggregate ?? "sum";
  const ys = yFields(spec.y);
  const secondaryFields = spec.secondary ? yFields(spec.secondary.y) : [];

  const defs: SeriesDef[] = [];
  if (spec.series) {
    const { order, bucketOf } = seriesBuckets(ds.rows, spec.series, ys);
    for (const bucket of order) {
      for (const y of ys) {
        const label = ys.length > 1 ? `${bucket} · ${source.field(y).label}` : bucket;
        defs.push({ key: label, label, field: y, color: bucket === OTHER_LABEL ? "muted" : defs.length, match: (row) => bucketOf(row) === bucket });
      }
    }
  } else {
    for (const y of ys) defs.push({ key: y, label: source.field(y).label, field: y, color: defs.length });
  }
  const primaryCount = defs.length;
  for (const y of secondaryFields) defs.push({ key: `secondary:${y}`, label: source.field(y).label, field: y, color: defs.length });

  // raw[catIndex][defIndex] = collected y values
  const index = new Map<string, number>();
  const cats: RawCategory[] = [];
  const raw: Scalar[][][] = [];
  for (const row of ds.rows) {
    const c = categoryOf(row[spec.x], xType);
    if (!c) continue;
    let i = index.get(c.key);
    if (i === undefined) {
      i = cats.length;
      index.set(c.key, i);
      cats.push(c);
      raw.push(defs.map(() => []));
    }
    const cells = raw[i]!;
    defs.forEach((d, j) => {
      if (!d.match || d.match(row)) cells[j]!.push(row[d.field] ?? null);
    });
  }

  let order = cats.map((_, i) => i);
  const totalOf = (i: number) => {
    let t = 0;
    for (let j = 0; j < primaryCount; j++) t += aggregateCell(raw[i]![j]!, agg) ?? 0;
    return t;
  };
  const totals = order.map(totalOf);
  const sort = spec.sort ?? (xType === "category" ? "none" : "x");
  const cmpX = (a: number, b: number) => {
    const ca = cats[a]!;
    const cb = cats[b]!;
    return ca.pos !== null && cb.pos !== null ? ca.pos - cb.pos : compareScalars(ca.value, cb.value);
  };
  if (sort === "x") order.sort(cmpX);
  else if (sort === "-x") order.sort((a, b) => cmpX(b, a));
  else if (sort === "y") order.sort((a, b) => totals[a]! - totals[b]!);
  else if (sort === "-y") order.sort((a, b) => totals[b]! - totals[a]!);

  let finalType = xType;
  const finalCats: RawCategory[] = [];
  const finalRaw: Scalar[][][] = [];
  if (spec.limit !== undefined && spec.limit < order.length) {
    const kept = new Set([...order].sort((a, b) => totals[b]! - totals[a]!).slice(0, spec.limit));
    const removed = order.filter((i) => !kept.has(i));
    order = order.filter((i) => kept.has(i));
    for (const i of order) {
      finalCats.push(cats[i]!);
      finalRaw.push(raw[i]!);
    }
    if (spec.others && removed.length > 0) {
      finalCats.push({ key: OTHER_KEY, value: OTHER_LABEL, pos: null });
      finalRaw.push(defs.map((_, j) => removed.flatMap((i) => raw[i]![j]!)));
      finalType = "category";
    }
  } else {
    for (const i of order) {
      finalCats.push(cats[i]!);
      finalRaw.push(raw[i]!);
    }
  }

  const xFormat = spec.xFormat ?? xInfo.format;
  const categories = labelCategories(finalCats, xType, xFormat, ctx);
  const toSeries = (d: SeriesDef, j: number): SeriesData => ({
    key: d.key,
    label: d.label,
    color: d.color,
    values: finalRaw.map((cells) => aggregateCell(cells[j]!, agg)),
  });
  return {
    xType: finalType,
    xLabel: spec.xLabel ?? xInfo.label,
    categories,
    series: defs.slice(0, primaryCount).map(toSeries),
    secondary: defs.slice(primaryCount).map((d, j) => toSeries(d, primaryCount + j)),
    measure: spec.yLabel ?? ys.map((y) => source.field(y).label).join(", "),
    yFormat: spec.yFormat ?? source.field(ys[0]!).format,
    secondaryFormat: spec.secondary?.format ?? (secondaryFields[0] !== undefined ? source.field(secondaryFields[0]).format : undefined),
  };
}
