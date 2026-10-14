import type { Dataset, FieldDef, FieldType, Issue, ReportSpec, Row } from "../spec.js";
import { parseCsv } from "./csv.js";
import { normalizeJson } from "./normalize.js";
import { applyTransforms } from "./transform.js";
import type { DataContext, FieldInfo, ResolvedDataset } from "./types.js";
import { closest, humanize, parseDate, toNumber } from "./values.js";
import { DataError } from "./errors.js";

/** Field metadata: union of row keys (first-seen), type by majority of non-null values, label/format from overrides. */
export function inferFields(rows: readonly Row[], overrides: readonly FieldDef[] = []): FieldInfo[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  return names.map((name) => {
    const def = overrides.find((o) => o.name === name);
    const info: FieldInfo = { name, type: def?.type ?? inferType(rows, name), label: def?.label ?? humanize(name) };
    if (def?.format !== undefined) info.format = def.format;
    if (def?.description !== undefined) info.description = def.description;
    return info;
  });
}

function inferType(rows: readonly Row[], name: string): FieldType {
  const counts: Record<FieldType, number> = { number: 0, string: 0, date: 0, boolean: 0 };
  let total = 0;
  for (const row of rows) {
    const v = row[name];
    if (v === null || v === undefined) continue;
    total++;
    if (typeof v === "number") counts.number++;
    else if (typeof v === "boolean") counts.boolean++;
    else if (parseDate(v) !== null) counts.date++;
    else if (toNumber(v) !== null) counts.number++;
    else counts.string++;
  }
  for (const type of ["number", "date", "boolean"] as const) if (counts[type] * 2 > total) return type;
  return "string";
}

/** Dataset ids this dataset needs resolved first, with the issue path of each reference. */
function dependencies(id: string, d: Dataset): Array<{ id: string; path: string }> {
  const deps: Array<{ id: string; path: string }> = [];
  if (d.from !== undefined) deps.push({ id: d.from, path: `datasets.${id}.from` });
  d.transform?.forEach((t, i) => {
    if (t.op === "lookup") deps.push({ id: t.from, path: `datasets.${id}.transform[${i}]` });
  });
  return deps;
}

function errorIssue(path: string, err: unknown): Issue {
  if (err instanceof DataError) {
    return { severity: "error", code: err.code, path, message: err.message, ...(err.hint !== undefined ? { hint: err.hint } : {}) };
  }
  return { severity: "error", code: "dataset_unavailable", path, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Load every dataset (rows | json | csv | from), run its transform pipeline and infer fields.
 * Datasets resolve in dependency order (`from`, `lookup.from`). A failing dataset is reported and omitted.
 */
export function resolveDatasets(datasets: Record<string, Dataset>): { datasets: Map<string, ResolvedDataset>; issues: Issue[] } {
  const resolved = new Map<string, ResolvedDataset>();
  const issues: Issue[] = [];
  const state = new Map<string, "visiting" | "done">();
  const ids = Object.keys(datasets);

  const visit = (id: string, stack: string[]): void => {
    if (state.get(id) === "done") return;
    const d = datasets[id]!;
    state.set(id, "visiting");
    let blocked = false;
    for (const dep of dependencies(id, d)) {
      if (!(dep.id in datasets)) {
        const guess = closest(dep.id, ids);
        issues.push({
          severity: "error",
          code: "unknown_dataset",
          path: dep.path,
          message: `dataset '${id}' references unknown dataset '${dep.id}'`,
          hint: guess ? `did you mean '${guess}'?` : `defined datasets: ${ids.join(", ") || "(none)"}`,
        });
        blocked = true;
        continue;
      }
      if (state.get(dep.id) === "visiting") {
        const chain = [...stack, id];
        const members = chain.slice(chain.indexOf(dep.id));
        const message = `datasets depend on each other in a cycle: ${[...members, dep.id].join(" → ")}`;
        for (const m of members) {
          if (issues.some((i) => i.code === "dataset_cycle" && i.path === `datasets.${m}`)) continue;
          issues.push({
            severity: "error",
            code: "dataset_cycle",
            path: `datasets.${m}`,
            message,
            hint: "break the cycle: derive one of these datasets from a raw source (rows/json/csv) instead",
          });
        }
        blocked = true;
        continue;
      }
      visit(dep.id, [...stack, id]);
      if (!resolved.has(dep.id)) {
        if (!issues.some((i) => i.code === "dataset_cycle" && i.path === `datasets.${id}`)) {
          issues.push({
            severity: "error",
            code: "dataset_unavailable",
            path: dep.path,
            message: `dataset '${id}' depends on '${dep.id}', which failed to resolve`,
            hint: `fix the issues reported for datasets.${dep.id}`,
          });
        }
        blocked = true;
      }
    }
    state.set(id, "done");
    if (blocked) return;
    const ds = load(id, d, resolved, issues);
    if (ds) resolved.set(id, ds);
  };

  for (const id of ids) visit(id, []);
  return { datasets: resolved, issues };
}

function load(id: string, d: Dataset, resolved: ReadonlyMap<string, ResolvedDataset>, issues: Issue[]): ResolvedDataset | undefined {
  let rows: Row[];
  try {
    if (d.rows !== undefined) rows = d.rows.map((r) => ({ ...r }));
    else if (d.csv !== undefined) rows = parseCsv(d.csv);
    else if (d.from !== undefined) rows = resolved.get(d.from)!.rows.map((r) => ({ ...r }));
    else {
      const opts: { path?: string; unnest?: string } = {};
      if (d.path !== undefined) opts.path = d.path;
      if (d.unnest !== undefined) opts.unnest = d.unnest;
      rows = normalizeJson(d.json, opts);
    }
  } catch (err) {
    issues.push(errorIssue(`datasets.${id}`, err));
    return undefined;
  }
  const transforms = d.transform ?? [];
  for (let i = 0; i < transforms.length; i++) {
    try {
      rows = applyTransforms(rows, [transforms[i]!], (other) => resolved.get(other));
    } catch (err) {
      issues.push(errorIssue(`datasets.${id}.transform[${i}]`, err));
      return undefined;
    }
  }
  const fields = inferFields(rows, d.fields);
  for (const def of d.fields ?? []) {
    if (rows.length === 0 || fields.some((f) => f.name === def.name)) continue;
    const guess = closest(
      def.name,
      fields.map((f) => f.name),
    );
    issues.push({
      severity: "warning",
      code: "unknown_field",
      path: `datasets.${id}.fields`,
      message: `field override '${def.name}' matches no field in dataset '${id}'`,
      hint: guess ? `did you mean '${guess}'?` : `available fields: ${fields.map((f) => f.name).join(", ")}`,
    });
  }
  const out: ResolvedDataset = { id, rows, fields };
  if (d.source !== undefined) out.source = d.source;
  if (d.description !== undefined) out.description = d.description;
  return out;
}

/** Resolve every dataset of a spec into a DataContext (locale default en-US, currency default USD). */
export function createDataContext(spec: ReportSpec): { context: DataContext; issues: Issue[] } {
  const { datasets, issues } = resolveDatasets(spec.datasets);
  return {
    context: { locale: spec.meta?.locale ?? "en-US", currency: spec.meta?.currency ?? "USD", datasets },
    issues,
  };
}
