import { z } from "zod";
import { Block, Dataset, Id, ReportSpec, Section } from "./spec.js";
import type { Issue } from "./spec.js";
import { closest } from "./data/values.js";
import { zodIssues } from "./issues.js";

/**
 * Id-addressed edit operations. Agents stream these (JSONL) to build a report incrementally
 * or to revise one block ("turn the second chart into a table") without regenerating the document.
 */
const Position = {
  before: Id.optional().describe("Insert before this sibling id."),
  after: Id.optional().describe("Insert after this sibling id. Default: append."),
};

export const Op = z
  .discriminatedUnion("op", [
    z
      .object({ op: z.literal("replace"), spec: ReportSpec })
      .describe("Replace the whole report."),
    z
      .object({
        op: z.literal("setReport"),
        patch: z
          .object({
            title: z.string().min(1),
            subtitle: z.string().nullable(),
            summary: z.string().nullable(),
            meta: z.record(z.string(), z.unknown()).nullable(),
            page: z.record(z.string(), z.unknown()).nullable(),
            theme: z.record(z.string(), z.unknown()).nullable(),
          })
          .partial(),
      })
      .describe("Update report-level fields. Objects merge; null removes."),
    z.object({ op: z.literal("setDataset"), id: Id, dataset: Dataset }).describe("Add or replace a dataset."),
    z.object({ op: z.literal("removeDataset"), id: Id }),
    z.object({ op: z.literal("addSection"), section: Section, ...Position }),
    z
      .object({
        op: z.literal("updateSection"),
        id: Id,
        patch: z.record(z.string(), z.unknown()).describe("Section fields except id/blocks. null removes a field."),
      })
      .describe("Patch section fields."),
    z.object({ op: z.literal("removeSection"), id: Id }),
    z.object({ op: z.literal("moveSection"), id: Id, ...Position }),
    z.object({ op: z.literal("addBlock"), section: Id, block: Block, ...Position }),
    z
      .object({
        op: z.literal("updateBlock"),
        id: Id,
        patch: z.record(z.string(), z.unknown()).describe("Deep merge: objects merge, arrays replace, null removes."),
      })
      .describe("Patch a block in place (e.g. change chart kind, shorten text)."),
    z.object({ op: z.literal("replaceBlock"), id: Id, block: Block }).describe("Swap a block for a different one (e.g. chart → table)."),
    z.object({ op: z.literal("removeBlock"), id: Id }),
    z
      .object({ op: z.literal("moveBlock"), id: Id, section: Id.optional().describe("Target section (default: current)."), ...Position })
      .describe("Move a block within or across sections."),
  ])
  .describe("One edit operation on a ReportSpec, addressed by ids.");
export type Op = z.infer<typeof Op>;
export type OpInput = z.input<typeof Op>;

export type ApplyResult = { ok: true; spec: ReportSpec } | { ok: false; issues: Issue[] };

class OpFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge for patches: objects merge recursively, arrays/scalars replace, null deletes. */
export function mergePatch(target: unknown, patch: Json): Json {
  const out: Json = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isPlainObject(v)) out[k] = mergePatch(out[k], v);
    else out[k] = v;
  }
  return out;
}

function insertAt<T extends { id: string }>(list: T[], item: T, pos: { before?: string | undefined; after?: string | undefined }, kind: string): T[] {
  const anchor = pos.before ?? pos.after;
  if (anchor === undefined) return [...list, item];
  const idx = list.findIndex((x) => x.id === anchor);
  if (idx < 0) {
    const guess = closest(anchor, list.map((x) => x.id));
    throw new OpFailure(`unknown_${kind}`, `no ${kind} '${anchor}' to insert ${pos.before ? "before" : "after"}`, guess ? `did you mean '${guess}'?` : undefined);
  }
  const at = pos.before !== undefined ? idx : idx + 1;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

function allIds(spec: ReportSpec): string[] {
  return spec.sections.flatMap((s) => [s.id, ...s.blocks.map((b) => b.id)]);
}

function assertFreshId(spec: ReportSpec, id: string, except?: string): void {
  if (id !== except && allIds(spec).includes(id)) {
    throw new OpFailure("duplicate_id", `id '${id}' is already used`, "pick a unique id for every section and block");
  }
}

function findSection(spec: ReportSpec, id: string): number {
  const idx = spec.sections.findIndex((s) => s.id === id);
  if (idx < 0) {
    const guess = closest(id, spec.sections.map((s) => s.id));
    throw new OpFailure("unknown_section", `no section '${id}'`, guess ? `did you mean '${guess}'?` : `sections: ${spec.sections.map((s) => s.id).join(", ") || "(none)"}`);
  }
  return idx;
}

function findBlock(spec: ReportSpec, id: string): { s: number; b: number } {
  for (let s = 0; s < spec.sections.length; s++) {
    const b = spec.sections[s]!.blocks.findIndex((x) => x.id === id);
    if (b >= 0) return { s, b };
  }
  const guess = closest(id, spec.sections.flatMap((x) => x.blocks.map((b) => b.id)));
  throw new OpFailure("unknown_block", `no block '${id}'`, guess ? `did you mean '${guess}'?` : undefined);
}

function withSection(spec: ReportSpec, index: number, section: Section): ReportSpec {
  const sections = [...spec.sections];
  sections[index] = section;
  return { ...spec, sections };
}

function parseOrFail<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  const at = first?.path.length ? ` at ${first.path.join(".")}` : "";
  throw new OpFailure("invalid_patch", `patched ${what} is invalid${at}: ${first?.message ?? "unknown error"}`);
}

