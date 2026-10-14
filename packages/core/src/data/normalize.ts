import type { Row, Scalar } from "../spec.js";
import { DataError } from "./errors.js";

type Json = Scalar | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isObjectArray(v: unknown): v is JsonObject[] {
  return Array.isArray(v) && v.length > 0 && v.some(isObject);
}

function walkPath(root: unknown, path: string): unknown {
  let node = root;
  const seen: string[] = [];
  for (const seg of path.split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(seg)) node = node[Number(seg)];
    else if (isObject(node) && seg in node) node = node[seg];
    else {
      const keys = isObject(node) ? Object.keys(node) : [];
      const where = seen.length ? `'${seen.join(".")}'` : "the root";
      throw new DataError(
        "unknown_field",
        `path '${path}' not found: ${where} has no '${seg}'`,
        keys.length ? `available keys: ${keys.slice(0, 12).join(", ")}` : undefined,
      );
    }
    seen.push(seg);
  }
  return node;
}

interface Flattener {
  maxDepth: number;
  /** Rows/keys produced by empty arrays; resolved once all rows are known. */
  emptyArrays: Array<[Row, string]>;
}

/** Flatten one record into `row` with dotted keys. `skip` is a full dotted path to leave out (the unnested array). */
function flatten(obj: JsonObject, prefix: string, depth: number, row: Row, f: Flattener, skip?: string): void {
  for (const [key, value] of Object.entries(obj)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (name === skip) continue;
    if (value === null || value === undefined) row[name] = null;
    else if (Array.isArray(value)) {
      if (value.length === 0) f.emptyArrays.push([row, name]);
      else if (value.some(isObject)) row[`${name}.count`] = value.length;
      else row[name] = value.map((v) => (Array.isArray(v) ? JSON.stringify(v) : String(v))).join(", ");
    } else if (isObject(value)) {
      if (depth + 1 < f.maxDepth) flatten(value, name, depth + 1, row, f, skip);
      else row[name] = JSON.stringify(value);
    } else row[name] = value;
  }
}

function recordRows(records: readonly Json[], unnest: string | undefined, f: Flattener, keyed?: readonly string[]): Row[] {
  const rows: Row[] = [];
  records.forEach((rec, i) => {
    const base: Row = keyed ? { key: keyed[i]! } : {};
    if (!isObject(rec)) {
      base.value = Array.isArray(rec) ? JSON.stringify(rec) : (rec ?? null);
      rows.push(base);
      return;
    }
    const pending = f.emptyArrays.length;
    flatten(rec, "", 0, base, f, unnest);
    let children: unknown;
    if (unnest !== undefined) {
      try {
        children = walkPath(rec, unnest);
      } catch {
        children = undefined;
      }
    }
    if (!Array.isArray(children) || children.length === 0) {
      rows.push(base);
      return;
    }
    const baseEmpty = f.emptyArrays.slice(pending);
    for (const child of children as Json[]) {
      const row: Row = { ...base };
      for (const [, name] of baseEmpty) f.emptyArrays.push([row, name]);
      if (isObject(child)) flatten(child, unnest!, 0, row, f);
      else row[`${unnest}.value`] = Array.isArray(child) ? JSON.stringify(child) : (child ?? null);
      rows.push(row);
    }
  });
  // Empty arrays become `<key>.count = 0` where other rows count objects, else a null scalar-list value.
  const counted = new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k.endsWith(".count"))));
  for (const [row, name] of f.emptyArrays) {
    if (counted.has(`${name}.count`)) row[`${name}.count`] = 0;
    else row[name] = null;
  }
  return rows;
}

/**
 * Locate the main record array in nested JSON (API envelopes like `{ meta, data: { orders: [...] } }`):
 * the largest array of objects within `maxDepth` levels, breadth-first so ties prefer shallower arrays.
 */
export function findRecordArray(json: unknown, maxDepth = 4): { path: string; records: Json[] } | undefined {
  let best: { path: string; records: Json[] } | undefined;
  const queue: Array<[unknown, string, number]> = [[json, "", 0]];
  for (let i = 0; i < queue.length; i++) {
    const [node, path, depth] = queue[i]!;
    if (isObjectArray(node)) {
      if (!best || node.length > best.records.length) best = { path, records: node };
      continue;
    }
    if (!isObject(node) || depth >= maxDepth) continue;
    for (const [k, v] of Object.entries(node)) queue.push([v, path ? `${path}.${k}` : k, depth + 1]);
  }
  return best;
}

/**
 * Normalize any JSON into flat rows.
 * - `path`: dot path to the record array; otherwise auto-detected with `findRecordArray`.
 * - Nested objects → dotted keys up to `maxDepth` segments; scalar arrays → ", "-joined; object arrays → `<key>.count`.
 * - `unnest`: explode that nested array into one row per child (child keys prefixed `<unnest>.`).
 * - Object of objects (no record array inside) → rows with a `key` field; scalar array → rows `{ value }`; single object → one row.
 */
export function normalizeJson(json: unknown, opts: { path?: string; unnest?: string; maxDepth?: number } = {}): Row[] {
  const f: Flattener = { maxDepth: opts.maxDepth ?? 3, emptyArrays: [] };
  const node = opts.path ? walkPath(json, opts.path) : json;
  if (Array.isArray(node)) return recordRows(node as Json[], opts.unnest, f);
  if (!isObject(node)) return node === undefined ? [] : [{ value: node as Scalar }];
  if (!opts.path) {
    const found = findRecordArray(node);
    if (found) return recordRows(found.records, opts.unnest, f);
    const entries = Object.entries(node);
    if (entries.length >= 2 && entries.every(([, v]) => isObject(v))) {
      return recordRows(
        entries.map(([, v]) => v),
        opts.unnest,
        f,
        entries.map(([k]) => k),
      );
    }
  }
  return recordRows([node], opts.unnest, f);
}
