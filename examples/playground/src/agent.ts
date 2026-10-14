import { profileDataset, suggestCharts } from "@report-anything/core";
import type { Issue, LayoutMode, ReportSession } from "@report-anything/core";
import type { ApplyOpsOutput, InspectOutput, ProfileOutput, ReportContextSummary } from "../server/tools.js";

interface Rejected {
  index: number;
  op: unknown;
  issues: Issue[];
}

interface CallState {
  applied: number;
  rejected: Rejected[];
}

/** Errors first, then warnings; capped so tool results stay small. */
function topIssues(issues: readonly Issue[], limit = 20): Issue[] {
  return [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).slice(0, limit);
}

/**
 * Executes the agent's tool calls against the browser-side ReportSession.
 * `apply_ops` is applied incrementally while the model is still streaming the call, so the report
 * builds up live; ops are applied one by one and a failing op is skipped and reported.
 */
export function createToolRunner(session: ReportSession) {
  const calls = new Map<string, CallState>();

  const applyRange = (toolCallId: string, ops: readonly unknown[], end: number): CallState => {
    let state = calls.get(toolCallId);
    if (!state) calls.set(toolCallId, (state = { applied: 0, rejected: [] }));
    for (; state.applied < end; state.applied++) {
      const op = ops[state.applied];
      if (typeof op === "object" && op !== null && "op" in op && op.op === "replace") {
        state.rejected.push({
          index: state.applied,
          op,
          issues: [{ severity: "error", code: "op_not_allowed", path: `ops[${state.applied}]`, message: "the agent may not replace the whole report", hint: "edit with section/block ops; datasets with user data must be kept" }],
        });
        continue;
      }
      const result = session.apply(op);
      if (!result.ok) state.rejected.push({ index: state.applied, op, issues: result.issues });
    }
    return state;
  };

  const inspect = (mode: LayoutMode): InspectOutput => {
    const i = session.inspect({ mode });
    return { pages: i.pages, valid: i.valid, outline: i.outline, issues: topIssues(i.issues) };
  };

  return {
    /** Apply the ops that are complete in a partially streamed call (all but the last element). */
    streamOps(toolCallId: string, ops: readonly unknown[]): void {
      if (ops.length > 1) applyRange(toolCallId, ops, ops.length - 1);
    },

    applyOps(toolCallId: string, ops: readonly unknown[]): ApplyOpsOutput {
      const state = applyRange(toolCallId, ops, ops.length);
      calls.delete(toolCallId);
      return {
        applied: ops.length - state.rejected.length,
        rejected: state.rejected,
        revision: session.getSnapshot().revision,
        ...inspect("print"),
      };
    },

    inspect,

    profile(datasetId: string): ProfileOutput {
      const ds = session.getSnapshot().context.datasets.get(datasetId);
      if (!ds) return { error: `no dataset '${datasetId}'`, datasets: [...session.getSnapshot().context.datasets.keys()] };
      const profile = profileDataset(ds);
      return {
        rows: profile.rowCount,
        fields: profile.fields.map((f) => ({ ...f, top: f.top?.map((t) => t.value) })),
        suggestions: suggestCharts(ds, profile).slice(0, 5).map((s) => ({ reason: s.reason, chart: s.chart })),
      };
    },
  };
}

/** Report state sent with every chat request. */
export function summarize(session: ReportSession): ReportContextSummary {
  const snap = session.getSnapshot();
  const i = session.inspect({ mode: "print" });
  return {
    title: snap.spec.title,
    revision: snap.revision,
    pages: i.pages,
    datasets: i.datasets.map((d) => {
      const source = snap.spec.datasets[d.id]?.source;
      return { id: d.id, rows: d.rows, fields: d.fields, ...(source ? { source } : {}) };
    }),
    outline: i.outline,
    errors: i.issues.filter((x) => x.severity === "error").map((x) => ({ path: x.path, message: x.message, ...(x.hint ? { hint: x.hint } : {}) })),
  };
}
