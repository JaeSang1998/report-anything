import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { convertToModelMessages, isStepCount, pipeUIMessageStreamToResponse, streamText, toUIMessageStream } from "ai";
import type { LanguageModel } from "ai";
import { reportTools } from "./tools.js";
import type { ReportAgentMessage, ReportContextSummary } from "./tools.js";

export class ConfigError extends Error {}

export interface ModelChoice {
  provider: "anthropic" | "openai";
  modelId: string;
}

/** Hosted model from the environment, or null when no key is set (the browser then runs the local agent). */
export function modelChoice(env: Record<string, string | undefined>): ModelChoice | null {
  const id = env.REPORT_AGENT_MODEL;
  if (env.ANTHROPIC_API_KEY) return { provider: "anthropic", modelId: id ?? "claude-sonnet-5-5" };
  if (env.OPENAI_API_KEY) return { provider: "openai", modelId: id ?? "gpt-6.1-sol" };
  return null;
}

export function resolveModel(env: Record<string, string | undefined>): LanguageModel {
  const choice = modelChoice(env);
  if (!choice) throw new ConfigError("No model configured. Put ANTHROPIC_API_KEY or OPENAI_API_KEY (optionally REPORT_AGENT_MODEL) in examples/playground/.env.local and restart `pnpm dev`.");
  return choice.provider === "anthropic" ? anthropic(choice.modelId) : openai(choice.modelId);
}

/** The skill is the prompt: editorial rules from SKILL.md plus the full spec reference. */
async function loadSkill(skillDir: string): Promise<string> {
  const [skill, reference] = await Promise.all([readFile(`${skillDir}/SKILL.md`, "utf8"), readFile(`${skillDir}/reference.md`, "utf8")]);
  const start = skill.indexOf("## Editorial rules");
  const end = skill.indexOf("\n## ", start + 1);
  return `${skill.slice(start, end === -1 ? undefined : end).trim()}\n\n${reference}`;
}

const ROLE = `You are a report agent inside a chat. The user sees the report inline in the conversation and it updates live while you stream ops.

How you work:
- You edit the report only through the apply_ops tool. Send a section or two per call so the report builds up visibly; several calls per answer are normal.
- Datasets the user attached are already in the report. You see their schema below, never their rows. Derive everything else with setDataset { from, transform }. Never write row data yourself and never use the "replace" op.
- Call profile_dataset before designing a report on data you have not profiled yet.
- After building or editing, read the apply_ops result (or call inspect_report with mode "print"). Fix every error and every layout diagnostic before you answer. Shape the layout with block importance and order (see Layout in the reference), never with span.
- Every number in KPIs, comparisons and prose is bound to data (Measures and {{templates}}); never type a figure.
- Reply in the user's language, in two or three sentences: what you built or changed and anything the data could not answer. The report itself carries the content; do not repeat it in chat.`;

function stateBlock(report: ReportContextSummary): string {
  return `## Current report (revision ${report.revision})\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

/**
 * Node handler for POST /api/chat. `model` is injected so the endpoint is independent of the provider
 * (and of how the dev server is wired).
 */
export function createChatHandler(opts: { model: () => LanguageModel; skillDir: string }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") return sendError(res, 405, "POST only");
    let model: LanguageModel;
    try {
      model = opts.model();
    } catch (err) {
      return sendError(res, 500, err instanceof Error ? err.message : String(err));
    }
    const body = (await readJsonBody(req)) as { messages: ReportAgentMessage[]; report: ReportContextSummary };
    const skill = await loadSkill(opts.skillDir);
    const result = streamText({
      model,
      system: `${ROLE}\n\n${skill}\n\n${stateBlock(body.report)}`,
      messages: await convertToModelMessages(body.messages),
      tools: reportTools,
      // Client-executed tools end the step; the browser resubmits with results.
      stopWhen: isStepCount(1),
    });
    pipeUIMessageStreamToResponse({
      response: res,
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: body.messages,
        onError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    });
  };
}
