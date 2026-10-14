import type { Row, Scalar } from "../spec.js";

const NUMERIC = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?$/;

/** Coerce a scalar to a finite number. Accepts numeric strings with thousands separators. */
export function toNumber(v: Scalar | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !NUMERIC.test(s) || s === "-" || s === "+" || s === ".") return null;
    const n = Number(s.replaceAll(",", ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const ISO_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;
const QUARTER = /^(\d{4})[- ]?Q([1-4])$/i;
const SLASH_DATE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/**
 * Parse date-like strings to epoch milliseconds (UTC).
 * Accepts YYYY-MM, YYYY-MM-DD, ISO datetimes, YYYY-Qn and YYYY/MM/DD.
 * Bare 4-digit years parse only when `allowYear` is set (they are usually numbers).
 */
export function parseDate(v: Scalar | undefined, allowYear = false): number | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const q = QUARTER.exec(s);
  if (q) return Date.UTC(Number(q[1]), (Number(q[2]) - 1) * 3, 1);
  const sl = SLASH_DATE.exec(s);
  if (sl) return validDate(Number(sl[1]), Number(sl[2]), Number(sl[3]));
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  if (m[2] === undefined) return allowYear ? Date.UTC(Number(m[1]), 0, 1) : null;
  if (m[4] !== undefined) {
    const t = Date.parse(m[7] === undefined ? `${s.replace(" ", "T")}Z` : s.replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  return validDate(Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3]));
}

function validDate(y: number, mo: number, d: number): number | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  return new Date(t).getUTCDate() === d ? t : null;
}

/** ISO `YYYY-MM-DD` for an epoch-ms UTC timestamp. */
export function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Closest candidate by edit distance (case-insensitive), for "did you mean" hints. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  const target = name.toLowerCase();
  let best: string | undefined;
  let bestDist = Math.max(2, Math.floor(target.length / 3)) + 1;
  for (const c of candidates) {
    const lc = c.toLowerCase();
    if (lc === target) return c;
    const prev = Array.from({ length: lc.length + 1 }, (_, j) => j);
    for (let i = 1; i <= target.length; i++) {
      let diag = prev[0]!;
      prev[0] = i;
      for (let j = 1; j <= lc.length; j++) {
        const tmp = prev[j]!;
        prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (target[i - 1] === lc[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    const d = prev[lc.length]!;
    if (d < bestDist || (lc.includes(target) && bestDist > 1)) {
      best = c;
      bestDist = lc.includes(target) ? 1 : d;
    }
  }
  return best;
}

/** Total order: null/undefined last, numbers numerically, dates chronologically, else locale string compare. */
export function compareScalars(a: Scalar | undefined, b: Scalar | undefined): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const ad = parseDate(a);
  const bd = parseDate(b);
  if (ad !== null && bd !== null) return ad - bd;
  const anum = toNumber(a);
  const bnum = toNumber(b);
  if (anum !== null && bnum !== null) return anum - bnum;
  return String(a).localeCompare(String(b));
}

/** Parse a sort key ('-field' = descending) into a row comparator. */
export function sortComparator(keys: readonly string[]): (a: Row, b: Row) => number {
  const parsed = keys.map((k) => (k.startsWith("-") ? { field: k.slice(1), dir: -1 } : { field: k, dir: 1 }));
  return (a, b) => {
    for (const { field, dir } of parsed) {
      const av = a[field];
      const bv = b[field];
      // Keep nulls last regardless of direction.
      if (av === null || av === undefined || bv === null || bv === undefined) {
        const c = compareScalars(av, bv);
        if (c !== 0) return c;
        continue;
      }
      const c = compareScalars(av, bv) * dir;
      if (c !== 0) return c;
    }
    return 0;
  };
}

/** "total_revenue" → "Total revenue", "customer.firstName" → "Customer first name". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0 ? name : words[0]!.toUpperCase() + words.slice(1);
}

/** Stable key for grouping by several fields. */
export function groupKey(row: Row, fields: readonly string[]): string {
  return JSON.stringify(fields.map((f) => row[f] ?? null));
}
