import type { Agg, ChartSpec, FieldDef, ReportSpecInput, Row, Scalar, TableColumn, Transform } from "./spec.js";
import type { DateUnit } from "./data/format.js";
import type { DatasetProfile, FieldProfile, ResolvedDataset } from "./data/types.js";
import { parseCsv } from "./data/csv.js";
import { formatDate } from "./data/format.js";
import { findRecordArray, normalizeJson } from "./data/normalize.js";
import { defaultAgg, fieldLabel, isStockMeasure, magnitude, profileDataset, rankMeasures } from "./data/profile.js";
import { inferFields } from "./data/resolve.js";
import { applyTransforms } from "./data/transform.js";
import { groupKey, humanize, parseDate, toNumber } from "./data/values.js";

type SectionInput = ReportSpecInput["sections"][number];
type BlockInput = SectionInput["blocks"][number];
type KpiItemInput = Extract<BlockInput, { type: "kpi" }>["items"][number];
type DatasetInput = NonNullable<ReportSpecInput["datasets"]>[string];
type MeasureInput = Extract<KpiItemInput["value"], { data: string }>;
type MakeId = (name: string) => string;

interface Source {
  id: string;
  rows: Row[];
  description: string;
  /** Set on exploded child datasets: dotted prefix of the child's own fields. */
  childPrefix?: string;
}

interface Analyzed {
  ds: ResolvedDataset;
  profile: DatasetProfile;
  defs: FieldDef[];
}

/** A source dataset after analysis, with the transforms (e.g. derived amount) it ships with. */
interface Table extends Analyzed {
  source: Source;
  transform: Transform[];
  /** Measures in headline order (see rankMeasures). */
  ranked: FieldProfile[];
}

/** What a chart/split/KPI aggregates: a field with its aggregation, or a row count (`field` undefined). */
interface MeasureRef {
  field: string | undefined;
  agg: Agg;
  label: string;
  /** Label for mid-sentence use (acronyms kept uppercase). */
  inline: string;
  /** Level metric (MRR, customers): only the latest period may be shown, never a sum across periods. */
  stock: boolean;
}

/** Ratio computed after aggregation (sum(num) / sum(den)), e.g. signups / sessions. */
interface DerivedRate {
  num: string;
  den: string;
  as: string;
}

/** The headline rate: a derived ratio, or an existing percent field (averaged). */
interface RateRef {
  field: string;
  label: string;
  derived: DerivedRate | undefined;
}

/** Period axis of a table: the time field, its truncation unit and the sorted period starts. */
interface TimeAxis {
  time: FieldProfile;
  unit: DateUnit | undefined;
  periods: Scalar[];
}

interface Trend {
  id: string;
  axis: TimeAxis;
  countField: string;
  /** Headline field aggregated per period (count field for a count headline). */
  value: string;
  changeField: string;
  dataset: DatasetInput;
}

interface Breakdown {
  table: Table;
  dim: FieldProfile;
  measure: MeasureRef;
  score: number;
}

/** Aggregated per-category dataset backing a chart or split sentence. */
interface ByDimension {
  id: string;
  valueField: string;
  shareField: string | undefined;
  rateField: string | undefined;
  /** True when filtered to the latest snapshot (stock measures). */
  latest: boolean;
}

/** Everything decided about the primary table before blocks are written. */
interface Plan {
  t: Table;
  head: MeasureRef;
  extras: FieldProfile[];
  rate: RateRef | undefined;
  eventLike: boolean;
  trend: Trend | undefined;
  countLabel: string;
}

const DOWN_IS_GOOD = /cost|expense|churn|loss|debt|defect|return|latency|duration|minutes|hours|backlog|비용|손실/i;
const PRICE_NAME = /price|단가|가격/i;
const QTY_NAME = /(^|[._\s-])(qty|quantity|units?)$|수량/i;
const RATE_PAIRS: Array<{ num: RegExp; den: RegExp; as: string }> = [
  { num: /^(signups?|sign_ups|registrations|conversions|orders|purchases|transactions|leads)$/i, den: /^(sessions|visits|visitors)$/i, as: "conversion_rate" },
  { num: /^conversions$/i, den: /^clicks$/i, as: "conversion_rate" },
  { num: /^clicks$/i, den: /^impressions$/i, as: "ctr" },
];
const UNSAFE_TEMPLATE_NAME = /[(){}|]/;
const DAY = 86_400_000;
const MAX_KPIS = 3;
const MAX_CHARTS = 3;
const MAX_SPLITS = 2;
const MAX_TABLE_COLUMNS = 8;
const MAX_TREND_MEASURES = 8;
/** Rows per period at or above which rows read as events rather than a pre-aggregated table. */
const EVENT_ROWS_PER_PERIOD = 10;
/** Dimensions with more categories than this are identifier-like and never charted. */
const MAX_CHART_CATEGORIES = 49;
/** Above this, bar charts keep the top 10 and group the rest. */
const MAX_FULL_BAR = 12;
const MAX_DONUT_SLICES = 6;

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isObjectArray(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.some(isObject);
}

