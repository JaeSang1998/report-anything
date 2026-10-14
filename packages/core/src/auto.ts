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
  rankField: string | undefined;
  /** True when filtered to the latest snapshot (stock measures). */
  latest: boolean;
}

/** A chart with its title and the data-bound sentence that accompanies it. */
interface Drafted {
  chart: ChartSpec;
  title: string;
  text: string;
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
 * Dataset aggregating `m` per `dim` (largest first), with each category's share of the total when summable, the
 * derived rate when given and, on request, its rank. Stocks are restricted to the latest snapshot; averages are never summed.
 */
function byDimension(
  t: Table,
  dim: string,
  m: MeasureRef,
  rate: DerivedRate | undefined,
  makeId: MakeId,
  datasets: Record<string, DatasetInput>,
  ranked = false,
): ByDimension {
  const id = makeId(`${t.ds.id}_by_${dim}`);
  const valueField = m.field ?? freeName("records", [dim]);
  const shareField = m.agg === "avg" ? undefined : freeName(`${valueField}_share`, [dim]);
  const rankField = ranked ? freeName("rank", [dim, valueField, shareField ?? "", ...(rate ? [rate.num, rate.den, rate.as] : [])]) : undefined;
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
      ...(rankField ? [{ op: "window" as const, fn: "rank" as const, field: valueField, as: rankField }] : []),
    ],
    description: `${m.label} per ${fieldLabel(dim, true)}${latest ? " in the latest period" : ""}`,
    ...(defs.length ? { fields: defs } : {}),
  };
  return { id, valueField, shareField, rateField: rate?.as, rankField, latest: latest !== undefined };
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

