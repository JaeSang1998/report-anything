import { useEffect, useId, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  buildComparisonModel,
  buildKpiModels,
  buildStatModel,
  buildTableModel,
  chartPlotHeight,
  estimateTextWidth,
  renderTemplate,
  FACET_KINDS,
  facetGrid,
  METRICS,
  pagerItems,
  sparklinePath,
  uiStrings,
} from "@report-anything/core";
import type { BlockOf, BlockType, DataContext, LayoutMode, Placement, TableCell, TablePage, TableSort } from "@report-anything/core";
import { ChartView, FacetChartView } from "./ChartView.js";
import { Markdown } from "./Markdown.js";

/** Rows of a table rendered on one printed page. */
export interface TableSlice {
  from: number;
  to: number;
  continued: boolean;
}

export interface BlockProps<T extends BlockType = BlockType> {
  block: BlockOf<T>;
  context: DataContext;
  /** Placement from the layout plan: pixel width and estimated height. */
  cell: Placement;
  mode: LayoutMode;
  /** False for static HTML (no hydration): blocks render without controls (tables capped at maxRows, unsortable). */
  interactive: boolean;
  paletteSize: number;
  slice?: TableSlice;
  /**
   * Body height the layout engine assigned to elastic blocks (chart plot, diagram box), so blocks placed side by side
   * end level. Undefined for blocks whose height follows their content.
   */
  plotHeight?: number;
}

/** Per-type body overrides — the SDUI extension point. Titles and captions stay with the frame. */
export type BlockComponents = { [T in BlockType]?: ComponentType<BlockProps<T>> };

function TextBody({ block, context }: BlockProps<"text">) {
  return <Markdown text={block.content} context={context} />;
}

function CalloutBody({ block, context }: BlockProps<"callout">) {
  return <Markdown className="ra-callout__body" text={block.content} context={context} />;
}

/** Marker shape carries tone, so status never depends on color alone. */
const TONE_MARK: Record<string, string> = { warning: "!", critical: "!", positive: "✓" };

