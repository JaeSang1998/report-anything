import { describe, expect, it } from "vitest";
import { ReportSpec } from "./spec.js";
import { applyOps } from "./ops.js";
import { createReportSession, SpecError } from "./session.js";
import { createOpParser } from "./stream.js";
import { validateReport } from "./validate.js";

const base = ReportSpec.parse({
  title: "T",
  datasets: { sales: { rows: [{ month: "2026-01", revenue: 10 }, { month: "2026-02", revenue: 12 }] } },
  sections: [
    { id: "a", blocks: [{ id: "c1", type: "chart", chart: { kind: "bar", data: "sales", x: "month", y: "revenue" } }, { id: "t1", type: "text", content: "hi" }] },
    { id: "b", blocks: [] },
  ],
});

describe("applyOps", () => {
  it("is transactional: a failing op leaves the spec untouched and points at the op", () => {
    const r = applyOps(base, [
      { op: "removeBlock", id: "t1" },
      { op: "removeBlock", id: "c2" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0]).toMatchObject({ code: "unknown_block", path: "ops[1]", hint: "did you mean 'c1'?" });
    expect(base.sections[0]!.blocks).toHaveLength(2);
  });

  it("deep-merges updateBlock patches, replaces arrays, deletes on null, and keeps the id", () => {
    const r = applyOps(base, [{ op: "updateBlock", id: "c1", patch: { id: "zzz", title: "Sales", chart: { kind: "line", y: ["revenue"] } } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.spec.sections[0]!.blocks[0]!;
    expect(block).toMatchObject({ id: "c1", title: "Sales", chart: { kind: "line", data: "sales", x: "month", y: ["revenue"] } });
    const cleared = applyOps(r.spec, [{ op: "updateBlock", id: "c1", patch: { title: null } }]);
    expect(cleared.ok && "title" in cleared.spec.sections[0]!.blocks[0]!).toBe(false);
  });

  it("rejects patches that make a block schema-invalid", () => {
    const r = applyOps(base, [{ op: "updateBlock", id: "c1", patch: { chart: { kind: "radar" } } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe("invalid_patch");
  });

  it("swaps block types with replaceBlock (chart → table)", () => {
    const r = applyOps(base, [{ op: "replaceBlock", id: "c1", block: { id: "c1", type: "table", data: "sales" } }]);
    expect(r.ok && r.spec.sections[0]!.blocks[0]!.type).toBe("table");
  });

  it("moves blocks across sections relative to siblings", () => {
    const r = applyOps(base, [
      { op: "moveBlock", id: "t1", section: "b" },
      { op: "moveBlock", id: "c1", section: "b", before: "t1" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.sections[0]!.blocks).toHaveLength(0);
    expect(r.spec.sections[1]!.blocks.map((b) => b.id)).toEqual(["c1", "t1"]);
  });

  it("refuses duplicate ids across sections and blocks", () => {
    const r = applyOps(base, [{ op: "addBlock", section: "b", block: { id: "a", type: "text", content: "x" } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe("duplicate_id");
  });

  it("reports schema errors of raw op JSON with the op index", () => {
    const r = applyOps(base, [{ op: "addBlock", section: "b", block: { id: "x", type: "sparkle" } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.path.startsWith("ops[0]")).toBe(true);
  });
});

describe("validateReport", () => {
  it("flags unknown fields with a did-you-mean hint and marks the block broken", () => {
    const r = validateReport({ ...base, sections: [{ id: "a", blocks: [{ id: "c", type: "chart", chart: { kind: "bar", data: "sales", x: "month", y: "revenu" } }] }] });
    expect(r.ok).toBe(false);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: "unknown_field", path: "sections[0].blocks[0].chart.y", hint: "did you mean 'revenue'?" }));
    expect(r.brokenBlocks?.has("c")).toBe(true);
  });

  it("rejects pie charts with several measures", () => {
    const r = validateReport({ ...base, sections: [{ id: "a", blocks: [{ id: "p", type: "chart", chart: { kind: "pie", data: "sales", x: "month", y: ["revenue", "revenue"] } }] }] });
    expect(r.issues.some((i) => i.code === "chart_encoding")).toBe(true);
  });

  const chartIssues = (chart: object) =>
    validateReport({ ...base, sections: [{ id: "a", blocks: [{ id: "c", type: "chart", chart: { data: "sales", x: "month", ...chart } }] }] }).issues.map((i) => `${i.severity}:${i.code}:${i.path}`);

  it.each([
    [{ kind: "waterfall", y: ["revenue", "revenue"] }, "error:chart_encoding:sections[0].blocks[0].chart.y"],
    [{ kind: "funnel", y: ["revenue", "revenue"] }, "error:chart_encoding:sections[0].blocks[0].chart.y"],
    [{ kind: "dumbbell", y: "revenue" }, "error:chart_encoding:sections[0].blocks[0].chart.y"],
    [{ kind: "dumbbell", y: ["revenue", "revenue", "revenue"] }, "error:chart_encoding:sections[0].blocks[0].chart.y"],
    [{ kind: "waterfall", y: "revenue", series: "month" }, "error:chart_encoding:sections[0].blocks[0].chart.series"],
    [{ kind: "dumbbell", y: ["revenue", "revenue"], series: "month" }, "error:chart_encoding:sections[0].blocks[0].chart.series"],
    [{ kind: "bar", y: "revenue", base: "first" }, "warning:ignored_option:sections[0].blocks[0].chart.base"],
    [{ kind: "funnel", y: "revenue", total: "End" }, "warning:ignored_option:sections[0].blocks[0].chart.total"],
  ])("checks waterfall/funnel/dumbbell encodings: %j", (chart, issue) => {
    expect(chartIssues(chart)).toEqual([issue]);
  });

  it("accepts well-formed waterfall, funnel and dumbbell charts", () => {
    expect(chartIssues({ kind: "waterfall", y: "revenue", base: "first", total: "End" })).toEqual([]);
    expect(chartIssues({ kind: "funnel", y: "revenue" })).toEqual([]);
    expect(chartIssues({ kind: "dumbbell", y: ["revenue", "revenue"] })).toEqual([]);
  });
});

describe("createReportSession", () => {
  it("accepts semantically broken intermediate states while streaming, then becomes valid", () => {
    const s = createReportSession();
    let notified = 0;
    s.subscribe(() => notified++);
    s.apply({ op: "addSection", section: { id: "a", blocks: [{ id: "c", type: "chart", chart: { kind: "bar", data: "sales", x: "m", y: "v" } }] } });
    expect(s.getSnapshot()).toMatchObject({ revision: 1, valid: false });
    s.apply({ op: "setDataset", id: "sales", dataset: { rows: [{ m: "a", v: 1 }] } });
    expect(s.getSnapshot()).toMatchObject({ revision: 2, valid: true });
    expect(notified).toBe(2);
  });

  it("does not bump the revision or notify on rejected ops", () => {
    const s = createReportSession(base);
    let notified = 0;
    s.subscribe(() => notified++);
    const r = s.apply({ op: "removeSection", id: "nope" });
    expect(r).toMatchObject({ ok: false, revision: 0 });
    expect(notified).toBe(0);
  });

  it("reuses resolved datasets when only blocks change", () => {
    const s = createReportSession(base);
    const before = s.getSnapshot().context.datasets;
    s.apply({ op: "updateBlock", id: "t1", patch: { content: "changed" } });
    expect(s.getSnapshot().context.datasets).toBe(before);
    s.apply({ op: "setDataset", id: "more", dataset: { rows: [{ a: 1 }] } });
    expect(s.getSnapshot().context.datasets).not.toBe(before);
  });

  it("throws SpecError with issues for schema-invalid initial specs", () => {
    expect(() => createReportSession({ sections: [] })).toThrow(SpecError);
  });
});

describe("createOpParser", () => {
  it("handles ops split across chunks, code fences and bad lines", () => {
    const p = createOpParser();
    const a = p.push('```jsonl\n{"op":"removeBlock",');
    expect(a.ops).toHaveLength(0);
    const b = p.push('"id":"t1"}\nnot json\n');
    const c = p.flush();
    expect(b.ops).toEqual([{ op: "removeBlock", id: "t1" }]);
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]!.path).toBe("line 3");
    expect(c.ops).toHaveLength(0);
  });
});