function isCsvText(v: unknown): v is string {
  return typeof v === "string" && /\r?\n/.test(v.trim()) && v.includes(",");
}

function makeIdFactory(): MakeId {
  const used = new Set<string>();
  return (name) => {
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (base === "") base = "data";
    if (!/^[a-z]/.test(base)) base = `d_${base}`;
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    return id;
  };
}

/** `name`, or `name_2`, `name_3`… avoiding existing field names. */
function freeName(name: string, taken: readonly string[]): string {
  let out = name;
  for (let i = 2; taken.includes(out); i++) out = `${name}_${i}`;
  return out;
}

/** Sources from records plus, when records hold arrays of objects, an exploded child dataset. */
function recordSources(id: string, records: unknown[], description: string, makeId: MakeId): Source[] {
  const out: Source[] = [{ id, rows: normalizeJson(records), description }];
  const nested = records.filter(isObject).flatMap((r) => Object.keys(r).filter((k) => isObjectArray(r[k])));
  const key = nested[0];
  if (key !== undefined) {
    out.push({
      id: makeId(`${id}_${key}`),
      rows: normalizeJson(records, { unnest: key }),
      description: `${description}, one row per ${key} entry`,
      childPrefix: `${key}.`,
    });
  }
  return out;
}

function collectSources(input: unknown, makeId: MakeId): Source[] {
  if (typeof input === "string") return [{ id: makeId("data"), rows: parseCsv(input), description: "CSV input" }];
  if (Array.isArray(input)) return recordSources(makeId("data"), input, "Input records", makeId);
  if (isObject(input)) {
    const tables = Object.entries(input).filter(([, v]) => isObjectArray(v) || isCsvText(v));
    if (tables.length > 0) {
      return tables.flatMap(([key, v]) =>
        typeof v === "string" ? [{ id: makeId(key), rows: parseCsv(v), description: `CSV '${key}'` }] : recordSources(makeId(key), v as unknown[], `Records in '${key}'`, makeId),
      );
    }
    const found = findRecordArray(input);
    if (found) return recordSources(makeId(found.path.split(".").pop() || "data"), found.records, `Records at '${found.path}'`, makeId);
  }
  return [{ id: makeId("data"), rows: normalizeJson(input), description: "Input" }];
}

/** Field overrides carrying a suggested format and/or an acronym-aware label. */
function fieldDef(name: string, format: string | undefined): FieldDef | undefined {
  const label = fieldLabel(name);
  const def: FieldDef = { name, ...(format ? { format } : {}), ...(label !== humanize(name) ? { label } : {}) };
  return Object.keys(def).length > 1 ? def : undefined;
}

function analyze(id: string, rows: Row[], childPrefix?: string): Analyzed {
  const base: ResolvedDataset = { id, rows, fields: inferFields(rows) };
  let profile = profileDataset(base);
  if (childPrefix !== undefined) {
    // Parent values repeat on every exploded row; only the child's own measures may be aggregated.
    const fields = profile.fields.map((f) => (f.role === "measure" && !f.name.startsWith(childPrefix) ? { ...f, role: "identifier" as const } : f));
    profile = { ...profile, fields };
  }
  const defs = profile.fields.flatMap((f) => fieldDef(f.name, f.suggestedFormat) ?? []);
  return { ds: { ...base, fields: inferFields(rows, defs) }, profile, defs };
}

/** Line amount (price × quantity) when a table has both but no summable amount of its own. */
function amountDerive(a: Analyzed, prefix: string): Transform | undefined {
  const measures = rankMeasures(a.profile.fields);
  const price = measures.find((f) => PRICE_NAME.test(f.name));
  const qty = measures.find((f) => QTY_NAME.test(f.name));
  if (!price || !qty || measures.some((m) => m !== price && m !== qty && defaultAgg(m) === "sum" && !m.name.endsWith(".count"))) {
    return undefined;
  }
  const as = freeName(`${prefix}amount`, a.ds.fields.map((f) => f.name));
  return { op: "derive", as, expr: `\`${price.name}\` * \`${qty.name}\`` };
}

function prepare(source: Source): Table {
  let a = analyze(source.id, source.rows, source.childPrefix);
  const derive = amountDerive(a, source.childPrefix ?? "");
  if (derive) a = analyze(source.id, applyTransforms(source.rows, [derive], () => undefined), source.childPrefix);
  return { ...a, source, transform: derive ? [derive] : [], ranked: rankMeasures(a.profile.fields) };
}

