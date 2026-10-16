/**
 * Every pixel constant shared by the layout solver and renderers (CSS px @ 96 dpi).
 *
 * The React adapter generates its CSS from this object, so the estimates produced by
 * `estimateBlockHeight` and the rendered DOM agree. Change a value here, never in CSS.
 *
 * Box model: blocks sit directly on the page. There are no cards: no padding, border,
 * radius, tiles, accent edges, icon tiles or pills. Whitespace (`grid.gap`, `section.gap`)
 * and typography separate blocks. Every block's height is
 *   [title line(s) + blockTitle.marginBottom] + body + [caption.marginTop + caption line(s)].
 *  - "line" values are CSS line-heights; multi-line text height = lines × line.
 *  - "*Gap" / "margin*" values are vertical spacing between stacked elements.
 *  - Theme density "compact" only switches table body rows to `table.rowCompact`.
 */
export const METRICS = {
  grid: {
    /** Grid columns. */
    columns: 12,
    /** Column gutter between cells and vertical gap between rows. */
    gap: 32,
  },
  blockTitle: {
    fontSize: 15,
    /** Single-line block title height. */
    line: 22,
    /** Space between the title and the block body. */
    marginBottom: 10,
  },
  caption: {
    fontSize: 12,
    /** Caption line height (captions wrap). */
    line: 18,
    /** Space between the block body and the caption. */
    marginTop: 8,
  },
  text: {
    fontSize: 14,
    line: 22,
    /** Space between paragraphs and between a paragraph and a list. */
    paragraphGap: 10,
    /** Space between consecutive list items in markdown. */
    itemGap: 4,
    /** Left indent reserved for bullet / number markers. */
    bulletIndent: 20,
  },
  /** Average glyph advance as a fraction of the font size, by script. */
  glyph: {
    /** Latin letters, punctuation, spaces. */
    latin: 0.55,
    /** CJK ideographs, Hangul, kana and fullwidth forms. */
    cjk: 1,
    /** Tabular digits. */
    digit: 0.6,
  },
  /** A `{{ template }}` placeholder is estimated as this many digit glyphs. */
  templateChars: 8,
  kpi: {
    /**
     * Minimum item width. Items per row = clamp(floor((width + columnGap) / (minItemWidth + columnGap)), 1, items).
     * Item height = label.line + value.line + delta.line (+ description.line if any item has one) (+ sparkline if any).
     */
    minItemWidth: 150,
    /** Items never grow wider than this, so two KPIs do not spread across the full page. */
    maxItemWidth: 280,
    columnGap: 24,
    rowGap: 20,
    label: { fontSize: 13, line: 18 },
    value: { fontSize: 28, line: 36 },
    delta: { fontSize: 13, line: 20 },
    description: { fontSize: 12, line: 18 },
    /** Sparkline height under the delta line. */
    sparkline: 28,
  },
  table: {
    /** Header row height. */
    header: 34,
    /** Body row height (normal density). */
    row: 30,
    /** Body row height (compact density). */
    rowCompact: 24,
    /** Totals row height. */
    totals: 34,
    /** "Showing N of M rows" note under a truncated table. */
    truncationNote: 24,
    /** Web pager under a paged table: row range, previous/next and page buttons. */
    pager: 44,
    fontSize: 13,
    cellPaddingX: 10,
  },
  chart: {
    /** Chart SVG height (axes included, block title/caption excluded) by `height` preset. */
    plot: { sm: 200, md: 280, lg: 360 },
    /** Small multiples: one panel's height, including its `facetLabel` line above the panel SVG. */
    facetPlot: 150,
    /** Gap between facet panels, horizontally and vertically. */
    facetGap: 16,
    /** Facet panel label line above each panel SVG. */
    facetLabel: 20,
    /** HTML legend band below the SVG, shown for multi-series and pie/donut charts. */
    legendBand: 28,
    fontSize: 12,
  },
  stat: {
    label: { fontSize: 14, line: 20 },
    value: { fontSize: 56, line: 64 },
    delta: { fontSize: 15, line: 24 },
    description: { fontSize: 16, line: 26 },
    /** Space above the description (only when there is one). */
    gap: 6,
  },
  callout: {
    /**
     * Body markdown size. The title line reads `${variantLabel}: ${title}` when a variant is set
     * (the label alone when there is no title), using blockTitle metrics.
     */
    fontSize: 16,
    line: 26,
  },
  list: {
    /** Primary item text line height (text.fontSize). */
    line: 22,
    /** Secondary detail line height. */
    detailLine: 20,
    detailFontSize: 13,
    /** Space between items. */
    itemGap: 8,
    /** Marker column (bullet / number / check). */
    marker: 24,
    /** A tag is plain text after the item text, `tagGap` px from it. */
    tagGap: 8,
    tagFontSize: 13,
  },
  comparison: {
    /** Entity header row height. */
    header: 36,
    /** One metric row height. */
    row: 36,
    /** Metric label column min width. */
    labelColumn: 120,
    /** Min width per entity column. */
    entityColumn: 96,
  },
  section: {
    titleFontSize: 20,
    /** Section title line height. */
    title: 28,
    /** Description line height (text.fontSize) and gap after the title. */
    descriptionLine: 22,
    descriptionGap: 4,
    /** Space between the section header and its first row. */
    marginBottom: 12,
    /** Space between consecutive sections on the same page. */
    gap: 48,
  },
  reportHeader: {
    titleFontSize: 34,
    titleLine: 42,
    subtitleFontSize: 17,
    subtitleLine: 24,
    subtitleGap: 4,
    /** Author · date line. */
    metaFontSize: 13,
    metaLine: 20,
    metaGap: 8,
    summaryFontSize: 15,
    summaryLine: 24,
    summaryGap: 12,
    /** Space between the report header and the first section. */
    marginBottom: 24,
  },
  /** Minimum cell widths: a composition that would give a block less is infeasible. */
  minWidth: {
    chart: 300,
    table: 320,
    diagram: 300,
    /** Text, callout and list blocks. */
    text: 220,
    stat: 260,
  },
  page: {
    /** Print margin on every side. */
    margin: 48,
    A4: { width: 794, height: 1123 },
    Letter: { width: 816, height: 1056 },
  },
  /**
   * Slides mode: a 16:9 canvas; the footer (title, slide number) sits in the bottom margin. The canvas is small
   * (960×540) so type set at document sizes reads presentation-sized once the deck scales it up.
   */
  slide: {
    width: 960,
    height: 540,
    margin: 40,
  },
  web: {
    /** Default web content width. */
    contentWidth: 1040,
  },
} as const;
