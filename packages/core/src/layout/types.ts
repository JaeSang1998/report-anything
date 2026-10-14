import type { Issue, PageSize } from "../spec.js";

export type LayoutMode = "web" | "print";

export interface LayoutOptions {
  mode: LayoutMode;
  /** Content width in CSS px. Web default 1040; print derives from page size/orientation minus margins. */
  contentWidth?: number;
  /** Gap between grid cells / rows in px (default 16). */
  gap?: number;
  /**
   * Measured block heights (px) from a real renderer; override estimates. Keyed by block id.
   * Elastic blocks (charts, diagrams) report their height without the assigned `plotHeight` (title, legend, caption):
   * their body is solved by the engine.
   */
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

/** Band templates the solver chooses from (see layout/compose.ts). */
export type Composition =
  | "full"
  | "hero"
  | "pair"
  | "trio"
  | "quad"
  | "grid"
  | "feature-left"
  | "feature-right"
  | "sidebar-left"
  | "sidebar-right"
  | "stack";

/** A block's cell in its band's 12-column grid. `col`/`row` are 1-based CSS grid lines. */
export interface Placement {
  blockId: string;
  col: number;
  span: number;
  row: number;
  rowSpan: number;
  /** Pixel width of the cell. */
  width: number;
  /** Total block height in px: title + body + caption (after levelling). */
  height: number;
  /** Elastic blocks (charts incl. facet grids, diagrams): the body height the renderer must draw, legend excluded. */
  plotHeight?: number;
}

/** A 12-column grid region with `rows` auto row tracks. Placements are in block (reading) order. */
export interface Band {
  composition: Composition;
  rows: number;
  height: number;
  placements: Placement[];
}

export interface SectionLayout {
  id: string;
  headerHeight: number;
  bands: Band[];
}

/** `spacingBefore`: vertical space (px) the renderer puts above the item, exactly as the paginator accounted it. */
export type PageItem = { spacingBefore: number } & (
  | { kind: "report-header" }
  | { kind: "section-header"; sectionId: string }
  | { kind: "band"; sectionId: string; band: number }
  /** Part of a band holding a single full-width table, split across pages. `from`/`to` are body row indices (to exclusive). */
  | { kind: "table-slice"; sectionId: string; band: number; blockId: string; from: number; to: number; continued: boolean }
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