function fieldFormat(t: Analyzed, field: string | undefined): string | undefined {
  return field === undefined ? undefined : t.defs.find((d) => d.name === field)?.format;
}

function timeField(t: Table): FieldProfile | undefined {
  return t.profile.fields.find((f) => f.role === "time" && f.distinct >= 2);
}

function measureRef(t: Table, m: FieldProfile | undefined, countLabel: string): MeasureRef {
  if (!m) return { field: undefined, agg: "count", label: countLabel, inline: countLabel.toLowerCase(), stock: false };
  const agg = defaultAgg(m);
  const label = agg === "avg" ? `Avg ${fieldLabel(m.name, true)}` : fieldLabel(m.name);
  const inline = agg === "avg" ? `avg ${fieldLabel(m.name, true)}` : fieldLabel(m.name, true);
  return { field: m.name, agg, label, inline, stock: timeField(t) !== undefined && isStockMeasure(m.name) };
}

/** Period granularity for raw timestamps: native spacing; daily data spanning enough periods coarsens to month/week. */
function periodUnit(times: number[]): DateUnit {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i]! - sorted[i - 1]!);
  const native: DateUnit = minGap >= 360 * DAY ? "year" : minGap >= 89 * DAY ? "quarter" : minGap >= 28 * DAY ? "month" : minGap >= 7 * DAY ? "week" : "day";
  // Weekly data stays weekly: months hold 4 or 5 weeks, so monthly sums of weekly flows mislead.
  if (native === "week") return sorted.length > 104 ? "month" : "week";
  if (native !== "day") return native;
  if (new Set(sorted.map((t) => new Date(t).toISOString().slice(0, 7))).size >= 3) return "month";
  if (new Set(sorted.map((t) => Math.floor((t + 3 * DAY) / (7 * DAY)))).size >= 3) return "week";
  return native;
}

function timeAxis(t: Table): TimeAxis | undefined {
  const time = timeField(t);
  if (!time) return undefined;
  let unit: DateUnit | undefined;
  if (time.type === "date") unit = periodUnit(t.ds.rows.map((r) => parseDate(r[time.name] ?? null, true)).filter((x): x is number => x !== null));
  const rows = applyTransforms(
    t.ds.rows,
    [
      ...(unit ? [{ op: "timeUnit" as const, field: time.name, unit }] : []),
      { op: "filter", expr: `\`${time.name}\` != null` },
      { op: "aggregate", groupBy: [time.name], measures: [{ agg: "count", as: "n" }] },
      { op: "sort", by: time.name },
    ],
    () => undefined,
  );
  return rows.length >= 2 ? { time, unit, periods: rows.map((r) => r[time.name] ?? null) } : undefined;
}

/**
 * Rows are events (count them) when they carry an identifier, or when periods hold many rows that do not
 * form a unique time × dimension grid (a grid is a pre-aggregated cross-tab).
 */
function isEventLike(t: Table, axis: TimeAxis | undefined): boolean {
  if (t.profile.fields.some((f) => f.role === "identifier")) return true;
  const rows = t.profile.rowCount;
  if (rows < EVENT_ROWS_PER_PERIOD * Math.max(axis?.periods.length ?? 1, 1)) return false;
  const dims = t.profile.fields.filter((f) => f.role === "dimension").map((f) => f.name);
  const keys = new Set(t.ds.rows.map((r) => groupKey(r, axis ? [axis.time.name, ...dims] : dims)));
  const grid = keys.size === rows && (axis === undefined || axis.time.distinct * 2 <= rows);
  return !grid;
}

function findRate(t: Table): DerivedRate | undefined {
  const names = t.ranked.filter((m) => defaultAgg(m) === "sum").map((m) => m.name);
  for (const p of RATE_PAIRS) {
    const num = names.find((n) => p.num.test(n));
    const den = names.find((n) => p.den.test(n));
    if (num && den) return { num, den, as: freeName(p.as, t.ds.fields.map((f) => f.name)) };
  }
  return undefined;
}

function rateTransform(r: DerivedRate): Transform {
  return { op: "derive", as: r.as, expr: `\`${r.num}\` / \`${r.den}\`` };
}

function rateDef(r: DerivedRate): FieldDef {
  return { name: r.as, format: "percent", label: fieldLabel(r.as) };
}

/**
 * Per-period dataset of the table's measures (+ record count, derived rate and the headline's change vs the
 * previous period). Stocks sum across dimensions within a period; with finer raw timestamps they keep the
 * period's last snapshot instead of summing over it.
 */