function trendChart(plan: Plan, trend: Trend): Drafted {
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

/** Report structures autoReport drafts from the same data. */
export type Archetype = "overview" | "brief" | "trend" | "compare" | "breakdown" | "bridge";

export interface AutoReportOptions {
  title?: string;
  locale?: string;
  currency?: string;
  /**
   * Structure of the draft (default "overview"): brief = one page of KPIs, one chart and one insight; trend = trajectory,
   * growth and best/worst periods; compare = latest vs previous window; breakdown = ranking and mix; bridge = waterfall of
   * what changed between two windows and who contributed.
   */
  archetype?: Archetype;
}

/** Shared drafting state: analyzed tables, the primary plan, and the datasets written so far. */
interface Draft {
  tables: Table[];
  primary: Table;
  plan: Plan;
  datasets: Record<string, DatasetInput>;
  makeId: MakeId;
  locale: string;
  /** Subject of archetype titles: the primary table's name, or the headline measure for anonymous "data" input. */
  subject: string;
}

/** An archetype's sections, its default title, and an optional note (why a fallback was used). */
interface Outline {
  title: string;
  sections: SectionInput[];
  note?: string;
  targetPages?: number;
}

/** A headline figure for comparison blocks (KPI order: headline, record count for events, extras, rate). */
interface Metric {
  ref: MeasureRef;
  format: string | undefined;
  down: boolean;
  derived: DerivedRate | undefined;
}

/** Two adjacent, equally long period windows ending at the latest period. */
interface Windows {
  axis: TimeAxis;
  prevStart: Scalar;
  latestStart: Scalar;
  /** Last period of each window (trend dataset keys). */
  prevLast: Scalar;
  latestLast: Scalar;
  /** Raw time value of each window's last snapshot: stocks are read there, never summed across periods. */
  prevEnd: Scalar;
  latestEnd: Scalar;
  prevLabel: string;
  latestLabel: string;
}

/** A wide two-value comparison per category: `from`/`to` fields, change = to − from, largest gain first. */
interface Split {
  id: string;
  from: string;
  to: string;
  change: string;
  changePct: string;
  abs: string;
  /** The dataset's rows, computed while drafting to choose wording (never to print numbers). */
  rows: Row[];
}

interface SplitPlan {
  name: string;
  /** Row filters/derivations producing `column` (applied before aggregation). */
  pre: Transform[];
  index: string[];
  column: string;
  /** Values of `column` pivoted into `fields` ([from, to]). */
  keys: [Scalar, Scalar];
  fields: [string, string];
  labels: [string, string];
  m: MeasureRef;
  changeLabel: string;
  description: string;
}

/** Periods per comparison window by unit, largest first; the largest window fitting three times in the data wins. */
const WINDOW_SIZES: Record<DateUnit, readonly number[]> = { year: [1], quarter: [4, 2, 1], month: [12, 6, 3, 1], week: [13, 4, 1], day: [28, 7, 1] };
const MAX_COMPARE_METRICS = 4;
const EXTREME_PERIODS = 3;
const MAX_WATERFALL_STEPS = 10;

function unsafe(...names: string[]): boolean {
  return names.some((n) => UNSAFE_TEMPLATE_NAME.test(n));
}

function latestSuffix(d: ByDimension, trend: Trend | undefined): string {
  return d.latest ? `, latest ${trend?.axis.unit ?? "period"}` : "";
}

/** A donut only for a small, summable, non-negative split. */
function canDonut(b: Breakdown, d: ByDimension): boolean {
  const min = b.table.profile.fields.find((f) => f.name === b.measure.field)?.min;
  return d.shareField !== undefined && (typeof min !== "number" || min >= 0) && b.dim.distinct <= MAX_DONUT_SLICES;
}

/** Bar chart of a breakdown (top 10 + others beyond 12 categories). */
function barChart(b: Breakdown, d: ByDimension, trend: Trend | undefined): Drafted {
  const dims = fieldLabel(b.dim.name, true);
  const limited = b.dim.distinct > MAX_FULL_BAR;
  const long = (b.dim.top ?? []).some((x) => String(x.value).length > 12);
  return {
    chart: {
      kind: "bar",
      data: d.id,
      x: b.dim.name,
      y: d.valueField,
      sort: "-y",
      ...(long || limited ? { horizontal: true } : {}),
      ...(limited ? { limit: 10, others: true } : {}),
    },
    title: (limited ? `Top 10 ${dims} by ${b.measure.inline}` : `${b.measure.label} by ${dims}`) + latestSuffix(d, trend),
    text: breakdownText(b, d, limited, trend),
  };
}

/** Dimensions of a table worth splitting by: chartable breakdowns (best first), then two-category fields. */
function dimsOf(t: Table, plan: Plan): FieldProfile[] {
  const prefix = t.source.childPrefix;
  const pairs = t.profile.fields.filter((f) => f.role === "dimension" && f.distinct === 2 && (prefix === undefined || f.name.startsWith(prefix)));
  return [...breakdowns([t], plan).map((b) => b.dim), ...pairs];
}

/** Fresh field names avoiding the table's fields and each other. */
function picker(t: Table): (name: string) => string {
  const taken = t.ds.fields.map((f) => f.name);
  return (name) => {
    const out = freeName(name, taken);
    taken.push(out);
    return out;
  };
}

function chartBlocks(id: string, c: Drafted): BlockInput[] {
  return [
    { id: `${id}_chart`, type: "chart", title: c.title, chart: c.chart, height: "md" },
    { id: `${id}_note`, type: "text", content: c.text },
  ];
}

function headlineMetrics(plan: Plan): Metric[] {
  const { t } = plan;
  const out: Metric[] = [];
  const add = (ref: MeasureRef, format: string | undefined, derived?: DerivedRate) => out.push({ ref, format, down: DOWN_IS_GOOD.test(ref.field ?? ""), derived });
  const count = measureRef(t, undefined, plan.countLabel);
  const head = t.ranked.find((m) => m.name === plan.head.field);
  if (head) add(plan.head, kpiFormat(head));
  else add(count, "integer");
  if (plan.eventLike && head) add(count, "integer");
  for (const m of plan.extras) add(measureRef(t, m, plan.countLabel), kpiFormat(m));
  const rate = plan.rate;
  if (rate?.derived) add({ field: rate.field, agg: "sum", label: rate.label, inline: fieldLabel(rate.field, true), stock: false }, "percent", rate.derived);
  else if (rate) {
    const f = t.ranked.find((m) => m.name === rate.field);
    if (f) add(measureRef(t, f, plan.countLabel), kpiFormat(f));
  }
  return out.slice(0, MAX_COMPARE_METRICS);
}

/**
 * One row per `group` value (period window or category) with every non-stock metric aggregated over the group's rows
 * and derived rates recomputed from their sums. Returns the dataset id and each metric's field in it.
 */
function groupTotals(d: Draft, name: string, metrics: Metric[], group: string, pre: Transform[], description: string): { id: string; field: (m: Metric) => string } {
  const t = d.primary;
  const count = freeName("records", t.ds.fields.map((f) => f.name));
  const measures: Array<{ field?: string; agg: Agg; as: string }> = [{ agg: "count", as: count }];
  const add = (agg: Agg, as: string) => {
    if (!measures.some((x) => x.as === as)) measures.push({ field: as, agg, as });
  };
  const derived = metrics.flatMap((m) => (m.derived ? [m.derived] : []));
  for (const m of metrics) {
    if (m.derived) [m.derived.num, m.derived.den].forEach((f) => add("sum", f));
    else if (m.ref.field !== undefined && !m.ref.stock) add(m.ref.agg, m.ref.field);
  }
  const id = d.makeId(name);
  const defs = [...t.defs.filter((x) => measures.some((m) => m.as === x.name)), ...derived.map(rateDef)];
  d.datasets[id] = {
    from: t.ds.id,
    transform: [...pre, { op: "aggregate", groupBy: [group], measures }, ...derived.map(rateTransform)],
    description,
    ...(defs.length ? { fields: defs } : {}),
  };
  return { id, field: (m) => m.derived?.as ?? m.ref.field ?? count };
}

function windows(t: Table, axis: TimeAxis, locale: string): Windows {
  const p = axis.periods;
  const n = p.length;
  const size = (axis.unit ? WINDOW_SIZES[axis.unit] : [1]).find((s) => 3 * s <= n) ?? 1;
  const at = (i: number): Scalar => p[Math.max(i, 0)] ?? null;
  const label = (from: number, to: number) =>
    from === to ? periodLabel(at(to), axis.unit, locale) : `${periodLabel(at(from), axis.unit, locale)}–${periodLabel(at(to), axis.unit, locale)}`;
  let prevEnd = at(n - size - 1);
  let latestEnd = at(n - 1);
  const cut = axis.unit ? parseDate(at(n - size), true) : null;
  if (cut !== null) {
    // Raw timestamps can be finer than the period: each window's level is its last raw snapshot.
    let prevMax = -Infinity;
    let latestMax = -Infinity;
    for (const r of t.ds.rows) {
      const raw = r[axis.time.name] ?? null;
      const ts = parseDate(raw, true);
      if (ts === null) continue;
      if (ts < cut && ts > prevMax) [prevMax, prevEnd] = [ts, raw];
      else if (ts >= cut && ts > latestMax) [latestMax, latestEnd] = [ts, raw];
    }
  }
  return {
    axis,
    prevStart: at(n - 2 * size),
    latestStart: at(n - size),
    prevLast: at(n - size - 1),
    latestLast: at(n - 1),
    prevEnd,
    latestEnd,
    prevLabel: label(n - 2 * size, n - size - 1),
    latestLabel: label(n - size, n - 1),
  };
}

/** Rows of both windows, tagged in `as` with `keys[0]` (previous) or `keys[1]` (latest); stocks keep only each window's last snapshot. */
function windowRows(w: Windows, as: string, keys: [string, string], stock: boolean): Transform[] {
  const time = w.axis.time.name;
  return [
    { op: "filter", expr: `\`${time}\` != null` },
    ...(stock ? [{ op: "filter" as const, expr: `\`${time}\` == ${literal(w.prevEnd)} or \`${time}\` == ${literal(w.latestEnd)}` }] : []),
    ...(w.axis.unit ? [{ op: "timeUnit" as const, field: time, unit: w.axis.unit }] : []),
    { op: "filter", expr: `\`${time}\` >= ${literal(w.prevStart)}` },
    { op: "derive", as, expr: `if(\`${time}\` >= ${literal(w.latestStart)}, ${literal(keys[1])}, ${literal(keys[0])})` },
  ];
}

function pivotSplit(d: Draft, pick: (name: string) => string, s: SplitPlan): Split {
  const t = d.primary;
  const value = s.m.field ?? pick("records");
  const [from, to] = s.fields;
  const change = pick("change");
  const changePct = pick("change_pct");
  const abs = pick("abs_change");
  const renames = Object.fromEntries(s.keys.map((k, i) => [String(k), s.fields[i]!]).filter(([k, f]) => k !== f));
  // Missing cells are zero for summable measures (a new category grew from nothing); averages stay unknown.
  const cell = (f: string) => (s.m.agg === "avg" ? `\`${f}\`` : `coalesce(\`${f}\`, 0)`);
  const transform: Transform[] = [
    ...s.index.map((f) => ({ op: "filter" as const, expr: `\`${f}\` != null` })),
    ...s.pre,
    { op: "aggregate", groupBy: [...s.index, s.column], measures: [{ ...(s.m.field ? { field: s.m.field } : {}), agg: s.m.agg, as: value }] },
    { op: "pivot", index: s.index, columns: s.column, values: value },
    ...(Object.keys(renames).length ? [{ op: "rename" as const, fields: renames }] : []),
    { op: "derive", as: change, expr: `${cell(to)} - ${cell(from)}` },
    { op: "derive", as: changePct, expr: `\`${change}\` / abs(\`${from}\`)` },
    { op: "derive", as: abs, expr: `abs(\`${change}\`)` },
    { op: "sort", by: `-${change}` },
  ];
  const format = s.m.field === undefined ? "integer" : fieldFormat(t, s.m.field);
  const withFormat = (name: string, label: string): FieldDef => ({ name, label, ...(format ? { format } : {}) });
  const id = d.makeId(s.name);
  d.datasets[id] = {
    from: t.ds.id,
    transform,
    description: s.description,
    fields: [
      ...s.index.flatMap((f) => fieldDef(f, undefined) ?? []),
      withFormat(from, s.labels[0]),
      withFormat(to, s.labels[1]),
      withFormat(change, s.changeLabel),
      { name: changePct, label: `${s.changeLabel} %`, format: "percent" },
      withFormat(abs, `Absolute ${s.changeLabel.toLowerCase()}`),
    ],
  };
  return { id, from, to, change, changePct, abs, rows: applyTransforms(t.ds.rows, transform, () => undefined) };
}

/** `m` per `dims` in the previous vs the latest window. */
function periodSplit(d: Draft, w: Windows, dims: string[], m: MeasureRef): Split {
  const pick = picker(d.primary);
  const period = pick("period");
  const fields: [string, string] = [pick("previous"), pick("latest")];
  return pivotSplit(d, pick, {
    name: `${d.primary.ds.id}_${dims.join("_")}_change`,
    pre: windowRows(w, period, fields, m.stock),
    index: dims,
    column: period,
    keys: fields,
    fields,
    labels: [w.prevLabel, w.latestLabel],
    m,
    changeLabel: "Change",
    description: `${m.label} per ${dims.map((f) => fieldLabel(f, true)).join(" × ")}, ${w.prevLabel} vs ${w.latestLabel}${m.stock ? " (end-of-window levels)" : ""}`,
  });
}

/** The largest gain and the largest drop (or smallest gain) of a one-dimension split; numbers stay bound. */
function moverText(s: Split, dim: string, m: MeasureRef): string {
  const dims = fieldLabel(dim, true);
  if (unsafe(dim, s.from, s.to, s.change, s.changePct)) return `${m.label} change by ${dims}, largest gain first.`;
  const ref = (agg: string, f: string, pipe = "") => `{{${agg}(${s.id}.${f})${pipe}}}`;
  const top = toNumber(s.rows[0]?.[s.change] ?? null);
  const bottom = toNumber(s.rows.at(-1)?.[s.change] ?? null);
  const gain =
    (top ?? 0) > 0
      ? `**${ref("first", dim)}** added the most (+${ref("first", s.change)}, ${ref("first", s.changePct, " | percent")})`
      : `**${ref("first", dim)}** held up best (${ref("first", s.change)})`;
  if (s.rows.length < 2) return `${gain}.`;
  const drop =
    (bottom ?? 0) < 0
      ? `**${ref("last", dim)}** fell the most (${ref("last", s.change)}, ${ref("last", s.changePct, " | percent")})`
      : `**${ref("last", dim)}** grew the least (${(bottom ?? 0) > 0 ? "+" : ""}${ref("last", s.change)})`;
  return `${gain}; ${drop}.`;
}

function overview(d: Draft): Outline {
  const { tables, primary, plan, datasets, makeId, locale } = d;
  const { trend } = plan;
  const derivedRate = plan.rate?.derived;
  const analysisBlocks: BlockInput[] = [];
  const addChart = (c: Drafted) => {
    const n = analysisBlocks.length / 2 + 1;
    analysisBlocks.push({ id: `chart_${n}`, type: "chart", title: c.title, chart: c.chart, height: "md" }, { id: `insight_${n}`, type: "text", content: c.text });
  };
  if (trend) addChart(trendChart(plan, trend));
  const usedX = new Set(trend ? [trend.axis.time.name] : []);
  for (const b of breakdowns(tables, plan)) {
    if (analysisBlocks.length / 2 >= MAX_CHARTS) break;
    if (usedX.has(b.dim.name)) continue;
    usedX.add(b.dim.name);
    const dd = byDimension(b.table, b.dim.name, b.measure, b.table === primary ? derivedRate : undefined, makeId, datasets);
    // A donut adds variety only as a later view of a small split.
    if (analysisBlocks.length > 0 && canDonut(b, dd) && analysisBlocks.some((x) => x.type === "chart" && x.chart.kind === "bar")) {
      addChart({
        chart: { kind: "donut", data: dd.id, x: b.dim.name, y: dd.valueField },
        title: `${b.measure.label} share by ${fieldLabel(b.dim.name, true)}${latestSuffix(dd, trend)}`,
        text: breakdownText(b, dd, false, trend),
      });
      continue;
    }
    addChart(barChart(b, dd, trend));
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
  return { title: `${fieldLabel(primary.ds.id)} report`, sections };
}

/** One page: headline KPIs, the most informative chart (headline trend, else the strongest breakdown), one insight. */
function brief(d: Draft): Outline {
  const { plan, primary } = d;
  let lead: Drafted | undefined;
  if (plan.trend) lead = trendChart(plan, plan.trend);
  else {
    const b = breakdowns(d.tables, plan)[0];
    if (b) lead = barChart(b, byDimension(b.table, b.dim.name, b.measure, b.table === primary ? plan.rate?.derived : undefined, d.makeId, d.datasets), plan.trend);
  }
  const blocks: BlockInput[] = [{ id: "kpis", type: "kpi", items: kpiItems(plan, d.makeId, d.datasets, d.locale) }];
  if (lead) {
    blocks.push(
      { id: "lead_chart", type: "chart", title: lead.title, chart: lead.chart, height: "md" },
      { id: "insight", type: "callout", tone: "info", variant: "insight", title: "What stands out", content: lead.text },
    );
  }
  return { title: `${d.subject} brief`, sections: [{ id: "brief", title: `${plan.head.label} at a glance`, role: "summary", blocks }], targetPages: 1 };
}

/** Trajectory with a 3-period moving average, period-over-period growth, and the best/worst periods. */
function trendReport(d: Draft): Outline | undefined {
  const { plan, primary } = d;
  const trend = plan.trend;
  if (!trend) return undefined;
  const { head } = plan;
  const unit = trend.axis.unit ?? "period";
  const time = trend.axis.time.name;
  const id = trend.id;
  const pick = picker(primary);
  for (const f of [trend.countField, trend.changeField, plan.rate?.derived?.as]) if (f !== undefined) pick(f);
  const ma = pick(`${trend.value}_avg3`);
  const rank = pick("rank");
  const format = head.field === undefined ? "integer" : fieldFormat(primary, head.field);
  const base = trend.dataset;
  d.datasets[id] = {
    ...base,
    transform: [...(base.transform ?? []), { op: "window", fn: "movingAvg", field: trend.value, as: ma, size: 3 }],
    fields: [
      ...(base.fields ?? []),
      { name: ma, label: `3-${unit} average`, ...(format ? { format } : {}) },
      { name: trend.changeField, label: `Change vs previous ${unit}`, format: "percent" },
      ...(head.field === undefined ? [{ name: trend.countField, label: plan.countLabel, format: "integer" }] : []),
    ],
  };
  const n = trend.axis.periods.length;
  const extremes = d.makeId(`${id}_extremes`);
  d.datasets[extremes] = {
    from: id,
    transform: [
      { op: "window", fn: "rank", field: trend.value, as: rank },
      { op: "filter", expr: `\`${rank}\` <= ${EXTREME_PERIODS} or \`${rank}\` > ${n - EXTREME_PERIODS}` },
      { op: "sort", by: `-${trend.value}` },
    ],
    description: `Top and bottom ${EXTREME_PERIODS} ${unit}s by ${head.inline}`,
  };

  const dateFormat = trend.axis.unit ? `date:${trend.axis.unit}` : undefined;
  const xFormat = dateFormat ? { xFormat: dateFormat } : {};
  const ref = (agg: string, f: string, pipe = "") => `{{${agg}(${id}.${f})${pipe}}}`;
  const safe = !unsafe(time, trend.value, trend.changeField, ma);
  const line: Drafted = {
    chart: { kind: "line", data: id, x: time, y: [trend.value, ma], ...xFormat },
    title: `${head.label} per ${unit} with its 3-${unit} moving average`,
    text: safe
      ? `Smoothed over 3 ${unit}s, ${head.inline} moved from ${ref("first", ma)} to **${ref("last", ma)}**; single ${unit}s ranged from ${ref("min", trend.value)} to ${ref("max", trend.value)}.`
      : `${head.label} per ${unit}, smoothed over 3 ${unit}s.`,
  };
  const growth: Drafted = {
    chart: { kind: "bar", data: id, x: time, y: trend.changeField, yFormat: "percent", reference: [{ value: 0, axis: "y" }], ...xFormat },
    title: `${head.label} growth, ${unit} over ${unit}`,
    text: safe
      ? `Across {{count(${id})}} ${unit}s, growth averaged ${ref("avg", trend.changeField, " | percent")} per ${unit}, from ${ref("min", trend.changeField, " | percent")} in the weakest ${unit} to ${ref("max", trend.changeField, " | percent")} in the strongest.`
      : `${head.label} change vs the previous ${unit}.`,
  };
  return {
    title: `${d.subject} trends`,
    sections: [
      {
        id: "latest",
        title: `Latest ${unit}`,
        role: "summary",
        blocks: [
          { id: "kpis", type: "kpi", items: kpiItems(plan, d.makeId, d.datasets, d.locale) },
          { id: "latest_change", type: "callout", tone: "info", variant: "insight", title: `Latest ${unit} change`, content: trendChart(plan, trend).text },
        ],
      },
      { id: "trajectory", title: `${head.label} over time`, role: "analysis", blocks: [...chartBlocks("trend", line), ...chartBlocks("growth", growth)] },
      {
        id: "extremes",
        title: `Best and worst ${unit}s`,
        role: "detail",
        blocks: [
          {
            id: "extremes_table",
            type: "table",
            title: `Top and bottom ${EXTREME_PERIODS} ${unit}s by ${head.inline}`,
            data: extremes,
            columns: [
              { field: time, label: fieldLabel(time), ...(dateFormat ? { format: dateFormat } : {}) },
              { field: trend.value, label: head.label, ...(format ? { format } : {}) },
              { field: trend.changeField, label: `vs previous ${unit}`, format: "percent" },
              { field: rank, label: "Rank", format: "integer" },
            ],
            sortBy: `-${trend.value}`,
            maxRows: 2 * EXTREME_PERIODS,
          },
        ],
      },
    ],
  };
}

/** Latest window vs the previous one: headline comparison, a dumbbell by the main dimension, the biggest movers. */
function compare(d: Draft): Outline | undefined {
  const { plan, primary } = d;
  const trend = plan.trend;
  if (!trend) return compareCategories(d);
  const w = windows(primary, trend.axis, d.locale);
  const head = plan.head;
  const metrics = headlineMetrics(plan);
  const period = picker(primary)("period");
  const keys: [string, string] = ["previous", "latest"];
  const totals = groupTotals(d, `${primary.ds.id}_windows`, metrics, period, windowRows(w, period, keys, false), `Headline metrics, ${w.prevLabel} vs ${w.latestLabel}`);
  const time = trend.axis.time.name;
  const value = (m: Metric, i: 0 | 1): MeasureInput =>
    m.ref.stock && m.ref.field !== undefined
      ? { data: trend.id, field: m.ref.field, agg: "sum", where: `\`${time}\` == ${literal(i === 0 ? w.prevLast : w.latestLast)}` }
      : { data: totals.id, field: totals.field(m), agg: "sum", where: `\`${period}\` == ${literal(keys[i])}` };
  const title = `${d.subject}: ${w.latestLabel} vs ${w.prevLabel}`;
  const sections: SectionInput[] = [
    {
      id: "head_to_head",
      title: `${w.latestLabel} vs ${w.prevLabel}`,
      role: "summary",
      blocks: [
        {
          id: "comparison",
          type: "comparison",
          title: `Key metrics, ${w.prevLabel} → ${w.latestLabel}`,
          entities: [w.prevLabel, w.latestLabel],
          metrics: metrics.map((m) => ({ label: m.ref.label, values: [value(m, 0), value(m, 1)], ...(m.format ? { format: m.format } : {}), ...(m.down ? { goodWhen: "down" as const } : {}) })),
        },
      ],
    },
  ];
  const [main, second] = dimsOf(primary, plan);
  if (!main) return { title, sections };
  const dims = fieldLabel(main.name, true);
  const s = periodSplit(d, w, [main.name], head);
  sections.push({
    id: "by_dimension",
    title: `${head.label} by ${dims}`,
    role: "analysis",
    blocks: chartBlocks("dumbbell", {
      chart: { kind: "dumbbell", data: s.id, x: main.name, y: [s.from, s.to] },
      title: `${head.label} by ${dims}, ${w.prevLabel} → ${w.latestLabel}`,
      text: moverText(s, main.name, head),
    }),
  });
  const index = second ? [main.name, second.name] : [main.name];
  const movers = second ? periodSplit(d, w, index, head) : s;
  const format = head.field === undefined ? "integer" : fieldFormat(primary, head.field);
  sections.push({
    id: "movers",
    title: "Biggest movers",
    role: "detail",
    blocks: [
      {
        id: "movers_table",
        type: "table",
        title: `Largest changes in ${head.inline} by ${index.map((f) => fieldLabel(f, true)).join(" and ")}`,
        data: movers.id,
        columns: [
          ...index.map((f) => ({ field: f })),
          ...[movers.from, movers.to, movers.change].map((f) => ({ field: f, ...(format ? { format } : {}) })),
          { field: movers.changePct, format: "percent" },
        ],
        sortBy: `-${movers.abs}`,
        maxRows: 10,
      },
    ],
  });
  return { title, sections };
}

/** Without time: the two leading categories of the main dimension, side by side. */
function compareCategories(d: Draft): Outline | undefined {
  const { primary: t, plan } = d;
  const [main, second] = dimsOf(t, plan);
  if (!main) return undefined;
  const m = plan.head;
  const pick = picker(t);
  const value = m.field ?? pick("records");
  const ranked = applyTransforms(
    t.ds.rows,
    [
      { op: "filter", expr: `\`${main.name}\` != null` },
      { op: "aggregate", groupBy: [main.name], measures: [{ ...(m.field ? { field: m.field } : {}), agg: m.agg, as: value }] },
      { op: "sort", by: `-${value}` },
    ],
    () => undefined,
  );
  const a = ranked[0]?.[main.name] ?? null;
  const b = ranked[1]?.[main.name] ?? null;
  if (a === null || b === null) return undefined;
  const [la, lb] = [String(a), String(b)];
  const both = `\`${main.name}\` == ${literal(a)} or \`${main.name}\` == ${literal(b)}`;
  const metrics = headlineMetrics(plan);
  const totals = groupTotals(d, `${t.ds.id}_${main.name}_pair`, metrics, main.name, [{ op: "filter", expr: both }], `Headline metrics for ${la} and ${lb}`);
  const at = (x: Metric, k: Scalar): MeasureInput => ({ data: totals.id, field: totals.field(x), agg: "sum", where: `\`${main.name}\` == ${literal(k)}` });
  const title = `${d.subject}: ${la} vs ${lb}`;
  const sections: SectionInput[] = [
    {
      id: "head_to_head",
      title: `${la} vs ${lb}`,
      role: "summary",
      blocks: [
        {
          id: "comparison",
          type: "comparison",
          title: `Key metrics, ${la} vs ${lb}`,
          entities: [la, lb],
          metrics: metrics.map((x) => ({ label: x.ref.label, values: [at(x, a), at(x, b)], ...(x.format ? { format: x.format } : {}), ...(x.down ? { goodWhen: "down" as const } : {}) })),
        },
      ],
    },
  ];
  if (!second) {
    const dd = byDimension(t, main.name, m, plan.rate?.derived, d.makeId, d.datasets, true);
    sections.push({
      id: "context",
      title: `All ${fieldLabel(main.name, true)} values`,
      role: "detail",
      blocks: [
        {
          id: "context_table",
          type: "table",
          title: `Where ${la} and ${lb} rank by ${m.inline}`,
          data: dd.id,
          columns: [
            { field: dd.rankField!, label: "Rank", format: "integer" },
            { field: main.name },
            { field: dd.valueField, label: m.label },
            ...(dd.shareField ? [{ field: dd.shareField, label: "Share", format: "percent" }] : []),
          ],
          sortBy: dd.rankField!,
          maxRows: 20,
        },
      ],
    });
    return { title, sections };
  }
  const slug = makeIdFactory();
  const s = pivotSplit(d, pick, {
    name: `${t.ds.id}_${second.name}_gap`,
    pre: [{ op: "filter", expr: both }],
    index: [second.name],
    column: main.name,
    keys: [b, a],
    fields: [pick(slug(lb)), pick(slug(la))],
    labels: [lb, la],
    m,
    changeLabel: `${la} lead`,
    description: `${m.label} per ${fieldLabel(second.name, true)}: ${la} vs ${lb}`,
  });
  const dims = fieldLabel(second.name, true);
  const ref = (agg: string, f: string) => `{{${agg}(${s.id}.${f})}}`;
  const bottom = toNumber(s.rows.at(-1)?.[s.change] ?? null) ?? 0;
  const text = unsafe(second.name, s.change)
    ? `${m.label} by ${dims}: ${la} vs ${lb}.`
    : `${la} leads ${lb} by the most in **${ref("first", second.name)}** (${ref("first", s.change)}); ` +
      (bottom < 0
        ? `${lb} is ahead in **${ref("last", second.name)}** (${ref("last", s.change)}).`
        : `the gap is smallest in **${ref("last", second.name)}** (${ref("last", s.change)}).`);
  sections.push(
    {
      id: "by_dimension",
      title: `${m.label} by ${dims}`,
      role: "analysis",
      blocks: chartBlocks("dumbbell", { chart: { kind: "dumbbell", data: s.id, x: second.name, y: [s.from, s.to] }, title: `${m.label} by ${dims}: ${la} vs ${lb}`, text }),
    },
    {
      id: "gaps",
      title: "Largest gaps",
      role: "detail",
      blocks: [
        {
          id: "gaps_table",
          type: "table",
          title: `${fieldLabel(second.name)} values where ${la} and ${lb} differ most`,
          data: s.id,
          columns: [{ field: second.name }, { field: s.to }, { field: s.from }, { field: s.change }],
          sortBy: `-${s.abs}`,
          maxRows: 10,
        },
      ],
    },
  );
  return { title, sections };
}

/** Ranking of the strongest dimension: horizontal bars (top 10 + others), share donut (≤ 6), mix by a second dimension, ranked table. */
function breakdownReport(d: Draft): Outline | undefined {
  const { plan, primary } = d;
  const b = breakdowns(d.tables, plan)[0];
  if (!b) return undefined;
  const { table: t, dim, measure: m } = b;
  const trend = plan.trend;
  const dims = fieldLabel(dim.name, true);
  const dd = byDimension(t, dim.name, m, t === primary ? plan.rate?.derived : undefined, d.makeId, d.datasets, true);
  const suffix = latestSuffix(dd, trend);
  const bar = barChart(b, dd, trend);
  const ranking = chartBlocks("ranking", { ...bar, chart: { ...bar.chart, horizontal: true } });
  if (canDonut(b, dd) && dd.shareField && !unsafe(dd.valueField, dd.shareField)) {
    const ref = (agg: string, f: string, pipe = "") => `{{${agg}(${dd.id}.${f})${pipe}}}`;
    ranking.push(
      ...chartBlocks("share", {
        chart: { kind: "donut", data: dd.id, x: dim.name, y: dd.valueField },
        title: `Share of ${m.inline} by ${dims}${suffix}`,
        text: `Across {{count(${dd.id})}} ${dims} values (${m.inline} ${ref("sum", dd.valueField)} in total), the median holds ${ref("median", dd.shareField, " | percent")} and the smallest ${ref("min", dd.shareField, " | percent")}.`,
      }),
    );
  }
  const sections: SectionInput[] = [{ id: "ranking", title: `${fieldLabel(dim.name)} ranking`, role: "analysis", blocks: ranking }];
  const second = dimsOf(t, plan).find((f) => f !== dim && f.distinct <= MAX_FULL_BAR);
  // Shares of averages mean nothing, so the 100% mix needs a summable measure.
  if (second && m.agg !== "avg") {
    const value = m.field ?? picker(t)("records");
    const latest = m.stock ? latestFilter(t) : undefined;
    const mix = d.makeId(`${t.ds.id}_${dim.name}_by_${second.name}`);
    const defs = [fieldDef(dim.name, undefined), fieldDef(second.name, undefined), fieldDef(value, fieldFormat(t, m.field))].filter((x): x is FieldDef => x !== undefined);
    d.datasets[mix] = {
      from: t.ds.id,
      transform: [
        { op: "filter", expr: `\`${dim.name}\` != null and \`${second.name}\` != null` },
        ...(latest ? [{ op: "filter" as const, expr: `\`${latest.field}\` == ${literal(latest.value)}` }] : []),
        { op: "aggregate", groupBy: [dim.name, second.name], measures: [{ ...(m.field ? { field: m.field } : {}), agg: m.agg, as: value }] },
      ],
      description: `${m.label} per ${dims} × ${fieldLabel(second.name, true)}${latest ? " in the latest period" : ""}`,
      ...(defs.length ? { fields: defs } : {}),
    };
    const secondSplit = byDimension(t, second.name, m, undefined, d.makeId, d.datasets);
    sections.push({
      id: "mix",
      title: `${fieldLabel(second.name)} mix by ${dims}`,
      role: "analysis",
      blocks: chartBlocks("mix", {
        chart: { kind: "bar", data: mix, x: dim.name, y: value, series: second.name, stack: "percent", horizontal: true },
        title: `${fieldLabel(second.name)} share of ${m.inline} within each ${dims}${suffix}`,
        text: breakdownText({ table: t, dim: second, measure: m, score: 0 }, secondSplit, false, trend),
      }),
    });
  }
  const format = m.field === undefined ? "integer" : fieldFormat(t, m.field);
  sections.push({
    id: "ranked",
    title: `Full ${dims} ranking`,
    role: "detail",
    blocks: [
      {
        id: "ranked_table",
        type: "table",
        title: `${fieldLabel(dim.name)} ranked by ${m.inline}${suffix}`,
        data: dd.id,
        columns: [
          { field: dd.rankField!, label: "Rank", format: "integer" },
          { field: dim.name },
          { field: dd.valueField, label: m.label, ...(format ? { format } : {}) },
          ...(dd.shareField ? [{ field: dd.shareField, label: "Share", format: "percent" }] : []),
          ...(dd.rateField ? [{ field: dd.rateField, format: "percent" }] : []),
        ],
        sortBy: dd.rankField!,
        maxRows: 20,
        ...(dd.shareField ? { totals: [dd.valueField, dd.shareField] } : {}),
      },
    ],
  });
  return { title: `${d.subject} by ${dims}`, sections };
}

/** What changed and why: waterfall from the previous window's total through each category's change to the latest total. */
function bridge(d: Draft): Outline | undefined {
  const { plan, primary } = d;
  const trend = plan.trend;
  const [main, second] = dimsOf(primary, plan);
  if (!trend || !main) return undefined;
  // Contributions must add up: averages cannot be bridged, so their records are counted instead.
  const m = plan.head.agg === "avg" ? measureRef(primary, undefined, plan.countLabel) : plan.head;
  const w = windows(primary, trend.axis, d.locale);
  const dims = fieldLabel(main.name, true);
  const s = periodSplit(d, w, [main.name], m);
  const pick = picker(primary);
  for (const f of [s.from, s.to, s.change, s.changePct, s.abs]) pick(f);
  const part = pick("part");
  const amount = pick("amount");
  const step = pick("step");
  const format = m.field === undefined ? "integer" : fieldFormat(primary, m.field);
  const steps = d.makeId(`${s.id}_steps`);
  d.datasets[steps] = {
    from: s.id,
    transform: [
      ...(s.rows.length > MAX_FULL_BAR ? [{ op: "top" as const, n: MAX_WATERFALL_STEPS, by: s.abs, field: main.name, othersLabel: "Other" }] : []),
      { op: "sort", by: `-${s.change}` },
      // Previous values and changes as rows; summing previous values per step gives the starting total, then one change per category.
      { op: "fold", fields: [s.from, s.change], as: [part, amount] },
      { op: "derive", as: step, expr: `if(\`${part}\` == ${literal(s.from)}, ${literal(w.prevLabel)}, \`${main.name}\`)` },
      { op: "aggregate", groupBy: [step], measures: [{ field: amount, agg: "sum", as: amount }] },
    ],
    description: `${m.label} bridge: ${w.prevLabel} total, then each ${dims} value's change`,
    fields: [
      { name: step, label: fieldLabel(main.name) },
      { name: amount, label: m.label, ...(format ? { format } : {}) },
    ],
  };
  const span = `${w.prevLabel} → ${w.latestLabel}`;
  const net = s.rows.reduce((a, r) => a + (toNumber(r[s.change] ?? null) ?? 0), 0);
  const totalText = unsafe(s.from, s.to, s.change)
    ? `${m.label} bridge from ${w.prevLabel} to ${w.latestLabel}.`
    : `${m.label} went from {{sum(${s.id}.${s.from})}} in ${w.prevLabel} to **{{sum(${s.id}.${s.to})}}** in ${w.latestLabel}, a net change of ${net > 0 ? "+" : ""}{{sum(${s.id}.${s.change})}} across {{count(${s.id})}} ${dims} values.`;
  const contributors: BlockInput[] = [
    { id: "contributors_callout", type: "callout", tone: "info", variant: "insight", title: `Biggest contributors by ${dims}`, content: moverText(s, main.name, m) },
  ];
  if (second) {
    const s2 = periodSplit(d, w, [second.name], m);
    contributors.push(
      ...chartBlocks("contributors", {
        chart: { kind: "bar", data: s2.id, x: second.name, y: s2.change, horizontal: true, reference: [{ value: 0, axis: "y" }] },
        title: `${m.label} change by ${fieldLabel(second.name, true)}, ${span}`,
        text: moverText(s2, second.name, m),
      }),
    );
  }
  return {
    title: `${d.subject}: what changed, ${span}`,
    sections: [
      {
        id: "what_changed",
        title: "What changed",
        role: "summary",
        blocks: chartBlocks("waterfall", {
          chart: { kind: "waterfall", data: steps, x: step, y: amount, base: "first", total: w.latestLabel },
          title: `${m.label} change by ${dims}, ${span}`,
          text: totalText,
        }),
      },
      { id: "contributors", title: "Contributors", role: "analysis", blocks: contributors },
      {
        id: "contributions",
        title: "Detail",
        role: "detail",
        blocks: [
          {
            id: "contributions_table",
            type: "table",
            title: `${m.label} by ${dims}, ${span}`,
            data: s.id,
            columns: [
              { field: main.name },
              ...[s.from, s.to, s.change].map((f) => ({ field: f, ...(format ? { format } : {}) })),
              { field: s.changePct, format: "percent" },
            ],
            sortBy: `-${s.change}`,
            maxRows: 20,
            totals: [s.from, s.to, s.change],
          },
        ],
      },
    ],
  };
}

const NO_TIME = "No date field was found";

function outline(d: Draft, archetype: Archetype): Outline {
  switch (archetype) {
    case "overview":
      return overview(d);
    case "brief":
      return brief(d);
    case "trend":
      return trendReport(d) ?? { ...overview(d), note: `${NO_TIME}, so this draft is an overview instead of a trend analysis.` };
    case "compare":
      return compare(d) ?? { ...overview(d), note: `${NO_TIME} and no categorical field to compare, so this draft is an overview.` };
    case "breakdown":
      return breakdownReport(d) ?? { ...overview(d), note: "No categorical field with 3–49 values was found, so this draft is an overview instead of a ranking." };
    case "bridge":
      if (!d.plan.trend) return { ...(breakdownReport(d) ?? overview(d)), note: `${NO_TIME}, so there is no earlier period to bridge from; this draft ranks categories instead.` };
      return bridge(d) ?? { ...trendReport(d)!, note: "No categorical field was found to attribute the change to, so this draft shows the trend instead." };
  }
}

/**
 * Headless "any data → draft report".
 * Accepts an array of records, an object of named arrays / CSV strings, nested JSON, or a CSV string.
 * The archetype picks the structure (see AutoReportOptions); "overview" reads KPIs → trend of the headline measure →
 * up to two category breakdowns → two-way splits → detail table.
 * Every number in the output is data-bound (Measure objects or {{...}} placeholders).
 */
export function autoReport(input: unknown, opts: AutoReportOptions = {}): ReportSpecInput {
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
  const pid = primary.ds.id;
  const subject = pid === "data" ? plan.head.label : fieldLabel(pid);
  const out = outline({ tables, primary, plan, datasets, makeId, locale: opts.locale ?? "en-US", subject }, opts.archetype ?? "overview");

  const time = trend?.axis.time.name;
  const unitPipe = trend?.axis.unit ? ` | date:${trend.axis.unit}` : "";
  const range = trend && time && !UNSAFE_TEMPLATE_NAME.test(time) ? ` from {{first(${trend.id}.${time})${unitPipe}}} to {{last(${trend.id}.${time})${unitPipe}}}` : "";
  const meta = {
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.currency ? { currency: opts.currency.toUpperCase() } : {}),
  };
  return {
    version: "1",
    title: opts.title ?? out.title,
    summary: `Automatically drafted from {{count(${pid})}} ${pid === "data" ? "records" : `${fieldLabel(pid, true)} records`}${range}.${out.note ? ` ${out.note}` : ""}`,
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(out.targetPages ? { page: { targetPages: out.targetPages } } : {}),
    datasets,
    sections: out.sections,
  };
}
