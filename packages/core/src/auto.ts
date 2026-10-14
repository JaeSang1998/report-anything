import type { Agg, ChartSpec, FieldDef, ReportSpecInput, Row, Scalar, TableColumn, Transform } from "./spec.js";
import type { DateUnit } from "./data/format.js";
import type { DatasetProfile, FieldProfile, ResolvedDataset } from "./data/types.js";
import { parseCsv } from "./data/csv.js";
import { formatDate } from "./data/format.js";
import { findRecordArray, normalizeJson } from "./data/normalize.js";
import { magnitude, profileDataset, rankMeasures } from "./data/profile.js";
import { inferFields } from "./data/resolve.js";
import { applyTransforms } from "./data/transform.js";
import { humanize, parseDate, toNumber } from "./data/values.js";

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

/** What a chart/split aggregates: a field with its aggregation, or a row count (`field` undefined). */
interface MeasureRef {
  field: string | undefined;
  agg: Agg;
  label: string;
}

interface Trend {
  id: string;
  time: string;
  unit: DateUnit | undefined;
  periods: Scalar[];
  countField: string;
  /** Headline measure aggregated per period (count field when the table has no measure). */
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
}

const AVG_NAME = /price|rate|ratio|avg|average|mean|score|rating|pct|percent|margin|(^|[^a-z])age($|[^a-z])|평균|단가|비율/i;
const DOWN_IS_GOOD = /cost|expense|churn|loss|debt|defect|return|비용|손실/i;
const PRICE_NAME = /price|단가|가격/i;
const QTY_NAME = /(^|[._\s-])(qty|quantity|units?)$|수량/i;
const UNSAFE_TEMPLATE_NAME = /[(){}|]/;
const DAY = 86_400_000;
const MAX_CHARTS = 3;
const MAX_SPLITS = 2;
const MAX_TABLE_COLUMNS = 8;
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

function analyze(id: string, rows: Row[], childPrefix?: string): Analyzed {
  const base: ResolvedDataset = { id, rows, fields: inferFields(rows) };
  let profile = profileDataset(base);
  if (childPrefix !== undefined) {
    // Parent values repeat on every exploded row; only the child's own measures may be aggregated.
    const fields = profile.fields.map((f) => (f.role === "measure" && !f.name.startsWith(childPrefix) ? { ...f, role: "identifier" as const } : f));
    profile = { ...profile, fields };
  }
  const defs = profile.fields.flatMap((f) => (f.suggestedFormat ? [{ name: f.name, format: f.suggestedFormat }] : []));
  return { ds: { ...base, fields: inferFields(rows, defs) }, profile, defs };
}

/** Line amount (price × quantity) when a table has both but no summable amount of its own. */
function amountDerive(a: Analyzed, prefix: string): Transform | undefined {
  const measures = rankMeasures(a.profile.fields);
  const price = measures.find((f) => PRICE_NAME.test(f.name));
  const qty = measures.find((f) => QTY_NAME.test(f.name));
  if (!price || !qty || measures.some((m) => m !== price && m !== qty && measureAgg(m) === "sum" && !m.name.endsWith(".count"))) {
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

function measureAgg(f: FieldProfile): Agg {
  return f.suggestedFormat === "percent" || AVG_NAME.test(f.name) ? "avg" : "sum";
}

function fieldFormat(t: Analyzed, field: string | undefined): string | undefined {
  return field === undefined ? undefined : t.defs.find((d) => d.name === field)?.format;
}

function measureRef(t: Table): MeasureRef {
  const m = t.ranked[0];
  if (!m) return { field: undefined, agg: "count", label: "Records" };
  const agg = measureAgg(m);
  return { field: m.name, agg, label: agg === "avg" ? `Avg ${humanize(m.name).toLowerCase()}` : humanize(m.name) };
}

/** Period granularity for raw timestamps: native spacing, coarsened to month/week when daily data spans enough periods. */
function periodUnit(times: number[]): DateUnit {
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i]! - sorted[i - 1]!);
  const native: DateUnit = minGap >= 360 * DAY ? "year" : minGap >= 89 * DAY ? "quarter" : minGap >= 28 * DAY ? "month" : minGap >= 7 * DAY ? "week" : "day";
  if (native !== "day" && native !== "week") return native;
  const months = new Set(sorted.map((t) => new Date(t).toISOString().slice(0, 7))).size;
  if (months >= 3) return "month";
  if (native === "day" && new Set(sorted.map((t) => Math.floor((t + 3 * DAY) / (7 * DAY)))).size >= 3) return "week";
  return native;
}

