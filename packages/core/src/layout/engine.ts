import type { DataContext } from "../data/types.js";
import type { Block, Issue, ReportSpec } from "../spec.js";
import { composeSection } from "./compose.js";
import { estimateReportHeader, estimateSectionHeader, tableMetrics } from "./estimate.js";
import { pageGeometry } from "./geometry.js";
import { METRICS } from "./metrics.js";
import { paginate } from "./paginate.js";
import type { PaginationBand, PaginationSection } from "./paginate.js";
import type { LayoutOptions, LayoutPlan, SectionLayout } from "./types.js";

/**
 * Solve the full layout: compositions → bands (levelled heights) → pages.
 * Web mode yields one page with every item; print mode paginates on the spec's page geometry.
 * Measured heights (`opts.measured*`) override estimates (elastic blocks: their chrome).
 */
export function layoutReport(spec: ReportSpec, ctx: DataContext, opts: LayoutOptions): LayoutPlan {
  const gap = opts.gap ?? METRICS.grid.gap;
  const page = opts.mode === "print" ? pageGeometry(spec.page) : undefined;
  const contentWidth = page?.contentWidth ?? opts.contentWidth ?? METRICS.web.contentWidth;
  const density = spec.theme?.density ?? "comfortable";
  const reportHeaderHeight = opts.measuredReportHeader ?? estimateReportHeader(spec, contentWidth);
  const env = { ctx, contentWidth, gap, density, measured: opts.measured, pageHeight: page?.contentHeight };

  const sections: SectionLayout[] = [];
  const pagination: PaginationSection[] = [];
  spec.sections.forEach((section, si) => {
    const blocks = new Map<string, { block: Block; index: number }>(section.blocks.map((block, index) => [block.id, { block, index }]));
    const headerHeight = opts.measuredHeaders?.[section.id] ?? estimateSectionHeader(section, contentWidth);
    const bands = composeSection(section, env);
    const paginationBands = bands.map((band): PaginationBand => {
      const tallest = band.placements.reduce((a, b) => (b.height > a.height ? b : a));
      const { block, index } = blocks.get(tallest.blockId)!;
      const out: PaginationBand = { height: band.height, tallest: { path: `sections[${si}].blocks[${index}]`, hint: tooTallHint(block) } };
      if (band.placements.length === 1 && tallest.span === METRICS.grid.columns && block.type === "table" && block.paginate !== false) {
        const t = tableMetrics(block, tallest.width, ctx, density);
        // A measured table implies its real row height; keep the estimated chrome.
        const chrome = t.top + t.header + t.footer;
        if (opts.measured?.[block.id] !== undefined && t.rows > 0) t.row = Math.max(t.row, (band.height - chrome) / t.rows);
        out.table = { ...t, blockId: block.id };
      }
      return out;
    });
    sections.push({ id: section.id, headerHeight, bands });
    pagination.push({ id: section.id, headerHeight, breakBefore: page !== undefined && section.breakBefore === true, bands: paginationBands });
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
        height: s.headerHeight + s.bands.reduce((n, b) => n + b.height, 0) + Math.max(0, s.bands.length - 1) * gap,
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
