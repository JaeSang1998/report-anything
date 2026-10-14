import type { Scalar } from "../spec.js";
import type { FormatContext } from "./types.js";
import { parseDate, toNumber } from "./values.js";

export const EMPTY_VALUE = "—";

export type DateUnit = "year" | "quarter" | "month" | "week" | "day";

interface ParsedFormat {
  kind: "number" | "integer" | "percent" | "currency" | "compact" | "date" | "datetime" | "text";
  digits?: number;
  currency?: string;
  unit?: DateUnit;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f as T;
}

export function parseFormat(format: string): ParsedFormat {
  const [kind, a, b] = format.split(":");
  switch (kind) {
    case "number":
    case "percent":
    case "compact":
      return { kind, ...(a !== undefined ? { digits: Number(a) } : {}) };
    case "currency": {
      const isCode = a !== undefined && /^[A-Z]{3}$/.test(a);
      const digitsArg = isCode ? b : a;
      return {
        kind,
        ...(isCode ? { currency: a } : {}),
        ...(digitsArg !== undefined ? { digits: Number(digitsArg) } : {}),
      };
    }
    case "date":
      return { kind, unit: (a as DateUnit | undefined) ?? "day" };
    case "integer":
    case "datetime":
    case "text":
      return { kind };
    default:
      return { kind: "text" };
  }
}

/** Format a value for display. Without a format: numbers get smart grouping, everything else is stringified. */
export function formatValue(value: Scalar | undefined, format: string | undefined, ctx: FormatContext): string {
  if (value === null || value === undefined || value === "") return EMPTY_VALUE;
  if (format === undefined) return defaultFormat(value, ctx);
  const f = parseFormat(format);
  if (f.kind === "text") return String(value);
  if (f.kind === "date" || f.kind === "datetime") {
    const t = typeof value === "number" ? value : parseDate(value, true);
    if (t === null) return String(value);
    return f.kind === "datetime" ? formatDateTime(t, ctx.locale) : formatDate(t, f.unit ?? "day", ctx.locale);
  }
  const n = toNumber(value);
  if (n === null) return String(value);
  return formatNumber(n, f, ctx);
}

function defaultFormat(value: Scalar, ctx: FormatContext): string {
  if (typeof value === "number") {
    const digits = Number.isInteger(value) ? 0 : Math.abs(value) < 1 ? 3 : 2;
    return cached(`n|${ctx.locale}|${digits}`, () => new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: digits })).format(value);
  }
  if (typeof value === "boolean") return value ? "✓" : "✗";
  return String(value);
}

function formatNumber(n: number, f: ParsedFormat, ctx: FormatContext): string {
  const { locale } = ctx;
  switch (f.kind) {
    case "integer":
      return cached(`i|${locale}`, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })).format(n);
    case "percent": {
      const d = f.digits ?? 1;
      // Fixed precision: a column of 2% / 1.1% reads as inconsistent data.
      return cached(`p|${locale}|${d}`, () => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: d, maximumFractionDigits: d })).format(n);
    }
    case "currency": {
      const cur = f.currency ?? ctx.currency;
      const key = `c|${locale}|${cur}|${f.digits ?? "auto"}`;
      return cached(key, () =>
        new Intl.NumberFormat(locale, {
          style: "currency",
          currency: cur,
          ...(f.digits !== undefined ? { minimumFractionDigits: f.digits, maximumFractionDigits: f.digits } : {}),
        }),
      ).format(n);
    }
    case "compact": {
      const d = f.digits ?? 1;
      return cached(`k|${locale}|${d}`, () => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: d })).format(n);
    }
    default: {
      const d = f.digits;
      return cached(`n|${locale}|${d ?? "auto"}`, () =>
        new Intl.NumberFormat(locale, d !== undefined ? { minimumFractionDigits: d, maximumFractionDigits: d } : { maximumFractionDigits: 2 }),
      ).format(n);
    }
  }
}

/** Compact currency/number used for axis ticks: keeps the unit of `format` but shortens magnitude. */
export function formatCompact(n: number, format: string | undefined, ctx: FormatContext): string {
  const f = format ? parseFormat(format) : undefined;
  if (f?.kind === "percent") return formatNumber(n, { kind: "percent", digits: f.digits ?? 0 }, ctx);
  if (f?.kind === "currency") {
    const cur = f.currency ?? ctx.currency;
    return cached(`cc|${ctx.locale}|${cur}`, () =>
      new Intl.NumberFormat(ctx.locale, { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }),
    ).format(n);
  }
  if (Math.abs(n) < 10_000) return formatNumber(n, { kind: "number" }, ctx);
  return formatNumber(n, { kind: "compact", digits: 1 }, ctx);
}

export function formatDate(t: number, unit: DateUnit, locale: string): string {
  const d = new Date(t);
  switch (unit) {
    case "year":
      return String(d.getUTCFullYear());
    case "quarter":
      return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "month":
      return cached(`dm|${locale}`, () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", timeZone: "UTC" })).format(d);
    default:
      return cached(`dd|${locale}`, () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" })).format(d);
  }
}

function formatDateTime(t: number, locale: string): string {
  return cached(`dt|${locale}`, () =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }),
  ).format(new Date(t));
}

/** Signed percentage for deltas: +12.3% / −4.0%. */
export function formatDelta(ratio: number, ctx: FormatContext, format = "percent:1"): string {
  const body = formatValue(Math.abs(ratio), format, ctx);
  if (ratio === 0) return body;
  return `${ratio > 0 ? "+" : "−"}${body}`;
}
