import type { DataContext } from "../data/types.js";
import type { Block, Issue, ReportSpec } from "../spec.js";
import { estimateBlockHeight, estimateReportHeader, estimateSectionHeader, tableMetrics } from "./estimate.js";
import { cellBox, pageGeometry } from "./geometry.js";
import { METRICS } from "./metrics.js";
import { paginate } from "./paginate.js";
import type { PaginationRow, PaginationSection } from "./paginate.js";
import { assignRows } from "./spans.js";
import type { Cell, LayoutOptions, LayoutPlan, RowLayout, SectionLayout } from "./types.js";

/**
 * Solve the full layout: spans → rows → cell widths → heights → pages.
 * Web mode yields one page with every item; print mode paginates on the spec's page geometry.
 * Measured heights (`opts.measured*`) always override estimates.
 */
export function layoutReport(spec: ReportSpec, ctx: DataContext, opts: LayoutOptions): LayoutPlan {
  const gap = opts.gap ?? METRICS.grid.gap;
  const page = opts.mode === "print" ? pageGeometry(spec.page) : undefined;
  const contentWidth = page?.contentWidth ?? opts.contentWidth ?? METRICS.web.contentWidth;
  const density = spec.theme?.density ?? "comfortable";
  const reportHeaderHeight = opts.measuredReportHeader ?? estimateReportHeader(spec, contentWidth);

  const sections: SectionLayout[] = [];
  const pagination: PaginationSection[] = [];
  spec.sections.forEach((section, si) => {
    const blocks = new Map<string, { block: Block; index: number }>(section.blocks.map((block, index) => [block.id, { block, index }]));
    const headerHeight = opts.measuredHeaders?.[section.id] ?? estimateSectionHeader(section, contentWidth);
    const rows: RowLayout[] = [];
    const paginationRows: PaginationRow[] = [];
    for (const spanRow of assignRows(section, ctx, contentWidth, gap)) {
      let start = 1;
      const cells: Cell[] = spanRow.map(({ blockId, span }) => {
        const { block } = blocks.get(blockId)!;
        const width = cellBox(start, span, contentWidth, gap).width;
        const cell: Cell = { blockId, span, start, width, height: opts.measured?.[blockId] ?? estimateBlockHeight(block, width, ctx, density) };
        start += span;
        return cell;
      });
      const height = Math.max(0, ...cells.map((c) => c.height));
      rows.push({ cells, height });

      const tallest = cells.reduce((a, b) => (b.height > a.height ? b : a));
      const { block, index } = blocks.get(tallest.blockId)!;
      const row: PaginationRow = { height, tallest: { path: `sections[${si}].blocks[${index}]`, hint: tooTallHint(block) } };
      if (cells.length === 1 && block.type === "table" && block.paginate !== false) {
        const t = tableMetrics(block, tallest.width, ctx, density);
        // A measured table implies its real row height; keep the estimated chrome.
        const chrome = t.top + t.header + t.footer;
        if (opts.measured?.[block.id] !== undefined && t.rows > 0) t.row = Math.max(t.row, (height - chrome) / t.rows);
        row.table = { ...t, blockId: block.id };
      }
      paginationRows.push(row);
    }
    sections.push({ id: section.id, headerHeight, rows });
    pagination.push({ id: section.id, headerHeight, breakBefore: page !== undefined && section.breakBefore === true, rows: paginationRows });
  });

  const { pages, issues } = paginate({
    reportHeaderHeight,
    sections: pagination,
    contentHeight: page?.contentHeight ?? Infinity,
    gap,
    sectionGap: METRICS.section.gap,
  });
  const diagnostics: Issue[] = [...issues];

  const target = spec.page?.targetPages;
  if (page && target !== undefined && pages.length > target) {
    const tallest = pagination
      .map((s, si) => ({
        si,
        height: s.headerHeight + s.rows.reduce((n, r) => n + r.height, 0) + Math.max(0, s.rows.length - 1) * gap,
      }))
      .sort((a, b) => b.height - a.height)
      .slice(0, 2)
      .map(({ si, height }) => {
        const s = spec.sections[si]!;
        return `"${s.title ?? s.id}" (sections[${si}], ~${Math.round(height)}px)`;
      });
    diagnostics.push({
      severity: "warning",
      code: "page_target_exceeded",
      path: "page.targetPages",
      message: `Report needs ${pages.length} pages but targetPages is ${target}.`,
      hint: `Tallest sections: ${tallest.join(" and ")}. Trim them: lower table maxRows, use chart height 'sm', shorten text, or move detail to an appendix.`,
    });
  }

  return {
    mode: opts.mode,
    columns: 12,
    gap,
    contentWidth,
    page,
    reportHeaderHeight,
    sections,
    pages,
    diagnostics,
  };
}

function tooTallHint(block: Block): string {
  switch (block.type) {
    case "chart":
      return "Use chart height 'sm' or 'md'.";
    case "table":
      return block.paginate === false
        ? "Set paginate: true so the table can split across pages, or lower maxRows."
        : "Lower maxRows or give the table the full width so it can split across pages.";
    case "kpi":
      return "Use fewer KPI items or split them into two kpi blocks.";
    default:
      return "Split the content into several shorter blocks.";
  }
}
