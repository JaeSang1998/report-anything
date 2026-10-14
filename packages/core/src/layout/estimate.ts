import type { DataContext } from "../data/types.js";
import type { Block, BlockOf, ReportSpec, Section } from "../spec.js";
import { FACET_KINDS } from "../chart/facet.js";
import { METRICS } from "./metrics.js";
import { CJK_RANGES, estimateTextWidth } from "../text.js";

export type Density = "comfortable" | "compact";

const TEMPLATE = /\{\{[^}]*\}\}/g;
const TEMPLATE_STANDIN = "0".repeat(METRICS.templateChars);
const TOKEN = new RegExp(`\\s+|[${CJK_RANGES}]|[^\\s${CJK_RANGES}]+`, "g");
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Number of lines `text` wraps to at `width` px (greedy word wrap; CJK breaks between glyphs). */
export function wrapLines(text: string, width: number, fontSize: number): number {
  // Inline markdown → display text; `{{ templates }}` become a fixed-width stand-in.
  const s = text
    .replace(TEMPLATE, TEMPLATE_STANDIN)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|[*`]/g, "")
    .trim();
  if (s === "") return 0;
  const avail = Math.max(width, fontSize);
  const space = estimateTextWidth(" ", fontSize);
  let lines = 1;
  let x = 0;
  let pendingSpace = false;
  for (const token of s.match(TOKEN) ?? []) {
    if (/^\s/.test(token)) {
      pendingSpace = true;
      continue;
    }
    const w = estimateTextWidth(token, fontSize);
    const next = x === 0 ? w : x + (pendingSpace ? space : 0) + w;
    pendingSpace = false;
    if (next <= avail) {
      x = next;
      continue;
    }
    if (x > 0) lines++;
    // A token wider than the line breaks across ceil(w / avail) lines.
    const extra = Math.ceil(w / avail) - 1;
    lines += extra;
    x = w - extra * avail;
  }
  return lines;
}

/** Height of a markdown-subset body: paragraphs (soft-wrapped lines joined) and bullet / numbered items. */
export function markdownHeight(md: string, width: number, fontSize: number = METRICS.text.fontSize, line: number = METRICS.text.line): number {
  const blocks: Array<{ item: boolean; text: string }> = [];
  let open = false;
  for (const raw of md.split(/\r?\n/)) {
    if (raw.trim() === "") {
      open = false;
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (BULLET.test(raw)) {
      blocks.push({ item: true, text: raw.replace(BULLET, "") });
      open = true;
    } else if (open && last) {
      last.text += ` ${raw.trim()}`;
    } else {
      blocks.push({ item: false, text: raw.trim() });
      open = true;
    }
  }
  let height = 0;
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (prev) height += prev.item && b.item ? METRICS.text.itemGap : METRICS.text.paragraphGap;
    const w = b.item ? width - METRICS.text.bulletIndent : width;
    height += Math.max(1, wrapLines(b.text, w, fontSize)) * line;
  });
  return height;
}

function titleHeight(title: string | undefined, width: number): number {
  if (!title) return 0;
  return Math.max(1, wrapLines(title, width, METRICS.blockTitle.fontSize)) * METRICS.blockTitle.line + METRICS.blockTitle.marginBottom;
}

function captionHeight(caption: string | undefined, width: number): number {
  if (!caption) return 0;
  return METRICS.caption.marginTop + Math.max(1, wrapLines(caption, width, METRICS.caption.fontSize)) * METRICS.caption.line;
}

/** Chart SVG height (axes included, block title/caption/legend excluded) for the block's `height` preset. */
export function chartPlotHeight(block: BlockOf<"chart">): number {
  return METRICS.chart.plot[block.height ?? "md"];
}

/** Whether the renderer shows an HTML legend band under the chart SVG. */
export function chartHasLegend(block: BlockOf<"chart">): boolean {
  const c = block.chart;
  if (c.legend !== undefined) return c.legend;
  if (c.kind === "pie" || c.kind === "donut") return true;
  const y = Array.isArray(c.y) ? c.y.length : 1;
  const secondary = c.secondary === undefined ? 0 : Array.isArray(c.secondary.y) ? c.secondary.y.length : 1;
  return c.series !== undefined || y + secondary >= 2;
}

/** Vertical decomposition of a table block, shared by height estimation and page splitting. */
export interface TableMetrics {
  /** Block title (+ its margin). */
  top: number;
  header: number;
  /** Body row height. */
  row: number;
  /** Body rows shown (after maxRows). */
  rows: number;
  /** Totals row + truncation note + caption (rendered on the last slice only). */
  footer: number;
}

export function tableMetrics(block: BlockOf<"table">, width: number, ctx: DataContext, density: Density = "comfortable"): TableMetrics {
  const total = ctx.datasets.get(block.data)?.rows.length;
  const rows = total === undefined ? (block.maxRows ?? 10) : Math.min(total, block.maxRows ?? total);
  const compact = (block.density ?? (density === "compact" ? "compact" : "normal")) === "compact";
  const totals = block.totals === true || (Array.isArray(block.totals) && block.totals.length > 0);
  const footer =
    (totals ? METRICS.table.totals : 0) +
    (total !== undefined && total > rows ? METRICS.table.truncationNote : 0) +
    captionHeight(block.caption, width);
  return {
    top: titleHeight(block.title, width),
    header: METRICS.table.header,
    row: compact ? METRICS.table.rowCompact : METRICS.table.row,
    rows,
    footer,
  };
}

/** Stand-in for the localized callout variant label ("Recommendation") when estimating its title line. */
const VARIANT_LABEL_STANDIN = "x".repeat(12);
/** Charts and diagrams stretch up to this far past the `lg` preset when levelled against their neighbours. */
const PLOT_STRETCH = 60;
/** Facet panel height range (px, label line included) when levelled. */
const FACET_PANEL = { min: 120, max: 200 } as const;
/** Narrowest facet panel; decides how many panels share a row. */
const FACET_MIN_PANEL_WIDTH = 220;
const FACET_MAX_COLUMNS = 4;

export interface FacetGrid {
  columns: number;
  rows: number;
  /** Panels drawn: distinct facet values, capped by `facetLimit` (default 12). */
  panels: number;
  /** One panel's height incl. its label line: the preset, or derived from an assigned `plotHeight`. */
  panelHeight: number;
}

/**
 * Small-multiple grid for a chart with `facet` at `cellWidth`. Shared by the layout engine and chart renderers so
 * geometry agrees. Pass the `plotHeight` the layout assigned to derive the panel height.
 */
export function facetGrid(block: BlockOf<"chart">, cellWidth: number, ctx: DataContext, plotHeight?: number): FacetGrid {
  const c = block.chart;
  const G = METRICS.chart.facetGap;
  // Kinds without small multiples ignore `facet` (validation warns).
  const facet = FACET_KINDS[c.kind] ? c.facet : undefined;
  const values = facet === undefined ? [] : (ctx.datasets.get(c.data)?.rows ?? []).map((r) => r[facet] ?? null);
  const panels = Math.min(new Set(values).size, c.facetLimit ?? 12);
  const columns = Math.max(1, Math.min(FACET_MAX_COLUMNS, panels, Math.floor((cellWidth + G) / (FACET_MIN_PANEL_WIDTH + G))));
  const rows = Math.max(1, Math.ceil(panels / columns));
  const panelHeight = plotHeight === undefined ? METRICS.chart.facetPlot : (plotHeight - (rows - 1) * G) / rows;
  return { columns, rows, panels, panelHeight };
}

/**
 * Vertical make-up of a block at `width`: `chrome` + `body`. Elastic blocks (charts incl. facet grids, diagrams) have
 * `chrome` = title + legend + caption and a body that may move within [`min`, `max`]. Every other block is all chrome
 * (`body` = `min` = `max` = 0).
 */
export interface BlockBox {
  chrome: number;
  body: number;
  min: number;
  max: number;
}

/** Height decomposition of a block at `width` px (no card padding). `density` only affects table row height. */
export function blockBox(block: Block, width: number, ctx: DataContext, density: Density = "comfortable"): BlockBox {
  const fixed = (chrome: number): BlockBox => ({ chrome, body: 0, min: 0, max: 0 });
  if (block.type === "table") {
    const t = tableMetrics(block, width, ctx, density);
    return fixed(t.top + t.header + t.rows * t.row + t.footer);
  }
  // Callouts with a variant read "Recommendation: <title>" (the label alone without a title).
  const title =
    block.type === "callout" && block.variant !== undefined
      ? block.title
        ? `${VARIANT_LABEL_STANDIN}: ${block.title}`
        : VARIANT_LABEL_STANDIN
      : block.title;
  const chrome = titleHeight(title, width) + captionHeight(block.caption, width);
  const P = METRICS.chart.plot;
  switch (block.type) {
    case "kpi": {
      const K = METRICS.kpi;
      const perRow = Math.max(1, Math.min(block.items.length, Math.floor((width + K.columnGap) / (K.minItemWidth + K.columnGap))));
      const rows = Math.ceil(block.items.length / perRow);
      const item =
        K.label.line +
        K.value.line +
        K.delta.line +
        (block.items.some((i) => i.description) ? K.description.line : 0) +
        (block.items.some((i) => i.sparkline) ? K.sparkline : 0);
      return fixed(chrome + rows * item + (rows - 1) * K.rowGap);
    }
    case "stat": {
      const S = METRICS.stat;
      const delta = block.compareTo !== undefined || block.delta !== undefined ? S.delta.line : 0;
      const description = block.description ? S.gap + markdownHeight(block.description, width, S.description.fontSize, S.description.line) : 0;
      return fixed(chrome + S.label.line + S.value.line + delta + description);
    }
    case "chart": {
      const legend = chartHasLegend(block) ? METRICS.chart.legendBand : 0;
      if (block.chart.facet === undefined || !FACET_KINDS[block.chart.kind]) return { chrome: chrome + legend, body: chartPlotHeight(block), min: P.sm, max: P.lg + PLOT_STRETCH };
      const { rows } = facetGrid(block, width, ctx);
      const gaps = (rows - 1) * METRICS.chart.facetGap;
      return { chrome: chrome + legend, body: rows * METRICS.chart.facetPlot + gaps, min: rows * FACET_PANEL.min + gaps, max: rows * FACET_PANEL.max + gaps };
    }
    case "diagram":
      // Diagrams are fitted into the same height presets as charts.
      return { chrome, body: P[block.height ?? "md"], min: P.sm, max: P.lg + PLOT_STRETCH };
    case "text":
      return fixed(chrome + markdownHeight(block.content, width));
    case "callout":
      return fixed(chrome + markdownHeight(block.content, width, METRICS.callout.fontSize, METRICS.callout.line));
    case "list": {
      const L = METRICS.list;
      const textWidthAvail = width - L.marker;
      let body = 0;
      block.items.forEach((item, i) => {
        if (i > 0) body += L.itemGap;
        const tag = item.tag ? estimateTextWidth(item.tag, L.tagFontSize) + L.tagGap : 0;
        body += Math.max(1, wrapLines(item.text, textWidthAvail - tag, METRICS.text.fontSize)) * L.line;
        if (item.detail) body += wrapLines(item.detail, textWidthAvail, L.detailFontSize) * L.detailLine;
      });
      return fixed(chrome + body);
    }
    case "comparison":
      return fixed(chrome + METRICS.comparison.header + block.metrics.length * METRICS.comparison.row);
  }
}

/** Total block height at `width` px with elastic bodies at their preset: title + body + caption. */
export function estimateBlockHeight(block: Block, width: number, ctx: DataContext, density: Density = "comfortable"): number {
  const box = blockBox(block, width, ctx, density);
  return box.chrome + box.body;
}

/** Section header height (title + description + bottom margin); 0 when the section has neither. */
export function estimateSectionHeader(section: Pick<Section, "title" | "description">, width: number): number {
  const S = METRICS.section;
  if (!section.title && !section.description) return 0;
  let h = section.title ? Math.max(1, wrapLines(section.title, width, S.titleFontSize)) * S.title : 0;
  if (section.description) {
    if (section.title) h += S.descriptionGap;
    h += wrapLines(section.description, width, METRICS.text.fontSize) * S.descriptionLine;
  }
  return h + S.marginBottom;
}

/** Report header height: title, subtitle, author/date line, summary and bottom margin. */
export function estimateReportHeader(spec: Pick<ReportSpec, "title" | "subtitle" | "summary" | "meta">, width: number): number {
  const R = METRICS.reportHeader;
  let h = Math.max(1, wrapLines(spec.title, width, R.titleFontSize)) * R.titleLine;
  if (spec.subtitle) h += R.subtitleGap + wrapLines(spec.subtitle, width, R.subtitleFontSize) * R.subtitleLine;
  if (spec.meta?.author || spec.meta?.date) h += R.metaGap + R.metaLine;
  if (spec.summary) h += R.summaryGap + markdownHeight(spec.summary, width, R.summaryFontSize, R.summaryLine);
  return h + R.marginBottom;
}
