import type { Issue } from "./spec.js";

export interface OpChunk {
  /** Complete JSON values parsed so far (not yet schema-checked; `applyOps` does that). */
  ops: unknown[];
  errors: Issue[];
}

/**
 * Incremental JSONL parser for streamed agent output. Feed text chunks as they arrive;
 * each complete line yields one op. Blank lines and markdown code fences are ignored,
 * so raw LLM output can be piped straight in.
 */
export function createOpParser(): { push(chunk: string): OpChunk; flush(): OpChunk } {
  let buffer = "";
  let line = 0;

  const parseLines = (lines: string[]): OpChunk => {
    const out: OpChunk = { ops: [], errors: [] };
    for (const raw of lines) {
      line++;
      const text = raw.trim();
      if (text === "" || text.startsWith("```")) continue;
      try {
        out.ops.push(JSON.parse(text));
      } catch (err) {
        out.errors.push({
          severity: "error",
          code: "invalid_json",
          path: `line ${line}`,
          message: err instanceof Error ? err.message : String(err),
          hint: "emit exactly one JSON op object per line",
        });
      }
    }
    return out;
  };

  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      return parseLines(parts);
    },
    flush() {
      const rest = buffer;
      buffer = "";
      return parseLines([rest]);
    },
  };
}
