import type { Agg, ChartSpec, Scalar } from "../spec.js";
import type { ChartSuggestion, DatasetProfile, FieldProfile, ResolvedDataset } from "./types.js";
import { humanize, parseDate, toNumber } from "./values.js";

const TIME_NAME = /(^|[^a-z])(date|year|month|quarter|week|day|period|time)([^a-z]|$)|연도|년도|날짜|일자|월별|기간/i;
const ID_NAME = /(^|[^a-z])(id|uuid)$/i;
const CAMEL_ID = /[a-z0-9]Id$/;
const PERCENT_NAME = /rate|ratio|pct|percent|share|margin|growth|률|율|비중/i;
/** Recurring-revenue and booking metrics written as whole words (so `arr` does not match "array"). */
const REVENUE_ACRONYM = /(^|[^a-z])(mrr|arr|gmv|bookings|billings)([^a-z]|$)/i;
const CURRENCY_NAME = /revenue|sales|price|cost|amount|profit|매출|금액|비용|이익|가격/i;
/** Unique strings are identifiers only beyond this many rows; small aggregated tables keep them as dimensions. */
const ID_MIN_ROWS = 12;
const MAX_BAR_CATEGORIES = 12;
const MAX_DONUT_SLICES = 6;
/** Summable money/amount names rank first when choosing a headline measure. */
const AMOUNT_NAME = /total|revenue|sales|amount|profit|cost|spend|value|매출|금액|비용|이익/i;
/** Per-unit, score, duration and ratio names: meaningful only averaged. */
const AVG_NAME =
  /price|rate|ratio|avg|average|mean|score|rating|csat|nps|pct|percent|margin|latency|duration|(^|[^a-z])age($|[^a-z])|(response|resolution|handl(e|ing)|wait|lead|cycle|processing|turnaround)[_\s-]?(time|minutes|mins|hours|hrs|seconds|secs|days)|평균|단가|비율/i;
/** Level (stock) metrics: a snapshot per period that must never be summed across periods. */
const STOCK_NAME =
  /(^|[^a-z])(mrr|arr|balance|customers|subscribers|users|accounts|members|seats|headcount|inventory|stock|backlog)([^a-z]|$)|(^|[^a-z])(customer|subscriber|user|account|member|seat)s?[_\s-]?count$|^(active|open)[_\s-]|[_\s-](active|open)$/i;
/** Flow qualifiers: `new_mrr`, `churned_customers`, `added_users` are changes during a period, not levels. */
const FLOW_NAME = /(^|[^a-z])(new|added|gained|lost|churned|churn|expansion|contraction|reactivated|reactivation|net|delta|change|signups?)([^a-z]|$)/i;
/** Words kept uppercase in labels. */
const ACRONYMS: Record<string, true> = {
  mrr: true, arr: true, gmv: true, csat: true, nps: true, id: true, url: true, api: true, ctr: true, cpc: true, cpm: true,
  roi: true, roas: true, kpi: true, sku: true, aov: true, ltv: true, cac: true, arpu: true, sla: true, utm: true, uuid: true,
};
/** Measures sharing one axis must stay within this max-magnitude ratio. */
const MAX_AXIS_RATIO = 10;

/** Display label for a field name: humanized, with known acronyms uppercase ("new_mrr" → "New MRR"). `inline` lowercases the first word for mid-sentence use. */
export function fieldLabel(name: string, inline = false): string {
  const words = humanize(name)
    .split(" ")
    .map((w) => (ACRONYMS[w.toLowerCase()] ? w.toUpperCase() : w));
  if (inline && words[0] !== undefined && !ACRONYMS[words[0].toLowerCase()]) words[0] = words[0].toLowerCase();
  return words.join(" ");
}

/** True for level metrics (MRR, customers, balance, active_*, open_*) that are snapshots per period; flows like `new_mrr` are excluded. */
export function isStockMeasure(name: string): boolean {
  return STOCK_NAME.test(name) && !FLOW_NAME.test(name);
}

/** How a measure combines across rows: rates, ratios, prices, scores and durations average; everything else sums. */
export function defaultAgg(f: FieldProfile): Agg {
  return f.suggestedFormat === "percent" || AVG_NAME.test(f.name) ? "avg" : "sum";
}

/**
 * Measures ordered by headline value: amounts/currency, then plain numbers, then averaged values
 * (prices, scores, durations), then ratios, then `<array>.count` fields from flattened JSON. Ties keep field order.
 */