function buildTrend(t: Table, axis: TimeAxis, head: MeasureRef, rate: DerivedRate | undefined, makeId: MakeId): Trend {
  const time = axis.time.name;
  const names = t.ds.fields.map((f) => f.name);
  const measures = t.ranked.slice(0, MAX_TREND_MEASURES);
  for (const extra of rate ? [rate.num, rate.den] : []) {
    const f = t.ranked.find((m) => m.name === extra);
    if (f && !measures.includes(f)) measures.push(f);
  }
  const countField = freeName("records", names);
  const value = head.field ?? countField;
  const changeField = freeName(`${value}_change`, names);
  const stock = (m: FieldProfile) => isStockMeasure(m.name);
  const firstPass = measures.map((m) => ({ field: m.name, agg: defaultAgg(m), as: m.name }));
  const timeUnit: Transform[] = axis.unit ? [{ op: "timeUnit", field: time, unit: axis.unit }] : [];
  const notNull: Transform = { op: "filter", expr: `\`${time}\` != null` };
  const snapshots = axis.unit !== undefined && measures.some(stock) && axis.time.distinct > axis.periods.length;
  const transforms: Transform[] = snapshots
    ? [
        notNull,
        { op: "aggregate", groupBy: [time], measures: [...firstPass, { agg: "count", as: countField }] },
        { op: "sort", by: time },
        ...timeUnit,
        {
          op: "aggregate",
          groupBy: [time],
          measures: [
            ...measures.map((m) => ({ field: m.name, agg: stock(m) ? ("last" as const) : defaultAgg(m), as: m.name })),
            { field: countField, agg: "sum", as: countField },
          ],
        },
      ]
    : [...timeUnit, notNull, { op: "aggregate", groupBy: [time], measures: [...firstPass, { agg: "count", as: countField }] }];
  transforms.push({ op: "sort", by: time }, ...(rate ? [rateTransform(rate)] : []), { op: "window", fn: "pctChange", field: value, as: changeField });
  const defs = [...t.defs.filter((d) => measures.some((m) => m.name === d.name) || d.name === time), ...(rate ? [rateDef(rate)] : [])];
  return {
    id: makeId(`${t.ds.id}_trend`),
    axis,
    countField,
    value,
    changeField,
    dataset: {
      from: t.ds.id,
      transform: transforms,
      description: `${fieldLabel(t.ds.id)} aggregated per ${axis.unit ?? fieldLabel(time, true)}${snapshots ? " (levels: last snapshot per period)" : ""}`,
      ...(defs.length ? { fields: defs } : {}),
    },
  };
}