function ListBody({ block, context }: BlockProps<"list">) {
  // Item text may carry data placeholders like any other prose.
  const fill = (s: string) => (s.includes("{{") ? renderTemplate(s, context).text : s);
  return (
    <ul className={`ra-list ra-list--${block.style}`}>
      {block.items.map((item, i) => {
        const tone = item.tone && TONE_MARK[item.tone] ? item.tone : undefined;
        const mark = tone ? TONE_MARK[tone] : block.style === "numbered" ? `${i + 1}.` : block.style === "check" ? "☐" : "•";
        return (
          <li key={i} className="ra-list__item">
            <span className={tone ? `ra-list__marker ra-tone--${tone}` : "ra-list__marker"}>{mark}</span>
            <span className="ra-list__body">
              <span className="ra-list__text">
                {fill(item.text)}
                {item.tag ? <span className="ra-list__tag">{item.tag}</span> : null}
              </span>
              {item.detail ? <span className="ra-list__detail">{fill(item.detail)}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Arrow shows the direction of change; colour (sentiment) says whether that direction is good. */
const arrow = (ratio: number) => (ratio > 0 ? "▲" : ratio < 0 ? "▼" : "■");

function KpiBody({ block, context, cell }: BlockProps<"kpi">) {
  const items = useMemo(() => buildKpiModels(block, context), [block, context]);
  const K = METRICS.kpi;
  // Same rule as the layout estimate: as many ≥ minItemWidth items per row as fit.
  const perRow = Math.max(1, Math.min(items.length, Math.floor((cell.width + K.columnGap) / (K.minItemWidth + K.columnGap))));
  const itemWidth = Math.min(K.maxItemWidth, (cell.width - (perRow - 1) * K.columnGap) / perRow);
  const hasDesc = items.some((i) => i.description);
  return (
    <div className="ra-kpis" style={{ gridTemplateColumns: `repeat(${perRow}, minmax(0, ${K.maxItemWidth}px))` }}>
      {items.map((k, i) => {
        // Never clip a headline number: fall back to compact magnitude when the full figure is too wide.
        const value = estimateTextWidth(k.text, K.value.fontSize) <= itemWidth ? k.text : k.compactText;
        return (
          <div key={i} className="ra-kpi">
            <div className="ra-kpi__label">{k.label}</div>
            <div className="ra-kpi__value" title={value === k.text ? undefined : k.text}>
              {value}
            </div>
            <div className="ra-kpi__delta">
              {k.delta ? (
                <>
                  <span className={`ra-delta ra-delta--${k.delta.sentiment}`}>
                    {arrow(k.delta.ratio)} {k.delta.text}
                  </span>
                  {k.delta.label ? <span className="ra-kpi__baseline"> {k.delta.label}</span> : null}
                </>
              ) : null}
            </div>
            {hasDesc ? <div className="ra-kpi__desc">{k.description ?? ""}</div> : null}
            {k.sparkline ? (
              <svg className="ra-kpi__spark" viewBox="0 0 120 24" preserveAspectRatio="none" aria-hidden>
                <path d={sparklinePath(k.sparkline, 120, 24)} vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One figure in display type: label, value, change against its baseline, and a sentence of context. */
function StatBody({ block, context }: BlockProps<"stat">) {
  const k = useMemo(() => buildStatModel(block, context), [block, context]);
  return (
    <div className="ra-stat">
      <div className="ra-stat__label">{k.label}</div>
      <div className="ra-stat__value">{k.text}</div>
      {k.delta ? (
        <div className="ra-stat__delta">
          <span className={`ra-delta ra-delta--${k.delta.sentiment}`}>
            {arrow(k.delta.ratio)} {k.delta.text}
          </span>
          {k.delta.label ? <span className="ra-kpi__baseline"> {k.delta.label}</span> : null}
        </div>
      ) : null}
      {block.description ? <Markdown className="ra-stat__description" text={block.description} context={context} /> : null}
    </div>
  );
}

function ChartBody({ block, context, cell, paletteSize, plotHeight }: BlockProps<"chart">) {
  const width = Math.max(120, Math.floor(cell.width));
  if (block.chart.facet !== undefined && FACET_KINDS[block.chart.kind]) {
    const grid = facetGrid(block, width, context, plotHeight);
    return <FacetChartView spec={block.chart} context={context} width={width} columns={grid.columns} panelHeight={grid.panelHeight} paletteSize={paletteSize} />;
  }
  return <ChartView spec={block.chart} context={context} width={width} height={plotHeight ?? chartPlotHeight(block)} paletteSize={paletteSize} />;
}

function TableCellView({ c, align }: { c: TableCell; align: string }) {
  const e = c.emphasis;
  const cls = `ra-align--${align}${e?.kind === "delta" ? ` ra-delta ra-delta--${e.sentiment}` : ""}`;
  if (e?.kind === "heat") {
    return (
      <td className={cls} style={{ background: `color-mix(in srgb, var(--ra-c1) ${Math.round(4 + e.t * 30)}%, transparent)` }}>
        {c.text}
      </td>
    );
  }
  if (e?.kind === "bar") {
    return (
      <td className={cls}>
        <span className="ra-databar">
          <span className={e.negative ? "ra-databar__fill ra-databar__fill--neg" : "ra-databar__fill"} style={{ width: `${Math.round(e.ratio * 100)}%` }} />
          <span className="ra-databar__text">{c.text}</span>
        </span>
      </td>
    );
  }
  return <td className={cls}>{c.text}</td>;
}

const ARIA_SORT: Record<TableSort["dir"], "ascending" | "descending"> = { asc: "ascending", desc: "descending" };

function TablePager({ page, pages, from, to, total, locale, onPage }: TablePage & { total: number; locale: string; onPage: (page: number) => void }) {
  const s = uiStrings(locale).pager;
  const fmt = (n: number) => n.toLocaleString(locale);
  // aria-disabled keeps the edge buttons focusable, so keyboard focus survives reaching the first or last page.
  const step = (target: number, label: string, flip: boolean) => {
    const off = target < 1 || target > pages;
    return (
      <button type="button" className="ra-pager__step" aria-label={label} aria-disabled={off} onClick={off ? undefined : () => onPage(target)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={flip ? "ra-pager__chevron--next" : undefined}>
          <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  };
  return (
    <nav className="ra-pager" aria-label={s.label}>
      <span className="ra-pager__range" aria-live="polite">
        {s.range(fmt(from + 1), fmt(to), fmt(total))}
      </span>
      <span className="ra-pager__pages">
        {step(page - 1, s.previous, false)}
        {pagerItems(page, pages).map((p, i) =>
          p === null ? (
            <span key={`gap${i}`} className="ra-pager__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="ra-pager__page"
              aria-label={s.page(fmt(p))}
              aria-current={p === page ? "page" : undefined}
              onClick={p === page ? undefined : () => onPage(p)}
            >
              {fmt(p)}
            </button>
          ),
        )}
        {step(page + 1, s.next, true)}
      </span>
    </nav>
  );
}

/**
 * Interactive web: one page of every row with a pager, and headers that sort on click (asc → desc → spec order).
 * Print, slides and static HTML: the first maxRows rows (sliced across printed pages) with a "showing N of M" note.
 */
function TableBody({ block, context, slice, mode, interactive }: BlockProps<"table">) {
  const paged = mode === "web" && interactive;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<TableSort | null>(null);
  const model = useMemo(() => buildTableModel(block, context, paged ? { page, ...(sort ? { sort } : {}) } : {}), [block, context, paged, page, sort]);
  const rows = slice ? model.rows.slice(slice.from, slice.to) : model.rows;
  const last = !slice || slice.to >= model.rows.length;
  const cycleSort = (field: string) => {
    setSort(sort?.field !== field ? { field, dir: "asc" } : sort.dir === "asc" ? { field, dir: "desc" } : null);
    setPage(1);
  };
  return (
    <>
      <div className="ra-table-scroll">
        <table className={`ra-table${block.density === "compact" ? " ra-table--compact" : ""}`}>
          <thead>
            <tr>
              {model.columns.map((c) => {
                const dir = sort?.field === c.field ? sort.dir : undefined;
                return (
                  <th key={c.field} className={`ra-align--${c.align}`} scope="col" aria-sort={dir ? ARIA_SORT[dir] : undefined}>
                    {paged ? (
                      <button type="button" className={`ra-table__sort${dir ? ` ra-table__sort--${dir}` : ""}`} onClick={() => cycleSort(c.field)}>
                        {c.label}
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="ra-table__arrow">
                          <path d="M4 1v6M1.5 3.5 4 1l2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                {r.cells.map((c, j) => (
                  <TableCellView key={c.field} c={c} align={model.columns[j]!.align} />
                ))}
              </tr>
            ))}
          </tbody>
          {model.totals && last ? (
            <tfoot>
              <tr>
                {model.totals.map((c, j) => (
                  <td key={c.field} className={`ra-align--${model.columns[j]!.align}`}>
                    {c.text}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {model.page && model.page.pages > 1 ? <TablePager {...model.page} total={model.totalRows} locale={context.locale} onPage={setPage} /> : null}
      {model.hiddenRows > 0 && last ? <div className="ra-table__note">{uiStrings(context.locale).showingRows(model.rows.length, model.totalRows)}</div> : null}
    </>
  );
}

function ComparisonBody({ block, context, cell }: BlockProps<"comparison">) {
  const model = useMemo(() => buildComparisonModel(block, context), [block, context]);
  const showDelta = model.rows.some((r) => r.delta);
  const C = METRICS.comparison;
  const columnWidth = (cell.width - C.labelColumn) / (model.entities.length + (showDelta ? 1 : 0)) - 16;
  // One precision for the whole table: compact every value if any full value would not fit its column.
  const compact = model.rows.some((r) => r.cells.some((c) => estimateTextWidth(c.text, METRICS.table.fontSize) > columnWidth));
  return (
    <div className="ra-table-scroll">
      <table className="ra-comparison">
        <thead>
          <tr>
            <th scope="col" />
            {model.entities.map((e) => (
              <th key={e} scope="col" className="ra-align--right">
                {e}
              </th>
            ))}
            {showDelta ? <th className="ra-align--right">{uiStrings(context.locale).change}</th> : null}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {r.cells.map((c, i) => (
                <td key={i} className="ra-align--right" title={compact ? c.text : undefined}>
                  {compact ? c.compactText : c.text}
                </td>
              ))}
              {showDelta ? <td className={`ra-align--right${r.delta ? ` ra-delta ra-delta--${r.delta.sentiment}` : ""}`}>{r.delta ? `${arrow(r.delta.ratio)} ${r.delta.text}` : ""}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Mermaid diagram fitted into the chart height preset. Mermaid is an optional peer dependency loaded on demand;
 * until it renders (and during server rendering) the source is shown in a `.mermaid` element, which static
 * HTML upgrades with `mermaid.run()`.
 */
function DiagramBody({ block, plotHeight }: BlockProps<"diagram">) {
  const height = plotHeight ?? METRICS.chart.plot[block.height ?? "md"];
  const id = `ra-diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    setState({});
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", fontFamily: "inherit" });
        const { svg } = await mermaid.render(id, block.source);
        if (!cancelled) setState({ svg });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [block.source, id]);
  return (
    <div className="ra-diagram" style={{ height }}>
      {state.svg ? (
        <div className="ra-diagram__svg" dangerouslySetInnerHTML={{ __html: state.svg }} />
      ) : state.error ? (
        <p className="ra-block-error">
          <strong>Cannot render diagram:</strong> {state.error}
        </p>
      ) : (
        <pre className="ra-diagram__source mermaid">{block.source}</pre>
      )}
    </div>
  );
}

export const DEFAULT_BLOCKS: { [T in BlockType]: ComponentType<BlockProps<T>> } = {
  text: TextBody,
  callout: CalloutBody,
  list: ListBody,
  kpi: KpiBody,
  stat: StatBody,
  chart: ChartBody,
  table: TableBody,
  comparison: ComparisonBody,
  diagram: DiagramBody,
};
