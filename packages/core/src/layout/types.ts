import type { Issue, PageSize } from "../spec.js";

export type LayoutMode = "web" | "print";

export interface LayoutOptions {
  mode: LayoutMode;
  /** Content width in CSS px. Web default 1040; print derives from page size/orientation minus margins. */
  contentWidth?: number;
  /** Gap between grid cells / rows in px (default 16). */
  gap?: number;
  /** Measured block heights (px) from a real renderer; override estimates. Keyed by block id. */
  measured?: Readonly<Record<string, number>>;
  /** Measured section header heights (px) keyed by section id. */
  measuredHeaders?: Readonly<Record<string, number>>;
  /** Measured report header height (px). */
  measuredReportHeader?: number;
}

export interface PageGeometry {
  size: PageSize;
  orientation: "portrait" | "landscape";
  /** Full page in CSS px at 96 dpi. */
  width: number;
  height: number;
  margin: number;
  contentWidth: number;
  contentHeight: number;
}

export interface Cell {
  blockId: string;
  span: number;
  /** 1-based grid column start. */
  start: number;
  /** Pixel width of the cell. */
  width: number;
  /** Estimated (or measured) block height in px. */
  height: number;
}

export interface RowLayout {
  cells: Cell[];
  height: number;
}

export interface SectionLayout {
  id: string;
  headerHeight: number;
  rows: RowLayout[];
}

/** `spacingBefore`: vertical space (px) the renderer puts above the item, exactly as the paginator accounted it. */
export type PageItem = { spacingBefore: number } & (
  | { kind: "report-header" }
  | { kind: "section-header"; sectionId: string }
  | { kind: "row"; sectionId: string; row: number }
  /** Part of a full-width table row split across pages. `from`/`to` are body row indices (to exclusive). */
  | { kind: "table-slice"; sectionId: string; row: number; blockId: string; from: number; to: number; continued: boolean }
);

export interface Page {
  index: number;
  items: PageItem[];
  usedHeight: number;
}

export interface LayoutPlan {
  mode: LayoutMode;
  columns: 12;
  gap: number;
  contentWidth: number;
  /** Print geometry (print mode only). */
  page?: PageGeometry;
  reportHeaderHeight: number;
  sections: SectionLayout[];
  /** Print mode: paginated items. Web mode: a single page containing everything. */
  pages: Page[];
  diagnostics: Issue[];
}