function literal(v: Scalar): string {
  return typeof v === "number" ? String(v) : `'${String(v).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function periodLabel(v: Scalar, unit: DateUnit | undefined, locale: string): string {
  const t = unit ? parseDate(v, true) : null;
  return t === null ? String(v) : formatDate(t, unit!, locale);
}

function kpiFormat(f: FieldProfile): string | undefined {
  return f.suggestedFormat ?? (magnitude(f) >= 100_000 ? "compact" : undefined);
}

/**
 * Headline KPIs (≤ 3): headline measure, record count (events only), one more measure, the headline rate,
 * then (events only) the headline's average per record. With a trend every KPI compares the latest period with
 * the previous one, so stocks are never summed across periods.
 */
function kpiItems(plan: Plan, makeId: MakeId, datasets: Record<string, DatasetInput>, locale: string): KpiItemInput[] {
  const { t, head, trend } = plan;
  const periods = trend?.axis.periods ?? [];
  const latest = periods[periods.length - 1];
  const prev = periods[periods.length - 2];
  const compare = trend !== undefined && latest !== undefined && latest !== null && prev !== undefined && prev !== null;
  const periodText = compare ? { deltaLabel: `vs ${periodLabel(prev, trend.axis.unit, locale)}`, description: periodLabel(latest, trend.axis.unit, locale) } : {};
  const at =
    (field: string) =>
    (period: Scalar): MeasureInput => ({ data: trend!.id, field, agg: "sum", where: `\`${trend!.axis.time.name}\` == ${literal(period)}` });
  const items: KpiItemInput[] = [];
  const add = (label: string, name: string, format: string | undefined, raw: MeasureInput, perPeriod: ((p: Scalar) => MeasureInput) | undefined) => {
    if (items.length >= MAX_KPIS) return;
    const common = { label, ...(format ? { format } : {}), ...(DOWN_IS_GOOD.test(name) ? { goodWhen: "down" as const } : {}) };
    if (compare && perPeriod) items.push({ ...common, ...periodText, value: perPeriod(latest), compareTo: perPeriod(prev) });
    else items.push({ ...common, value: raw });
  };
  const count = () => add(plan.countLabel, "records", "integer", { data: t.ds.id, agg: "count" }, trend ? at(trend.countField) : undefined);
  const measure = (m: FieldProfile) => {
    const ref = measureRef(t, m, plan.countLabel);
    add(ref.label, m.name, kpiFormat(m), { data: t.ds.id, field: m.name, agg: ref.agg }, at(m.name));
  };

  const headProfile = t.ranked.find((m) => m.name === head.field);
  if (headProfile) measure(headProfile);
  else count();
  if (plan.eventLike && headProfile) count();
  for (const m of plan.extras) measure(m);
  const rate = plan.rate;
  if (rate) {
    if (rate.derived && trend) add(rate.label, rate.field, "percent", { data: trend.id, field: rate.field, agg: "avg" }, at(rate.field));
    else if (rate.derived) {
      const id = makeId(`${t.ds.id}_totals`);
      datasets[id] = {
        from: t.ds.id,
        transform: [{ op: "aggregate", groupBy: [], measures: [rate.derived.num, rate.derived.den].map((f) => ({ field: f, agg: "sum" as const, as: f })) }, rateTransform(rate.derived)],
        description: `${fieldLabel(rate.field)} over all rows`,
        fields: [rateDef(rate.derived)],
      };
      add(rate.label, rate.field, "percent", { data: id, field: rate.field, agg: "sum" }, undefined);
    } else {
      const f = t.ranked.find((m) => m.name === rate.field);
      if (f) measure(f);
    }
  }
  if (plan.eventLike && headProfile && head.agg === "sum" && !head.stock) {
    // Several records per period: the average record value is a distinct, meaningful figure.
    const time = trend?.axis.time.name;
    const range = (from: Scalar, to?: Scalar) =>
      trend!.axis.unit
        ? `\`${time}\` >= ${literal(from)}${to === undefined ? "" : ` and \`${time}\` < ${literal(to)}`}`
        : `\`${time}\` == ${literal(from)}`;
    add(
      `Avg ${fieldLabel(headProfile.name, true)} per record`,
      headProfile.name,
      kpiFormat(headProfile),
      { data: t.ds.id, field: headProfile.name, agg: "avg" },
      trend ? (p) => ({ data: t.ds.id, field: headProfile.name, agg: "avg", where: p === latest ? range(latest) : range(prev!, latest!) }) : undefined,
    );
  }
  return items;
}

/** Latest raw time value of a table, used to show stocks as their latest snapshot. */
function latestFilter(t: Table): { field: string; value: Scalar } | undefined {
  const time = timeField(t);
  return time && time.max !== undefined ? { field: time.name, value: time.max } : undefined;
}

/** Coefficient of variation of per-category totals: how much the dimension explains (0 = even split). */
function spread(t: Table, dim: string, m: MeasureRef): number {
  const latest = m.stock ? latestFilter(t) : undefined;
  const totals = new Map<string, number>();
  for (const r of t.ds.rows) {
    const k = r[dim];
    if (k === null || k === undefined || (latest && r[latest.field] !== latest.value)) continue;
    const v = m.field === undefined ? 1 : (toNumber(r[m.field]) ?? 0);
    totals.set(String(k), (totals.get(String(k)) ?? 0) + v);
  }
  const vals = [...totals.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1);
  if (mean <= 0) return 0;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return Math.min(sd / mean, 2) / 2;
}