/** Per-period dataset of `measures` plus a record count and the headline's change vs the previous period. */
function buildTrend(t: Table, measures: readonly FieldProfile[], makeId: MakeId): Trend | undefined {
  const time = t.profile.fields.find((f) => f.role === "time" && f.distinct >= 2);
  if (!time || t.ds.rows.length === 0) return undefined;
  const names = t.ds.fields.map((f) => f.name);
  const transforms: Transform[] = [];
  let unit: DateUnit | undefined;
  if (time.type === "date") {
    const times = t.ds.rows.map((r) => parseDate(r[time.name] ?? null, true)).filter((x): x is number => x !== null);
    unit = periodUnit(times);
    transforms.push({ op: "timeUnit", field: time.name, unit });
  }
  const countField = freeName("records", names);
  const value = measures[0]?.name ?? countField;
  const changeField = freeName(`${value}_change`, names);
  transforms.push(
    { op: "filter", expr: `\`${time.name}\` != null` },
    {
      op: "aggregate",
      groupBy: [time.name],
      measures: [...measures.map((m) => ({ field: m.name, agg: measureAgg(m), as: m.name })), { agg: "count", as: countField }],
    },
    { op: "sort", by: time.name },
    { op: "window", fn: "pctChange", field: value, as: changeField },
  );
  const rows = applyTransforms(t.ds.rows, transforms, () => undefined);
  const defs = t.defs.filter((d) => measures.some((m) => m.name === d.name));
  const id = makeId(`${t.ds.id}_trend`);
  return {
    id,
    time: time.name,
    unit,
    periods: rows.map((r) => r[time.name] ?? null),
    countField,
    value,
    changeField,
    dataset: {
      from: t.ds.id,
      transform: transforms,
      description: `${humanize(t.ds.id)} aggregated per ${unit ?? humanize(time.name).toLowerCase()}`,
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
 * Headline KPIs: primary measure, record count and at most one more measure (the next ranked one,
 * else the primary's per-record average). With a trend they compare the latest period with the previous one.
 */
function kpiItems(t: Table, extra: FieldProfile | undefined, trend: Trend | undefined, locale: string): KpiItemInput[] {
  const primary = t.ranked[0];
  const latest = trend?.periods[trend.periods.length - 1];
  const prev = trend?.periods[trend.periods.length - 2];
  const compare = trend !== undefined && latest !== undefined && latest !== null && prev !== undefined && prev !== null;
  const periods = compare
    ? { deltaLabel: `vs ${periodLabel(prev, trend.unit, locale)}`, description: periodLabel(latest, trend.unit, locale) }
    : {};
  const at =
    (field: string) =>
    (period: Scalar): MeasureInput => ({ data: trend!.id, field, agg: "sum", where: `\`${trend!.time}\` == ${literal(period)}` });
  // One record per period (pre-aggregated input) makes per-period counts and averages meaningless.
  const manyPerPeriod = trend !== undefined && t.profile.rowCount > trend.periods.length;
  const items: KpiItemInput[] = [];
  const add = (label: string, name: string, format: string | undefined, raw: { field?: string; agg: Agg }, perPeriod: ((p: Scalar) => MeasureInput) | undefined) => {
    const common = { label, ...(format ? { format } : {}), ...(DOWN_IS_GOOD.test(name) ? { goodWhen: "down" as const } : {}) };
    if (compare && perPeriod) items.push({ ...common, ...periods, value: perPeriod(latest), compareTo: perPeriod(prev) });
    else items.push({ ...common, value: { data: t.ds.id, ...raw } });
  };

  if (primary) {
    const ref = measureRef(t);
    add(ref.label, primary.name, kpiFormat(primary), { field: primary.name, agg: ref.agg }, at(primary.name));
  }
  add(t.ds.id === "data" ? "Records" : humanize(t.ds.id), "records", "integer", { agg: "count" }, manyPerPeriod ? at(trend!.countField) : undefined);
  if (extra) {
    const agg = measureAgg(extra);
    add(agg === "avg" ? `Avg ${humanize(extra.name).toLowerCase()}` : humanize(extra.name), extra.name, kpiFormat(extra), { field: extra.name, agg }, at(extra.name));
  } else if (primary && measureAgg(primary) === "sum" && (trend ? manyPerPeriod : t.profile.rowCount > 1)) {
    // Several records per period: the average record value is a distinct, meaningful figure.
    const range = (from: Scalar, to?: Scalar) =>
      trend!.unit
        ? `\`${trend!.time}\` >= ${literal(from)}${to === undefined ? "" : ` and \`${trend!.time}\` < ${literal(to)}`}`
        : `\`${trend!.time}\` == ${literal(from)}`;
    add(
      `Avg ${humanize(primary.name).toLowerCase()} per record`,
      primary.name,
      kpiFormat(primary),
      { field: primary.name, agg: "avg" },
      (p) => ({ data: t.ds.id, field: primary.name, agg: "avg", where: p === latest ? range(latest) : range(prev!, latest!) }),
    );
  }
  return items;
}

/** Coefficient of variation of per-category totals: how much the dimension explains (0 = even split). */
function spread(t: Table, dim: string, m: MeasureRef): number {
  const totals = new Map<string, number>();
  for (const r of t.ds.rows) {
    const k = r[dim];
    if (k === null || k === undefined) continue;
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
function breakdowns(tables: readonly Table[], primary: Table): Breakdown[] {
  return tables
    .flatMap((t) => {
      const measure = measureRef(t);
      const prefix = t.source.childPrefix;
      return t.profile.fields
        .filter((f) => f.role === "dimension" && f.distinct >= 3 && f.distinct <= MAX_CHART_CATEGORIES)
        .filter((f) => prefix === undefined || f.name.startsWith(prefix))
        .map((dim) => ({
          table: t,
          dim,
          measure,
          score: (dim.distinct <= MAX_FULL_BAR ? 2 : 1) + (t === primary ? 0.5 : 0) + spread(t, dim.name, measure),
        }));
    })
    .sort((a, b) => b.score - a.score);
}

/** Dataset aggregating `m` per `dim` (largest first) with each category's share of the total when summable. */
function byDimension(t: Table, dim: string, m: MeasureRef, makeId: MakeId, datasets: Record<string, DatasetInput>): ByDimension {
  const id = makeId(`${t.ds.id}_by_${dim}`);
  const valueField = m.field ?? freeName("records", [dim]);
  const shareField = m.agg === "avg" ? undefined : freeName(`${valueField}_share`, [dim]);
  const format = fieldFormat(t, m.field);
  datasets[id] = {
    from: t.ds.id,
    transform: [
      { op: "filter", expr: `\`${dim}\` != null` },
      { op: "aggregate", groupBy: [dim], measures: [{ ...(m.field ? { field: m.field } : {}), agg: m.agg, as: valueField }] },
      { op: "sort", by: `-${valueField}` },
      ...(shareField ? [{ op: "window" as const, fn: "share" as const, field: valueField, as: shareField }] : []),
    ],
    description: `${m.label} per ${humanize(dim).toLowerCase()}`,
    ...(format ? { fields: [{ name: valueField, format }] } : {}),
  };
  return { id, valueField, shareField };
}

/** Sentence on the leader's and laggard's share — information the bars themselves do not print. */
function breakdownText(b: Breakdown, d: ByDimension, limited: boolean): string {
  const dim = b.dim.name;
  const what = b.measure.label.toLowerCase();
  const dims = humanize(dim).toLowerCase();
  if ([dim, d.valueField].some((n) => UNSAFE_TEMPLATE_NAME.test(n))) return `${b.measure.label} by ${dims}, largest first.`;
  const lead = limited ? `Of {{count(${d.id})}} ${dims} values, ` : "";
  if (!d.shareField) {
    return `${lead}**{{first(${d.id}.${dim})}}** is highest at {{first(${d.id}.${d.valueField})}}, against {{last(${d.id}.${d.valueField})}} for {{last(${d.id}.${dim})}}.`;
  }
  return `${lead}**{{first(${d.id}.${dim})}}** leads with {{first(${d.id}.${d.shareField}) | percent}} of ${what} ({{first(${d.id}.${d.valueField})}}); {{last(${d.id}.${dim})}} contributes the least at {{last(${d.id}.${d.shareField}) | percent}}.`;
}

/** Two-category dimensions are stated, not charted. */
function splitText(t: Table, dim: string, d: ByDimension): string {
  const m = measureRef(t);
  if (UNSAFE_TEMPLATE_NAME.test(dim)) return "";
  const label = humanize(dim);
  if (!d.shareField) {
    return `**${label}:** {{first(${d.id}.${dim})}} averages {{first(${d.id}.${d.valueField})}} versus {{last(${d.id}.${d.valueField})}} for {{last(${d.id}.${dim})}}.`;
  }
  return `**${label}:** {{first(${d.id}.${dim})}} accounts for {{first(${d.id}.${d.shareField}) | percent}} of ${m.label.toLowerCase()} ({{first(${d.id}.${d.valueField})}}), {{last(${d.id}.${dim})}} for the remaining {{last(${d.id}.${d.shareField}) | percent}}.`;
}

function trendChart(t: Table, trend: Trend, rate: FieldProfile | undefined): { chart: ChartSpec; title: string; text: string } {
  const label = t.ranked[0] ? measureRef(t).label : "Records";
  const unit = trend.unit ?? "period";
  const chart: ChartSpec = {
    kind: "line",
    data: trend.id,
    x: trend.time,
    y: trend.value,
    ...(trend.unit ? { xFormat: `date:${trend.unit}` } : {}),
    ...(rate ? { secondary: { y: rate.name, format: "percent", label: humanize(rate.name) } } : {}),
  };
  const title = `${label}${rate ? ` and ${humanize(rate.name).toLowerCase()}` : ""} per ${unit}`;
  if ([trend.time, trend.value, trend.changeField].some((n) => UNSAFE_TEMPLATE_NAME.test(n))) return { chart, title, text: `${label} per ${unit}.` };
  const d = trend.id;
  const when = `{{last(${d}.${trend.time})${trend.unit ? ` | date:${trend.unit}` : ""}}}`;
  const text =
    `In ${when}, ${label.toLowerCase()} was **{{last(${d}.${trend.value})}}**, {{last(${d}.${trend.changeField}) | percent}} vs the previous ${unit}; ` +
    `the {{count(${d})}}-${unit} average is {{avg(${d}.${trend.value})}}.`;
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

  const head = primary.ranked[0];
  const extra = primary.ranked.find((m) => m !== head && !m.name.endsWith(".count"));
  const rate = head?.suggestedFormat !== "percent" ? primary.ranked.find((m) => m !== head && m.suggestedFormat === "percent") : undefined;
  const trendMeasures = [head, extra, rate].filter((m, i, all): m is FieldProfile => m !== undefined && all.indexOf(m) === i);
  const trend = buildTrend(primary, trendMeasures, makeId);
  if (trend) datasets[trend.id] = trend.dataset;

  const analysisBlocks: BlockInput[] = [];
  const addChart = (chart: ChartSpec, title: string, text: string) => {
    const n = analysisBlocks.length / 2 + 1;
    analysisBlocks.push({ id: `chart_${n}`, type: "chart", title, chart, height: "md" }, { id: `insight_${n}`, type: "text", content: text });
  };
  if (trend) {
    const c = trendChart(primary, trend, rate);
    addChart(c.chart, c.title, c.text);
  }
  const usedX = new Set(trend ? [trend.time] : []);
  for (const b of breakdowns(tables, primary)) {
    if (analysisBlocks.length / 2 >= MAX_CHARTS) break;
    if (usedX.has(b.dim.name)) continue;
    usedX.add(b.dim.name);
    const d = byDimension(b.table, b.dim.name, b.measure, makeId, datasets);
    const dims = humanize(b.dim.name).toLowerCase();
    const limited = b.dim.distinct > MAX_FULL_BAR;
    const min = b.table.profile.fields.find((f) => f.name === b.measure.field)?.min;
    const nonNegative = typeof min !== "number" || min >= 0;
    // A donut adds variety only as a later view of a small, summable, non-negative split.
    if (analysisBlocks.length > 0 && d.shareField && nonNegative && b.dim.distinct <= MAX_DONUT_SLICES && analysisBlocks.some((x) => x.type === "chart" && x.chart.kind === "bar")) {
      addChart({ kind: "donut", data: d.id, x: b.dim.name, y: d.valueField }, `${b.measure.label} share by ${dims}`, breakdownText(b, d, false));
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
      limited ? `Top 10 ${dims} by ${b.measure.label.toLowerCase()}` : `${b.measure.label} by ${dims}`,
      breakdownText(b, d, limited),
    );
  }
  const splits = primary.profile.fields
    .filter((f) => f.role === "dimension" && f.distinct === 2 && !usedX.has(f.name))
    .slice(0, MAX_SPLITS)
    .map((f) => splitText(primary, f.name, byDimension(primary, f.name, measureRef(primary), makeId, datasets)))
    .filter((s) => s !== "");
  if (splits.length) analysisBlocks.push({ id: "splits", type: "text", title: "How it splits", content: splits.map((s) => `- ${s}`).join("\n") });

  const sections: SectionInput[] = [
    { id: "summary", title: "Summary", role: "summary", blocks: [{ id: "kpis", type: "kpi", items: kpiItems(primary, extra, trend, locale) }] },
  ];
  if (analysisBlocks.length) sections.push({ id: "analysis", title: "Analysis", role: "analysis", layout: "main-side", blocks: analysisBlocks });
  const columns = tableColumns(primary);
  const sortName = trend?.time ?? head?.name;
  sections.push({
    id: "detail",
    title: "Detail",
    role: "detail",
    blocks: [
      {
        id: "detail_table",
        type: "table",
        title: `${humanize(primary.ds.id)} records`,
        data: primary.ds.id,
        ...(columns.length ? { columns } : {}),
        ...(sortName !== undefined ? { sortBy: `-${sortName}` } : {}),
        maxRows: 20,
      },
    ],
  });

  const pid = primary.ds.id;
  const range =
    trend && !UNSAFE_TEMPLATE_NAME.test(trend.time)
      ? ` from {{first(${trend.id}.${trend.time})${trend.unit ? ` | date:${trend.unit}` : ""}}} to {{last(${trend.id}.${trend.time})${trend.unit ? ` | date:${trend.unit}` : ""}}}`
      : "";
  const meta = {
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.currency ? { currency: opts.currency.toUpperCase() } : {}),
  };
  return {
    version: "1",
    title: opts.title ?? (pid === "data" ? "Data report" : `${humanize(pid)} report`),
    summary: `Automatically drafted from {{count(${pid})}} ${pid === "data" ? "records" : humanize(pid).toLowerCase() + " records"}${range}.`,
    ...(Object.keys(meta).length ? { meta } : {}),
    datasets,
    sections,
  };
}
