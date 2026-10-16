import type { Block, Issue, ReportSpec } from "./spec.js";
import type { DataContext } from "./data/types.js";
import type { Composition, LayoutMode, LayoutPlan } from "./layout/types.js";
import { layoutReport } from "./layout/engine.js";
import { mermaidKind } from "./diagram.js";

/** Compact, token-cheap view of a report for agents: what exists, where it landed, what is wrong. */
export interface Inspection {
  title: string;
  valid: boolean;
  mode: LayoutMode;
  pages: number;
  datasets: Array<{ id: string; rows: number; fields: string[] }>;
  outline: Array<{
    section: string;
    title?: string;
    /** Band compositions in order, e.g. ["hero", "feature-right", "full"]. */
    bands: Composition[];
    blocks: Array<{ id: string; type: Block["type"]; summary: string; span?: number; height?: number; page?: number }>;
  }>;
  issues: Issue[];
}

function blockSummary(block: Block): string {
  switch (block.type) {
    case "chart": {
      const c = block.chart;
      const ys = Array.isArray(c.y) ? c.y.join(",") : c.y;
      return `${c.kind} ${c.data}: x=${c.x} y=${ys}${c.series ? ` series=${c.series}` : ""}${c.stack ? " stacked" : ""}`;
    }
    case "table":
      return `${block.data}${block.columns ? ` cols=${block.columns.map((c) => c.field).join(",")}` : ""}${block.maxRows ? ` max=${block.maxRows}` : ""}`;
    case "kpi":
      return block.items.map((i) => i.label).join(" | ");
    case "stat":
      return `stat: ${block.label}`;
    case "comparison":
      return `${block.entities.join(" vs ")}: ${block.metrics.length} metrics`;
    case "list":
      return `${block.items.length} ${block.style} items`;
    case "diagram":
      return `${block.syntax} ${mermaidKind(block.source) ?? "diagram"}, ${block.source.trim().split("\n").length} lines`;
    case "text":
    case "callout": {
      const text = block.content.replace(/\s+/g, " ").trim();
      return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    }
  }
}

function pageOfBlocks(plan: LayoutPlan): Map<string, number> {
  const out = new Map<string, number>();
  for (const page of plan.pages) {
    for (const item of page.items) {
      if (item.kind === "band") {
        const band = plan.sections.find((s) => s.id === item.sectionId)?.bands[item.band];
        for (const p of band?.placements ?? []) if (!out.has(p.blockId)) out.set(p.blockId, page.index + 1);
      } else if (item.kind === "table-slice" && !out.has(item.blockId)) {
        out.set(item.blockId, page.index + 1);
      }
    }
  }
  return out;
}

export function inspectReport(
  snapshot: { spec: ReportSpec; context: DataContext; issues: Issue[] },
  opts: { mode?: LayoutMode } = {},
): Inspection {
  const { spec, context } = snapshot;
  const mode = opts.mode ?? "print";
  const plan = layoutReport(spec, context, { mode });
  const placements = new Map(plan.sections.flatMap((s) => s.bands.flatMap((b) => b.placements.map((p) => [p.blockId, p] as const))));
  const pages = pageOfBlocks(plan);
  const issues = [...snapshot.issues, ...plan.diagnostics];
  return {
    title: spec.title,
    valid: !issues.some((i) => i.severity === "error"),
    mode,
    pages: plan.pages.length,
    datasets: [...context.datasets.values()].map((d) => ({ id: d.id, rows: d.rows.length, fields: d.fields.map((f) => `${f.name}:${f.type}`) })),
    outline: spec.sections.map((s, si) => ({
      section: s.id,
      ...(s.title ? { title: s.title } : {}),
      bands: plan.sections[si]?.bands.map((b) => b.composition) ?? [],
      blocks: s.blocks.map((b) => {
        const cell = placements.get(b.id);
        const page = pages.get(b.id);
        return {
          id: b.id,
          type: b.type,
          summary: blockSummary(b),
          ...(cell ? { span: cell.span, height: Math.round(cell.height) } : {}),
          ...(mode !== "web" && page !== undefined ? { page } : {}),
        };
      }),
    })),
    issues,
  };
}