/** Chartable dimensions (3–49 categories, child tables only their own fields), best explanatory value first. */
function breakdowns(tables: readonly Table[], plan: Plan): Breakdown[] {
  return tables
    .flatMap((t) => {
      const measure = t === plan.t ? plan.head : measureRef(t, t.ranked[0], fieldLabel(t.ds.id));
      const prefix = t.source.childPrefix;
      return t.profile.fields
        .filter((f) => f.role === "dimension" && f.distinct >= 3 && f.distinct <= MAX_CHART_CATEGORIES)
        .filter((f) => prefix === undefined || f.name.startsWith(prefix))
        .map((dim) => ({
          table: t,
          dim,
          measure,
          score: (dim.distinct <= MAX_FULL_BAR ? 2 : 1) + (t === plan.t ? 0.5 : 0) + spread(t, dim.name, measure),
        }));
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Dataset aggregating `m` per `dim` (largest first), with each category's share of the total when summable and the
 * derived rate when given. Stocks are restricted to the latest snapshot; averages are never summed.
 */
function byDimension(t: Table, dim: string, m: MeasureRef, rate: DerivedRate | undefined, makeId: MakeId, datasets: Record<string, DatasetInput>): ByDimension {
  const id = makeId(`${t.ds.id}_by_${dim}`);
  const valueField = m.field ?? freeName("records", [dim]);
  const shareField = m.agg === "avg" ? undefined : freeName(`${valueField}_share`, [dim]);
  const latest = m.stock ? latestFilter(t) : undefined;
  const inputs = (rate ? [rate.num, rate.den] : []).filter((f) => f !== m.field);
  const defs = [fieldDef(dim, undefined), fieldDef(valueField, fieldFormat(t, m.field)), ...(rate ? [rateDef(rate)] : [])].filter((d): d is FieldDef => d !== undefined);
  datasets[id] = {
    from: t.ds.id,
    transform: [
      { op: "filter", expr: `\`${dim}\` != null` },
      ...(latest ? [{ op: "filter" as const, expr: `\`${latest.field}\` == ${literal(latest.value)}` }] : []),
      {
        op: "aggregate",
        groupBy: [dim],
        measures: [{ ...(m.field ? { field: m.field } : {}), agg: m.agg, as: valueField }, ...inputs.map((f) => ({ field: f, agg: "sum" as const, as: f }))],
      },
      ...(rate ? [rateTransform(rate)] : []),
      { op: "sort", by: `-${valueField}` },
      ...(shareField ? [{ op: "window" as const, fn: "share" as const, field: valueField, as: shareField }] : []),
    ],
    description: `${m.label} per ${fieldLabel(dim, true)}${latest ? " in the latest period" : ""}`,
    ...(defs.length ? { fields: defs } : {}),
  };
  return { id, valueField, shareField, rateField: rate?.as, latest: latest !== undefined };
}

/** "In {{last period}}, " for breakdowns restricted to the latest snapshot. */
function latestLead(d: ByDimension, trend: Trend | undefined): string {
  if (!d.latest || !trend || UNSAFE_TEMPLATE_NAME.test(trend.axis.time.name)) return "";
  return `${trend.axis.unit === "week" ? "In the week of" : "In"} {{last(${trend.id}.${trend.axis.time.name})${trend.axis.unit ? ` | date:${trend.axis.unit}` : ""}}}, `;
}

/** Sentence on the leader's and laggard's share (and rate) — information the bars themselves do not print. */
function breakdownText(b: Breakdown, d: ByDimension, limited: boolean, trend: Trend | undefined): string {
  const dim = b.dim.name;
  const dims = fieldLabel(dim, true);
  if ([dim, d.valueField, d.rateField ?? ""].some((n) => UNSAFE_TEMPLATE_NAME.test(n))) return `${b.measure.label} by ${dims}, largest first.`;
  const lead = latestLead(d, trend) + (limited ? `of {{count(${d.id})}} ${dims} values, ` : "");
  const sentence = (body: string) => {
    const out = lead + body;
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  const leader = `{{first(${d.id}.${dim})}}`;
  const rate = d.rateField ? ` at a ${fieldLabel(d.rateField, true)} of {{first(${d.id}.${d.rateField}) | percent}}` : "";
  return !d.shareField
    ? sentence(`**${leader}** is highest at {{first(${d.id}.${d.valueField})}}${rate}, against {{last(${d.id}.${d.valueField})}} for {{last(${d.id}.${dim})}}.`)
    : sentence(`**${leader}** leads with {{first(${d.id}.${d.shareField}) | percent}} of ${b.measure.inline} ({{first(${d.id}.${d.valueField})}})${rate}; {{last(${d.id}.${dim})}} contributes the least at {{last(${d.id}.${d.shareField}) | percent}}.`);
}

/** Two-category dimensions are stated, not charted. */
function splitText(plan: Plan, dim: string, d: ByDimension): string {
  if (UNSAFE_TEMPLATE_NAME.test(dim)) return "";
  const lead = latestLead(d, plan.trend);
  const label = fieldLabel(dim);
  if (!d.shareField) {
    return `**${label}:** ${lead}{{first(${d.id}.${dim})}} averages {{first(${d.id}.${d.valueField})}} versus {{last(${d.id}.${d.valueField})}} for {{last(${d.id}.${dim})}}.`;
  }
  return `**${label}:** ${lead}{{first(${d.id}.${dim})}} accounts for {{first(${d.id}.${d.shareField}) | percent}} of ${plan.head.inline} ({{first(${d.id}.${d.valueField})}}), {{last(${d.id}.${dim})}} for the remaining {{last(${d.id}.${d.shareField}) | percent}}.`;
}

function trendChart(plan: Plan, trend: Trend): { chart: ChartSpec; title: string; text: string } {
  const { head, rate } = plan;
  const secondary = rate && head.field !== rate.field ? rate : undefined;
  const unit = trend.axis.unit ?? "period";
  const time = trend.axis.time.name;
  const chart: ChartSpec = {
    kind: "line",
    data: trend.id,
    x: time,
    y: trend.value,
    ...(trend.axis.unit ? { xFormat: `date:${trend.axis.unit}` } : {}),
    ...(secondary ? { secondary: { y: secondary.field, format: "percent", label: secondary.label } } : {}),
  };
  const title = `${head.label}${secondary ? ` and ${secondary.label.replace(/^[A-Z][a-z]/, (s) => s.toLowerCase())}` : ""} per ${unit}`;
  if ([time, trend.value, trend.changeField, secondary?.field ?? ""].some((n) => UNSAFE_TEMPLATE_NAME.test(n))) return { chart, title, text: `${head.label} per ${unit}.` };
  const d = trend.id;
  const when = `{{last(${d}.${time})${trend.axis.unit ? ` | date:${trend.axis.unit}` : ""}}}`;
  const rateText = secondary ? ` ${secondary.label} was {{last(${d}.${secondary.field}) | percent}} (first ${unit}: {{first(${d}.${secondary.field}) | percent}}).` : "";
  const text =
    `${unit === "week" ? "In the week of" : "In"} ${when}, ${head.inline} was **{{last(${d}.${trend.value})}}**, {{last(${d}.${trend.changeField}) | percent}} vs the previous ${unit}; ` +
    `the {{count(${d})}}-${unit} average is {{avg(${d}.${trend.value})}}.${rateText}`;
  return { chart, title, text };
}

function tableColumns(t: Table): TableColumn[] {
  const order: FieldProfile["role"][] = ["time", "identifier", "dimension", "measure"];
  return order
    .flatMap((role) => t.profile.fields.filter((f) => f.role === role))
    .slice(0, MAX_TABLE_COLUMNS)
    .map((f) => {
      const format = fieldFormat(t, f.name);
      return { field: f.name, ...(format ? { format } : {}) };
    });
}

/** Decide headline, KPI extras, rate and trend for the primary table. */
function planPrimary(t: Table, makeId: MakeId): Plan {
  const axis = timeAxis(t);
  const eventLike = isEventLike(t, axis);
  const countLabel = t.ds.id === "data" ? "Records" : fieldLabel(t.ds.id);
  // Events whose measures are all averages (durations, scores) are best headlined by their count.
  const first = t.ranked[0];
  const headProfile = first && !(eventLike && defaultAgg(first) === "avg") ? first : undefined;
  const head = measureRef(t, headProfile, countLabel);
  const derived = findRate(t);
  const percent = t.ranked.find((m) => m !== headProfile && m.suggestedFormat === "percent");
  const rate: RateRef | undefined = derived
    ? { field: derived.as, label: fieldLabel(derived.as), derived }
    : percent && headProfile?.suggestedFormat !== "percent"
      ? { field: percent.name, label: measureRef(t, percent, countLabel).label, derived: undefined }
      : undefined;
  const candidates = t.ranked.filter((m) => m !== headProfile && !m.name.endsWith(".count") && m.suggestedFormat !== "percent");
  const extra = candidates.find((m) => m.suggestedFormat !== headProfile?.suggestedFormat) ?? candidates[0];
  // A count headline leaves room for more averaged measures (e.g. response time, CSAT).
  const extras = headProfile ? (extra ? [extra] : []) : candidates;
  const trend = axis ? buildTrend(t, axis, head, derived, makeId) : undefined;
  return { t, head, extras, rate, eventLike, trend, countLabel };
}

/**
 * Headless "any data → draft report".
 * Accepts an array of records, an object of named arrays / CSV strings, nested JSON, or a CSV string.
 * Reading order: KPIs → trend of the headline measure → up to two category breakdowns → two-way splits → detail table.
 * Every number in the output is data-bound (Measure objects or {{...}} placeholders).
 */
export function autoReport(input: unknown, opts: { title?: string; locale?: string; currency?: string } = {}): ReportSpecInput {
  const locale = opts.locale ?? "en-US";
  const makeId = makeIdFactory();
  const tables = collectSources(input, makeId).map(prepare);
  const parents = tables.filter((t) => t.source.childPrefix === undefined);
  const primary = parents.reduce((best, t) => {
    const score = t.ranked.length * 1e6 + t.profile.rowCount;
    return score > best.ranked.length * 1e6 + best.profile.rowCount ? t : best;
  }, parents[0] ?? tables[0]!);

  const datasets: Record<string, DatasetInput> = {};
  for (const t of tables) {
    datasets[t.ds.id] = {
      rows: t.source.rows,
      description: t.source.description,
      ...(t.transform.length ? { transform: t.transform } : {}),
      ...(t.defs.length ? { fields: t.defs } : {}),
    };
  }

  const plan = planPrimary(primary, makeId);
  const { trend } = plan;
  if (trend) datasets[trend.id] = trend.dataset;
  const derivedRate = plan.rate?.derived;

  const analysisBlocks: BlockInput[] = [];
  const addChart = (chart: ChartSpec, title: string, text: string) => {
    const n = analysisBlocks.length / 2 + 1;
    analysisBlocks.push({ id: `chart_${n}`, type: "chart", title, chart, height: "md" }, { id: `insight_${n}`, type: "text", content: text });
  };
  if (trend) {
    const c = trendChart(plan, trend);
    addChart(c.chart, c.title, c.text);
  }
  const usedX = new Set(trend ? [trend.axis.time.name] : []);
  for (const b of breakdowns(tables, plan)) {
    if (analysisBlocks.length / 2 >= MAX_CHARTS) break;
    if (usedX.has(b.dim.name)) continue;
    usedX.add(b.dim.name);
    const d = byDimension(b.table, b.dim.name, b.measure, b.table === primary ? derivedRate : undefined, makeId, datasets);
    const dims = fieldLabel(b.dim.name, true);
    const limited = b.dim.distinct > MAX_FULL_BAR;
    const latest = d.latest ? `, latest ${trend?.axis.unit ?? "period"}` : "";
    const min = b.table.profile.fields.find((f) => f.name === b.measure.field)?.min;
    const nonNegative = typeof min !== "number" || min >= 0;
    // A donut adds variety only as a later view of a small, summable, non-negative split.
    if (analysisBlocks.length > 0 && d.shareField && nonNegative && b.dim.distinct <= MAX_DONUT_SLICES && analysisBlocks.some((x) => x.type === "chart" && x.chart.kind === "bar")) {
      addChart({ kind: "donut", data: d.id, x: b.dim.name, y: d.valueField }, `${b.measure.label} share by ${dims}${latest}`, breakdownText(b, d, false, trend));
      continue;
    }
    const long = (b.dim.top ?? []).some((x) => String(x.value).length > 12);
    addChart(
      {
        kind: "bar",
        data: d.id,
        x: b.dim.name,
        y: d.valueField,
        sort: "-y",
        ...(long || limited ? { horizontal: true } : {}),
        ...(limited ? { limit: 10, others: true } : {}),
      },
      (limited ? `Top 10 ${dims} by ${b.measure.inline}` : `${b.measure.label} by ${dims}`) + latest,
      breakdownText(b, d, limited, trend),
    );
  }
  const splits = primary.profile.fields
    .filter((f) => f.role === "dimension" && f.distinct === 2 && !usedX.has(f.name))
    .slice(0, MAX_SPLITS)
    .map((f) => splitText(plan, f.name, byDimension(primary, f.name, plan.head, undefined, makeId, datasets)))
    .filter((s) => s !== "");
  if (splits.length) analysisBlocks.push({ id: "splits", type: "text", title: "How it splits", content: splits.map((s) => `- ${s}`).join("\n") });

  const sections: SectionInput[] = [
    { id: "summary", title: "Summary", role: "summary", blocks: [{ id: "kpis", type: "kpi", items: kpiItems(plan, makeId, datasets, locale) }] },
  ];
  if (analysisBlocks.length) sections.push({ id: "analysis", title: "Analysis", role: "analysis", layout: "main-side", blocks: analysisBlocks });
  const columns = tableColumns(primary);
  const sortName = trend?.axis.time.name ?? plan.head.field;
  sections.push({
    id: "detail",
    title: "Detail",
    role: "detail",
    blocks: [
      {
        id: "detail_table",
        type: "table",
        title: `${fieldLabel(primary.ds.id)} records`,
        data: primary.ds.id,
        ...(columns.length ? { columns } : {}),
        ...(sortName !== undefined ? { sortBy: `-${sortName}` } : {}),
        maxRows: 20,
      },
    ],
  });

  const pid = primary.ds.id;
  const time = trend?.axis.time.name;
  const unitPipe = trend?.axis.unit ? ` | date:${trend.axis.unit}` : "";
  const range = trend && time && !UNSAFE_TEMPLATE_NAME.test(time) ? ` from {{first(${trend.id}.${time})${unitPipe}}} to {{last(${trend.id}.${time})${unitPipe}}}` : "";
  const meta = {
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.currency ? { currency: opts.currency.toUpperCase() } : {}),
  };
  return {
    version: "1",
    title: opts.title ?? (pid === "data" ? "Data report" : `${fieldLabel(pid)} report`),
    summary: `Automatically drafted from {{count(${pid})}} ${pid === "data" ? "records" : `${fieldLabel(pid, true)} records`}${range}.`,
    ...(Object.keys(meta).length ? { meta } : {}),
    datasets,
    sections,
  };
}
