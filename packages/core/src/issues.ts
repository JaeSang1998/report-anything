import type { z } from "zod";
import type { Issue } from "./spec.js";

/** ["sections", 0, "blocks", 2, "chart"] → "sections[0].blocks[2].chart" */
export function formatPath(path: readonly PropertyKey[], prefix = ""): string {
  let out = prefix;
  for (const p of path) out += typeof p === "number" ? `[${p}]` : out === "" ? String(p) : `.${String(p)}`;
  return out;
}

/** Convert Zod issues to agent-facing Issues with hints for the common mistakes. */
export function zodIssues(error: z.ZodError, prefix = "", code = "schema"): Issue[] {
  return error.issues.map((iss) => {
    let hint: string | undefined;
    if (iss.code === "invalid_value" && "values" in iss) hint = `allowed: ${iss.values.map((v) => JSON.stringify(v)).join(", ")}`;
    else if (iss.code === "invalid_union" && "note" in iss && iss.note === "No matching discriminator") {
      hint = "check the 'type' (blocks) / 'op' (transforms, ops) / 'kind' (charts) value";
    } else if (iss.code === "invalid_type" && iss.input === undefined) hint = "required field is missing";
    return {
      severity: "error" as const,
      code,
      path: formatPath(iss.path, prefix),
      message: iss.message,
      ...(hint ? { hint } : {}),
    };
  });
}
