import type { ReportSpec } from "../spec.js";
import { METRICS } from "./metrics.js";
import type { PageGeometry } from "./types.js";

/** Printable page box in CSS px @ 96 dpi (A4 794×1123, Letter 816×1056; landscape swaps). */
export function pageGeometry(page?: ReportSpec["page"]): PageGeometry {
  const size = page?.size ?? "A4";
  const orientation = page?.orientation ?? "portrait";
  const base = METRICS.page[size];
  const width = orientation === "landscape" ? base.height : base.width;
  const height = orientation === "landscape" ? base.width : base.height;
  const margin = METRICS.page.margin;
  return { size, orientation, width, height, margin, contentWidth: width - 2 * margin, contentHeight: height - 2 * margin };
}

/**
 * Left edge (px) of 1-based grid column `start`, and pixel width of a cell spanning `span` columns.
 * Edges are rounded so that integer cell widths plus gaps sum exactly to an integer content width.
 */
export function cellBox(start: number, span: number, contentWidth: number, gap: number): { x: number; width: number } {
  const columns = METRICS.grid.columns;
  const col = (contentWidth - (columns - 1) * gap) / columns;
  const x0 = (start - 1) * (col + gap);
  const x1 = x0 + span * col + (span - 1) * gap;
  const x = Math.round(x0);
  return { x, width: Math.round(x1) - x };
}
