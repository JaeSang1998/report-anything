import type { Issue } from "../spec.js";
import type { TableMetrics } from "./estimate.js";
import type { Page, PageItem } from "./types.js";

/** Minimum body rows per table slice (unless the table itself is smaller). */
export const MIN_TABLE_SLICE = 3;

export interface PaginationRow {
  height: number;
  /** Set when the row is a single full-width table that may split across pages. */
  table?: TableMetrics & { blockId: string };
  /** Tallest cell of the row, reported when the row overflows a page. */
  tallest: { path: string; hint: string };
}

export interface PaginationSection {
  id: string;
  headerHeight: number;
  breakBefore: boolean;
  rows: PaginationRow[];
}

export interface PaginationInput {
  reportHeaderHeight: number;
  sections: readonly PaginationSection[];
  /** Usable page height; `Infinity` produces a single page (web mode). */
  contentHeight: number;
  /** Vertical gap between rows of a section. */
  gap: number;
  /** Vertical gap between consecutive sections on one page. */
  sectionGap: number;
}

/**
 * Greedy page filling with keep-with-next headers, atomic rows and full-width table splitting.
 * Never emits empty pages.
 */
export function paginate(input: PaginationInput): { pages: Page[]; issues: Issue[] } {
  const H = input.contentHeight;
  const pages: Page[] = [];
  const issues: Issue[] = [];
  let items: PageItem[] = [];
  let used = 0;
  /** What sits last on the current page: drives the spacing before the next item. */
  let last: { kind: "none" | "report" | "header" | "row"; section?: string } = { kind: "none" };

  const newPage = (): void => {
    if (items.length === 0) return;
    pages.push({ index: pages.length, items, usedHeight: used });
    items = [];
    used = 0;
    last = { kind: "none" };
  };
  const spacingBefore = (kind: "header" | "row", section: string): number => {
    if (last.kind === "none" || last.kind === "report" || last.kind === "header") return 0;
    return kind === "row" && last.section === section ? input.gap : input.sectionGap;
  };
  /** `item.spacingBefore` is the exact space accounted above it; renderers apply it verbatim. */
  const place = (item: PageItem, height: number, section?: string): void => {
    items.push(item);
    used += item.spacingBefore + height;
    last = { kind: item.kind === "section-header" ? "header" : item.kind === "report-header" ? "report" : "row", section };
  };
  /** The page may break here unless this section's header was just placed (keep-with-next). */
  const mayBreak = (section: string): boolean => items.length > 0 && !(last.kind === "header" && last.section === section);
  const sliceHeight = (t: TableMetrics, rows: number, final: boolean): number => t.top + t.header + rows * t.row + (final ? t.footer : 0);

  place({ kind: "report-header", spacingBefore: 0 }, input.reportHeaderHeight);

  for (const s of input.sections) {
    if (s.breakBefore) newPage();
    const first = s.rows[0];

    if (s.headerHeight > 0) {
      let firstNeed = first?.height ?? 0;
      const t = first?.table;
      if (t && firstNeed > H - s.headerHeight) {
        firstNeed = sliceHeight(t, Math.min(MIN_TABLE_SLICE, t.rows), t.rows <= MIN_TABLE_SLICE);
      }
      let spacing = spacingBefore("header", s.id);
      if (items.length > 0 && used + spacing + s.headerHeight + firstNeed > H) {
        newPage();
        spacing = 0;
      }
      place({ kind: "section-header", sectionId: s.id, spacingBefore: spacing }, s.headerHeight, s.id);
    }

    s.rows.forEach((r, rowIndex) => {
      const freshAvailable = H - (rowIndex === 0 ? s.headerHeight : 0);
      const t = r.table;
      if (t && r.height > freshAvailable) {
        let from = 0;
        while (from < t.rows) {
          const spacing = spacingBefore("row", s.id);
          const available = H - used - spacing;
          const remaining = t.rows - from;
          let k: number;
          if (sliceHeight(t, remaining, true) <= available) {
            k = remaining;
          } else {
            k = Math.min(remaining - 1, Math.floor((available - t.top - t.header) / t.row));
            // Leave at least MIN_TABLE_SLICE rows for the next slice.
            if (remaining - k < MIN_TABLE_SLICE) k = remaining - MIN_TABLE_SLICE;
          }
          const minK = Math.min(MIN_TABLE_SLICE, remaining);
          if (k < minK) {
            if (mayBreak(s.id)) {
              newPage();
              continue;
            }
            // Nothing fits even on a fresh page: force the minimum slice.
            k = minK;
          }
          const to = from + k;
          const item: PageItem = {
            kind: "table-slice",
            sectionId: s.id,
            row: rowIndex,
            blockId: t.blockId,
            from,
            to,
            continued: from > 0,
            spacingBefore: spacing,
          };
          place(item, sliceHeight(t, k, to === t.rows), s.id);
          from = to;
        }
        return;
      }
      let spacing = spacingBefore("row", s.id);
      if (used + spacing + r.height > H && mayBreak(s.id)) {
        newPage();
        spacing = spacingBefore("row", s.id);
      }
      place({ kind: "row", sectionId: s.id, row: rowIndex, spacingBefore: spacing }, r.height, s.id);
      if (used > H) {
        issues.push({
          severity: "warning",
          code: "block_too_tall",
          path: r.tallest.path,
          message: `Block is ${Math.round(r.height)}px tall but a page holds ${Math.round(freshAvailable)}px; it overflows its page.`,
          hint: r.tallest.hint,
        });
      }
    });
  }
  newPage();
  return { pages, issues };
}
