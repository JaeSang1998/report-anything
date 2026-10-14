import { z } from "zod";
import { ReportSpec } from "./spec.js";
import { Op } from "./ops.js";

/**
 * JSON Schemas for LLM tool definitions / structured output.
 * `io: "input"` describes what agents write (defaults optional), not the parsed shape.
 */
export function reportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReportSpec, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

export function opJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Op, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}