export function rankMeasures(fields: readonly FieldProfile[]): FieldProfile[] {
  const weight = (f: FieldProfile): number => {
    if (f.name.endsWith(".count")) return 4;
    if (f.suggestedFormat === "percent") return 3;
    if (defaultAgg(f) === "avg") return 2;
    return f.suggestedFormat === "currency" || AMOUNT_NAME.test(f.name) || REVENUE_ACRONYM.test(f.name) ? 0 : 1;
  };
  return fields
    .filter((f) => f.role === "measure" && f.distinct > 0)
    .map((f, i) => ({ f, i, w: weight(f) }))
    .sort((a, b) => a.w - b.w || a.i - b.i)
    .map(({ f }) => f);
}

/** Largest absolute value of a numeric profile (0 when unknown). */
export function magnitude(f: FieldProfile): number {
  return Math.max(Math.abs(typeof f.min === "number" ? f.min : 0), Math.abs(typeof f.max === "number" ? f.max : 0));
}

function profileField(ds: ResolvedDataset, name: string, type: FieldProfile["type"]): FieldProfile {
  const values: Scalar[] = ds.rows.map((r) => r[name] ?? null);
  const present = values.filter((v): v is Exclude<Scalar, null> => v !== null);
  const freq = new Map<string, { value: Scalar; count: number }>();
  for (const v of present) {
    const k = JSON.stringify(v);
    const e = freq.get(k);
    if (e) e.count++;
    else freq.set(k, { value: v, count: 1 });
  }
  const p: FieldProfile = { name, type, role: "dimension", count: values.length, nulls: values.length - present.length, distinct: freq.size };

  const nums = type === "number" ? present.map(toNumber).filter((n): n is number => n !== null) : [];
  if (nums.length) {
    p.min = Math.min(...nums);
    p.max = Math.max(...nums);
    p.sum = nums.reduce((a, b) => a + b, 0);
    p.mean = p.sum / nums.length;
  } else if (type === "date") {
    const dated = present.flatMap((v) => {
      const t = parseDate(v, true);
      return t === null ? [] : [{ t, v: String(v) }];
    });
    if (dated.length) {
      dated.sort((a, b) => a.t - b.t);
      p.min = dated[0]!.v;
      p.max = dated[dated.length - 1]!.v;
    }
  }

  const uniqueStrings = type === "string" && freq.size === present.length && present.length > ID_MIN_ROWS;
  if (ID_NAME.test(name) || CAMEL_ID.test(name) || uniqueStrings) p.role = "identifier";
  else if (type === "date" || (type === "number" && TIME_NAME.test(name))) p.role = "time";
  else if (type === "number") p.role = "measure";

  if (p.role === "dimension") {
    p.top = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  }
  if (p.role === "measure") {
    const ratioScale = nums.length > 0 && nums.every((n) => n >= -1.5 && n <= 1.5) && nums.some((n) => !Number.isInteger(n));
    if (ratioScale && PERCENT_NAME.test(name)) p.suggestedFormat = "percent";
    else if (CURRENCY_NAME.test(name) || REVENUE_ACRONYM.test(name)) p.suggestedFormat = "currency";
  }
  return p;
}

/** Per-field statistics and semantic roles (time / measure / dimension / identifier). */
export function profileDataset(ds: ResolvedDataset): DatasetProfile {
  return { id: ds.id, rowCount: ds.rows.length, fields: ds.fields.map((f) => profileField(ds, f.name, f.type)) };
}

