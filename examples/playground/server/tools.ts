import { tool } from "ai";
import type { InferUITools, UIDataTypes, UIMessage } from "ai";
import { z } from "zod";
import type { Inspection, Issue } from "@report-anything/core";

/**
 * Tools the report agent can call. None has `execute`: the browser owns the ReportSession,
 * runs each call against it (ops apply live while the model is still streaming them) and
 * returns the result, so the model always sees the real validation and layout outcome.
 */
export const reportTools = {
  apply_ops: tool({
    description:
      "Edit the report with id-addressed ops (setReport, setDataset, removeDataset, addSection, updateSection, removeSection, moveSection, addBlock, updateBlock, replaceBlock, removeBlock, moveBlock). Ops apply in order as they stream; a failing op is skipped and reported. Returns applied/rejected ops, validation errors and the resulting outline with section compositions, placements and pages.",
    inputSchema: z.object({
      ops: z.array(z.record(z.string(), z.unknown())).min(1).describe("Ops in the ReportSpec op format from the reference."),
    }),
  }),
  inspect_report: tool({
    description: "Read the current report outline (section compositions, block placements, estimated heights, pages), datasets and every validation/layout issue.",
    inputSchema: z.object({ mode: z.enum(["web", "print"]).describe("print reports page assignment and page diagnostics.") }),
  }),
  profile_dataset: tool({
    description: "Profile one dataset already in the report: field roles (time/measure/dimension/identifier), stats, distinct counts, suggested formats and ranked chart suggestions.",
    inputSchema: z.object({ dataset: z.string().describe("Dataset id.") }),
  }),
};

/** Results the browser returns for each tool (tools have no server `execute`, so outputs are declared here). */
export interface InspectOutput {
  pages: number;
  valid: boolean;
  outline: Inspection["outline"];
  issues: Issue[];
}

export interface ApplyOpsOutput extends InspectOutput {
  applied: number;
  rejected: Array<{ index: number; op: unknown; issues: Issue[] }>;
  revision: number;
}

export type ProfileOutput =
  | { rows: number; fields: unknown[]; suggestions: Array<{ reason: string; chart: unknown }> }
  | { error: string; datasets: string[] };

type Inputs = InferUITools<typeof reportTools>;

export type ReportAgentTools = {
  apply_ops: { input: Inputs["apply_ops"]["input"]; output: ApplyOpsOutput };
  inspect_report: { input: Inputs["inspect_report"]["input"]; output: InspectOutput };
  profile_dataset: { input: Inputs["profile_dataset"]["input"]; output: ProfileOutput };
};

export type ReportAgentMessage = UIMessage<unknown, UIDataTypes, ReportAgentTools>;

/** Compact report state the browser sends with every request, so the agent never works from stale memory. */
export interface ReportContextSummary {
  title: string;
  revision: number;
  pages: number;
  datasets: Array<{ id: string; rows: number; fields: string[]; source?: string }>;
  outline: unknown;
  errors: Array<{ path: string; message: string; hint?: string }>;
}