function applyOne(spec: ReportSpec, op: Op): ReportSpec {
  switch (op.op) {
    case "replace":
      return op.spec;
    case "setReport":
      return parseOrFail(ReportSpec, mergePatch(spec, op.patch as Json), "report");
    case "setDataset":
      return { ...spec, datasets: { ...spec.datasets, [op.id]: op.dataset } };
    case "removeDataset": {
      if (!(op.id in spec.datasets)) throw new OpFailure("unknown_dataset", `no dataset '${op.id}'`);
      const { [op.id]: _removed, ...datasets } = spec.datasets;
      return { ...spec, datasets };
    }
    case "addSection": {
      assertFreshId(spec, op.section.id);
      for (const b of op.section.blocks) assertFreshId(spec, b.id);
      return { ...spec, sections: insertAt(spec.sections, op.section, op, "section") };
    }
    case "updateSection": {
      const i = findSection(spec, op.id);
      const { id: _id, blocks: _blocks, ...patch } = op.patch;
      const current = spec.sections[i]!;
      const next = parseOrFail(Section, { ...mergePatch(current, patch), id: current.id, blocks: current.blocks }, `section '${op.id}'`);
      return withSection(spec, i, next);
    }
    case "removeSection": {
      const i = findSection(spec, op.id);
      return { ...spec, sections: spec.sections.filter((_, k) => k !== i) };
    }
    case "moveSection": {
      const i = findSection(spec, op.id);
      const section = spec.sections[i]!;
      const rest = spec.sections.filter((_, k) => k !== i);
      return { ...spec, sections: insertAt(rest, section, op, "section") };
    }
    case "addBlock": {
      const i = findSection(spec, op.section);
      assertFreshId(spec, op.block.id);
      const section = spec.sections[i]!;
      return withSection(spec, i, { ...section, blocks: insertAt(section.blocks, op.block, op, "block") });
    }
    case "updateBlock": {
      const { s, b } = findBlock(spec, op.id);
      const section = spec.sections[s]!;
      const current = section.blocks[b]!;
      const { id: _id, ...patch } = op.patch;
      const next = parseOrFail(Block, { ...mergePatch(current, patch), id: current.id }, `block '${op.id}'`);
      const blocks = [...section.blocks];
      blocks[b] = next;
      return withSection(spec, s, { ...section, blocks });
    }
    case "replaceBlock": {
      const { s, b } = findBlock(spec, op.id);
      assertFreshId(spec, op.block.id, op.id);
      const section = spec.sections[s]!;
      const blocks = [...section.blocks];
      blocks[b] = op.block;
      return withSection(spec, s, { ...section, blocks });
    }
    case "removeBlock": {
      const { s, b } = findBlock(spec, op.id);
      const section = spec.sections[s]!;
      return withSection(spec, s, { ...section, blocks: section.blocks.filter((_, k) => k !== b) });
    }
    case "moveBlock": {
      const { s, b } = findBlock(spec, op.id);
      const block = spec.sections[s]!.blocks[b]!;
      const from = spec.sections[s]!;
      const removed = withSection(spec, s, { ...from, blocks: from.blocks.filter((_, k) => k !== b) });
      const t = op.section === undefined ? s : findSection(removed, op.section);
      const target = removed.sections[t]!;
      return withSection(removed, t, { ...target, blocks: insertAt(target.blocks, block, op, "block") });
    }
  }
}

/**
 * Apply ops transactionally: either every op applies or the spec is unchanged and issues explain the first failure.
 * Ops are parsed with the Op schema, so raw agent JSON is accepted.
 */
export function applyOps(spec: ReportSpec, ops: readonly unknown[]): ApplyResult {
  let current = spec;
  for (let i = 0; i < ops.length; i++) {
    const parsed = Op.safeParse(ops[i]);
    if (!parsed.success) {
      return { ok: false, issues: zodIssues(parsed.error, `ops[${i}]`, "invalid_op") };
    }
    try {
      current = applyOne(current, parsed.data);
    } catch (err) {
      if (!(err instanceof OpFailure)) throw err;
      return {
        ok: false,
        issues: [{ severity: "error", code: err.code, path: `ops[${i}]`, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }],
      };
    }
  }
  return { ok: true, spec: current };
}
