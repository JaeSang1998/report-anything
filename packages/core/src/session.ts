import { ReportSpec } from "./spec.js";
import type { Issue } from "./spec.js";
import type { DataContext } from "./data/types.js";
import type { LayoutMode } from "./layout/types.js";
import { applyOps } from "./ops.js";
import { analyzeReport } from "./validate.js";
import type { AnalysisCache } from "./validate.js";
import { inspectReport } from "./inspect.js";
import type { Inspection } from "./inspect.js";
import { zodIssues } from "./issues.js";

export interface ReportSnapshot {
  /** Increments on every accepted change. */
  revision: number;
  spec: ReportSpec;
  context: DataContext;
  issues: Issue[];
  brokenBlocks: ReadonlySet<string>;
  /** No error-severity issues. Intermediate streaming states are often invalid; renderers degrade per block. */
  valid: boolean;
}

export type SessionResult = { ok: true; revision: number; issues: Issue[] } | { ok: false; revision: number; issues: Issue[] };

export interface ReportSession {
  getSnapshot(): ReportSnapshot;
  /** useSyncExternalStore-compatible. */
  subscribe(listener: () => void): () => void;
  /**
   * Apply one op or a batch transactionally. Structural failures (unknown id, schema-invalid op) reject the batch;
   * semantic issues (unknown field, bad template) are accepted and reported on the snapshot.
   */
  apply(ops: unknown): SessionResult;
  inspect(opts?: { mode?: LayoutMode }): Inspection;
}

export class SpecError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`invalid ReportSpec: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
}

const EMPTY: ReportSpec = ReportSpec.parse({ title: "Untitled report", sections: [] });

export interface ReportSessionOptions {
  /** Revision of `initial` when a session is restored from storage, so revision numbers keep counting up. Default 0. */
  revision?: number;
}

export function createReportSession(initial?: unknown, options: ReportSessionOptions = {}): ReportSession {
  let spec = EMPTY;
  if (initial !== undefined) {
    const parsed = ReportSpec.safeParse(initial);
    if (!parsed.success) throw new SpecError(zodIssues(parsed.error));
    spec = parsed.data;
  }
  const listeners = new Set<() => void>();
  let cache: AnalysisCache | undefined;
  let snapshot = build(spec, options.revision ?? 0);

  function build(next: ReportSpec, revision: number): ReportSnapshot {
    const analysis = analyzeReport(next, cache);
    cache = analysis.cache;
    return {
      revision,
      spec: next,
      context: analysis.context,
      issues: analysis.issues,
      brokenBlocks: analysis.brokenBlocks,
      valid: !analysis.issues.some((i) => i.severity === "error"),
    };
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply(ops) {
      const result = applyOps(snapshot.spec, Array.isArray(ops) ? ops : [ops]);
      if (!result.ok) return { ok: false, revision: snapshot.revision, issues: result.issues };
      snapshot = build(result.spec, snapshot.revision + 1);
      for (const l of listeners) l();
      return { ok: true, revision: snapshot.revision, issues: snapshot.issues };
    },
    inspect: (opts) => inspectReport(snapshot, opts),
  };
}