/** Chart candidates for a dataset, best first. */
export function suggestCharts(ds: ResolvedDataset, profile: DatasetProfile = profileDataset(ds)): ChartSuggestion[] {
  const label = (name: string) => {
    const own = ds.fields.find((f) => f.name === name)?.label;
    return own !== undefined && own !== humanize(name) ? own.toLowerCase() : fieldLabel(name, true);
  };
  const byRole = (role: FieldProfile["role"]) => profile.fields.filter((f) => f.role === role && f.distinct > 0);
  const measures = rankMeasures(profile.fields);
  const times = byRole("time");
  const dims = byRole("dimension");
  const out: ChartSuggestion[] = [];
  const push = (score: number, reason: string, chart: Omit<ChartSpec, "data">) => out.push({ score, reason, chart: { data: ds.id, ...chart } as ChartSpec });
  const yFormat = (m: FieldProfile) => (m.suggestedFormat && !ds.fields.find((f) => f.name === m.name)?.format ? { yFormat: m.suggestedFormat } : {});

  const primary = measures[0];
  if (!primary) return out;
  const time = times[0];

  if (time && time.distinct >= 2) {
    // Several measures share an axis only when they share a unit and a magnitude.
    const scale = magnitude(primary);
    const sameUnit = measures
      .filter((m) => {
        const s = magnitude(m);
        return m.suggestedFormat === primary.suggestedFormat && Math.max(s, scale) <= MAX_AXIS_RATIO * Math.max(Math.min(s, scale), Number.MIN_VALUE);
      })
      .slice(0, 3);
    push(
      0.9,
      sameUnit.length > 1
        ? `${sameUnit.map((m) => label(m.name)).join(", ")} over ${label(time.name)} show the trend across ${time.distinct} periods.`
        : `${fieldLabel(primary.name)} over ${label(time.name)} shows the trend across ${time.distinct} periods.`,
      { kind: "line", x: time.name, y: sameUnit.length > 1 ? sameUnit.map((m) => m.name) : primary.name, ...yFormat(primary) },
    );
    const split = dims.find((d) => d.distinct >= 2 && d.distinct <= MAX_DONUT_SLICES);
    if (split) {
      push(0.82, `Splitting ${label(primary.name)} by ${label(split.name)} over time compares how each of ${split.distinct} groups trends.`, {
        kind: "line",
        x: time.name,
        y: primary.name,
        series: split.name,
        ...yFormat(primary),
      });
    }
  }

  const second = measures[1];
  if (second && profile.rowCount >= 5) {
    push(0.5, `A scatter of ${label(primary.name)} against ${label(second.name)} reveals correlation and outliers across ${profile.rowCount} rows.`, {
      kind: "scatter",
      x: primary.name,
      y: second.name,
    });
  }

  // Category charts aggregate over all rows: with a time field, level metrics (MRR, customers) would be summed across periods.
  const cat = time ? measures.find((m) => !isStockMeasure(m.name)) : primary;
  if (!cat) return out.sort((a, b) => b.score - a.score);
  const catAvg = defaultAgg(cat) === "avg";
  const catAgg = catAvg ? { aggregate: "avg" as const } : {};

  for (const dim of dims.slice(0, 2)) {
    if (dim.distinct < 2) continue;
    const longLabels = (dim.top ?? []).some((t) => String(t.value).length > 12);
    if (dim.distinct <= MAX_BAR_CATEGORIES) {
      push(0.8 - (dim === dims[0] ? 0 : 0.1), `Bars rank ${label(cat.name)} across the ${dim.distinct} ${label(dim.name)} values.`, {
        kind: "bar",
        x: dim.name,
        y: cat.name,
        sort: "-y",
        ...(longLabels ? { horizontal: true } : {}),
        ...yFormat(cat),
        ...catAgg,
      });
    } else {
      push(0.65 - (dim === dims[0] ? 0 : 0.1), `${dim.distinct} ${label(dim.name)} values are too many to show; the top 10 by ${label(cat.name)} are ranked with the rest grouped.`, {
        kind: "bar",
        x: dim.name,
        y: cat.name,
        sort: "-y",
        limit: 10,
        others: true,
        horizontal: true,
        ...yFormat(cat),
        ...catAgg,
      });
    }
  }

  const share = dims.find((d) => d.distinct >= 2 && d.distinct <= MAX_DONUT_SLICES);
  if (share && !catAvg && typeof cat.min === "number" && cat.min >= 0) {
    push(0.6, `A donut shows each ${label(share.name)}'s share of total ${label(cat.name)} (${share.distinct} slices).`, {
      kind: "donut",
      x: share.name,
      y: cat.name,
    });
  }

  if (dims.length === 0 && !time) {
    const id = byRole("identifier").find((f) => f.type === "string");
    if (id) {
      push(0.55, `Ranks the top 10 ${label(id.name)} values by ${label(cat.name)}.`, {
        kind: "bar",
        x: id.name,
        y: cat.name,
        sort: "-y",
        limit: 10,
        horizontal: true,
        ...yFormat(cat),
        ...catAgg,
      });
    }
  }

  const [d1, d2] = dims;
  if (d1 && d2 && d1.distinct >= 2 && d2.distinct >= 2) {
    if (d1.distinct <= MAX_BAR_CATEGORIES && d2.distinct <= MAX_BAR_CATEGORIES) {
      push(0.55, `A heatmap crosses ${label(d1.name)} with ${label(d2.name)} to spot where ${label(cat.name)} concentrates.`, {
        kind: "heatmap",
        x: d1.name,
        y: d2.name,
        value: cat.name,
        ...catAgg,
      });
    }
    if (!catAvg && d1.distinct <= MAX_BAR_CATEGORIES && d2.distinct <= MAX_DONUT_SLICES) {
      push(0.58, `Stacked bars break ${label(cat.name)} per ${label(d1.name)} down by ${label(d2.name)}.`, {
        kind: "bar",
        x: d1.name,
        y: cat.name,
        series: d2.name,
        stack: true,
        ...yFormat(cat),
      });
    }
  }

  return out.sort((a, b) => b.score - a.score);
}
